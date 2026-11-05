import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';

// Synthetic HTTP inventory tests only: no Windows collection, LDAP, real agent,
// production endpoint, shell job, or VM is involved.
async function fixture(t) {
  const password = 'synthetic-inventory-test-password';
  const service = createApp({ databasePath: ':memory:', env: { ADMIN_USERNAME: 'inventory-test', ADMIN_PASSWORD: password } });
  const server = await listen(service.app);
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let csrf = '';
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); });
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(base + '/api' + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { Origin: base, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  const login = await request('/auth/login', { method: 'POST', body: { username: 'inventory-test', password } });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrfToken;
  const enrollment = await request('/enrollment-tokens', { method: 'POST', body: { label: 'Synthetic inventory', maxUses: 1, expiresInHours: 1 } });
  assert.equal(enrollment.status, 201);
  const endpoint = await request('/agent/enroll', { method: 'POST', body: { enrollmentToken: enrollment.data.token, deviceId: 'synthetic-inventory-device', hostname: 'SYNTHETIC-PC' } });
  assert.equal(endpoint.status, 201);
  const checkin = inventory => request('/agent/checkin', { method: 'POST', token: endpoint.data.agentToken, body: { bootId: 'synthetic-boot', ...(inventory === undefined ? {} : { inventory }) } });
  const read = async () => {
    const response = await request(`/endpoints/${endpoint.data.endpointId}`);
    assert.equal(response.status, 200); return response.data.inventory;
  };
  return { checkin, read };
}

test('extended endpoint inventory survives HTTP roundtrip with bounded known nested fields only', async t => {
  const f = await fixture(t);
  const directory = {
    distinguishedName: 'CN=SYNTHETIC-PC,OU=Workstations,OU=Research\\, Staff,DC=library,DC=example',
    canonicalName: 'library.example/Research, Staff/Workstations/SYNTHETIC-PC',
    organizationalUnits: ['Research, Staff', 'Workstations'],
    domainController: 'dc01.library.example', site: 'Main-Library', error: null
  };
  const hardware = { manufacturer: 'Example Manufacturer', model: 'Desktop Model', serialNumber: 'TEST-SERIAL', biosVersion: '1.2.3' };
  const adapter = { name: 'Ethernet', mac: '00-11-22-33-44-55', ipv4: ['192.0.2.5'], gateways: ['192.0.2.1'], dnsServers: ['192.0.2.2', '2001:db8::53'], dhcpEnabled: false };
  const accepted = await f.checkin({
    hostname: 'SYNTHETIC-PC', domain: 'library.example', domainJoined: true,
    directory: { ...directory, ignored: { arbitrary: 'not retained' } },
    hardware: { ...hardware, ignored: { arbitrary: true } },
    networkAdapters: [{ ...adapter, ignored: ['not retained'] }],
    pendingReboot: true, pendingRebootReasons: ['Windows Update', 'Component Based Servicing'],
    uptimeSeconds: 1234.5, inventoryCollectedAt: '2026-11-04T21:00:00.1234567+00:00',
    unknownDiagnostics: { arbitrary: 'not retained' }
  });
  assert.equal(accepted.status, 200);
  const inventory = await f.read();
  assert.deepEqual(inventory.directory, directory);
  assert.deepEqual(inventory.hardware, hardware);
  assert.deepEqual(inventory.networkAdapters, [adapter]);
  assert.equal(inventory.pendingReboot, true);
  assert.deepEqual(inventory.pendingRebootReasons, ['Windows Update', 'Component Based Servicing']);
  assert.equal(inventory.uptimeSeconds, 1234.5);
  assert.equal(inventory.inventoryCollectedAt, '2026-11-04T21:00:00.123Z');
  assert.equal('unknownDiagnostics' in inventory, false);
  assert.equal((await f.checkin()).status, 200);
  assert.deepEqual(await f.read(), inventory, 'heartbeat without inventory preserves the complete last snapshot');
});

test('older agents and unavailable diagnostics remain compatible without inventing domain or reboot state', async t => {
  const f = await fixture(t);
  const legacy = { hostname: 'SYNTHETIC-PC', osName: 'Synthetic Windows', domain: 'WORKGROUP', domainJoined: false, cpuPercent: 12.5, memoryTotalBytes: 1024, memoryUsedBytes: 0, ipv4: ['192.0.2.5'], disks: [{ name: 'C:', label: 'System', totalBytes: 1000, freeBytes: 1000 }], software: [{ name: 'Reader', version: '1.0' }] };
  assert.equal((await f.checkin(legacy)).status, 200);
  const expectedUnknown = { directory: null, hardware: null, networkAdapters: [], pendingReboot: null, pendingRebootReasons: [], uptimeSeconds: null, inventoryCollectedAt: null };
  const first = await f.read();
  for (const [field, value] of Object.entries(expectedUnknown)) assert.deepEqual(first[field], value, field);
  assert.equal(first.domainJoined, false); assert.equal(first.memoryUsedBytes, 0); assert.equal(first.cpuPercent, 12.5);
  assert.deepEqual(first.disks, legacy.disks);
  assert.equal((await f.checkin({ ...legacy, ...Object.fromEntries(Object.keys(expectedUnknown).map(field => [field, null])) })).status, 200);
  assert.deepEqual(await f.read(), first);

  assert.equal((await f.checkin({ ...legacy, directory: { error: 'Directory lookup unavailable or timed out.' }, hardware: {}, networkAdapters: [{ name: null, mac: null, ipv4: null, gateways: null, dnsServers: null, dhcpEnabled: null }], pendingReboot: false, pendingRebootReasons: [], uptimeSeconds: 0 })).status, 200);
  const partial = await f.read();
  assert.deepEqual(partial.directory, { distinguishedName: null, canonicalName: null, organizationalUnits: [], domainController: null, site: null, error: 'Directory lookup unavailable or timed out.' });
  assert.deepEqual(partial.hardware, { manufacturer: null, model: null, serialNumber: null, biosVersion: null });
  assert.deepEqual(partial.networkAdapters, [{ name: null, mac: null, ipv4: [], gateways: [], dnsServers: [], dhcpEnabled: null }]);
  assert.equal(partial.pendingReboot, false); assert.equal(partial.uptimeSeconds, 0);
});

test('malformed or excessive diagnostics are rejected atomically instead of stored or silently truncated', async t => {
  const f = await fixture(t);
  assert.equal((await f.checkin({ hostname: 'SYNTHETIC-PC', directory: { organizationalUnits: ['Known OU'] }, pendingReboot: false })).status, 200);
  const before = await f.read();
  const cases = [
    { directory: [] }, { directory: 'not an object' },
    { directory: { distinguishedName: 'x'.repeat(4097) } },
    { directory: { organizationalUnits: Array(65).fill('OU') } },
    { directory: { organizationalUnits: [{ name: 'OU' }] } },
    { directory: { domainController: ['dc01'] } },
    { directory: { error: 'x'.repeat(1001) } },
    { hardware: true }, { hardware: { manufacturer: 'x'.repeat(257) } },
    { hardware: { serialNumber: { nested: 'no' } } },
    { networkAdapters: {} }, { networkAdapters: Array(129).fill({}) },
    { networkAdapters: [null] }, { networkAdapters: [[]] },
    { networkAdapters: [{ name: 'x'.repeat(513) }] },
    { networkAdapters: [{ ipv4: Array(129).fill('192.0.2.5') }] },
    { networkAdapters: [{ gateways: [{ address: '192.0.2.1' }] }] },
    { networkAdapters: [{ dnsServers: ['x'.repeat(101)] }] },
    { networkAdapters: [{ dhcpEnabled: 'false' }] },
    { pendingReboot: 'false' }, { pendingRebootReasons: Array(65).fill('Reason') },
    { pendingRebootReasons: ['x'.repeat(513)] }, { pendingRebootReasons: [false] },
    { uptimeSeconds: -1 }, { uptimeSeconds: '120' },
    { inventoryCollectedAt: 'not a date' }, { inventoryCollectedAt: '2026-11-04' },
    { inventoryCollectedAt: 'x'.repeat(65) }
  ];
  for (const inventory of cases) {
    const response = await f.checkin(inventory);
    assert.equal(response.status, 400, JSON.stringify(inventory).slice(0, 160));
    assert.deepEqual(await f.read(), before, 'invalid checkin must not replace the last known inventory');
  }
});
