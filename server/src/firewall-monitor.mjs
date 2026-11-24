import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { transaction } from './db.mjs';

const minute = 60_000;
const day = 1440 * minute;
const rangeBuckets = new Map([[1, 5], [6, 15], [24, 60], [168, 360]]);
const fields = {
  sender: 'sender', srcIp: 'src_ip', dstIp: 'dst_ip', dstPort: 'dst_port',
  protocol: 'protocol', policy: 'policy', application: 'application', host: 'host', messageId: 'message_id',
};
const ipFields = new Set(['srcIp', 'dstIp', 'sender']);
const actions = ['allow', 'deny', 'unparsed'];

export function trafficFilters(input, fail) {
  const filters = {};
  if (input.action !== undefined && input.action !== '') {
    if (!actions.includes(input.action)) fail(400, 'Invalid traffic action.');
    filters.action = input.action;
  }
  for (const field of Object.keys(fields)) {
    const value = input[field];
    if (value === undefined || value === '') continue;
    if (field === 'dstPort') {
      if (!(typeof value === 'number' || (typeof value === 'string' && /^\d{1,5}$/.test(value))) ||
          !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 65535) fail(400, 'Invalid destination port.');
      filters.dstPort = Number(value);
    } else if (ipFields.has(field)) {
      if (typeof value !== 'string' || !isIP(value) || (field === 'sender' && isIP(value) !== 4)) fail(400, `Invalid ${field} address.`);
      filters[field] = value;
    } else {
      if (typeof value !== 'string' || !value.trim() || value.length > 253) fail(400, `Invalid ${field} filter.`);
      filters[field] = value.trim();
    }
  }
  return filters;
}

export function trafficWhere(filters, cutoff, until) {
  const clauses = ['received_at >= ?', 'received_at <= ?'];
  const args = [cutoff, until];
  for (const [key, column] of Object.entries(fields)) {
    if (filters[key] === undefined) continue;
    clauses.push(key === 'sender' || key === 'dstPort' ? `${column} = ?` : `${column} = ? COLLATE NOCASE`);
    args.push(filters[key]);
  }
  if (filters.action === 'unparsed') clauses.push('action IS NULL');
  else if (filters.action) { clauses.push('action = ?'); args.push(filters.action); }
  return { clauses, args };
}

export function timeWindow(value, fail, now = Date.now()) {
  const hours = value === undefined ? 24 : Number(value);
  if ((value !== undefined && typeof value !== 'string') || !rangeBuckets.has(hours)) fail(400, 'Use a range of 1, 6, 24, or 168 hours.');
  return { hours, from: new Date(now - hours * 60 * minute).toISOString(), to: new Date(now).toISOString() };
}

const tallies = `COUNT(*) AS total, COUNT(CASE WHEN action='allow' THEN 1 END) AS allowed,
  COUNT(CASE WHEN action='deny' THEN 1 END) AS denied, COUNT(CASE WHEN action IS NULL THEN 1 END) AS unparsed`;
const bytes = 'COALESCE(SUM(1.0 * COALESCE(sent_bytes,0) + COALESCE(received_bytes,0)),0)';
const ruleColumns = `id,name,kind,enabled,window_minutes AS windowMinutes,threshold,cooldown_minutes AS cooldownMinutes,
  filters,updated_at AS updatedAt,last_notified_at AS lastNotifiedAt`;
const alertColumns = `id,rule_id AS ruleId,rule_name AS ruleName,kind,fired_at AS firedAt,observed,
  window_minutes AS windowMinutes,threshold,filters,acknowledged_at AS acknowledgedAt,acknowledged_by AS acknowledgedBy`;
const ruleView = row => ({ ...row, enabled: Boolean(row.enabled), filters: JSON.parse(row.filters) });
const alertView = row => ({ ...row, filters: JSON.parse(row.filters) });

