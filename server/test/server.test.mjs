import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';

const TEST_PASSWORD = 'not-a-production-password-for-tests';
async function fixture(t, databasePath = ':memory:') {
  const service = createApp({ databasePath, env: { ADMIN_USERNAME: 'librarian', ADMIN_PASSWORD: TEST_PASSWORD } });
  const server = service.app.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = ''; let csrf = '';
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); };
  t.after(stop);
  async function request(path, { method = 'GET', body, token, auth = true, headers = {}, raw = false } = {}) {
    const response = await fetch(base + '/api' + path, {
      method,
      signal: AbortSignal.timeout(10000),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Origin: base, ...(auth && cookie ? { Cookie: cookie, 'X-CSRF-Token': csrf } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const data = raw ? await response.text() : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  const login = await request('/auth/login', { method: 'POST', body: { username: 'librarian', password: TEST_PASSWORD }, auth: false });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0]; csrf = login.data.csrfToken;
  async function enroll(deviceId = 'device-1') {
    const enrollment = await request('/enrollment-tokens', { method: 'POST', body: { label: 'Test enroll', maxUses: 1, expiresInHours: 1 } });
    assert.equal(enrollment.status, 201);
    const enrolled = await request('/agent/enroll', { method: 'POST', body: { enrollmentToken: enrollment.data.token, deviceId, hostname: deviceId }, auth: false });
    assert.equal(enrolled.status, 201);
    return enrolled.data;
  }
  async function queue(endpointIds, kind = 'powershell', payload = { script: 'Write-Output "hello"' }, extra = {}) {
    const result = await request('/jobs', { method: 'POST', body: { endpointIds, kind, payload, ...extra } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.jobs;
  }
  return { ...service, request, enroll, queue, base, cookie: () => cookie, csrf: () => csrf };
}

test('bootstrap refuses default credentials and operator actions require both session and CSRF', async t => {
  assert.throws(() => createApp({ databasePath: ':memory:', env: {} }), /First startup requires/);
  const f = await fixture(t);
  assert.equal((await f.request('/endpoints', { auth: false })).status, 401);
  assert.equal((await f.request('/scripts', { method: 'POST', body: { name: 'x', body: 'x' }, headers: { 'X-CSRF-Token': '' } })).status, 403);
  assert.equal((await f.request('/scripts', { method: 'POST', body: { name: 'x', body: 'x' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.request('/auth/login', { method: 'POST', body: { username: 'librarian', password: TEST_PASSWORD }, headers: { Origin: 'https://attacker.example' }, auth: false })).status, 403);
  const agent = await f.enroll();
  assert.equal((await f.request('/scripts', { method: 'POST', body: { name: 'x', body: 'x' }, auth: false, token: agent.agentToken })).status, 401);
  const me = await f.request('/auth/me'); assert.equal(me.data.user.role, 'admin');
  const login = await f.request('/auth/login', { method: 'POST', body: { username: 'librarian', password: TEST_PASSWORD }, auth: false });
  assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
});

test('enrollment is limited, credentials hashed, revoked identities cannot claim and may reenroll explicitly', async t => {
  const f = await fixture(t);
  const created = await f.request('/enrollment-tokens', { method: 'POST', body: { label: 'one', maxUses: 1, expiresInHours: 1 } });
  const body = { enrollmentToken: created.data.token, deviceId: 'device-one', hostname: 'PC-ONE' };
  const first = await f.request('/agent/enroll', { method: 'POST', body, auth: false }); assert.equal(first.status, 201);
  assert.equal((await f.request('/agent/enroll', { method: 'POST', body: { ...body, deviceId: 'device-two' }, auth: false })).status, 403);
  assert.notEqual(f.db.prepare('SELECT token_hash FROM endpoints').get().token_hash, first.data.agentToken);
  assert.notEqual(f.db.prepare('SELECT token_hash FROM enrollment_tokens').get().token_hash, created.data.token);
  const tokenList = await f.request('/enrollment-tokens'); assert.equal('token' in tokenList.data[0], false);
  await f.queue([first.data.endpointId], 'reboot', { delaySeconds: 30 });
  assert.equal((await f.request(`/endpoints/${first.data.endpointId}/revoke`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: first.data.agentToken, auth: false })).status, 401);
  assert.equal((await f.request('/jobs')).data[0].status, 'cancelled');
  const replacement = await f.enroll('device-one'); assert.equal(replacement.endpointId, first.data.endpointId);
  assert.notEqual(replacement.agentToken, first.data.agentToken);
});

test('inventory preserves unavailable metrics and rejects malformed collection shapes', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const agent = { method: 'POST', token: endpoint.agentToken, auth: false };
  const good = await f.request('/agent/checkin', { ...agent, body: { bootId: 'boot-1', inventory: { hostname: 'LIBRARY-PC', cpuPercent: null, memoryUsedBytes: null, domainJoined: null, ipv4: ['192.168.10.7'], disks: [{ name: 'C:', label: 'System', totalBytes: 1000000, freeBytes: 1000 }], software: [{ name: 'Reader', version: '1.0' }] } } });
  assert.equal(good.status, 200);
  const inventory = (await f.request(`/endpoints/${endpoint.endpointId}`)).data.inventory;
  assert.equal(inventory.cpuPercent, null); assert.equal(inventory.memoryUsedBytes, null); assert.equal(inventory.domainJoined, null);
  assert.equal(inventory.software[0].publisher, '');
  assert.equal((await f.request('/agent/checkin', { ...agent, body: { inventory: { disks: 'wrong' } } })).status, 400);
  assert.equal((await f.request('/agent/checkin', { ...agent, body: { inventory: { cpuPercent: 110 } } })).status, 400);
  assert.equal((await f.request('/agent/checkin', { ...agent, body: { inventory: { disks: [{ name: 'C:', totalBytes: 100, freeBytes: 101 }] } } })).status, 400);
  assert.equal((await f.request('/agent/checkin', { ...agent, body: { inventory: { software: [null] } } })).status, 400);
});

test('concurrent claim/start grants one execution, idempotency blocks duplicate bulk commands, endpoint ownership is enforced', async t => {
  const f = await fixture(t); const one = await f.enroll('one'); const two = await f.enroll('two');
  const [job] = await f.queue([one.endpointId], 'reboot', { delaySeconds: 30 }, { idempotencyKey: 'reboot-request-1' });
  const same = await f.request('/jobs', { method: 'POST', body: { endpointIds: [one.endpointId], kind: 'reboot', payload: { delaySeconds: 30 }, idempotencyKey: 'reboot-request-1' } });
  assert.equal(same.status, 200); assert.equal(same.data.jobs[0].id, job.id);
  const different = await f.request('/jobs', { method: 'POST', body: { endpointIds: [one.endpointId], kind: 'reboot', payload: { delaySeconds: 60 }, idempotencyKey: 'reboot-request-1' } }); assert.equal(different.status, 409);
  const claims = await Promise.all(Array.from({ length: 10 }, () => f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: one.agentToken, auth: false })));
  assert.equal(claims.filter(result => result.data.job).length, 1);
  const claimed = claims.find(result => result.data.job).data.job;
  assert.equal((await f.request(`/agent/jobs/${job.id}/start`, { method: 'POST', body: { dispatchToken: claimed.dispatchToken }, token: two.agentToken, auth: false })).status, 404);
  const starts = await Promise.all(Array.from({ length: 10 }, () => f.request(`/agent/jobs/${job.id}/start`, { method: 'POST', body: { dispatchToken: claimed.dispatchToken }, token: one.agentToken, auth: false })));
  assert.equal(starts.filter(result => result.data.mayExecute).length, 1);
  assert.equal((await f.request(`/jobs/${job.id}/cancel`, { method: 'POST', body: {} })).status, 409);
  assert.equal((await f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: one.agentToken, auth: false })).data.job, null);
});

test('output exceeding a megabyte survives pagination, duplicate uploads, completion and complete download exactly', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); const [job] = await f.queue([endpoint.endpointId]);
  const claimed = await f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: endpoint.agentToken, auth: false });
  await f.request(`/agent/jobs/${job.id}/start`, { method: 'POST', body: { dispatchToken: claimed.data.job.dispatchToken }, token: endpoint.agentToken, auth: false });
  const chunks = Array.from({ length: 22 }, (_, i) => `line ${i}: ` + 'Long PowerShell response é漢字\n'.repeat(1500));
  const gap = await f.request(`/agent/jobs/${job.id}/output/1`, { method: 'PUT', body: { stream: 'stdout', text: 'must not skip sequence zero' }, token: endpoint.agentToken, auth: false }); assert.equal(gap.status, 409);
  for (const [sequence, text] of chunks.entries()) {
    assert.ok(Buffer.byteLength(text) < 65536);
    const result = await f.request(`/agent/jobs/${job.id}/output/${sequence}`, { method: 'PUT', body: { stream: sequence % 2 ? 'stderr' : 'stdout', text }, token: endpoint.agentToken, auth: false }); assert.equal(result.status, 200);
  }
  const duplicate = await f.request(`/agent/jobs/${job.id}/output/0`, { method: 'PUT', body: { stream: 'stdout', text: chunks[0] }, token: endpoint.agentToken, auth: false }); assert.equal(duplicate.data.duplicate, true);
  const mismatch = await f.request(`/agent/jobs/${job.id}/output/0`, { method: 'PUT', body: { stream: 'stdout', text: 'different' }, token: endpoint.agentToken, auth: false }); assert.equal(mismatch.status, 409);
  const oversized = await f.request(`/agent/jobs/${job.id}/output/100`, { method: 'PUT', body: { stream: 'stdout', text: '漢'.repeat(30000) }, token: endpoint.agentToken, auth: false }); assert.equal(oversized.status, 413);
  let after = -1; const retrieved = [];
  do {
    const result = await f.request(`/jobs/${job.id}/output?after=${after}&limit=3`);
    retrieved.push(...result.data.chunks.map(chunk => chunk.text)); after = result.data.nextCursor;
    if (!result.data.hasMore) break;
  } while (true);
  assert.deepEqual(retrieved, chunks);
  const completeBody = { status: 'succeeded', exitCode: 0, summary: 'Finished' };
  assert.equal((await f.request(`/agent/jobs/${job.id}/complete`, { method: 'POST', body: completeBody, token: endpoint.agentToken, auth: false })).status, 200);
  assert.equal((await f.request(`/agent/jobs/${job.id}/complete`, { method: 'POST', body: completeBody, token: endpoint.agentToken, auth: false })).status, 200);
  assert.equal((await f.request(`/agent/jobs/${job.id}/complete`, { method: 'POST', body: { ...completeBody, status: 'failed' }, token: endpoint.agentToken, auth: false })).status, 409);
  const downloaded = await f.request(`/jobs/${job.id}/download`, { raw: true });
  assert.ok(Buffer.byteLength(downloaded.data) > 1000000); assert.equal(downloaded.data, chunks.join(''));
});

