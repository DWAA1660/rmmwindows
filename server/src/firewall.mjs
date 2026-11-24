import { createSocket } from 'node:dgram';
import { isIP } from 'node:net';
import { transaction } from './db.mjs';

const retentionDays = 7;
const maxEvents = 50_000;
const maxSources = 64;
const maxBytes = 8192;
const maxQueue = 1000;
const pageSize = 50;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function port(value) {
  return value && /^\d{1,5}$/.test(value) && Number(value) <= 65535 ? Number(value) : null;
}

export function parseTraffic(raw) {
  const message = raw.replace(/^<\d{1,3}>/, '').trim();
  // Traffic Monitor format: disposition, addresses, service/protocol, optional ports.
  const modern = /(?:^|\s)(Allow|Deny)\s+(\S+)\s+(\S+)\s+([\w.+/-]+)\s*(.*)$/i.exec(message);
  // Older packet filter format: disposition, interfaces, packet length, protocol,
  // IP header length, TTL, addresses (optionally annotated with |username), ports.
  const legacy = /(?:^|\s)(Allow|Deny)\s+\S+\s+\S+\s+\d+\s+([\w.+/-]+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s*(.*)$/i.exec(message);
  const matches = modern ? [modern] : [];
  if (legacy) matches.push([legacy[0], legacy[1], legacy[3], legacy[4], legacy[2], legacy[5]]);
  for (const [, disposition, source, destination, service, tail] of matches) {
    const [srcIp] = source.split('|');
    const [dstIp] = destination.split('|');
    if (!isIP(srcIp) || !isIP(dstIp)) continue;
    const protocol = service.split('/').at(-1).toLowerCase();
    const ports = /^(\d+)\s+(\d+)(?:\s|$)/.exec(tail);
    const policy = /(?:^|\s)\(([^()]{1,200})\)(?=\s*(?:[\w-]+=|$))/.exec(tail)?.[1] ?? null;
    return { action: disposition.toLowerCase(), srcIp, dstIp, protocol, srcPort: port(ports?.[1]), dstPort: port(ports?.[2]), policy };
  }
  return { action: null, srcIp: null, dstIp: null, protocol: null, srcPort: null, dstPort: null, policy: null };
}

export function createFirewall({ db, env, audit, fail, str }) {
  const configuredPort = env.FIREWALL_SYSLOG_PORT;
  const listenPort = Number(configuredPort);
  const sources = new Set(db.prepare('SELECT address FROM firewall_sources WHERE enabled=1').all().map(row => row.address));
  const queue = [];
  let receiver = configuredPort ? 'starting' : 'disabled';
  let socket;
  let timer;
  let nextPrune = 0;
  let rejected = 0;
  let dropped = 0;
  let lastStorageError = null;
  const cutoff = () => new Date(Date.now() - retentionDays * 86400000).toISOString();
  const insert = db.prepare(`INSERT INTO firewall_events
    (sender,received_at,action,src_ip,dst_ip,protocol,src_port,dst_port,policy,raw) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const updateReceived = db.prepare('UPDATE firewall_sources SET last_received_at=? WHERE address=?');
  const expire = db.prepare('DELETE FROM firewall_events WHERE received_at < ?');
  const limitHistory = db.prepare('DELETE FROM firewall_events WHERE id <= ?');

  function receive(message, remote) {
    if (!sources.has(remote.address) || !message.length || message.length > maxBytes) {
      rejected++;
      return;
    }
    let raw;
    try { raw = decoder.decode(message); } catch { rejected++; return; }
    const priority = /^<(\d{1,3})>/.exec(raw)?.[1];
    // Local1 is reserved for WatchGuard traffic in the documented configuration.
    if (priority === undefined || Math.floor(Number(priority) / 8) !== 17) {
      rejected++;
      return;
    }
    if (queue.length >= maxQueue) { dropped++; return; }
    queue.push({ raw, sender: remote.address, receivedAt: new Date().toISOString() });
  }

  function flush(size = 250) {
    const batch = queue.splice(0, size);
    const prune = Date.now() >= nextPrune;
    if (!batch.length && !prune) return;
    try {
      transaction(db, () => {
        let lastId;
        const lastSeen = new Map();
        for (const { raw, sender, receivedAt } of batch) {
          const { action, srcIp, dstIp, protocol, srcPort, dstPort, policy } = parseTraffic(raw);
          lastId = insert.run(sender, receivedAt, action, srcIp, dstIp, protocol, srcPort, dstPort, policy, raw).lastInsertRowid;
          lastSeen.set(sender, receivedAt);
        }
        for (const [sender, receivedAt] of lastSeen) updateReceived.run(receivedAt, sender);
        if (lastId) limitHistory.run(Number(lastId) - maxEvents);
        if (prune) expire.run(cutoff());
      });
    } catch (error) {
      dropped += batch.length;
      if (!lastStorageError || Date.now() - Date.parse(lastStorageError) >= 60_000)
        console.error('Firewall syslog storage failure:', error.message);
      lastStorageError = new Date().toISOString();
    } finally {
      if (prune) nextPrune = Date.now() + 60_000;
    }
  }

  function start() {
    if (timer) return;
    flush();
    timer = setInterval(flush, 250);
    timer.unref();
    if (!configuredPort) return;
    const host = env.FIREWALL_SYSLOG_HOST || '127.0.0.1';
    if (!/^\d+$/.test(configuredPort) || listenPort < 1024 || listenPort > 65535 || isIP(host) !== 4) {
      receiver = 'error';
      console.error('Firewall syslog requires an IPv4 bind address and UDP port 1024–65535.');
      return;
    }
    socket = createSocket('udp4');
    socket.on('message', receive);
    socket.once('listening', () => { receiver = 'listening'; });
    socket.on('error', error => {
      receiver = 'error';
      console.error('Firewall syslog listener failed:', error.message);
      socket?.close();
      socket = undefined;
    });
    socket.bind(listenPort, host);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    socket?.close();
    socket = undefined;
    if (queue.length) flush(queue.length);
  }

  const listSources = () => db.prepare(`SELECT address,name,enabled,last_received_at AS lastReceivedAt
    FROM firewall_sources ORDER BY name COLLATE NOCASE,address`).all().map(row => ({ ...row, enabled: Boolean(row.enabled) }));

  function mount(router) {
    router.use('/firewall', (req, res, next) => {
      if (req.operator.role === 'viewer') return res.status(403).json({ error: 'Operator access required.' });
      next();
    });
    router.get('/firewall', (req, res) => {
      res.json({ receiver, rejected, dropped, lastStorageError, retentionDays, maxEvents, sources: listSources() });
    });
    router.put('/firewall/sources/:address', (req, res) => {
      if (req.operator.role !== 'admin') fail(403, 'Administrator access required.');
      const { address } = req.params;
      if (isIP(address) !== 4 || address === '0.0.0.0') fail(400, 'Enter the sender’s IPv4 address.');
      const name = str(req.body.name, 'Name', { max: 100 });
      const { enabled } = req.body;
      if (typeof enabled !== 'boolean') fail(400, 'Enabled must be true or false.');
      transaction(db, () => {
        const existing = db.prepare('SELECT name,enabled FROM firewall_sources WHERE address=?').get(address);
        if (!existing && listSources().length >= maxSources) fail(409, 'The firewall source limit has been reached.');
        if (existing?.name === name && Boolean(existing.enabled) === enabled) return;
        db.prepare(`INSERT INTO firewall_sources(address,name,enabled) VALUES (?,?,?)
          ON CONFLICT(address) DO UPDATE SET name=excluded.name,enabled=excluded.enabled`).run(address, name, Number(enabled));
        audit(req.operator.username, 'firewall.source.saved', address, { name, enabled });
      });
      if (enabled) sources.add(address);
      else sources.delete(address);
      res.json({ sources: listSources() });
    });
    router.get('/firewall/events', (req, res) => {
      const { sender, action, query, before } = req.query;
      if (sender !== undefined && (typeof sender !== 'string' || isIP(sender) !== 4)) fail(400, 'Invalid sender.');
      if (action !== undefined && !['allow', 'deny', 'unparsed'].includes(action)) fail(400, 'Invalid traffic action.');
      if (query !== undefined && (typeof query !== 'string' || query.length > 100)) fail(400, 'Search is limited to 100 characters.');
      if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before))))
        fail(400, 'Invalid page cursor.');
      const where = ['received_at >= ?'];
      const args = [cutoff()];
      if (before !== undefined) { where.push('id < ?'); args.push(Number(before)); }
      if (sender !== undefined) { where.push('sender = ?'); args.push(sender); }
      if (action === 'unparsed') where.push('action IS NULL');
      else if (action !== undefined) { where.push('action = ?'); args.push(action); }
      if (query?.trim()) {
        const term = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
        where.push(`(src_ip LIKE ? ESCAPE '\\' OR dst_ip LIKE ? ESCAPE '\\' OR policy LIKE ? ESCAPE '\\')`);
        args.push(term, term, term);
      }
      const events = db.prepare(`SELECT id,sender,received_at AS receivedAt,action,src_ip AS srcIp,dst_ip AS dstIp,
        protocol,src_port AS srcPort,dst_port AS dstPort,policy,raw FROM firewall_events
        WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, pageSize + 1);
      const nextBefore = events.length > pageSize ? events[pageSize - 1].id : null;
      if (nextBefore !== null) events.pop();
      res.json({ events, nextBefore });
    });
  }

  return { start, stop, mount };
}
