import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { mountSupport, relayFrame } from '../src/support.mjs';
import { listen } from './listen.mjs';
import { hashToken } from '../src/security.mjs';

const ORIGIN = 'http://support.test';
const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out: ${description}`); await delay(10); }
}
async function fixture(t, options = {}) {
  const service = createApp({ databasePath: options.databasePath || ':memory:', supportValidationIntervalMs: 100,
    env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'support-test-password', PUBLIC_ORIGIN: ORIGIN } });
  const server = await listen(service.app); service.attachSupport(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    service.stopSupport(); for (const ws of sockets) ws.terminate();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close();
  });
  const request = async (path, method = 'GET', body, session = {}, headers = {}) => {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...session, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login = async (username = 'admin', password = 'support-test-password') => {
    const result = await request('/auth/login', 'POST', { username, password }); assert.equal(result.status, 200);
    return { Cookie: result.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': result.data.csrfToken };
  };
  const admin = await login();
  let next = 0;
  const enroll = async (version = '0.1.6') => {
    const token = await request('/enrollment-tokens', 'POST', { label: 'support test', maxUses: 1, expiresInHours: 1 }, admin);
    const endpoint = (await request('/agent/enroll', 'POST', { hostname: `TEST-${++next}`, deviceId: `test-${next}`, enrollmentToken: token.data.token })).data;
    const auth = { Authorization: `Bearer ${endpoint.agentToken}` };
    await request('/agent/checkin', 'POST', { inventory: { hostname: `TEST-${next}`, agentVersion: version } }, auth);
    return { ...endpoint, auth };
  };
  let idem = 0;
  const create = async (endpoint, session = admin, extra = {}) => request('/support/sessions', 'POST', {
    endpointId: endpoint.endpointId, requestedControl: true, idempotencyKey: `support-${++idem}`, ...extra }, session);
  const launch = async (endpoint, support) => {
    const job = (await request('/agent/jobs/claim', 'POST', {}, endpoint.auth)).data.job;
    assert.equal(job.id, support.jobId); assert.equal(job.kind, 'remote_support');
    assert.equal((await request(`/agent/jobs/${job.id}/start`, 'POST', { dispatchToken: job.dispatchToken }, endpoint.auth)).data.mayExecute, true);
    const grant = await request(`/agent/support/${support.id}/claim`, 'POST', { jobId: job.id }, endpoint.auth);
    assert.equal(grant.status, 200); return grant.data;
  };
  const connect = (support, options = {}, protocols) => new Promise(resolve => {
    const ws = new WebSocket(base.replace(/^http/, 'ws') + `/api/support/${support.id}/stream`, protocols, options);
    sockets.push(ws); ws.messages = [];
    ws.on('message', (data, binary) => ws.messages.push(binary ? Buffer.from(data) : JSON.parse(data.toString())));
    ws.on('error', () => {});
    ws.once('open', () => resolve({ ws, status: 101 }));
    ws.once('unexpected-response', (_, response) => { response.resume(); ws.terminate(); resolve({ ws, status: response.statusCode }); });
  });
  const ticket = async (support, session = admin) => (await request(`/support/sessions/${support.id}/ticket`, 'POST', {}, session)).data.ticket;
  const browser = async (support, session = admin) => connect(support, { headers: { Origin: ORIGIN, Cookie: session.Cookie } }, ['rmm-support', `ticket.${await ticket(support, session)}`]);
  const device = (support, grant) => connect(support, { headers: { Authorization: `Bearer ${grant.credential}` } });
  return { ...service, request, admin, enroll, create, launch, login, connect, ticket, browser, device };
}

test('support HTTP authorization, internal launch, idempotency, ownership, old agents and one-time credential', async t => {
  const f = await fixture(t); const a = await f.enroll(); const b = await f.enroll();
  assert.equal((await f.create(a, {})).status, 401);
  assert.equal((await f.create(a, { Cookie: f.admin.Cookie })).status, 403);
  assert.equal((await f.create(await f.enroll('0.1.5'))).status, 409);
  assert.equal((await f.request('/jobs', 'POST', { endpointIds: [a.endpointId], kind: 'remote_support', payload: { sessionId: 'fake' } }, f.admin)).status, 400);
  const body = { endpointId: a.endpointId, requestedControl: true, idempotencyKey: 'same-support' };
  const session = (await f.request('/support/sessions', 'POST', body, f.admin)).data;
  assert.equal(session.status, 'requested'); assert.equal(session.controlApproved, false);
  assert.equal((await f.request('/support/sessions', 'POST', body, f.admin)).data.id, session.id);
  assert.equal((await f.request('/support/sessions', 'POST', { ...body, requestedControl: false }, f.admin)).status, 409);
  assert.equal((await f.create(a)).status, 409);
  const claimPath = `/agent/support/${session.id}/claim`;
  assert.equal((await f.request(claimPath, 'POST', { jobId: session.jobId }, a.auth)).status, 409);
  assert.equal((await f.request(claimPath, 'POST', { jobId: session.jobId }, b.auth)).status, 404);
  const grant = await f.launch(a, session);
  assert.equal(grant.requestedControl, true); assert.equal(grant.credential.length, 43);
  assert.equal((await f.request(claimPath, 'POST', { jobId: session.jobId }, a.auth)).status, 409);
  const stored = f.db.prepare('SELECT * FROM support_sessions WHERE id=?').get(session.id);
  assert.equal(stored.credential_hash, hashToken(grant.credential)); assert.ok(!JSON.stringify(stored).includes(grant.credential));
  await f.request('/users', 'POST', { username: 'other', email: '', role: 'admin', password: 'other-test-pass', currentPassword: 'support-test-password' }, f.admin);
  const other = await f.login('other', 'other-test-pass');
  for (const [path, method] of [[`/support/sessions/${session.id}`, 'GET'], [`/support/sessions/${session.id}/ticket`, 'POST'], [`/support/sessions/${session.id}/stop`, 'POST']])
    assert.equal((await f.request(path, method, method === 'POST' ? {} : undefined, other)).status, 404);
  await f.request('/users', 'POST', { username: 'viewer', email: '', role: 'viewer', password: 'viewer-test-pass', currentPassword: 'support-test-password' }, f.admin);
  const viewer = await f.login('viewer', 'viewer-test-pass'); assert.equal((await f.create(b, viewer)).status, 403);
});

test('websocket origin/ticket/device scopes and no capture or input before consent; pause and stop fail closed', async t => {
  const f = await fixture(t); const a = await f.enroll(); const session = (await f.create(a)).data; const grant = await f.launch(a, session);
  const scopedTicket = await f.ticket(session);
  assert.equal((await f.connect(session, { headers: { Origin: 'http://evil.test', Cookie: f.admin.Cookie } }, ['rmm-support', `ticket.${scopedTicket}`])).status, 403);
  assert.equal((await f.connect(session, { headers: { Origin: ORIGIN } }, ['rmm-support', `ticket.${scopedTicket}`])).status, 403);
  assert.equal((await f.connect(session, { headers: { Authorization: `Bearer ${a.agentToken}` } })).status, 403);
  const client = (await f.connect(session, { headers: { Origin: ORIGIN, Cookie: f.admin.Cookie } }, ['rmm-support', `ticket.${scopedTicket}`])).ws;
  assert.equal(client.protocol, 'rmm-support');
  assert.equal(f.db.prepare('SELECT count(*) n FROM support_tickets WHERE support_id=?').get(session.id).n, 0, 'ticket durably consumed');
  assert.equal((await f.connect(session, { headers: { Origin: ORIGIN, Cookie: f.admin.Cookie } }, ['rmm-support', `ticket.${scopedTicket}`])).status, 403);
  const dev = (await f.device(session, grant)).ws;
  assert.equal((await f.device(session, grant)).status, 403);
  client.send(JSON.stringify({ type: 'input', action: 'keyDown', key: 'KeyA' })); dev.send(jpeg);
  await delay(40); assert.equal(client.messages.filter(Buffer.isBuffer).length, 0); assert.equal(dev.messages.filter(m => m.type === 'input').length, 0);
  dev.send(JSON.stringify({ type: 'consent', approved: true, control: true, userName: 'TEST\\Staff', decision: 'automatic' }));
  await until(() => client.messages.some(m => m.session?.status === 'active' && m.session.controlApproved), 'staff consent activates');
  dev.send(JSON.stringify({ type: 'display', width: 1920, height: 1080 })); dev.send(jpeg);
  await until(() => client.messages.some(Buffer.isBuffer), 'live JPEG');
  assert.deepEqual(client.messages.find(Buffer.isBuffer), jpeg); assert.equal(client.messages.find(m => m.type === 'display').width, 1920);
  client.send(JSON.stringify({ type: 'input', action: 'move', x: .25, y: .75 }));
  client.send(JSON.stringify({ type: 'input', action: 'keyDown', key: 'KeyA' }));
  await until(() => dev.messages.some(m => m.type === 'input' && m.key === 'KeyA'), 'control forwarded');
  dev.send(JSON.stringify({ type: 'paused', paused: true, reason: 'secure_desktop' }));
  await until(() => client.messages.some(m => m.paused), 'pause received');
  const inputCount = dev.messages.filter(m => m.type === 'input').length; const frameCount = client.messages.filter(Buffer.isBuffer).length;
  client.send(JSON.stringify({ type: 'input', action: 'keyUp', key: 'KeyA' })); dev.send(jpeg);
  await delay(40); assert.equal(dev.messages.filter(m => m.type === 'input').length, inputCount); assert.equal(client.messages.filter(Buffer.isBuffer).length, frameCount);
  assert.ok(dev.messages.some(m => m.action === 'releaseAll'));
  dev.send(JSON.stringify({ type: 'paused', paused: false }));
  await until(() => client.messages.at(-1)?.paused === false, 'local resume');
  client.send(JSON.stringify({ type: 'input', action: 'move', x: -1, y: .5 }));
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(session.id).status === 'failed', 'invalid input terminates');
  const audit = JSON.stringify(f.db.prepare("SELECT details FROM audit WHERE action LIKE 'support.%'").all());
  assert.ok(audit.includes('automatic')); assert.ok(!audit.includes('KeyA')); assert.ok(!audit.includes(grant.credential));
  assert.equal((await f.request(`/support/sessions/${session.id}/ticket`, 'POST', {}, f.admin)).status, 409);
});

test('view-only consent blocks input, decline terminates, disconnection prevents resume, and expiry/revocation end support', async t => {
  const f = await fixture(t); const a = await f.enroll();
  const session = (await f.create(a)).data; const grant = await f.launch(a, session);
  const client = (await f.browser(session)).ws; const dev = (await f.device(session, grant)).ws;
  dev.send(JSON.stringify({ type: 'consent', approved: true, control: false, userName: 'Staff' }));
  await until(() => client.messages.some(m => m.session?.status === 'active'), 'view only active');
  client.send(JSON.stringify({ type: 'input', action: 'down', x: .5, y: .5, button: 0 })); await delay(30);
  assert.ok(!dev.messages.some(m => m.type === 'input'));
  dev.close(); await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(session.id).status === 'stopped', 'device close');
  assert.equal((await f.device(session, grant)).status, 403);
  const declined = (await f.create(a)).data; const declinedGrant = await f.launch(a, declined); const declining = (await f.device(declined, declinedGrant)).ws;
  declining.send(JSON.stringify({ type: 'consent', approved: false, control: false, userName: 'Staff' }));
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(declined.id).status === 'declined', 'declined');
  const expiring = (await f.create(a)).data;
  f.db.prepare('UPDATE support_sessions SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', expiring.id);
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(expiring.id).status === 'expired', 'expiry sweep');
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(expiring.jobId).status, 'cancelled');
  const revoked = (await f.create(a)).data; const revokedGrant = await f.launch(a, revoked); const connected = (await f.device(revoked, revokedGrant)).ws;
  f.db.prepare('UPDATE users SET disabled=1').run();
  await until(() => connected.readyState === WebSocket.CLOSED, 'disabled account closes live socket');
  assert.equal(f.db.prepare('SELECT end_reason FROM support_sessions WHERE id=?').get(revoked.id).end_reason, 'operator_session_revoked');
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(revoked.jobId).status, 'running', 'running launch never requeued');
});

test('ticket expiry and login binding; logout and server shutdown terminate sessions without replay', async t => {
  const f = await fixture(t); const a = await f.enroll(); const session = (await f.create(a)).data;
  const expiredTicket = await f.ticket(session);
  f.db.prepare('UPDATE support_tickets SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  assert.equal((await f.connect(session, { headers: { Origin: ORIGIN, Cookie: f.admin.Cookie } }, ['rmm-support', `ticket.${expiredTicket}`])).status, 403);
  const loginAgain = await f.login();
  assert.equal((await f.request(`/support/sessions/${session.id}/ticket`, 'POST', {}, loginAgain)).status, 403);
  const grant = await f.launch(a, session); await f.device(session, grant);
  await f.request('/auth/logout', 'POST', {}, f.admin);
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(session.id).status === 'stopped', 'logout revokes session');
  const next = (await f.create(a, loginAgain)).data;
  f.stopSupport();
  assert.equal(f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(next.id).status, 'stopped');
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(next.jobId).status, 'cancelled');
});

test('live frame backpressure drops stale frames without queueing unbounded bytes', () => {
  const delivered = []; const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: frame => delivered.push(frame) };
  assert.equal(relayFrame(socket, jpeg, 16), true); socket.bufferedAmount = 17;
  assert.equal(relayFrame(socket, jpeg, 16), false); assert.deepEqual(delivered, [jpeg]);
  socket.readyState = WebSocket.CLOSED; socket.bufferedAmount = 0; assert.equal(relayFrame(socket, jpeg, 16), false);
});

test('failed launch, launch deadline and process restart terminate sessions and never requeue consumed launch jobs', async t => {
  const f = await fixture(t); const a = await f.enroll(); const b = await f.enroll();
  const failed = (await f.create(a)).data;
  f.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(failed.jobId);
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(failed.id).status === 'failed', 'failed launch releases endpoint');
  const timedOut = (await f.create(a)).data;
  f.db.prepare('UPDATE support_sessions SET created_at=? WHERE id=?').run(new Date(Date.now() - 121000).toISOString(), timedOut.id);
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(timedOut.id).status === 'failed', 'bounded launch deadline');
  assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(timedOut.jobId).status, 'cancelled');
  const consumed = (await f.create(a)).data; const queued = (await f.create(b)).data;
  await f.launch(a, consumed); f.stopSupport();
  // Model rows left by abrupt process loss, not a graceful shutdown. A fresh support
  // module must reconcile them even if no sockets from the old process exist.
  f.db.prepare("UPDATE support_sessions SET status='awaiting_consent',credential_hash='old-hash' WHERE id IN (?,?)").run(consumed.id, queued.id);
  f.db.prepare("UPDATE jobs SET status='queued',completed_at=NULL WHERE id=?").run(queued.jobId);
  const restarted = mountSupport({ db: f.db, audit: () => {}, publicOrigin: ORIGIN });
  try {
    const rows = f.db.prepare('SELECT status,end_reason,credential_hash FROM support_sessions WHERE id IN (?,?)').all(consumed.id, queued.id);
    assert.ok(rows.every(row => row.status === 'stopped' && row.end_reason === 'server_restarted' && row.credential_hash === null));
    assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(consumed.jobId).status, 'running');
    assert.equal(f.db.prepare('SELECT status FROM jobs WHERE id=?').get(queued.jobId).status, 'cancelled');
  } finally { restarted.shutdown(); }
});

test('admin support policy validates and audits settings while session and claim keep immutable policy snapshots', async t => {
  const f = await fixture(t); const a = await f.enroll(); const b = await f.enroll();
  assert.deepEqual((await f.request('/settings/support', 'GET', undefined, f.admin)).data, { approvalRequired: true, approvalSeconds: 15, showSessionDetails: true });
  const old = (await f.create(a)).data; assert.equal(old.approvalRequired, true); assert.equal(old.approvalSeconds, 15);
  for (const body of [ {}, { approvalRequired: false }, { approvalRequired: 0, approvalSeconds: 15 },
    { approvalRequired: true, approvalSeconds: 0 }, { approvalRequired: true, approvalSeconds: 301 },
    { approvalRequired: true, approvalSeconds: 1.5 }, { approvalRequired: true, approvalSeconds: '15' },
    { approvalRequired: true, approvalSeconds: 15, extra: true } ])
    assert.equal((await f.request('/settings/support', 'PATCH', body, f.admin)).status, 400);
  const next = { approvalRequired: false, approvalSeconds: 27, showSessionDetails: true };
  assert.equal((await f.request('/settings/support', 'PATCH', next, { Cookie: f.admin.Cookie })).status, 403);
  assert.equal((await f.request('/settings/support', 'PATCH', next, f.admin, { Origin: 'http://evil.test' })).status, 403);
  assert.deepEqual((await f.request('/settings/support', 'PATCH', next, f.admin)).data, next);
  const audit = JSON.parse(f.db.prepare("SELECT details FROM audit WHERE action='support.settings.updated'").get().details);
  assert.deepEqual(audit, { previous: { approvalRequired: true, approvalSeconds: 15, showSessionDetails: true }, next });
  const oldView = (await f.request(`/support/sessions/${old.id}`, 'GET', undefined, f.admin)).data;
  assert.equal(oldView.approvalRequired, true); assert.equal(oldView.approvalSeconds, 15);
  const oldGrant = await f.launch(a, old); assert.equal(oldGrant.approvalRequired, true); assert.equal(oldGrant.approvalSeconds, 15);
  const current = (await f.create(b)).data;
  assert.equal(current.approvalRequired, false); assert.equal(current.approvalSeconds, 27);
  const currentGrant = await f.launch(b, current); assert.equal(currentGrant.approvalRequired, false); assert.equal(currentGrant.approvalSeconds, 27);
  const dev = (await f.device(current, currentGrant)).ws;
  dev.send(JSON.stringify({ type: 'consent', approved: true, control: true, userName: 'VM-User', decision: 'unattended' }));
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(current.id).status === 'active', 'unattended policy accepted');
  for (const role of ['operator', 'viewer']) {
    await f.request('/users', 'POST', { username: role, email: '', role, password: 'role-test-password', currentPassword: 'support-test-password' }, f.admin);
    const user = await f.login(role, 'role-test-password');
    assert.equal((await f.request('/settings/support', 'GET', undefined, user)).status, 403);
    assert.equal((await f.request('/settings/support', 'PATCH', next, user)).status, 403);
  }
  await f.request('/settings/support', 'PATCH', { approvalRequired: true, approvalSeconds: 300 }, f.admin);
  const c = await f.enroll(); const long = (await f.create(c)).data; await f.launch(c, long);
  f.db.prepare('UPDATE support_sessions SET created_at=? WHERE id=?').run(new Date(Date.now() - 150000).toISOString(), long.id);
  await delay(150); assert.equal(f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(long.id).status, 'awaiting_consent', 'configured countdown fits within deadline');
});

test('support policy persists across full app/database reopen', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'rmm-support-policy-')); const filename = join(folder, 'test.db');
  t.after(() => {
    const target = resolve(folder); assert.ok(target.startsWith(resolve(tmpdir()) + '\\rmm-support-policy-') || target.startsWith(resolve(tmpdir()) + '/rmm-support-policy-'));
    rmSync(target, { recursive: true, force: true });
  });
  await t.test('save', async child => {
    const f = await fixture(child, { databasePath: filename });
    assert.equal((await f.request('/settings/support', 'PATCH', { approvalRequired: false, approvalSeconds: 300 }, f.admin)).status, 200);
  });
  await t.test('reload', async child => {
    const f = await fixture(child, { databasePath: filename });
    assert.deepEqual((await f.request('/settings/support', 'GET', undefined, f.admin)).data, { approvalRequired: false, approvalSeconds: 300, showSessionDetails: true });
    assert.equal(f.db.prepare('PRAGMA user_version').get().user_version, 9);
  });
});

test('native secure-attention relay requires capability, staff control, live controller and normal desktop, and rate-limits requests', async t => {
  const f = await fixture(t); const a = await f.enroll(); const session = (await f.create(a)).data; const grant = await f.launch(a, session);
  const browser = (await f.browser(session)).ws; const dev = (await f.device(session, grant)).ws;
  const requestAttention = () => { const requestId = randomUUID(); browser.send(JSON.stringify({ type: 'secureAttention', requestId })); return requestId; };
  const beforeConsent = requestAttention();
  await until(() => browser.messages.some(m => m.type === 'secureAttentionResult' && m.requestId === beforeConsent), 'preconsent SAS denied');
  assert.ok(!dev.messages.some(m => m.type === 'secureAttention'));
  dev.send(JSON.stringify({ type: 'consent', approved: true, control: true, userName: 'Staff' }));
  await until(() => browser.messages.some(m => m.session?.status === 'active'), 'control active');
  const unavailable = requestAttention();
  await until(() => browser.messages.some(m => m.requestId === unavailable && m.success === false), 'missing capability denied');
  dev.send(JSON.stringify({ type: 'capabilities', secureAttention: true, secureDesktop: false }));
  await until(() => browser.messages.some(m => m.type === 'capabilities' && m.secureAttention), 'native capability forwarded');
  const accepted = requestAttention();
  await until(() => dev.messages.some(m => m.type === 'secureAttention' && m.requestId === accepted), 'native request forwarded');
  dev.send(JSON.stringify({ type: 'secureAttentionResult', requestId: accepted, success: true, message: 'sent' }));
  await until(() => browser.messages.some(m => m.requestId === accepted && m.success === true), 'result forwarded');
  assert.match(browser.messages.find(m => m.requestId === accepted && m.success).message, /Secure desktop viewing is unavailable/);
  const throttled = requestAttention();
  await until(() => browser.messages.some(m => m.requestId === throttled && m.success === false), 'SAS rate limited');
  assert.equal(dev.messages.filter(m => m.type === 'secureAttention').length, 1);
  dev.send(JSON.stringify({ type: 'paused', paused: true }));
  await until(() => browser.messages.at(-1)?.paused === true, 'desktop paused');
  const paused = requestAttention();
  await until(() => browser.messages.some(m => m.requestId === paused && m.success === false), 'paused SAS denied');
  assert.equal(dev.messages.filter(m => m.type === 'secureAttention').length, 1);
  const audits = f.db.prepare("SELECT action,details FROM audit WHERE action LIKE 'support.secureattention.%'").all();
  assert.equal(audits.filter(row => row.action === 'support.secureattention.requested').length, 1);
  assert.ok(audits.some(row => row.action === 'support.secureattention.result' && JSON.parse(row.details).result === 'sent'));
  dev.send(JSON.stringify({ type: 'secureAttentionResult', requestId: randomUUID(), success: false, message: 'RAW-SECRET-EXCEPTION' }));
  await until(() => f.db.prepare('SELECT status FROM support_sessions WHERE id=?').get(session.id).status === 'failed', 'unwhitelisted result rejected');
  assert.ok(!JSON.stringify(browser.messages).includes('RAW-SECRET-EXCEPTION'));
  const b = await f.enroll(); const view = (await f.create(b)).data; const viewGrant = await f.launch(b, view);
  const viewer = (await f.browser(view)).ws; const viewDevice = (await f.device(view, viewGrant)).ws;
  viewDevice.send(JSON.stringify({ type: 'capabilities', secureAttention: true, secureDesktop: false }));
  viewDevice.send(JSON.stringify({ type: 'consent', approved: true, control: false, userName: 'Staff' }));
  await until(() => viewer.messages.some(m => m.session?.status === 'active'), 'view-only session active');
  const viewOnlyId = randomUUID(); viewer.send(JSON.stringify({ type: 'secureAttention', requestId: viewOnlyId }));
  await until(() => viewer.messages.some(m => m.requestId === viewOnlyId && m.success === false), 'view-only SAS denied');
  assert.ok(!viewDevice.messages.some(m => m.type === 'secureAttention'));
});

test('session-details policy is independent of approval (all four combinations), snapshotted per session, and requires agent 0.1.7 when hidden', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/settings/support', 'PATCH', { approvalRequired: true, approvalSeconds: 15, showSessionDetails: 'no' }, f.admin)).status, 400);
  for (const approvalRequired of [true, false]) for (const showSessionDetails of [true, false]) {
    const body = { approvalRequired, approvalSeconds: 12, showSessionDetails };
    assert.deepEqual((await f.request('/settings/support', 'PATCH', body, f.admin)).data, body);
    assert.deepEqual((await f.request('/settings/support', 'GET', undefined, f.admin)).data, body);
  }
  // Both off is now stored. Omitting showSessionDetails (older clients) keeps the stored choice.
  assert.equal((await f.request('/settings/support', 'PATCH', { approvalRequired: false, approvalSeconds: 9 }, f.admin)).data.showSessionDetails, false);
  const refused = await f.create(await f.enroll('0.1.6'));
  assert.equal(refused.status, 409); assert.match(refused.data.error, /0\.1\.7/);
  const modern = await f.enroll('0.1.7');
  const hidden = (await f.create(modern)).data;
  assert.equal(hidden.showSessionDetails, false); assert.equal(hidden.approvalRequired, false);
  const grant = await f.launch(modern, hidden);
  assert.equal(grant.showSessionDetails, false); assert.equal(grant.approvalRequired, false);
  await f.request('/settings/support', 'PATCH', { approvalRequired: true, approvalSeconds: 15, showSessionDetails: true }, f.admin);
  assert.equal((await f.request(`/support/sessions/${hidden.id}`, 'GET', undefined, f.admin)).data.showSessionDetails, false, 'existing session keeps its snapshot');
  const visible = (await f.create(await f.enroll('0.1.6'))).data;
  assert.equal(visible.showSessionDetails, true, 'old agents still work while the indicator is on');
  const audits = f.db.prepare("SELECT details FROM audit WHERE action='support.settings.updated'").all().map(row => JSON.parse(row.details).next);
  assert.ok(audits.some(next => next.approvalRequired === false && next.showSessionDetails === false), 'both-off change audited');
});

test('monitor selection validates displays, pauses frames and input while switching, and resumes only on matching metadata', async t => {
  const f = await fixture(t);
  const displays = [{ id: 'DISPLAY1', name: 'Primary', width: 1920, height: 1080, isPrimary: true }, { id: 'DISPLAY2', name: 'Left', width: 1280, height: 1024, isPrimary: false }];
  const start = async () => {
    const endpoint = await f.enroll('0.1.7'); const session = (await f.create(endpoint)).data; const grant = await f.launch(endpoint, session);
    const browser = (await f.browser(session)).ws; const dev = (await f.device(session, grant)).ws;
    dev.send(JSON.stringify({ type: 'consent', approved: true, control: true, userName: 'TEST\\Staff', decision: 'automatic' }));
    await until(() => browser.messages.some(m => m.session?.status === 'active'), 'active');
    return { browser, dev, status: () => f.db.prepare('SELECT status,end_reason FROM support_sessions WHERE id=?').get(session.id) };
  };
  const advertised = async s => {
    s.dev.send(JSON.stringify({ type: 'displays', displays }));
    await until(() => s.browser.messages.some(m => m.type === 'displays' && m.displays.length === 2), 'display list reaches the browser');
  };
  const s = await start(); await advertised(s);
  s.dev.send(JSON.stringify({ type: 'display', id: 'DISPLAY1', width: 1920, height: 1080 })); s.dev.send(jpeg);
  await until(() => s.browser.messages.some(Buffer.isBuffer), 'first monitor frame');
  s.browser.send(JSON.stringify({ type: 'selectDisplay', displayId: 'DISPLAY2' }));
  await until(() => s.dev.messages.some(m => m.type === 'selectDisplay' && m.displayId === 'DISPLAY2'), 'selection forwarded');
  assert.ok(s.dev.messages.some(m => m.action === 'releaseAll'), 'held keys released before switching');
  await until(() => s.browser.messages.some(m => m.paused === true), 'browser told the stream is paused');
  const frames = s.browser.messages.filter(Buffer.isBuffer).length;
  const inputs = () => s.dev.messages.filter(m => m.type === 'input' && m.action !== 'releaseAll').length;
  const before = inputs();
  s.dev.send(jpeg); s.browser.send(JSON.stringify({ type: 'input', action: 'move', x: .5, y: .5 }));
  await delay(60);
  assert.equal(s.browser.messages.filter(Buffer.isBuffer).length, frames, 'no frames while switching');
  assert.equal(inputs(), before, 'no input while switching');
  s.dev.send(JSON.stringify({ type: 'display', id: 'DISPLAY2', width: 1280, height: 1024 }));
  s.dev.send(JSON.stringify({ type: 'paused', paused: false }));
  await until(() => s.browser.messages.at(-1)?.paused === false, 'resumed after matching metadata');
  assert.ok(s.browser.messages.some(m => m.type === 'display' && m.id === 'DISPLAY2' && m.width === 1280));
  s.dev.send(jpeg); await until(() => s.browser.messages.filter(Buffer.isBuffer).length > frames, 'frames flow again');
  s.browser.send(JSON.stringify({ type: 'input', action: 'move', x: .25, y: .25 }));
  await until(() => s.dev.messages.some(m => m.type === 'input' && m.action === 'move' && m.x === .25), 'input flows again');
  assert.ok(f.db.prepare("SELECT count(*) n FROM audit WHERE action='support.display.selected'").get().n >= 1, 'monitor switch audited');

  // Resuming before confirming the new monitor, confirming a different one, or choosing an
  // unknown one all fail closed.
  const early = await start(); await advertised(early);
  early.browser.send(JSON.stringify({ type: 'selectDisplay', displayId: 'DISPLAY2' }));
  await until(() => early.dev.messages.some(m => m.type === 'selectDisplay'), 'forwarded');
  early.dev.send(JSON.stringify({ type: 'paused', paused: false }));
  await until(() => early.status().end_reason === 'display_switch_unconfirmed', 'unconfirmed resume ends the session');
  const mismatch = await start(); await advertised(mismatch);
  mismatch.browser.send(JSON.stringify({ type: 'selectDisplay', displayId: 'DISPLAY2' }));
  await until(() => mismatch.dev.messages.some(m => m.type === 'selectDisplay'), 'forwarded');
  mismatch.dev.send(JSON.stringify({ type: 'display', id: 'DISPLAY1', width: 1920, height: 1080 }));
  await until(() => mismatch.status().end_reason === 'display_switch_mismatch', 'wrong monitor ends the session');
  const unknown = await start(); await advertised(unknown);
  unknown.browser.send(JSON.stringify({ type: 'selectDisplay', displayId: 'NOT-A-DISPLAY' }));
  await until(() => unknown.status().end_reason === 'invalid_display_selection', 'unknown monitor selection ends the session');
  for (const bad of [[], Array.from({ length: 17 }, (_, i) => ({ ...displays[0], id: 'D' + i })), [displays[0], displays[0]], [{ ...displays[0], width: 0 }]]) {
    const session = await start(); session.dev.send(JSON.stringify({ type: 'displays', displays: bad }));
    await until(() => session.status().end_reason === 'invalid_displays', 'invalid display advertisement ends the session');
  }
});