export function createFirewallMonitor({ db, audit, fail, str }) {
  const rules = db.prepare(`SELECT ${ruleColumns} FROM firewall_alert_rules ORDER BY name COLLATE NOCASE,id`);
  const rule = db.prepare(`SELECT ${ruleColumns} FROM firewall_alert_rules WHERE id=?`);
  const olderAlerts = db.prepare(`SELECT ${alertColumns} FROM firewall_alerts WHERE id<? ORDER BY id DESC LIMIT 101`);
  const visibleAlerts = db.prepare(`SELECT ${alertColumns} FROM firewall_alerts ORDER BY id DESC LIMIT 101`);
  const isSource = db.prepare('SELECT address,enabled,last_received_at AS lastReceivedAt FROM firewall_sources WHERE address=?');
  const saveRule = db.prepare(`INSERT INTO firewall_alert_rules
    (id,name,enabled,kind,window_minutes,threshold,cooldown_minutes,filters,updated_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,kind=excluded.kind,
      window_minutes=excluded.window_minutes,threshold=excluded.threshold,cooldown_minutes=excluded.cooldown_minutes,
      filters=excluded.filters,updated_at=excluded.updated_at`);
  const updateFired = db.prepare('UPDATE firewall_alert_rules SET last_notified_at=? WHERE id=?');
  const fire = db.prepare(`INSERT INTO firewall_alerts
    (rule_id,rule_name,kind,fired_at,observed,window_minutes,threshold,filters) VALUES (?,?,?,?,?,?,?,?)`);
  const readSummary = new Map();

  function overview(req, res) {
    const { sender } = trafficFilters({ sender: req.query.sender }, fail);
    if (sender && !isSource.get(sender)) fail(404, 'Firebox source not found.');
    const now = Date.now();
    const { hours, from, to } = timeWindow(req.query.hours, fail, now);
    const key = `${sender ?? '*'}:${hours}`;
    const cached = readSummary.get(key);
    if (cached && cached.expires > now) return res.json(cached.result);
    const { clauses, args } = trafficWhere({ sender }, from, to);
    const where = clauses.join(' AND ');
    const minutes = rangeBuckets.get(hours);
    const totals = db.prepare(`SELECT ${tallies}, ${bytes} AS bytes,
      COUNT(CASE WHEN sent_bytes IS NOT NULL OR received_bytes IS NOT NULL THEN 1 END) AS measured,
      COUNT(DISTINCT src_ip) AS uniqueSources,COUNT(DISTINCT dst_ip) AS uniqueDestinations
      FROM firewall_events WHERE ${where}`).get(...args);
    const samples = db.prepare(`SELECT (unixepoch(received_at)-unixepoch(?))/? AS bucket, ${tallies}
      FROM firewall_events WHERE ${where} GROUP BY bucket ORDER BY bucket`).all(from, minutes * 60, ...args);
    const buckets = Array.from({ length: hours * 60 / minutes }, (_, i) => ({
      start: new Date(Date.parse(from) + i * minutes * minute).toISOString(), total: 0, allowed: 0, denied: 0, unparsed: 0,
    }));
    for (const { bucket, ...counts } of samples) Object.assign(buckets[Math.min(bucket, buckets.length - 1)], counts);
    const top = Object.fromEntries(Object.entries({
      sources: 'src_ip', destinations: 'dst_ip', ports: 'dst_port',
      policies: 'policy', applications: 'application', hosts: 'host',
    }).map(([name, column]) => [name, db.prepare(`SELECT ${column} AS value, COUNT(*) AS count,
      COUNT(CASE WHEN action='deny' THEN 1 END) AS denied, ${bytes} AS bytes
      FROM firewall_events WHERE ${where} AND ${column} IS NOT NULL
      GROUP BY ${column} ORDER BY count DESC,value LIMIT 8`).all(...args)]));
    const result = { from, to, bucketMinutes: minutes, totals, buckets, top };
    readSummary.set(key, { result, expires: now + 12_000 });
    return res.json(result);
  }

  function validateRule(body) {
    const name = str(body.name, 'Rule name', { max: 100 });
    const { kind, enabled, windowMinutes, cooldownMinutes } = body;
    if (!['traffic', 'silence'].includes(kind)) fail(400, 'Choose traffic or silence.');
    if (typeof enabled !== 'boolean') fail(400, 'Enabled must be true or false.');
    if (!Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440 ||
        !Number.isInteger(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440)
      fail(400, 'Window and cooldown must be between 1 and 1440 minutes.');
    if (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters)) fail(400, 'Provide a filter object.');
    if (Object.keys(body.filters).some(key => key !== 'action' && !Object.hasOwn(fields, key))) fail(400, 'Unknown traffic filter.');
    const filters = trafficFilters(body.filters, fail);
    if (filters.sender && !isSource.get(filters.sender)) fail(400, 'Choose a registered Firebox.');
    if (kind === 'silence' && (!filters.sender || Object.keys(filters).length !== 1)) fail(400, 'Silence rules require a Firebox and no traffic filters.');
    const threshold = kind === 'silence' ? windowMinutes : body.threshold;
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50_000) fail(400, 'Event threshold must be between 1 and 50,000.');
    return { name, enabled, kind, windowMinutes, threshold, cooldownMinutes, filters };
  }

  function tick(now = new Date()) {
    const timestamp = now.toISOString();
    const time = now.getTime();
    transaction(db, () => {
      for (const item of rules.all().map(ruleView)) {
        if (!item.enabled || (item.lastNotifiedAt && time - Date.parse(item.lastNotifiedAt) < item.cooldownMinutes * minute)) continue;
        const source = item.filters.sender && isSource.get(item.filters.sender);
        if (item.filters.sender && !source?.enabled) continue;
        let observed;
        if (item.kind === 'silence') {
          observed = Math.floor((time - Math.max(Date.parse(item.updatedAt), Date.parse(source.lastReceivedAt) || 0)) / minute);
        } else {
          const from = new Date(Math.max(time - item.windowMinutes * minute, Date.parse(item.updatedAt))).toISOString();
          const { clauses, args } = trafficWhere(item.filters, from, timestamp);
          observed = db.prepare(`SELECT COUNT(*) AS count FROM firewall_events WHERE ${clauses.join(' AND ')}`).get(...args).count;
        }
        if (observed < item.threshold) continue;
        fire.run(item.id, item.name, item.kind, timestamp, observed, item.windowMinutes, item.threshold, JSON.stringify(item.filters));
        updateFired.run(timestamp, item.id);
      }
      db.prepare('DELETE FROM firewall_alerts WHERE fired_at < ?').run(new Date(time - 30 * day).toISOString());
      db.exec('DELETE FROM firewall_alerts WHERE id <= COALESCE((SELECT id FROM firewall_alerts ORDER BY id DESC LIMIT 1 OFFSET 1000),0)');
    });
  }

  function devices(req, res) {
    const { sender } = trafficFilters({ sender: req.query.sender }, fail);
    if (sender && !isSource.get(sender)) fail(404, 'Firebox source not found.');
    const { from, to } = timeWindow(req.query.hours, fail);
    const { scope = 'lan', sort = 'recent', query = '' } = req.query;
    if (!['all', 'lan'].includes(scope) || !['recent', 'events', 'denied', 'bytes'].includes(sort) ||
        typeof query !== 'string' || query.length > 100) fail(400, 'Invalid observed-device filters.');
    const { clauses, args } = trafficWhere({ sender }, from, to);
    clauses.push('src_ip IS NOT NULL');
    if (scope === 'lan') clauses.push(`(src_ip LIKE '10.%' OR src_ip LIKE '192.168.%'
      OR (src_ip LIKE '172.%' AND CAST(substr(src_ip,5) AS INTEGER) BETWEEN 16 AND 31)
      OR src_ip GLOB '[fF][cCdD][0-9a-fA-F][0-9a-fA-F]:*')`);
    const order = { recent: 'lastSeen DESC', events: 'total DESC', denied: 'denied DESC', bytes: 'bytes DESC' }[sort];
    const like = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
    const rows = db.prepare(`WITH observed AS (
      SELECT src_ip AS ip, MIN(received_at) AS firstSeen, MAX(received_at) AS lastSeen, ${tallies},
        ${bytes} AS bytes, COUNT(DISTINCT dst_ip) AS destinations
      FROM firewall_events WHERE ${clauses.join(' AND ')} GROUP BY src_ip
    ), known AS (
      SELECT item.value AS ip, CASE WHEN COUNT(DISTINCT endpoints.id)=1
        THEN MIN(COALESCE(NULLIF(endpoints.display_name,''),endpoints.hostname)) END AS endpointName
      FROM endpoints, json_each(endpoints.inventory,'$.ipv4') AS item
      WHERE endpoints.revoked=0 AND item.type='text' GROUP BY item.value
    )
    SELECT observed.*,known.endpointName FROM observed LEFT JOIN known ON observed.ip=known.ip
    WHERE observed.ip LIKE ? ESCAPE '\\' OR known.endpointName LIKE ? ESCAPE '\\'
    ORDER BY ${order},observed.ip LIMIT 101`).all(...args, like, like);
    const hasMore = rows.length > 100;
    if (hasMore) rows.pop();
    res.json({ devices: rows, hasMore });
  }

  function mount(router) {
    const adminOnly = req => { if (req.operator.role !== 'admin') fail(403, 'Administrator access required.'); };
    router.get('/firewall/overview', overview);
    router.get('/firewall/devices', devices);
    router.get('/firewall/alerts', (req, res) => {
      const { before } = req.query;
      if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,14}$/.test(before))) fail(400, 'Invalid alert cursor.');
      const page = before === undefined ? visibleAlerts.all() : olderAlerts.all(Number(before));
      const nextBefore = page.length > 100 ? page[99].id : null;
      if (nextBefore !== null) page.pop();
      res.json({
        rules: rules.all().map(ruleView),
        alerts: page.map(alertView), nextBefore,
        open: db.prepare('SELECT COUNT(*) AS count FROM firewall_alerts WHERE acknowledged_at IS NULL').get().count,
      });
    });
    function save(req, res) {
      adminOnly(req);
      const draft = validateRule(req.body);
      const id = req.params.id ?? randomUUID();
      transaction(db, () => {
        if (req.params.id && !rule.get(id)) fail(404, 'Alert rule not found.');
        if (!req.params.id && rules.all().length >= 32) fail(409, 'The firewall alert rule limit has been reached.');
        saveRule.run(id, draft.name, Number(draft.enabled), draft.kind, draft.windowMinutes, draft.threshold,
          draft.cooldownMinutes, JSON.stringify(draft.filters), new Date().toISOString());
        audit(req.operator.username, 'firewall.alert_rule.saved', id, { name: draft.name, enabled: draft.enabled });
      });
      res.status(req.params.id ? 200 : 201).json(ruleView(rule.get(id)));
    }
    router.post('/firewall/alert-rules', save);
    router.put('/firewall/alert-rules/:id', save);
    router.post('/firewall/alerts/:id/acknowledge', (req, res) => {
      const id = Number(req.params.id);
      if (!/^\d{1,15}$/.test(req.params.id)) fail(400, 'Invalid alert ID.');
      transaction(db, () => {
        const row = db.prepare('SELECT acknowledged_at FROM firewall_alerts WHERE id=?').get(id);
        if (!row) fail(404, 'Alert not found.');
        if (row.acknowledged_at) return;
        db.prepare('UPDATE firewall_alerts SET acknowledged_at=?,acknowledged_by=? WHERE id=?')
          .run(new Date().toISOString(), req.operator.username, id);
        audit(req.operator.username, 'firewall.alert.acknowledged', String(id));
      });
      res.status(204).end();
    });
  }
  return { mount, tick };
}
