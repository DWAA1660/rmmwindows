// Real Windows agent -> real API smoke test. No service install, reboot, or production access.
import { createApp } from '../server/src/app.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const phase = message => console.log(`[integration] ${message}`);

if (process.platform !== 'win32') throw new Error('This integration test requires Windows.');
const root = resolve(import.meta.dirname, '..');
const localDotnet = join(root, 'artifacts/dotnet-sdk/dotnet.exe');
const dotnetPath = process.env.DOTNET_PATH || (existsSync(localDotnet) ? localDotnet : 'dotnet');
const temp = await mkdtemp(join(tmpdir(), 'library-rmm-e2e-'));
const service = createApp({ databasePath: join(temp, 'test.db'), env: {
  ADMIN_USERNAME: 'integration-test', ADMIN_PASSWORD: randomBytes(24).toString('hex'),
  PUBLIC_ORIGIN: 'http://rmm.test', COOKIE_SECURE: 'false'
} });
// This workstation's ephemeral range includes browser-forbidden ports. Pick a
// high loopback port so Node fetch does not reject an otherwise valid listener.
const listener = service.app.listen(49152 + Math.floor(Math.random() * 16384), '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}`;
phase('Isolated API listening; authenticating test operator.');
let child;
let cookie;
let csrf;
let logs = '';
try {
  // Bootstrap password is intentionally retrieved only from this test's own DB seed env.
  // Create a fresh operator by using the existing hash's corresponding test secret below.
  const { passwordHash } = await import('../server/src/security.mjs');
  const password = randomBytes(24).toString('hex');
  service.db.prepare('UPDATE users SET password_hash=?').run(passwordHash(password));
  async function api(path, { method = 'GET', body, agentToken } = {}) {
    const headers = { Origin: 'http://rmm.test' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (agentToken) headers.Authorization = `Bearer ${agentToken}`;
    else if (cookie) { headers.Cookie = cookie; headers['X-CSRF-Token'] = csrf; }
    const response = await fetch(base + '/api' + path, { method, headers, signal: AbortSignal.timeout(15000),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const result = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error || ''}`);
    return result;
  }
  csrf = (await api('/auth/login', { method: 'POST', body: { username: 'integration-test', password } })).csrfToken;
  // Tokenless enrollment, exactly as the default installer configures it: the agent has only
  // a device ID and a join secret, and must be approved in the console before it can work.
  const deviceId = randomUUID();
  phase('Building and launching a tokenless agent that must request to join.');
  const agentDir = join(temp, 'endpoint');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'agent.json'), JSON.stringify({ serverUrl: base, deviceId,
    joinSecret: randomBytes(32).toString('base64url'), pollSeconds: 5,
    inventoryMinutes: 15, allowInsecureLocalhost: true }));
  const built = spawnSync(dotnetPath, ['build', 'agent/LibraryRmm.Agent.csproj', '-c', 'Release', '--nologo'], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  const dll = join(root, 'agent/bin/Release/net10.0-windows/LibraryRmm.Agent.dll');
  assert.ok(existsSync(dll), 'Build must produce the .NET 10 Windows agent.');
  child = spawn(dotnetPath, [dll, '--data-dir', agentDir], { cwd: root, windowsHide: true });
  child.on('error', error => { logs += `Agent spawn failed: ${error.message}`; });
  child.stdout.on('data', data => { logs = (logs + data).slice(-12000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-12000); });
  const waitFor = async (label, check, ms = 90000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const value = await check();
      if (value) return value;
      if (child.exitCode !== null) throw new Error(`Agent exited while waiting for ${label}: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for ${label}: ${logs}`);
  };
  const joinRequest = await waitFor('join request', async () => (await api('/join-requests')).find(row => row.deviceId === deviceId));
  assert.equal(joinRequest.status, 'pending');
  assert.ok(!(await api('/endpoints')).some(row => row.deviceId === deviceId), 'No endpoint may exist before approval.');
  await api(`/join-requests/${joinRequest.id}/approve`, { method: 'POST', body: {} });
  phase('Join request approved; waiting for the agent to collect its credential (next 30 s poll).');
  const persisted = await waitFor('approved credential', async () => {
    const config = JSON.parse(await readFile(join(agentDir, 'agent.json'), 'utf8'));
    return config.agentToken ? config : null;
  });
  const enrolled = { endpointId: persisted.endpointId, agentToken: persisted.agentToken };
  assert.equal((await api('/join-requests')).find(row => row.deviceId === deviceId).endpointId, enrolled.endpointId);
  assert.equal(persisted.deviceId, deviceId, 'Approval must keep the device identity.');
  const expected = 'RMM✓🙂'.repeat(30000);
  const request = await api('/jobs', { method: 'POST', body: { endpointIds: [enrolled.endpointId],
    kind: 'powershell', payload: { script: "[Console]::Out.Write(('RMM✓🙂' * 30000)); [Console]::Error.Write('stderr-complete')" },
    timeoutSeconds: 60, idempotencyKey: randomUUID() } });
  const id = request.jobs[0].id;
  const deadline = Date.now() + 120000;
  let job;
  while (Date.now() < deadline) {
    job = await api(`/jobs/${id}`);
    if (['succeeded', 'failed', 'interrupted'].includes(job.status)) break;
    if (child.exitCode !== null) throw new Error(`Agent exited: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.equal(job.status, 'succeeded', `${job.status}: ${job.summary}\n${logs}`);
  phase('PowerShell job succeeded; verifying paginated output.');
  let after = -1;
  const chunks = [];
  while (true) {
    const page = await api(`/jobs/${id}/output?after=${after}&limit=7`);
    chunks.push(...page.chunks);
    after = page.nextCursor;
    if (!page.hasMore) break;
  }
  assert.equal(chunks.filter(c => c.stream === 'stdout').map(c => c.text).join(''), expected);
  assert.equal(chunks.filter(c => c.stream === 'stderr').map(c => c.text).join(''), 'stderr-complete');
  const next = await api('/agent/jobs/claim', { method: 'POST', body: {}, agentToken: enrolled.agentToken });
  assert.equal(next.job, null, 'Completed command must never be dispatched again.');
  phase('Exact stdout/stderr and consumed job verified; downloading full output.');
  const downloaded = await fetch(base + `/api/jobs/${id}/download`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000) });
  phase(`Download headers received (${downloaded.status}); consuming body.`);
  assert.ok(downloaded.ok);
  const full = await downloaded.text();
  assert.ok(full.includes('stderr-complete'));
  assert.equal(full, chunks.map(c => c.text).join(''));
  console.log(`PASS real .NET 10 Windows agent/API: ${Buffer.byteLength(expected)} UTF-8 stdout bytes, stderr, ${chunks.length} chunks, full download, no redispatch.`);
} finally {
  phase('Stopping isolated agent and API.');
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
  }
  // Agent HttpClient and fetch use keep-alive. Closing the listener alone can
  // wait forever on active sockets after a failed assertion or aborted download.
  listener.closeAllConnections();
  await new Promise(resolve => listener.close(resolve));
  service.close();
  const target = resolve(temp);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('library-rmm-e2e-'));
  // A killed agent's short-lived PowerShell child can hold its working folder briefly.
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