test('persisted dispatch remains consumed across server restart and uncertain interrupted completion is allowed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rmm-test-')); const filename = join(dir, 'rmm.db');
  const f = await fixture(t, filename); const endpoint = await f.enroll(); const [job] = await f.queue([endpoint.endpointId]);
  const claim = await f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: endpoint.agentToken, auth: false }); assert.equal(claim.data.job.id, job.id);
  // A second process opening the durable database sees consumption. This models
  // a service restart and an endpoint restored to its pre-execution snapshot.
  const after = await fixture(t, filename);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await after.request('/agent/jobs/claim', { method: 'POST', body: {}, token: endpoint.agentToken, auth: false })).data.job, null);
  const completed = await after.request(`/agent/jobs/${job.id}/complete`, { method: 'POST', body: { status: 'interrupted', exitCode: null, summary: 'Claim response lost; no retry' }, token: endpoint.agentToken, auth: false }); assert.equal(completed.status, 200);
  assert.equal((await after.request(`/agent/jobs/${job.id}/start`, { method: 'POST', body: { dispatchToken: claim.data.job.dispatchToken }, token: endpoint.agentToken, auth: false })).data.mayExecute, false);
});

test('download streams many small astral-Unicode chunks without hanging or changing bytes', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); const [job] = await f.queue([endpoint.endpointId]);
  const claim = await f.request('/agent/jobs/claim', { method: 'POST', body: {}, token: endpoint.agentToken, auth: false });
  await f.request(`/agent/jobs/${job.id}/start`, { method: 'POST', body: { dispatchToken: claim.data.job.dispatchToken }, token: endpoint.agentToken, auth: false });
  const chunks = ['system test\n', ...Array.from({ length: 64 }, (_, i) => 'RMM✓🙂'.repeat(500 + i)), 'stderr-complete'];
  for (const [sequence, text] of chunks.entries()) {
    const result = await f.request(`/agent/jobs/${job.id}/output/${sequence}`, { method: 'PUT', body: { stream: 'stdout', text }, token: endpoint.agentToken, auth: false }); assert.equal(result.status, 200);
  }
  const downloaded = await f.request(`/jobs/${job.id}/download`, { raw: true });
  assert.equal(downloaded.data, chunks.join(''));
  assert.ok(Buffer.byteLength(downloaded.data) > 300000);
});

