import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { contentDisposition } from '../src/files.mjs';
import { listen } from './listen.mjs';

async function harness(t, options = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'rmm-files-test-'));
  const password = 'isolated-files-password';
  const service = createApp({ databasePath: join(folder, 'rmm.db'), env: { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: password }, ...options });
  const server = await listen(service.app);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close();
    assert.ok(folder.startsWith(join(tmpdir(), 'rmm-files-test-')));
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, session, bearer, raw, signal } = {}) => {
    const headers = { Origin: origin };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (raw !== undefined) headers['Content-Type'] = 'application/octet-stream';
    if (session) Object.assign(headers, { Cookie: session.cookie, 'X-CSRF-Token': session.csrf });
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const response = await fetch(origin + '/api' + path, { method, headers, signal, ...(body !== undefined ? { body: JSON.stringify(body) } : raw !== undefined ? { body: raw } : {}) });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = async (username, pass) => { const result = await call('/auth/login', { method: 'POST', body: { username, password: pass } }); return { cookie: result.cookie, csrf: result.data.csrfToken }; };
  const admin = await login('admin', password);
  // Enroll one endpoint through the token path.
  const token = (await call('/enrollment-tokens', { method: 'POST', session: admin, body: { label: 'files test' } })).data.token;
  const enrolled = (await call('/agent/enroll', { method: 'POST', body: { enrollmentToken: token, deviceId: randomUUID(), hostname: 'BRANCH-PC-01' } })).data;
  await call('/agent/checkin', { method: 'POST', bearer: enrolled.agentToken, body: { bootId: 'boot' } });
  const queue = (payload, extra = {}) => call('/jobs', { method: 'POST', session: admin, body: { endpointIds: [enrolled.endpointId], kind: 'files', payload, idempotencyKey: randomUUID(), ...extra } });
  return { service, folder, call, login, admin, password, enrolled, queue };
}

test('job claims long-poll for new work, keep immediate behavior for old agents, and never consume a job for a gone client', async t => {
  const { call, enrolled, queue } = await harness(t);
  const bearer = enrolled.agentToken;

  let started = Date.now();
  const immediate = await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} });
  assert.equal(immediate.data.job, null);
  assert.ok(Date.now() - started < 1000, 'an old-style claim must answer immediately');
  assert.equal((await call('/agent/jobs/claim', { method: 'POST', bearer, body: { waitSeconds: 0 } })).status, 400);
  assert.equal((await call('/agent/jobs/claim', { method: 'POST', bearer, body: { waitSeconds: 26 } })).status, 400);

  started = Date.now();
  const waiting = call('/agent/jobs/claim', { method: 'POST', bearer, body: { waitSeconds: 20 } });
  await new Promise(resolve => setTimeout(resolve, 300));
  const queued = await queue({ action: 'list', path: 'C:\\Users' });
  assert.equal(queued.status, 201);
  const claimed = await waiting;
  assert.equal(claimed.data.job?.id, queued.data.jobs[0].id, 'the waiting claim receives the job queued after it started');
  assert.ok(Date.now() - started < 2000, `long-poll answered after ${Date.now() - started} ms`);
  assert.equal((await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} })).data.job, null, 'a claimed job is never dispatched again');

  started = Date.now();
  const empty = await call('/agent/jobs/claim', { method: 'POST', bearer, body: { waitSeconds: 1 } });
  assert.equal(empty.data.job, null);
  assert.ok(Date.now() - started >= 900, 'an empty long-poll waits for its window');

  // A client that disconnects while waiting must not consume a job queued afterwards.
  const controller = new AbortController();
  const abandoned = call('/agent/jobs/claim', { method: 'POST', bearer, body: { waitSeconds: 20 }, signal: controller.signal }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 200));
  controller.abort();
  await abandoned;
  await new Promise(resolve => setTimeout(resolve, 200));
  const later = await queue({ action: 'list', path: '' });
  await new Promise(resolve => setTimeout(resolve, 200));
  const next = await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} });
  assert.equal(next.data.job?.id, later.data.jobs[0].id, 'the job stayed queued for the next live claim');
});

