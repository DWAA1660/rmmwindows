import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, agentUpdateScript } from '../src/app.mjs';
import { listen } from './listen.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const password = 'synthetic-update-agent-password';
  const directory = mkdtempSync(join(tmpdir(), 'rmm-update-agent-test-'));
  const zip = Buffer.from('synthetic package');
  writeFileSync(join(directory, 'library-rmm-agent-win-x64.zip'), zip);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: '0.1.9', runtime: 'win-x64', sha256: createHash('sha256').update(zip).digest('hex') }));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = createApp({ databasePath: ':memory:', downloadDirectory: directory, env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password } });
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
  return { ...service, request, login, admin, password, endpointId: enrolled.data.endpointId, agent: { Authorization: `Bearer ${enrolled.data.agentToken}` } };
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

test("per-group automatic updates: default on, toggled by operators for any group, reported only to each group's own agents", async t => {
  const f = await fixture(t);
  const manifest = async () => { const r = await f.request('/agent/update-manifest', 'GET', undefined, f.agent); assert.equal(r.status, 200); return r.data; };
  const initial = await manifest();
  assert.equal(initial.version, '0.1.9'); assert.equal(initial.downloadUrl, '/downloads/library-rmm-agent-win-x64.zip'); assert.equal(initial.autoUpdate, true, 'automatic updates default on');
  assert.equal((await f.request('/agent/update-manifest')).status, 401, 'the per-endpoint manifest needs the agent credential');
  assert.equal((await f.request('/agent/update-manifest', 'GET', undefined, f.admin)).status, 401, 'an operator cookie cannot read it as an agent');

  const groups = (await f.request('/groups', 'GET', undefined, f.admin)).data;
  assert.ok(groups.every(group => group.autoUpdate === true));
  const frozen = await f.request('/groups', 'POST', { name: 'Reboot restore' }, f.admin);
  assert.equal(frozen.status, 201); assert.equal(frozen.data.autoUpdate, true);
  assert.equal((await f.request(`/groups/${frozen.data.id}/members`, 'POST', { endpointIds: [f.endpointId] }, f.admin)).status, 200);
  const off = await f.request(`/groups/${frozen.data.id}/auto-update`, 'PUT', { autoUpdate: false }, f.admin);
  assert.equal(off.status, 200); assert.equal(off.data.autoUpdate, false);
  assert.equal((await manifest()).autoUpdate, false);
  assert.equal((await f.request(`/groups/${frozen.data.id}/auto-update`, 'PUT', { autoUpdate: 'no' }, f.admin)).status, 400);
  // The permanent default group can be toggled too, even though it cannot be renamed.
  const defaultOff = await f.request('/groups/new-endpoints/auto-update', 'PUT', { autoUpdate: false }, f.admin);
  assert.equal(defaultOff.status, 200); assert.equal(defaultOff.data.autoUpdate, false);
  // Manual updates still work for a group with automatic updates off.
  assert.equal((await f.request(`/endpoints/${f.endpointId}/update-agent`, 'POST', { idempotencyKey: 'manual' }, f.admin)).status, 201);

  assert.equal((await f.request('/users', 'POST', { username: 'toggle-viewer', role: 'viewer', password: 'synthetic-user-password', currentPassword: f.password }, f.admin)).status, 201);
  const viewer = await f.login('toggle-viewer', 'synthetic-user-password');
  assert.equal((await f.request(`/groups/${frozen.data.id}/auto-update`, 'PUT', { autoUpdate: true }, viewer)).status, 403);
  assert.equal((await manifest()).autoUpdate, false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='group.auto_update.changed'").get().n, 2);
  // Deleting the group moves its computers to the destination and they follow that group's setting.
  const on = await f.request('/groups/new-endpoints/auto-update', 'PUT', { autoUpdate: true }, f.admin);
  assert.equal(on.status, 200);
  assert.equal((await f.request(`/groups/${frozen.data.id}`, 'DELETE', {}, f.admin)).status, 200);
  assert.equal((await manifest()).autoUpdate, true);
});
