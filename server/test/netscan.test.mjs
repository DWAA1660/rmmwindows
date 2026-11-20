import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { parseTarget, parseTargets, parsePorts, scanConfig, scanScript, emptyResult, applyLine, evaluate } from '../src/netscan.mjs';
import { listen } from './listen.mjs';

test('targets accept whole subnets, ranges and single IPs with clear limits', () => {
  assert.deepEqual(parseTarget('10.1.2.0/24'), { input: '10.1.2.0/24', kind: 'subnet', start: 0x0a010201, end: 0x0a0102fe, count: 254 });
  assert.equal(parseTarget('10.1.2.77/24').count, 254, 'host bits are ignored, the whole subnet is scanned');
  assert.equal(parseTarget('10.1.2.8/31').count, 2);
  assert.equal(parseTarget('10.1.2.8/32').count, 1);
  assert.equal(parseTarget('10.0.0.10-10.0.0.50').count, 41);
  assert.equal(parseTarget('10.0.0.10-50').count, 41, 'short ranges keep the first three octets');
  assert.equal(parseTarget('10.0.0.255-10.0.1.3').count, 5, 'ranges may cross octets');
  assert.deepEqual(parseTarget(' 192.168.1.40 '), { input: '192.168.1.40', kind: 'ip', start: 0xc0a80128, end: 0xc0a80128, count: 1 });
  for (const bad of ['10.0.0.0/16', '127.0.0.1', '224.0.0.1', '0.1.2.3', '10.0.0.256', '10.0.0.50-10', '10.0.0.1-300', 'printer', '10.0.0.1/33', '01.2.3.4'])
    assert.throws(() => parseTarget(bad), undefined, bad);
  const merged = parseTargets(['10.0.0.0/24', '10.0.0.5', '10.0.0.200-10.0.1.10']);
  assert.deepEqual(merged.ranges, [[0x0a000001, 0x0a00010a]]);
  assert.equal(merged.addresses, 266);
  assert.throws(() => parseTargets(['10.0.0.0/20', '10.1.0.0/24']), /limit is 4,096/);
});

test('ports accept numbers and ranges; scan config enforces probe limits', () => {
  assert.deepEqual(parsePorts('443, 80 22;8000-8002'), [22, 80, 443, 8000, 8001, 8002]);
  assert.deepEqual(parsePorts([9100, '515', 9100]), [515, 9100]);
  assert.throws(() => parsePorts('0'));
  assert.throws(() => parsePorts('1-2000'), /at most 1024/);
  assert.throws(() => parsePorts('80;rm -rf'));
  assert.throws(() => scanConfig({ targets: ['10.0.0.0/20'], ports: parsePorts('1-40') }), /probes/);
  assert.throws(() => scanConfig({ targets: ['10.0.0.1'], ports: [], ping: false }), /at least one port/);
  assert.throws(() => scanConfig({ targets: ['10.0.0.1'], ports: [], expect: 'reachable' }), /needs at least one port/);
  assert.throws(() => scanConfig({ targets: ['10.0.0.1'], ports: [80], speed: 'ludicrous' }));
  const config = scanConfig({ targets: ['10.0.0.40'], ports: [9100], expect: 'reachable' });
  const script = scanScript(config);
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64')), { v: 1, ranges: [{ s: 0x0a000028, e: 0x0a000028 }], ports: [9100], timeoutMs: 800, concurrency: 256, ping: true, resolveNames: true, onlyResponsive: false });
});

test('scanner output folds into hosts and a reachable/blocked verdict', () => {
  const result = emptyResult();
  const lines = [
    'noise that is not a record',
    'RMMSCAN {"t":"start","computer":"PC1","addresses":3,"ports":2,"interfaces":{"name":"Ethernet","ip":"10.0.0.5","prefix":24,"gateways":"10.0.0.1","mac":"AA"}}',
    'RMMSCAN {"t":"host","ip":"10.0.0.40","rtt":1,"ttl":64,"open":9100,"closed":[515],"closedCount":1,"filtered":0}',
    'RMMSCAN {"t":"arp","items":[{"ip":"10.0.0.40","mac":"00-11-22-33-44-55"},{"ip":"10.0.0.41","mac":"00-11-22-33-44-66"}]}',
    'RMMSCAN {"t":"names","items":{"ip":"10.0.0.40","name":"printer.library.local"}}',
    'RMMSCAN {broken',
    'RMMSCAN {"t":"end","elapsedMs":900,"up":2,"open":1}',
  ];
  for (const line of lines) applyLine(result, line);
  assert.equal(result.started.computer, 'PC1');
  assert.deepEqual(result.interfaces[0].gateways, ['10.0.0.1'], 'PowerShell single-item arrays are normalized');
  const printer = result.hosts.get('10.0.0.40');
  assert.deepEqual(printer.open, [9100]); assert.equal(printer.name, 'printer.library.local'); assert.equal(printer.mac, '00-11-22-33-44-55'); assert.equal(printer.arpOnly, false);
  assert.equal(result.hosts.get('10.0.0.41').arpOnly, true);
  const reach = evaluate(scanConfig({ targets: ['10.0.0.40-41'], ports: [9100, 515], expect: 'reachable' }), result, true);
  assert.equal(reach.checked, 4); assert.equal(reach.failed, 3); assert.equal(reach.verdict, 'fail');
  assert.deepEqual(reach.failures[0], { ip: '10.0.0.40', port: 515 });
  const block = evaluate(scanConfig({ targets: ['10.0.0.41'], ports: [445], expect: 'blocked' }), result, true);
  assert.equal(block.verdict, 'pass');
  assert.equal(evaluate(scanConfig({ targets: ['10.0.0.41'], ports: [445], expect: 'blocked' }), result, false).verdict, 'pending');
});

