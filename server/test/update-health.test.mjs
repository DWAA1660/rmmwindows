import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.mjs';
import { UPDATE_ERROR_SUMMARIES, UPDATE_PHASE_SUMMARIES } from '../src/update-health.mjs';
import { listen } from './listen.mjs';

const baseReport = () => ({ schemaVersion: 1, installedVersion: '0.1.8', availableVersion: '0.1.9',
  phase: 'checking', stage: 'manifest', checkedAt: '2026-11-05T12:00:00.1234567+00:00', attempts: 0 });
async function fixture(t) {
  const password = 'synthetic-update-health-password';
  const service = createApp({ databasePath: ':memory:', env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password } });
  const server = await listen(service.app); const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); });
  const request = async (path, method = 'GET', body, auth = {}, headers = {}) => {
    const response = await fetch(origin + '/api' + path, { method, signal: AbortSignal.timeout(10000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...auth, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (username = 'admin', supplied = password) => {
    const result = await request('/auth/login', 'POST', { username, password: supplied }); assert.equal(result.status, 200);
    return { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': result.data.csrfToken };
  };
  const admin = await login(); let next = 0;
  const enroll = async () => {
    const token = await request('/enrollment-tokens', 'POST', { label: 'Synthetic updater test', maxUses: 1, expiresInHours: 1 }, admin);
    const enrolled = await request('/agent/enroll', 'POST', { enrollmentToken: token.data.token, hostname: `UPDATE-TEST-${++next}`, deviceId: `update-test-${next}` });
    assert.equal(enrolled.status, 201); return { ...enrolled.data, auth: { Authorization: `Bearer ${enrolled.data.agentToken}` } };
  };
  const status = (endpoint, report = baseReport()) => request('/agent/update-status', 'POST', { updateStatus: report }, endpoint.auth);
  const read = async endpoint => {
    const response = await request(`/endpoints/${endpoint.endpointId}`, 'GET', undefined, admin); assert.equal(response.status, 200); return response.data;
  };
  return { ...service, request, admin, password, login, enroll, status, read };
}

test('update evidence is bearer scoped, startup-safe, authenticated read-only and unknown for older agents', async t => {
  const f = await fixture(t); const a = await f.enroll(); const b = await f.enroll();
  assert.equal((await f.request('/agent-updates')).status, 401);
  assert.equal((await f.request('/agent-updates', 'GET', undefined, a.auth)).status, 401);
  assert.equal((await f.request('/agent/update-status', 'POST', { updateStatus: baseReport() }, f.admin)).status, 401, 'operator cookie/CSRF cannot impersonate an agent');
  assert.equal((await f.request('/agent/update-status', 'POST', { endpointId: b.endpointId, updateStatus: baseReport() }, a.auth)).status, 400);
  assert.equal((await f.request('/agent/checkin', 'POST', { bootId: 'kept-boot', inventory: { hostname: 'KEPT-HOST', agentVersion: '0.1.6' } }, a.auth)).status, 200);
  const before = await f.read(a); assert.equal(before.updateStatus, null);
  const receivedBefore = Date.now();
  assert.equal((await f.request('/agent/update-status', 'POST', { updateStatus: baseReport() }, a.auth, { Origin: '' })).status, 200, 'bearer startup reporting does not depend on browser CSRF');
  const receivedAfter = Date.now(); const current = await f.read(a);
  assert.equal(current.bootId, before.bootId); assert.deepEqual(current.inventory, before.inventory);
  assert.equal(current.updateStatus.summary, UPDATE_PHASE_SUMMARIES.checking);
  assert.equal(current.updateStatus.checkedAt, '2026-11-05T12:00:00.123Z');
  assert.ok(Date.parse(current.updateStatus.receivedAt) >= receivedBefore && Date.parse(current.updateStatus.receivedAt) <= receivedAfter);
  assert.equal((await f.read(b)).updateStatus, null);
  const reports = (await f.request('/agent-updates', 'GET', undefined, f.admin)).data;
  assert.ok(Array.isArray(reports)); assert.equal(reports.length, 2);
  assert.equal(reports.find(row => row.endpointId === a.endpointId).agentVersion, '0.1.6');
  assert.equal(reports.find(row => row.endpointId === a.endpointId).updateStatus.installedVersion, '0.1.8');
  assert.equal(reports.find(row => row.endpointId === b.endpointId).updateStatus, null, 'no telemetry is unknown, not an invented failure');
  for (const role of ['viewer', 'operator']) {
    assert.equal((await f.request('/users', 'POST', { username: `update-${role}`, role, password: 'synthetic-user-password', currentPassword: f.password }, f.admin)).status, 201);
    const session = await f.login(`update-${role}`, 'synthetic-user-password');
    assert.equal((await f.request('/agent-updates', 'GET', undefined, session)).status, 200);
    assert.equal((await f.request('/agent/update-status', 'POST', { updateStatus: baseReport() }, session)).status, 401);
  }
  await f.request(`/endpoints/${a.endpointId}/revoke`, 'POST', {}, f.admin);
  assert.equal((await f.status(a)).status, 401);
  assert.equal((await f.request('/agent-updates', 'GET', undefined, f.admin)).data.some(row => row.endpointId === a.endpointId), false);
});

test('checkin combines inventory and safe update status atomically and omission preserves report age', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const valid = { ...baseReport(), phase: 'retry_wait', stage: 'install', errorCode: 'pipeline_stopped', summary: UPDATE_ERROR_SUMMARIES.pipeline_stopped,
    attempts: 2, lastAttemptAt: '2026-11-05T11:55:00Z', nextRetryAt: '2026-11-05T13:55:00Z', packageSha256: 'A'.repeat(64) };
  assert.equal((await f.request('/agent/checkin', 'POST', { bootId: 'boot-original', inventory: { hostname: 'ORIGINAL', agentVersion: '0.1.8' }, updateStatus: valid }, endpoint.auth)).status, 200);
  const before = await f.read(endpoint);
  assert.equal(before.updateStatus.packageSha256, 'a'.repeat(64)); assert.equal(before.updateStatus.errorCode, 'pipeline_stopped');
  const invalid = await f.request('/agent/checkin', 'POST', { bootId: 'must-not-replace', inventory: { hostname: 'MUST-NOT-REPLACE' }, updateStatus: { ...valid, attempts: 4 } }, endpoint.auth);
  assert.equal(invalid.status, 400);
  const unchanged = await f.read(endpoint);
  for (const field of ['hostname', 'bootId', 'lastSeen', 'inventory', 'updateStatus']) assert.deepEqual(unchanged[field], before[field], field);
  assert.equal((await f.request('/agent/checkin', 'POST', { bootId: 'boot-original' }, endpoint.auth)).status, 200);
  assert.deepEqual((await f.read(endpoint)).updateStatus, before.updateStatus, 'old-agent heartbeats do not wipe or refresh receivedAt');
  assert.equal((await f.request('/agent/checkin', 'POST', { inventory: { disks: 'wrong' }, updateStatus: { ...baseReport(), phase: 'current', stage: 'complete' } }, endpoint.auth)).status, 400);
  assert.deepEqual((await f.read(endpoint)).updateStatus, before.updateStatus, 'invalid inventory does not update telemetry either');
});

test('strict report bounds reject raw secrets, unknown fields, arbitrary summaries and invalid telemetry without retaining them', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); assert.equal((await f.status(endpoint)).status, 200);
  const original = await f.read(endpoint); const secret = 'TEST-ONLY-DO-NOT-RETAIN-CREDENTIAL';
  const invalid = [null, [], {}, { ...baseReport(), schemaVersion: 2 }, { ...baseReport(), token: secret },
    { ...baseReport(), endpointId: endpoint.endpointId }, { ...baseReport(), receivedAt: '2020-01-01T00:00:00Z' },
    { ...baseReport(), logs: [secret] }, { ...baseReport(), summary: `Network failed at https://${secret}@example.test` },
    { ...baseReport(), summary: 'x'.repeat(401) }, { ...baseReport(), errorCode: secret }, { ...baseReport(), errorCode: 'x'.repeat(81) },
    { ...baseReport(), phase: 'arbitrary' }, { ...baseReport(), stage: 'script' },
    { ...baseReport(), attempts: -1 }, { ...baseReport(), attempts: 4 }, { ...baseReport(), attempts: 1.5 },
    { ...baseReport(), installedVersion: '0.1.8 https://example.test' }, { ...baseReport(), availableVersion: 'x'.repeat(105) },
    { ...baseReport(), checkedAt: 'not a date' }, { ...baseReport(), lastAttemptAt: '2026-11-05' },
    { ...baseReport(), nextRetryAt: 'x'.repeat(65) }, { ...baseReport(), packageSha256: 'z'.repeat(64) },
    { ...baseReport(), packageSha256: 'a'.repeat(65) }, { ...baseReport(), summary: { raw: secret } }];
  for (const report of invalid) {
    const result = await f.status(endpoint, report); assert.equal(result.status, 400);
    assert.equal(JSON.stringify(result.data).includes(secret), false, 'validation response must not echo telemetry values');
  }
  assert.equal((await f.request('/agent/update-status', 'POST', {}, endpoint.auth)).status, 400);
  assert.deepEqual((await f.read(endpoint)).updateStatus, original.updateStatus);
  for (const table of ['endpoint_update_status', 'endpoint_update_history', 'audit']) assert.equal(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()).includes(secret), false, table);
});