test('schedules create one current occurrence, skip missed backlog and do not overlap unresolved jobs', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const script = await f.request('/scripts', { method: 'POST', body: { name: 'Disk report', description: '', body: 'Get-Volume' } }); assert.equal(script.status, 201);
  const due = new Date(Date.now() + 30000);
  const schedule = await f.request('/schedules', { method: 'POST', body: { name: 'Every five minutes', scriptId: script.data.id, endpointIds: [endpoint.endpointId], intervalMinutes: 5, startsAt: due.toISOString(), enabled: true } }); assert.equal(schedule.status, 201);
  f.tickSchedules(due); f.tickSchedules(due);
  assert.equal((await f.request('/jobs')).data.length, 1);
  f.db.prepare('UPDATE endpoints SET last_seen=? WHERE id=?').run(new Date(due.getTime() + 300000).toISOString(), endpoint.endpointId);
  f.tickSchedules(new Date(due.getTime() + 300000));
  assert.equal((await f.request('/jobs')).data.length, 1);
  // Even after resolving the first job, a long outage never creates catch-up jobs.
  const first = (await f.request('/jobs')).data[0]; await f.request(`/jobs/${first.id}/cancel`, { method: 'POST', body: {} });
  f.tickSchedules(new Date(due.getTime() + 20 * 60000));
  assert.equal((await f.request('/jobs')).data.length, 1);
  const row = f.db.prepare('SELECT * FROM schedules').get(); assert.ok(Date.parse(row.next_run_at) > due.getTime() + 20 * 60000);
  assert.equal((await f.request(`/scripts/${script.data.id}`, { method: 'DELETE' })).status, 409);
});
