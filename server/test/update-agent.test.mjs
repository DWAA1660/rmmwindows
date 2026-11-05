import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, agentUpdateScript } from '../src/app.mjs';
import { listen } from './listen.mjs';

async function fixture(t) {
  const password = 'synthetic-update-agent-password';
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
  const token = await request('/enrollment-tokens', 'POST', { label: 'Synthetic update-agent test', maxUses: 1, expiresInHours: 1 }, admin);
  const enrolled = await request('/agent/enroll', 'POST', { enrollmentToken: token.data.token, hostname: 'UPDATE-AGENT-TEST', deviceId: 'update-agent-test' });
  assert.equal(enrolled.status, 201);
  return { ...service, request, login, admin, password, endpointId: enrolled.data.endpointId };
}

test('update-agent queues one fixed, server-written job and refuses duplicates and read-only accounts', async t => {
  const f = await fixture(t);
  const first = await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'click-1' }, f.admin);
  assert.equal(first.status, 201);
  const job = first.data.job;
  assert.equal(job.kind, 'powershell'); assert.equal(job.status, 'queued'); assert.equal(job.endpointId, f.endpointId);
  const stored = JSON.parse(f.db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id).payload);
  assert.equal(stored.script, agentUpdateScript('https://rmm.parkcountylibrary.org'));
  assert.match(stored.script, /'https:\/\/rmm\.parkcountylibrary\.org\/install\.ps1'/, 'script uses the server-configured origin, never request headers');

  const retried = await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'click-1' }, f.admin);
  assert.equal(retried.status, 200); assert.equal(retried.data.job.id, job.id, 'an uncertain retry returns the same job');
  const second = await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'click-2' }, f.admin);
  assert.equal(second.status, 409, 'a second update is refused while one is queued');
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs WHERE endpoint_id=?').get(f.endpointId).n, 1);

  // Once the first job reaches a final state another update may be requested. Nothing is requeued.
  f.db.prepare("UPDATE jobs SET status='interrupted' WHERE id=?").run(job.id);
  const later = await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'click-3' }, f.admin);
  assert.equal(later.status, 201); assert.notEqual(later.data.job.id, job.id);
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status, 'interrupted', 'the earlier job is never requeued');

  assert.equal((await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'x' })).status, 401);
  assert.equal((await f.request('/users', 'POST', { username: 'update-viewer', role: 'viewer', password: 'synthetic-user-password', currentPassword: f.password }, f.admin)).status, 201);
  const viewer = await f.login('update-viewer', 'synthetic-user-password');
  assert.equal((await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'v' }, viewer)).status, 403);
  assert.equal((await f.request('/endpoints/00000000-0000-4000-8000-000000000000/update-agent', 'POST', { idempotencyKey: 'n' }, f.admin)).status, 404);
  assert.equal((await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', {}, f.admin)).status, 400, 'an idempotency key is required');
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='agent.update.requested'").get().n, 2);
});