test('history deduplicates timestamp-only heartbeats, caps transitions at 100 and never prunes command output', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  assert.equal((await f.status(endpoint)).status, 200);
  const historyCount = () => f.db.prepare('SELECT COUNT(*) count FROM endpoint_update_history WHERE endpoint_id=?').get(endpoint.endpointId).count;
  assert.equal(historyCount(), 1);
  assert.equal((await f.status(endpoint, { ...baseReport(), checkedAt: '2026-11-05T12:01:00Z' })).status, 200); assert.equal(historyCount(), 1);
  assert.equal((await f.read(endpoint)).updateStatus.checkedAt, '2026-11-05T12:01:00.000Z');
  const failed = { ...baseReport(), phase: 'failed', stage: 'manifest', attempts: 1, errorCode: 'tls_error' };
  await f.status(endpoint, failed); await f.status(endpoint, { ...failed, checkedAt: '2026-11-05T12:02:00Z' });
  assert.equal(historyCount(), 2);
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit WHERE action='agent.update.failure'").get().count, 1);
  const job = (await f.request('/jobs', 'POST', { endpointIds: [endpoint.endpointId], kind: 'powershell', payload: { script: 'synthetic only' } }, f.admin)).data.jobs[0];
  const claim = (await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job;
  await f.request(`/agent/jobs/${job.id}/start`, 'POST', { dispatchToken: claim.dispatchToken }, endpoint.auth);
  await f.request(`/agent/jobs/${job.id}/output/0`, 'PUT', { stream: 'stdout', text: 'Must remain complete after telemetry history pruning.' }, endpoint.auth);
  for (let index = 0; index < 105; index++) {
    const report = { ...baseReport(), phase: index % 2 ? 'checking' : 'current', stage: index % 2 ? 'manifest' : 'complete' };
    assert.equal((await f.status(endpoint, report)).status, 200);
  }
  assert.equal(historyCount(), 100);
  assert.equal(f.db.prepare('SELECT text FROM output_chunks WHERE job_id=?').get(job.id).text, 'Must remain complete after telemetry history pruning.');
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'running', 'telemetry never changes or requeues jobs');
  assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit WHERE action='agent.update.failure'").get().count, 1);
});

