import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';

test('Firebox traffic flows from a registered UDP sender to authorized, paginated dashboard queries', async t => {
  const probe = createSocket('udp4');
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.bind(0, '127.0.0.1', resolve); });
  const udpPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const password = 'isolated-firewall-password';
  const service = createApp({ databasePath: ':memory:', env: {
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password, FIREWALL_SYSLOG_PORT: String(udpPort)
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
});
