import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { parseTraffic } from '../src/firewall-parser.mjs';
import { listen } from './listen.mjs';

const nativeDns = '<142>Nov 24 10:00:00 Edge example (2026-11-24T17:00:00) firewall: msg_id="3000-0151" Allow Guest External udp 192.168.99.50 198.51.100.70 24600 53 duration="43 seconds" sent_bytes="60" rcvd_bytes="106" src_ip="192.168.99.50" dst_ip="198.51.100.70" src_ip_nat="203.0.113.100" src_port_nat="11111" src_port="24600" dst_port="53" (DNS-00)';
const nativeHttps = '<142>Nov 24 10:00:00 Edge example (2026-11-24T17:00:00) https-proxy[1234]: msg_id="2CFF-0000" Allow Public External tcp 192.168.99.50 198.51.100.72 25511 443 msg="HTTPS Request" sni="cdn.example.test" action="allow" app_name="SSL/TLS" sent_bytes="1959" rcvd_bytes="5157" src_ip="192.168.99.50" dst_ip="198.51.100.72" src_port="25511" dst_port="443" (HTTPS-proxy-00)';

test('native Firebox DNS and HTTPS proxy logs expose policy, application, SNI and reported bytes', () => {
  assert.deepEqual(parseTraffic(nativeDns), {
    action: 'allow', srcIp: '192.168.99.50', dstIp: '198.51.100.70', protocol: 'udp',
    srcPort: 24600, dstPort: 53, policy: 'DNS-00', application: null, host: null, sentBytes: 60, receivedBytes: 106, messageId: '3000-0151',
  });
  assert.deepEqual(parseTraffic(nativeHttps), {
    action: 'allow', srcIp: '192.168.99.50', dstIp: '198.51.100.72', protocol: 'tcp',
    srcPort: 25511, dstPort: 443, policy: 'HTTPS-proxy-00', application: 'SSL/TLS', host: 'cdn.example.test',
    sentBytes: 1959, receivedBytes: 5157, messageId: '2CFF-0000',
  });
  const packetFilter = parseTraffic('<140>Edge firewall: msg_id="3000-0148" Deny External Firebox 40 tcp 20 192.0.2.7 198.51.100.8 48887 993 offset 5 S (Unhandled External Packet-00)');
  assert.deepEqual([packetFilter.action, packetFilter.srcIp, packetFilter.dstPort], ['deny', '192.0.2.7', 993]);
  const icmp = parseTraffic('<142>Edge Allow 192.0.2.1 198.51.100.1 echo-request/icmp 84 64 (Ping)');
  assert.equal(icmp.srcPort, null);
  assert.equal(icmp.dstPort, null);
  assert.equal(parseTraffic('<142>firewall msg="Allow 192.0.2.1 198.51.100.1 https/tcp is only text"'), null);
});