test('files payloads are validated, audited, and viewers cannot queue them', async t => {
  const { call, admin, queue, service, login } = await harness(t);
  for (const payload of [
    { action: 'format' }, { action: 'list', path: '\\\\server\\share' }, { action: 'list', path: 'relative' }, { action: 'list', path: 'C:\\x\\*.txt' },
    { action: 'list', path: 'C:\\x\\file.txt:stream' }, { action: 'delete', paths: [] }, { action: 'delete', paths: ['C:\\a', 'c:\\A'] },
    { action: 'delete', paths: ['C:\\a'], recursive: 'yes' }, { action: 'move', sources: ['C:\\a'] }, { action: 'copy', sources: ['C:\\a'], destinationDirectory: '\\\\?\\C:\\' },
    { action: 'rename', path: 'C:\\a', newName: 'x\\y' }, { action: 'rename', path: 'C:\\a', newName: 'CON' }, { action: 'rename', path: 'C:\\a', newName: 'dot.' },
    { action: 'download', path: 'C:/forward/slash' }, { action: 'delete', paths: Array.from({ length: 501 }, (_, index) => `C:\\f${index}`) }
  ]) assert.equal((await queue(payload)).status, 400, JSON.stringify(payload).slice(0, 120));
  const deletion = await queue({ action: 'delete', paths: ['C:\\Users\\Public\\old.txt', 'D:\\Temp'], recursive: true });
  assert.equal(deletion.status, 201);
  assert.deepEqual(deletion.data.jobs[0].payload, { action: 'delete', paths: ['C:\\Users\\Public\\old.txt', 'D:\\Temp'], recursive: true });
  assert.deepEqual((await queue({ action: 'list' })).data.jobs[0].payload, { action: 'list', path: '' });
  assert.deepEqual((await queue({ action: 'copy', sources: ['C:\\a'], destinationDirectory: 'C:\\b' })).data.jobs[0].payload, { action: 'copy', sources: ['C:\\a'], destinationDirectory: 'C:\\b', overwrite: false });
  const row = service.db.prepare("SELECT * FROM audit WHERE action='files.delete'").get();
  assert.ok(row && JSON.parse(row.details).paths.includes('D:\\Temp'), 'file operations are audited with their paths');

  const created = await call('/users', { method: 'POST', session: admin, body: { username: 'viewer1', email: '', role: 'viewer', password: 'viewer-password-1', currentPassword: 'isolated-files-password' } });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const viewer = await login('viewer1', 'viewer-password-1');
  const endpointId = deletion.data.jobs[0].endpointId;
  assert.equal((await call('/jobs', { method: 'POST', session: viewer, body: { endpointIds: [endpointId], kind: 'files', payload: { action: 'list', path: '' } } })).status, 403);
});

