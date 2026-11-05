import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';

// Protocol/lifecycle tests use only synthetic agents and memory/temporary DBs.
// No actual terminal process, Windows service, VM or production endpoint runs.
async function fixture(t, databasePath = ':memory:') {
  const password = 'terminal-synthetic-password';
  const service = createApp({ databasePath, env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password } });
  const server = await listen(service.app); const origin = `http://127.0.0.1:${server.address().port}`;
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); };
  t.after(stop);
  const request = async (path, method = 'GET', body, session = {}, headers = {}) => {
    const response = await fetch(origin + '/api' + path, { method, signal: AbortSignal.timeout(10000), headers: { Origin: origin, 'Content-Type': 'application/json', ...session, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (username = 'admin', supplied = password) => {
    const response = await request('/auth/login', 'POST', { username, password: supplied }); assert.equal(response.status, 200);
    return { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': response.data.csrfToken };
  };
  const admin = await login(); let device = 0;
  const enroll = async (agentVersion = '0.1.7') => {
    const token = await request('/enrollment-tokens', 'POST', { label: 'Synthetic terminal', maxUses: 1, expiresInHours: 1 }, admin);
    const response = await request('/agent/enroll', 'POST', { enrollmentToken: token.data.token, deviceId: `terminal-device-${++device}`, hostname: `TERMINAL-${device}` });
    assert.equal(response.status, 201); const auth = { Authorization: `Bearer ${response.data.agentToken}` };
    assert.equal((await request('/agent/checkin', 'POST', { inventory: { agentVersion } }, auth)).status, 200);
    return { ...response.data, auth };
  };
  const create = async (endpoint, session = admin, key = randomUUID()) => request('/terminals', 'POST', { endpointId: endpoint.endpointId, idempotencyKey: key }, session);
  const command = async (terminal, script = '$value = 5', key = randomUUID(), extra = {}) => request(`/terminals/${terminal.id}/commands`, 'POST', { command: script, idempotencyKey: key, ...extra }, admin);
  const start = async endpoint => {
    const claim = await request('/agent/jobs/claim', 'POST', {}, endpoint.auth);
    assert.equal(claim.status, 200); assert.ok(claim.data.job);
    const job = claim.data.job;
    assert.equal((await request(`/agent/jobs/${job.id}/start`, 'POST', { dispatchToken: job.dispatchToken }, endpoint.auth)).data.mayExecute, true);
    return job;
  };
  const authorize = async (endpoint, terminal, job, instanceId) => request(`/agent/terminals/${terminal.id}/authorize`, 'POST', { jobId: job.id, instanceId }, endpoint.auth);
  const validate = (endpoint, instanceId, sessionIds) => request('/agent/terminals/validate', 'POST', { instanceId, sessionIds }, endpoint.auth);
  const complete = (endpoint, job) => request(`/agent/jobs/${job.id}/complete`, 'POST', { status: 'succeeded', exitCode: 0, summary: 'Synthetic command complete' }, endpoint.auth);
  return { ...service, stop, request, login, admin, enroll, create, command, start, authorize, validate, complete, password };
}

test('terminals enforce role, origin, original-login ownership, minimum agent and four-session cap', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); const otherEndpoint = await f.enroll();
  assert.equal((await f.create(endpoint, {})).status, 401);
  assert.equal((await f.create(endpoint, { Cookie: f.admin.Cookie })).status, 403);
  assert.equal((await f.create(await f.enroll('0.1.6'))).status, 409);
  assert.equal((await f.request('/jobs', 'POST', { endpointIds: [endpoint.endpointId], kind: 'terminal', payload: { sessionId: randomUUID(), script: 'not allowed' } }, f.admin)).status, 400);
  const key = randomUUID(); const created = await f.create(endpoint, f.admin, key); assert.equal(created.status, 201);
  const terminal = created.data; assert.equal(terminal.status, 'open'); assert.equal(terminal.workingDirectory, null);
  assert.ok(Date.parse(terminal.expiresAt) - Date.parse(terminal.createdAt) <= 2 * 3600000 + 10);
  assert.equal((await f.create(endpoint, f.admin, key)).data.id, terminal.id);
  assert.equal((await f.create(otherEndpoint, f.admin, key)).status, 409);
  const secondLogin = await f.login();
  assert.equal((await f.request(`/terminals/${terminal.id}`, 'GET', undefined, secondLogin)).status, 404);
  assert.equal((await f.request(`/terminals/${terminal.id}/close`, 'POST', {}, secondLogin)).status, 404);
  const viewer = await f.request('/users', 'POST', { username: 'terminal-viewer', role: 'viewer', password: 'viewer-synthetic-password', currentPassword: f.password }, f.admin);
  assert.equal(viewer.status, 201); const viewerLogin = await f.login('terminal-viewer', 'viewer-synthetic-password');
  assert.equal((await f.create(endpoint, viewerLogin)).status, 403);
  assert.equal((await f.request(`/terminals/${terminal.id}`, 'GET', undefined, viewerLogin)).status, 403);
  for (let i = 0; i < 3; i++) assert.equal((await f.create(endpoint)).status, 201);
  assert.equal((await f.create(endpoint)).status, 409);
  assert.equal((await f.request(`/terminals/${terminal.id}/close`, 'POST', {}, f.admin)).status, 200);
  assert.equal((await f.create(endpoint)).status, 201);
});

test('each terminal command is a distinct at-most-once job and its execution grant is never repeated', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); const stranger = await f.enroll();
  const terminal = (await f.create(endpoint)).data; const key = randomUUID();
  const submitted = await f.command(terminal, '$value = 5; Set-Location C:\\Library', key, { timeoutSeconds: 1 });
  assert.equal(submitted.status, 201); assert.equal(submitted.data.kind, 'terminal'); assert.equal(submitted.data.timeoutSeconds, 1);
  assert.deepEqual(submitted.data.payload, { sessionId: terminal.id, script: '$value = 5; Set-Location C:\\Library' });
  assert.equal((await f.command(terminal, '$value = 5; Set-Location C:\\Library', key, { timeoutSeconds: 1 })).data.id, submitted.data.id);
  assert.equal((await f.command(terminal, 'different', key)).status, 409);
  assert.equal((await f.command(terminal)).status, 409);
  const instanceId = randomUUID();
  assert.equal((await f.authorize(endpoint, terminal, submitted.data, instanceId)).status, 409, 'queued job cannot grant terminal execution');
  const job = await f.start(endpoint);
  assert.equal((await f.command(terminal)).status, 409);
  assert.equal((await f.authorize(stranger, terminal, job, instanceId)).status, 404);
  const grants = await Promise.all(Array.from({ length: 5 }, () => f.authorize(endpoint, terminal, job, instanceId)));
  assert.equal(grants.filter(response => response.status === 200).length, 1);
  assert.equal(grants.filter(response => response.status === 409).length, 4);
  assert.equal(f.db.prepare('SELECT authorized_at FROM terminal_commands WHERE job_id=?').get(job.id).authorized_at !== null, true);
  const state = await f.request(`/agent/terminals/${terminal.id}/state`, 'POST', { instanceId, jobId: job.id, status: 'open', workingDirectory: 'C:\\Library' }, endpoint.auth);
  assert.equal(state.status, 200); assert.equal(state.data.workingDirectory, 'C:\\Library');
  assert.deepEqual((await f.validate(endpoint, instanceId, [terminal.id])).data.allowed, [terminal.id]);
  assert.equal((await f.complete(endpoint, job)).status, 200);
  assert.equal((await f.authorize(endpoint, terminal, job, instanceId)).status, 409);
  assert.equal((await f.request(`/agent/terminals/${terminal.id}/state`, 'POST', { instanceId, jobId: job.id, status: 'open', workingDirectory: 'C:\\OldJobMustNotChangeState' }, endpoint.auth)).status, 409);
  const next = await f.command(terminal, '$value; Get-Location'); assert.equal(next.status, 201); assert.notEqual(next.data.id, job.id);
  const nextJob = await f.start(endpoint);
  assert.equal((await f.authorize(endpoint, terminal, nextJob, instanceId)).data.workingDirectory, 'C:\\Library');
  const history = await f.request(`/terminals/${terminal.id}`, 'GET', undefined, f.admin);
  assert.equal(history.data.jobs.length, 2);
  assert.equal(history.data.jobs.find(value => value.id === job.id).status, 'succeeded');
  assert.equal((await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job, null);
  const audit = JSON.stringify(f.db.prepare("SELECT details FROM audit WHERE action LIKE 'terminal.%'").all());
  assert.equal(audit.includes('$value'), false, 'audit stores terminal lifecycle metadata, not command text');
});

test('an idle terminal may be ended by its bound instance using the last completed authorized job', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const terminal = (await f.create(endpoint)).data; await f.command(terminal);
  const job = await f.start(endpoint); const instanceId = randomUUID();
  assert.equal((await f.authorize(endpoint, terminal, job, instanceId)).status, 200);
  assert.equal((await f.complete(endpoint, job)).status, 200);
  assert.equal((await f.request(`/agent/terminals/${terminal.id}/state`, 'POST', { instanceId: randomUUID(), jobId: job.id, status: 'closed' }, endpoint.auth)).status, 409);
  const closed = await f.request(`/agent/terminals/${terminal.id}/state`, 'POST', { instanceId, jobId: job.id, status: 'closed' }, endpoint.auth);
  assert.equal(closed.status, 200); assert.equal(closed.data.status, 'closed'); assert.equal(closed.data.reason, 'agent_closed');
  assert.equal((await f.request(`/jobs/${job.id}`, 'GET', undefined, f.admin)).data.status, 'succeeded');
  assert.equal((await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job, null);
});

test('closing cancels only unconsumed commands and never requeues dispatched or running work', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const queuedTerminal = (await f.create(endpoint)).data; const queued = (await f.command(queuedTerminal)).data;
  assert.equal((await f.request(`/terminals/${queuedTerminal.id}/close`, 'POST', {}, f.admin)).data.status, 'closed');
  assert.equal((await f.request(`/jobs/${queued.id}`, 'GET', undefined, f.admin)).data.status, 'cancelled');
  assert.equal((await f.command(queuedTerminal)).status, 409);
  const dispatchedTerminal = (await f.create(endpoint)).data; const dispatched = (await f.command(dispatchedTerminal)).data;
  const claim = await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth); assert.equal(claim.data.job.id, dispatched.id);
  await f.request(`/terminals/${dispatchedTerminal.id}/close`, 'POST', {}, f.admin);
  assert.equal((await f.request(`/jobs/${dispatched.id}`, 'GET', undefined, f.admin)).data.status, 'dispatched');
  assert.equal((await f.request(`/agent/jobs/${dispatched.id}/start`, 'POST', { dispatchToken: claim.data.job.dispatchToken }, endpoint.auth)).data.mayExecute, true);
  assert.equal((await f.authorize(endpoint, dispatchedTerminal, dispatched, randomUUID())).status, 409);
  const runningTerminal = (await f.create(endpoint)).data; await f.command(runningTerminal);
  const running = await f.start(endpoint); const instanceId = randomUUID(); await f.authorize(endpoint, runningTerminal, running, instanceId);
  await f.request(`/terminals/${runningTerminal.id}/close`, 'POST', {}, f.admin);
  assert.equal((await f.request(`/jobs/${running.id}`, 'GET', undefined, f.admin)).data.status, 'running');
  assert.deepEqual((await f.validate(endpoint, instanceId, [runningTerminal.id])).data.allowed, []);
  assert.equal((await f.request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job, null);
});