test('Firebox traffic flows from a registered UDP sender to authorized, paginated dashboard queries', async t => {
  const probe = createSocket('udp4');
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(0, '127.0.0.1', resolve); });
  const udpPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const password = 'isolated-firewall-password';
  const service = createApp({ databasePath: ':memory:', env: {
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password, FIREWALL_SYSLOG_PORT: String(udpPort), FIREWALL_HTTPS_RELAY: 'true'
  } });
  const server = await listen(service.app);
  const client = createSocket('udp4');
  t.after(async () => {
    client.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    service.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const req = async (path, session, method = 'GET', body) => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: {
        Origin: origin, 'Content-Type': 'application/json',
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrf ?? '' } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async username => {
    const result = await req('/auth/login', null, 'POST', { username, password });
    assert.equal(result.status, 200);
    return { cookie: result.cookie, csrf: result.data.csrfToken };
  };
  const admin = await login('admin');
  for (const role of ['operator', 'viewer']) {
    assert.equal((await req('/users', admin, 'POST', { username: role, role, password, currentPassword: password })).status, 201);
  }
  const operator = await login('operator');
  const viewer = await login('viewer');
  const source = '/firewall/sources/127.0.0.1';
  const definition = { name: 'West branch', enabled: true };
  assert.equal((await req('/firewall/events')).status, 401);
  assert.equal((await req('/FireWall/events/', viewer)).status, 403);
  assert.equal((await req(source, operator, 'PUT', definition)).status, 403);
  assert.equal((await req(source, { cookie: admin.cookie }, 'PUT', definition)).status, 403);
  assert.equal((await req('/firewall/sources/0.0.0.0', admin, 'PUT', definition)).status, 400);

  service.startFirewall();
  const status = async () => (await req('/firewall', operator)).data;
  const waitFor = async predicate => {
    for (let attempts = 0; attempts < 40; attempts++) {
      const snapshot = await status();
      if (predicate(snapshot)) return snapshot;
      await delay(50);
    }
    assert.fail('Waited for collector status: ' + JSON.stringify(await status()));
  };
  await waitFor(snapshot => snapshot.receiver === 'listening');
  const send = message => new Promise((resolve, reject) => {
    client.send(Buffer.from(message), udpPort, '127.0.0.1', error => error ? reject(error) : resolve());
  });
  const allow = '<142>Nov 24 10:02:10 branch Allow 192.0.2.20 198.51.100.9 https/tcp 42973 443 Trusted External Allowed 60 63 (Web_Allow) proc_id="firewall" msg_id="3000-0148"';
  const deny = '<140>Deny Trusted External 52 udp 20 127 192.0.2.30|staff 198.51.100.8 62443 53 (DNS Block)';
  const icmp = '<140>Deny 2001:db8::1 2001:db8::2 echo-request/icmpv6 Trusted Firebox Denied (Ping)';
  const unknown = '<142>Firebox format that the current parser does not recognize\n';
  await send(allow);
  await waitFor(snapshot => snapshot.rejected === 1);
  assert.equal((await req(source, admin, 'PUT', definition)).status, 200);
  await send(allow.replace('<142>', '<150>'));
  await send('x'.repeat(8193));
  for (let index = 0; index < 51; index++) await send(allow);
  await send(deny);
  await send(icmp);
  await send(unknown);

  await waitFor(snapshot => snapshot.sources[0].lastReceivedAt && snapshot.rejected === 3 &&
    service.db.prepare('SELECT count(*) AS n FROM firewall_events').get().n === 54);
  const events = async (qs = '') => (await req(`/firewall/events${qs}`, operator)).data;
  const first = await events();
  assert.equal(first.events.length, 50);
  assert.equal(first.events[0].raw, unknown);
  assert.equal(first.events[0].action, null);
  assert.deepEqual([first.events[1].srcIp, first.events[1].dstIp, first.events[1].dstPort],
    ['2001:db8::1', '2001:db8::2', null]);
  assert.deepEqual([first.events[2].action, first.events[2].srcIp, first.events[2].dstPort, first.events[2].policy],
    ['deny', '192.0.2.30', 53, 'DNS Block']);
  assert.deepEqual([first.events[3].action, first.events[3].srcPort, first.events[3].protocol, first.events[3].policy],
    ['allow', 42973, 'tcp', 'Web_Allow']);
  const older = await events(`?before=${first.nextBefore}`);
  assert.equal(older.events.length, 4);
  assert.ok(older.events.every(event => event.id < first.nextBefore));
  assert.equal((await events('?sender=127.0.0.1&action=deny&query=DNS')).events.length, 1);
  assert.equal((await events('?query=%25')).events.length, 0);
  assert.equal((await events('?query=Web_Allow')).events.length, 50);
  assert.equal((await req('/firewall/events?before=0', admin)).status, 400);

  service.db.prepare('UPDATE firewall_events SET received_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', first.events[0].id);
  assert.equal((await events('?action=unparsed')).events.length, 0);
  assert.equal((await req(source, admin, 'PUT', { ...definition, enabled: false })).status, 200);
  await send(deny);
  await waitFor(snapshot => snapshot.rejected === 4);
  assert.equal((await events('?action=deny')).events.length, 2);
  assert.equal(service.db.prepare("SELECT count(*) AS n FROM audit WHERE action='firewall.source.saved'").get().n, 2);

  const relayAddress = '192.0.2.1';
  const relaySource = `/firewall/sources/${relayAddress}`;
  const keyPath = relaySource + '/relay-key';
  assert.equal((await req(relaySource, admin, 'PUT', { name: 'Relay Test', enabled: true })).status, 200);
  assert.equal((await req(keyPath, operator, 'POST', {})).status, 403);
  assert.equal((await req(keyPath, { cookie: admin.cookie }, 'POST', {})).status, 403);
  const { data: { key } } = await req(keyPath, admin, 'POST', {});
  assert.match(key, /^[\w-]{43}$/);
  const sendRelay = async (relayKey, batch, address = relayAddress) => {
    const response = await fetch(`${origin}/api/firewall/relay/${address}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relayKey}` },
      body: JSON.stringify({ events: batch })
    });
    return { status: response.status, body: await response.json() };
  };
  const batch = [{ id: randomUUID(), raw: deny }, { id: randomUUID(), raw: '<150>Non-traffic' }];
  assert.equal((await sendRelay('invalid', batch)).status, 401);
  assert.equal((await sendRelay(key, batch, '127.0.0.1')).status, 401);
  assert.equal((await sendRelay(key, [{ id: 'invalid', raw: allow }])).status, 400);
  assert.deepEqual((await sendRelay(key, batch)).body, { acknowledged: 2, stored: 1, ignored: 1 });
  assert.deepEqual((await sendRelay(key, batch)).body, { acknowledged: 2, stored: 0, ignored: 1 });
  assert.equal((await events(`?sender=${relayAddress}`)).events[0].raw, deny);
  const snapshot = await status();
  assert.equal(snapshot.relayEnabled, true);
  assert.equal(snapshot.sources.find(item => item.address === relayAddress).hasRelayKey, true);
  assert.ok(!JSON.stringify(snapshot).includes(key));
  assert.ok(!JSON.stringify(service.db.prepare('SELECT * FROM audit').all()).includes(key));
  assert.equal((await req(relaySource, admin, 'PUT', { name: 'Relay Test', enabled: false })).status, 200);
  assert.deepEqual((await sendRelay(key, batch)).body, { acknowledged: 2, stored: 0, ignored: 2 });
  const { data: { key: replacement } } = await req(keyPath, admin, 'POST', {});
  assert.equal((await sendRelay(key, batch)).status, 401);
  const revoked = await fetch(`${origin}/api${keyPath}`, {
    method: 'DELETE', headers: { Origin: origin, Cookie: admin.cookie, 'X-CSRF-Token': admin.csrf }
  });
  assert.equal(revoked.status, 204);
  assert.equal((await sendRelay(replacement, batch)).status, 401);

  // Schema 14 history remains intact while newly supported records acquire fields.
  const receivedAt = new Date().toISOString();
  const old = service.db.prepare('INSERT INTO firewall_events(sender,received_at,raw) VALUES (?,?,?)').run(relayAddress, receivedAt, nativeDns);
  service.db.prepare('INSERT INTO firewall_events(sender,received_at,raw) VALUES (?,?,?)').run(relayAddress, receivedAt, nativeHttps);
  assert.equal(service.reparseFirewallHistory(), true);
  assert.equal(service.reparseFirewallHistory(), false);
  const retained = service.db.prepare('SELECT raw,received_at,action,dst_port FROM firewall_events WHERE id=?').get(old.lastInsertRowid);
  assert.deepEqual(Object.values(retained), [nativeDns, receivedAt, 'allow', 53]);
  assert.equal((await req('/firewall/overview', viewer)).status, 403);
  const { data: stats } = await req(`/firewall/overview?hours=1&sender=${relayAddress}`, operator);
  assert.equal(stats.totals.allowed, 2);
  assert.equal(stats.totals.measured, 2);
  assert.equal(stats.totals.bytes, 7282);
  assert.equal(stats.buckets.reduce((sum, row) => sum + row.total, 0), stats.totals.total);
  assert.equal(stats.top.hosts[0].value, 'cdn.example.test');
  assert.deepEqual((await events('?hours=1&dstPort=443&application=ssl%2Ftls')).events.map(row => row.host), ['cdn.example.test']);
  assert.equal((await events('?query=19331&searchRaw=true')).events.length, 0);
  assert.equal((await events('?query=11111&searchRaw=true')).events.length, 1);
  const { data: observed } = await req('/firewall/devices?hours=1&scope=lan&sort=bytes', operator);
  assert.deepEqual(observed.devices.map(device => [device.ip, device.destinations]), [['192.168.99.50', 2]]);
  const exported = await fetch(`${origin}/api/firewall/events.csv?hours=1&host=cdn.example.test`, { headers: { Cookie: operator.cookie } });
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.equal(csv.split('\r\n').length, 3);
  assert.match(csv, /cdn\.example\.test/);
  assert.ok(!csv.includes('proxy_act'));

  const ruleBody = { name: 'DNS volume test', kind: 'traffic', enabled: true, threshold: 2,
    windowMinutes: 5, cooldownMinutes: 30, filters: { sender: relayAddress, action: 'allow', dstPort: 53 } };
  assert.equal((await req('/firewall/alert-rules', operator, 'POST', ruleBody)).status, 403);
  assert.equal((await req('/firewall/alert-rules', admin, 'POST', { ...ruleBody, filters: { unknown: true } })).status, 400);
  const createdRule = await req('/firewall/alert-rules', admin, 'POST', ruleBody);
  assert.equal(createdRule.status, 201);
  const quietAddress = '192.0.2.2';
  assert.equal((await req(`/firewall/sources/${quietAddress}`, admin, 'PUT', { name: 'Quiet test', enabled: true })).status, 200);
  assert.equal((await req('/firewall/alert-rules', admin, 'POST', {
    ...ruleBody, name: 'Firebox quiet', kind: 'silence', windowMinutes: 1, filters: { sender: quietAddress },
  })).status, 201);
  assert.equal((await req(relaySource, admin, 'PUT', { name: 'Relay Test', enabled: true })).status, 200);
  const { data: { key: finalKey } } = await req(keyPath, admin, 'POST', {});
  await delay(10);
  const report = [{ id: randomUUID(), raw: nativeDns }, { id: randomUUID(), raw: nativeDns }];
  assert.equal((await sendRelay(finalKey, report)).body.stored, 2);
  service.tickFirewall(new Date(Date.now() + 65_000));
  const { data: inbox } = await req('/firewall/alerts', operator);
  assert.equal(inbox.open, 2);
  const thresholdAlert = inbox.alerts.find(alert => alert.ruleId === createdRule.data.id);
  assert.equal(thresholdAlert.observed, 2, 'historical rows before rule creation are excluded');
  assert.equal(inbox.alerts.find(alert => alert.kind === 'silence').observed, 1);
  service.tickFirewall(new Date(Date.now() + 125_000));
  assert.equal((await req('/firewall/alerts', operator)).data.open, 2);
  const ackPath = `/firewall/alerts/${thresholdAlert.id}/acknowledge`;
  assert.equal((await req(ackPath, viewer, 'POST', {})).status, 403);
  assert.equal((await fetch(origin + '/api' + ackPath, { method: 'POST', headers: {
    Cookie: operator.cookie, Origin: origin, 'X-CSRF-Token': operator.csrf, 'Content-Type': 'application/json',
  }, body: '{}' })).status, 204);
  assert.equal((await req('/firewall/alerts', operator)).data.open, 1);
});