test('download transfer stores exact bytes on disk, verifies SHA-256, streams an attachment, enforces caps and expires', async t => {
  const { call, admin, queue, enrolled, folder, service, login } = await harness(t, { maxFileBytes: 6 * 1024 * 1024, maxTotalFileBytes: 8 * 1024 * 1024 });
  const bearer = enrolled.agentToken;
  const claimStart = async () => {
    const job = (await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} })).data.job;
    assert.equal((await call(`/agent/jobs/${job.id}/start`, { method: 'POST', bearer, body: { dispatchToken: job.dispatchToken } })).data.mayExecute, true);
    return job;
  };
  const bytes = randomBytes(5 * 1024 * 1024 + 321);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const parts = [bytes.subarray(0, 4 * 1024 * 1024), bytes.subarray(4 * 1024 * 1024)];

  // Chunks are refused before start authorization and for jobs that are not downloads.
  const listJob = (await queue({ action: 'list', path: 'C:\\' })).data.jobs[0];
  await claimStart();
  assert.equal((await call(`/agent/jobs/${listJob.id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).status, 409);
  const queued = (await queue({ action: 'download', path: 'C:\\Users\\Public\\Reports\\quarterly ünï.pdf' })).data.jobs[0];
  const early = (await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} })).data.job;
  assert.equal((await call(`/agent/jobs/${early.id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).status, 409, 'no bytes before start authorization');
  assert.equal((await call(`/agent/jobs/${early.id}/start`, { method: 'POST', bearer, body: { dispatchToken: early.dispatchToken } })).data.mayExecute, true);
  const id = queued.id;

  assert.equal((await call(`/agent/jobs/${id}/file/1`, { method: 'PUT', bearer, raw: parts[1] })).status, 409, 'gap rejected');
  assert.equal((await call(`/agent/jobs/${id}/file/0`, { method: 'PUT', bearer, raw: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413, 'chunks above 4 MiB rejected');
  assert.equal((await call(`/agent/jobs/${id}/file/0`, { method: 'PUT', raw: parts[0] })).status, 401, 'agent authentication required');
  assert.equal((await call(`/agent/jobs/${id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).data.duplicate, false);
  assert.equal((await call(`/agent/jobs/${id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).data.duplicate, true, 'identical retry accepted');
  assert.equal((await call(`/agent/jobs/${id}/file/0`, { method: 'PUT', bearer, raw: randomBytes(10) })).status, 409, 'different bytes for a stored sequence rejected');
  assert.equal((await call(`/jobs/${id}/file`, { session: admin })).status, 409, 'not downloadable while receiving');
  assert.equal((await call(`/agent/jobs/${id}/file/1`, { method: 'PUT', bearer, raw: parts[1] })).status, 200);
  assert.equal((await call(`/agent/jobs/${id}/file/complete`, { method: 'POST', bearer, body: { name: 'x.pdf', sizeBytes: bytes.length, sha256: '0'.repeat(64), chunks: 2 } })).status, 422, 'server re-hashes the file');
  assert.equal((await call(`/agent/jobs/${id}/file/complete`, { method: 'POST', bearer, body: { name: 'x.pdf', sizeBytes: bytes.length - 1, sha256, chunks: 2 } })).status, 409);
  const name = 'quarterly "report" ünï.pdf';
  assert.equal((await call(`/agent/jobs/${id}/file/complete`, { method: 'POST', bearer, body: { name, sizeBytes: bytes.length, sha256, chunks: 2 } })).data.ok, true);
  assert.equal((await call(`/agent/jobs/${id}/file/complete`, { method: 'POST', bearer, body: { name, sizeBytes: bytes.length, sha256, chunks: 2 } })).data.duplicate, true, 'completion is idempotent');
  assert.equal((await call(`/agent/jobs/${id}/complete`, { method: 'POST', bearer, body: { status: 'succeeded', exitCode: 0, summary: 'Uploaded' } })).status, 200);
  assert.deepEqual(readdirSync(join(folder, 'files')), [`${id}.bin`], 'stored beside the database, outside the web root');

  const download = await call(`/jobs/${id}/file`, { session: admin });
  assert.equal(download.status, 200);
  assert.ok(Buffer.compare(download.data, bytes) === 0, 'downloaded bytes are identical');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('x-content-sha256'), sha256);
  const disposition = download.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="quarterly _report_ _n_\.pdf"; filename\*=UTF-8''quarterly%20_report_%20%C3%BCn%C3%AF\.pdf$/);
  assert.equal(contentDisposition('..\\..\\evil\r\nX: y'), `attachment; filename=".._.._evil__X_ y"; filename*=UTF-8''.._.._evil__X_%20y`);
  assert.equal(service.db.prepare("SELECT count(*) n FROM audit WHERE action='file.downloaded' AND target=?").get(id).n, 1);
  assert.equal(service.db.prepare("SELECT count(*) n FROM audit WHERE action='file.transfer.received' AND target=?").get(id).n, 1);

  await call('/users', { method: 'POST', session: admin, body: { username: 'viewer2', email: '', role: 'viewer', password: 'viewer-password-2', currentPassword: 'isolated-files-password' } });
  assert.equal((await call(`/jobs/${id}/file`, { session: await login('viewer2', 'viewer-password-2') })).status, 403, 'viewers cannot download endpoint files');
  assert.equal((await call(`/jobs/${id}/file`)).status, 401);

  // Total store cap (8 MiB here): a second 5 MiB file does not fit next to the first.
  const second = (await queue({ action: 'download', path: 'C:\\big.iso' })).data.jobs[0];
  await claimStart();
  assert.equal((await call(`/agent/jobs/${second.id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).status, 507, 'total stored bytes are capped');
  // Per-file cap (6 MiB here).
  service.db.prepare("UPDATE file_transfers SET status='expired' WHERE job_id=?").run(id);
  service.cleanupFiles();
  assert.ok(!existsSync(join(folder, 'files', `${id}.bin`)), 'expired files are removed from disk');
  assert.equal((await call(`/jobs/${id}/file`, { session: admin })).status, 410);
  assert.equal((await call(`/agent/jobs/${second.id}/file/0`, { method: 'PUT', bearer, raw: parts[0] })).status, 200);
  assert.equal((await call(`/agent/jobs/${second.id}/file/1`, { method: 'PUT', bearer, raw: parts[0] })).status, 413, 'per-file cap enforced');

  // Zero-byte files send no chunks.
  const empty = (await queue({ action: 'download', path: 'C:\\empty.txt' })).data.jobs[0];
  await claimStart();
  const emptySha = createHash('sha256').digest('hex');
  assert.equal((await call(`/agent/jobs/${empty.id}/file/complete`, { method: 'POST', bearer, body: { name: 'empty.txt', sizeBytes: 0, sha256: emptySha, chunks: 0 } })).status, 200);
  assert.equal((await call(`/jobs/${empty.id}/file`, { session: admin })).data.length, 0);
});

test('stored files expire after the retention period and orphaned files are removed', async t => {
  const { call, admin, queue, enrolled, folder, service } = await harness(t, { fileRetentionMs: 60000 });
  const bearer = enrolled.agentToken;
  const job = (await queue({ action: 'download', path: 'C:\\a.txt' })).data.jobs[0];
  const claimed = (await call('/agent/jobs/claim', { method: 'POST', bearer, body: {} })).data.job;
  await call(`/agent/jobs/${claimed.id}/start`, { method: 'POST', bearer, body: { dispatchToken: claimed.dispatchToken } });
  const data = Buffer.from('hello library');
  await call(`/agent/jobs/${job.id}/file/0`, { method: 'PUT', bearer, raw: data });
  await call(`/agent/jobs/${job.id}/file/complete`, { method: 'POST', bearer, body: { name: 'a.txt', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), chunks: 1 } });
  writeFileSync(join(folder, 'files', `${randomUUID()}.bin`), 'orphan');
  assert.equal(service.cleanupFiles(Date.now()), 0, 'fresh files are kept');
  assert.deepEqual(readdirSync(join(folder, 'files')), [`${job.id}.bin`], 'orphaned files are removed');
  assert.equal(service.cleanupFiles(Date.now() + 61000), 1);
  assert.deepEqual(readdirSync(join(folder, 'files')), []);
  assert.equal((await call(`/jobs/${job.id}/file`, { session: admin })).status, 410);
});