test('agent instance changes close the terminal and foreign endpoint validation has no authority', async t => {
  const f = await fixture(t); const endpoint = await f.enroll(); const stranger = await f.enroll();
  const terminal = (await f.create(endpoint)).data; await f.command(terminal); const job = await f.start(endpoint);
  const original = randomUUID(); assert.equal((await f.authorize(endpoint, terminal, job, original)).status, 200);
  assert.deepEqual((await f.validate(stranger, randomUUID(), [terminal.id])).data.allowed, []);
  assert.equal((await f.request(`/terminals/${terminal.id}`, 'GET', undefined, f.admin)).data.status, 'open');
  assert.equal((await f.authorize(endpoint, terminal, job, randomUUID())).status, 409);
  const closed = (await f.request(`/terminals/${terminal.id}`, 'GET', undefined, f.admin)).data;
  assert.equal(closed.status, 'closed'); assert.equal(closed.reason, 'agent_restarted');
  assert.deepEqual((await f.validate(endpoint, original, [terminal.id])).data.allowed, []);
  assert.equal((await f.request(`/jobs/${job.id}`, 'GET', undefined, f.admin)).data.status, 'running');
  assert.equal((await f.validate(endpoint, original, Array(9).fill(terminal.id))).status, 400);
});

test('expiry, logout, role changes and endpoint revocation invalidate original terminal ownership', async t => {
  const f = await fixture(t); const endpoint = await f.enroll();
  const expiring = (await f.create(endpoint)).data; const queued = (await f.command(expiring)).data;
  f.db.prepare('UPDATE terminal_sessions SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00Z', expiring.id);
  assert.equal((await f.request(`/terminals/${expiring.id}`, 'GET', undefined, f.admin)).data.reason, 'session_expired');
  assert.equal((await f.request(`/jobs/${queued.id}`, 'GET', undefined, f.admin)).data.status, 'cancelled');
  const revoked = (await f.create(endpoint)).data; await f.command(revoked); const running = await f.start(endpoint);
  const instanceId = randomUUID(); await f.authorize(endpoint, revoked, running, instanceId);
  assert.equal((await f.request('/auth/logout', 'POST', {}, f.admin)).status, 200);
  assert.deepEqual((await f.validate(endpoint, instanceId, [revoked.id])).data.allowed, []);
  assert.equal(f.db.prepare('SELECT close_reason FROM terminal_sessions WHERE id=?').get(revoked.id).close_reason, 'operator_session_revoked');

  const newLogin = await f.login();
  const roleTerminal = (await f.create(endpoint, newLogin)).data;
  f.db.prepare("UPDATE users SET role='viewer' WHERE username='admin'").run();
  assert.deepEqual((await f.validate(endpoint, instanceId, [roleTerminal.id])).data.allowed, []);
  assert.equal(f.db.prepare('SELECT status FROM terminal_sessions WHERE id=?').get(roleTerminal.id).status, 'closed');
  f.db.prepare("UPDATE users SET role='admin' WHERE username='admin'").run();
  const endpointTerminal = (await f.create(endpoint, newLogin)).data;
  await f.request(`/endpoints/${endpoint.endpointId}/revoke`, 'POST', {}, newLogin);
  assert.equal((await f.request(`/terminals/${endpointTerminal.id}`, 'GET', undefined, newLogin)).data.reason, 'endpoint_revoked');
});