async function fixture(t) {
  const password = 'synthetic-netscan-password';
  const service = createApp({ databasePath: ':memory:', env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password } });
  const server = await listen(service.app); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); });
  const request = async (path, method = 'GET', body, auth = {}) => {
    const response = await fetch(origin + '/api' + path, { method, signal: AbortSignal.timeout(10000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const login = async (username, supplied) => {
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: supplied }) });
    const data = await response.json(); assert.equal(response.status, 200);
    return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': data.csrfToken };
  };
  const admin = await login('admin', password);
  const token = await request('/enrollment-tokens', 'POST', { label: 'netscan test', maxUses: 2, expiresInHours: 1 }, admin);
  const enroll = async name => {
    const enrolled = await request('/agent/enroll', 'POST', { enrollmentToken: token.data.token, hostname: name, deviceId: `netscan-${name}` });
    assert.equal(enrolled.status, 201);
    return { id: enrolled.data.endpointId, auth: { Authorization: `Bearer ${enrolled.data.agentToken}` } };
  };
  return { ...service, request, login, admin, password, staff: await enroll('STAFF-PC'), patron: await enroll('PATRON-PC') };
}

test('scans queue one fixed job per computer, report live results and enforce roles', async t => {
  const f = await fixture(t);
  const body = { endpointIds: [f.staff.id, f.patron.id], targets: ['10.0.0.40'], ports: [9100], expect: 'reachable', name: 'Everyone can print', idempotencyKey: 'scan-1' };
  const created = await f.request('/netscans', 'POST', body, f.admin);
  assert.equal(created.status, 201);
  assert.equal(created.data.sources.length, 2); assert.equal(created.data.status, 'queued'); assert.equal(created.data.verdict, 'pending');
  const again = await f.request('/netscans', 'POST', body, f.admin);
  assert.equal(again.status, 200); assert.equal(again.data.id, created.data.id, 'an uncertain retry returns the same scan');
  assert.equal((await f.request('/netscans', 'POST', { ...body, ports: [80] }, f.admin)).status, 409, 'a reused key for different work is refused');
  assert.equal((await f.request('/netscans', 'POST', { ...body, targets: ['10.0.0.0/16'], idempotencyKey: 'scan-2' }, f.admin)).status, 400);
  assert.equal(f.db.prepare("SELECT count(*) n FROM jobs WHERE kind='powershell'").get().n, 2);

  // Each staff computer's agent claims, starts and reports like any job.
  const run = async (endpoint, lines) => {
    const claim = await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth);
    assert.match(claim.data.job.payload.script, /Library RMM network scan/);
    assert.equal(claim.data.job.timeoutSeconds, 300);
    assert.equal((await f.request(`/agent/jobs/${claim.data.job.id}/start`, 'POST', { dispatchToken: claim.data.job.dispatchToken }, endpoint.auth)).data.mayExecute, true);
    // Output arrives split mid-line across chunks; the parser must join them.
    const text = lines.join('\n') + '\n';
    const cut = Math.floor(text.length / 2);
    for (const [sequence, piece] of [text.slice(0, cut), text.slice(cut)].entries())
      assert.equal((await f.request(`/agent/jobs/${claim.data.job.id}/output/${sequence}`, 'PUT', { stream: 'stdout', text: piece }, endpoint.auth)).status, 200);
    return claim.data.job.id;
  };
  const staffJob = await run(f.staff, ['RMMSCAN {"t":"start","computer":"STAFF-PC","addresses":1,"ports":1,"interfaces":[]}', 'RMMSCAN {"t":"host","ip":"10.0.0.40","rtt":2,"ttl":64,"open":[9100],"closed":[],"closedCount":0,"filtered":0}', 'RMMSCAN {"t":"end","elapsedMs":800,"up":1,"open":1}']);
  const live = await f.request(`/netscans/${created.data.id}`, 'GET', undefined, f.admin);
  const staffSource = live.data.sources.find(s => s.endpointId === f.staff.id);
  assert.equal(staffSource.hostsUp, 1); assert.equal(staffSource.test.verdict, 'pending', 'no verdict until the job finishes');
  await f.request(`/agent/jobs/${staffJob}/complete`, 'POST', { status: 'succeeded', exitCode: 0, summary: 'done' }, f.staff.auth);
  const patronJob = await run(f.patron, ['RMMSCAN {"t":"start","computer":"PATRON-PC","addresses":1,"ports":1,"interfaces":[]}', 'RMMSCAN {"t":"end","elapsedMs":800,"up":0,"open":0}']);
  await f.request(`/agent/jobs/${patronJob}/complete`, 'POST', { status: 'succeeded', exitCode: 0, summary: 'done' }, f.patron.auth);
  const done = await f.request(`/netscans/${created.data.id}`, 'GET', undefined, f.admin);
  assert.equal(done.data.status, 'finished');
  assert.equal(done.data.verdict, 'fail');
  assert.equal(done.data.sources.find(s => s.endpointId === f.staff.id).test.verdict, 'pass');
  assert.deepEqual(done.data.sources.find(s => s.endpointId === f.patron.id).test.failures, [{ ip: '10.0.0.40', port: 9100 }]);
  const list = await f.request('/netscans', 'GET', undefined, f.admin);
  assert.equal(list.data[0].id, created.data.id); assert.equal(list.data[0].sources[0].hosts, undefined, 'the list is a summary');
  assert.ok(f.db.prepare("SELECT id FROM audit WHERE action='netscan.created'").get());

  assert.equal((await f.request('/users', 'POST', { username: 'scan-viewer', role: 'viewer', password: 'synthetic-viewer-password', currentPassword: f.password }, f.admin)).status, 201);
  const viewer = await f.login('scan-viewer', 'synthetic-viewer-password');
  assert.equal((await f.request(`/netscans/${created.data.id}`, 'GET', undefined, viewer)).status, 200, 'viewers can read results');
  assert.equal((await f.request('/netscans', 'POST', { ...body, idempotencyKey: 'viewer' }, viewer)).status, 403, 'viewers cannot start scans');
  assert.equal((await f.request('/netscan/presets', 'POST', { kind: 'ports', name: 'x', ports: [80] }, viewer)).status, 403);
  assert.equal((await f.request('/netscans', 'GET')).status, 401);
});

