import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';

test('tokenless join requests wait for approval, issue rotating credentials, and honor deny/revoke', async t => {
  const password = 'isolated-join-password';
  const service = createApp({ databasePath: ':memory:', env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password } });
  const server = await listen(service.app);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, session, bearer } = {}) => {
    const headers = { 'Content-Type': 'application/json', Origin: origin };
    if (session) Object.assign(headers, { Cookie: session.cookie, 'X-CSRF-Token': session.csrf });
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetch(origin + '/api' + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await call('/auth/login', { method: 'POST', body: { username: 'admin', password } });
  const admin = { cookie: login.cookie, csrf: login.data.csrfToken };

  const deviceId = randomUUID(), joinSecret = 'a'.repeat(43);
  const join = (body = {}) => call('/agent/join', { method: 'POST', body: { deviceId, joinSecret, hostname: 'CIRC-DESK-01', osName: 'Windows 11 Pro', ...body } });
  assert.equal((await join()).data.status, 'pending');
  assert.equal((await join()).data.status, 'pending', 'polling while pending must not create duplicates');
  assert.equal((await join({ joinSecret: 'b'.repeat(43) })).status, 403, 'another secret cannot hijack a request');
  assert.equal((await join({ joinSecret: 'short' })).status, 400);
  assert.equal((await join({ deviceId: 'not-a-uuid' })).status, 400);
  assert.equal((await call('/join-requests')).status, 401, 'listing requires sign-in');

  const listed = await call('/join-requests', { session: admin });
  assert.equal(listed.data.length, 1);
  const request = listed.data[0];
  assert.equal(request.hostname, 'CIRC-DESK-01'); assert.equal(request.status, 'pending'); assert.equal(request.details.osName, 'Windows 11 Pro');
  assert.ok(!('secretHash' in request) && !JSON.stringify(listed.data).includes(joinSecret), 'secret material is never returned');
  assert.equal((await call(`/join-requests/${request.id}/approve`, { method: 'POST', body: {}, session: { ...admin, csrf: 'wrong' } })).status, 403, 'CSRF enforced');

  assert.equal((await call(`/join-requests/${request.id}/approve`, { method: 'POST', body: {}, session: admin })).data.status, 'approved');
  const first = await join();
  assert.equal(first.data.status, 'approved'); assert.ok(first.data.agentToken && first.data.endpointId);
  assert.equal((await call('/agent/checkin', { method: 'POST', body: { bootId: 'x' }, bearer: first.data.agentToken })).status, 200);
  // Lost response / disk rollback recovery: a second authenticated poll rotates the credential.
  const second = await join();
  assert.equal(second.data.endpointId, first.data.endpointId);
  assert.notEqual(second.data.agentToken, first.data.agentToken);
  assert.equal((await call('/agent/checkin', { method: 'POST', body: { bootId: 'x' }, bearer: first.data.agentToken })).status, 401, 'old token stops working');
  assert.equal((await call('/agent/checkin', { method: 'POST', body: { bootId: 'x' }, bearer: second.data.agentToken })).status, 200);
  assert.equal((await call(`/join-requests/${request.id}/deny`, { method: 'POST', body: {}, session: admin })).status, 409, 'joined computers are revoked, not denied');
  // Uninstall retires the endpoint itself: queued work is cancelled and the credential stops working.
  const queued = await call('/jobs', { method: 'POST', session: admin, body: { endpointIds: [second.data.endpointId], kind: 'inventory', payload: {}, idempotencyKey: randomUUID() } });
  assert.equal(queued.status, 201);
  assert.equal((await call('/agent/retire', { method: 'POST', body: {}, bearer: second.data.agentToken })).status, 200);
  assert.equal((await call('/agent/checkin', { method: 'POST', body: { bootId: 'x' }, bearer: second.data.agentToken })).status, 401, 'retired credential stops working');
  assert.equal((await call(`/jobs/${queued.data.jobs[0].id}`, { session: admin })).data.status, 'cancelled', 'queued work is never dispatched after uninstall');
  assert.ok((await call(`/endpoints/${second.data.endpointId}`, { session: admin })).data.revoked);
  assert.equal((await call(`/endpoints/${first.data.endpointId}/revoke`, { method: 'POST', body: {}, session: admin })).status, 200);
  const afterRevoke = await join();
  assert.equal(afterRevoke.data.status, 'denied'); assert.ok(!afterRevoke.data.agentToken, 'a revoked endpoint is never re-issued a credential');

  // Deny path: no credential, and a later approval still works.
  const other = randomUUID();
  const otherJoin = () => call('/agent/join', { method: 'POST', body: { deviceId: other, joinSecret: 'c'.repeat(43), hostname: 'UNKNOWN-PC' } });
  await otherJoin();
  const otherRequest = (await call('/join-requests', { session: admin })).data.find(row => row.deviceId === other);
  assert.equal((await call(`/join-requests/${otherRequest.id}/deny`, { method: 'POST', body: {}, session: admin })).data.status, 'denied');
  const denied = await otherJoin();
  assert.equal(denied.data.status, 'denied'); assert.ok(!denied.data.agentToken);
  assert.equal((await call(`/join-requests/${otherRequest.id}`, { method: 'DELETE', session: admin })).status, 200);
  assert.equal((await otherJoin()).data.status, 'pending', 'removing a request lets the device ask again');

  const actions = service.db.prepare("SELECT action FROM audit WHERE action LIKE 'agent.join.%'").all().map(row => row.action);
  for (const action of ['agent.join.requested', 'agent.join.approved', 'agent.join.credential.issued', 'agent.join.denied', 'agent.join.removed']) assert.ok(actions.includes(action), action);
});