test('server startup and shutdown close sessions while durable consumed jobs and grants survive', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'rmm-terminal-protocol-')); const databasePath = join(folder, 'test.db');
  const first = await fixture(t, databasePath); const endpoint = await first.enroll();
  const terminal = (await first.create(endpoint)).data; await first.command(terminal); const job = await first.start(endpoint);
  assert.equal((await first.authorize(endpoint, terminal, job, randomUUID())).status, 200);
  const second = await fixture(t, databasePath);
  t.after(() => { assert.ok(folder.startsWith(join(tmpdir(), 'rmm-terminal-protocol-'))); rmSync(folder, { recursive: true, force: true }); });
  assert.equal(second.db.prepare('SELECT status FROM terminal_sessions WHERE id=?').get(terminal.id).status, 'closed');
  assert.equal(second.db.prepare('SELECT close_reason FROM terminal_sessions WHERE id=?').get(terminal.id).close_reason, 'server_restarted');
  assert.equal(second.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'running');
  assert.ok(second.db.prepare('SELECT authorized_at FROM terminal_commands WHERE job_id=?').get(job.id).authorized_at);
  assert.equal((await second.request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job, null);
  const next = (await second.create(endpoint)).data;
  await second.stop();
  assert.equal(first.db.prepare('SELECT close_reason FROM terminal_sessions WHERE id=?').get(next.id).close_reason, 'server_shutdown');
});