test('saved target lists, port lists and tests are validated and unique', async t => {
  const f = await fixture(t);
  const targets = await f.request('/netscan/presets', 'POST', { kind: 'targets', name: 'Branch printers', targets: ['10.0.0.40', '10.0.1.0/28', '10.0.2.10-20'] }, f.admin);
  assert.equal(targets.status, 201); assert.deepEqual(targets.data.targets, ['10.0.0.40', '10.0.1.0/28', '10.0.2.10-20']);
  assert.equal((await f.request('/netscan/presets', 'POST', { kind: 'targets', name: 'branch PRINTERS', targets: ['10.0.0.41'] }, f.admin)).status, 409);
  assert.equal((await f.request('/netscan/presets', 'POST', { kind: 'targets', name: 'Bad', targets: ['10.0.0.0/8'] }, f.admin)).status, 400);
  const ports = await f.request('/netscan/presets', 'POST', { kind: 'ports', name: 'Printing', ports: '9100, 515, 631' }, f.admin);
  assert.deepEqual(ports.data.ports, [515, 631, 9100]);
  const testPreset = await f.request('/netscan/presets', 'POST', { kind: 'test', name: 'Patrons cannot reach SMB', targets: ['10.0.5.0/24'], ports: [445, 139], expect: 'blocked', endpointIds: [f.patron.id] }, f.admin);
  assert.equal(testPreset.status, 201);
  assert.equal(testPreset.data.expect, 'blocked'); assert.deepEqual(testPreset.data.endpointIds, [f.patron.id]); assert.equal(testPreset.data.speed, 'normal');
  const renamed = await f.request(`/netscan/presets/${testPreset.data.id}`, 'PUT', { name: 'Patron VLAN isolation', targets: ['10.0.5.0/24'], ports: [445], expect: 'blocked' }, f.admin);
  assert.equal(renamed.status, 200); assert.deepEqual(renamed.data.ports, [445]);
  const scan = await f.request('/netscans', 'POST', { endpointIds: [f.patron.id], testId: testPreset.data.id, targets: renamed.data.targets, ports: renamed.data.ports, expect: 'blocked', idempotencyKey: 'from-test' }, f.admin);
  assert.equal(scan.status, 201); assert.equal(scan.data.testId, testPreset.data.id);
  const all = await f.request('/netscan/presets', 'GET', undefined, f.admin);
  assert.deepEqual(all.data.map(p => p.kind).sort(), ['ports', 'targets', 'test']);
  assert.equal((await f.request(`/netscan/presets/${ports.data.id}`, 'DELETE', undefined, f.admin)).status, 200);
  assert.equal((await f.request('/netscan/validate', 'POST', { targets: ['10.0.0.0/24'], ports: [80, 443] }, f.admin)).data.probes, 508);
});