test('server safe-summary catalog matches the agent wire contract exactly and all declared values report successfully', async t => {
  const source = readFileSync(new URL('../../agent/UpdateDiagnostics.cs', import.meta.url), 'utf8');
  const errorsStart = source.indexOf('ErrorSummaries ='); const phasesStart = source.indexOf('PhaseSummaries =');
  const catalog = text => Object.fromEntries([...text.matchAll(/\["([^"]+)"\]\s*=\s*"([^"]*)"/g)].map(match => [match[1], match[2]]));
  assert.ok(errorsStart > 0 && phasesStart > errorsStart);
  assert.deepEqual(catalog(source.slice(errorsStart, phasesStart)), UPDATE_ERROR_SUMMARIES);
  assert.deepEqual(catalog(source.slice(phasesStart, source.indexOf('VersionPattern', phasesStart))), UPDATE_PHASE_SUMMARIES);
  const f = await fixture(t); const endpoint = await f.enroll();
  for (const [phase, summary] of Object.entries(UPDATE_PHASE_SUMMARIES)) assert.equal((await f.status(endpoint, { ...baseReport(), phase, summary })).status, 200);
  for (const [errorCode, summary] of Object.entries(UPDATE_ERROR_SUMMARIES)) assert.equal((await f.status(endpoint, { ...baseReport(), phase: 'failed', errorCode, summary })).status, 200);
});
