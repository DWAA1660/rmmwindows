// Real Windows agent -> real API smoke test. No service install, reboot, or production access.
import { createApp } from '../server/src/app.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';

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
  // Heartbeat + full inventory through the real PowerShell wrapper must reach the console.
  const inventoried = await waitFor('first inventory', async () => {
    const row = await api(`/endpoints/${enrolled.endpointId}`);
    return row.online && row.inventory?.agentVersion ? row : null;
  });
  assert.ok(inventoried.inventory.osName && Array.isArray(inventoried.inventory.software), 'Inventory must include OS and software.');
  phase(`Inventory received (agent ${inventoried.inventory.agentVersion}, ${inventoried.inventory.software.length} software entries).`);
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

  // Remote file explorer: list, mkdir/copy/delete and a multi-chunk download, all inside this
  // test's temp folder. The long-poll claim should start each job within a moment.
  phase('File explorer: list, change and download files in the isolated temp folder.');
  const sample = join(temp, 'endpoint-files');
  await mkdir(join(sample, 'Sub Folder'), { recursive: true });
  const payloadBytes = randomBytes(5 * 1024 * 1024 + 4321);
  await writeFile(join(sample, 'report ü.bin'), payloadBytes);
  async function runFiles(payload, timeoutSeconds = 120) {
    const queuedAt = Date.now();
    const created = await api('/jobs', { method: 'POST', body: { endpointIds: [enrolled.endpointId], kind: 'files', payload, timeoutSeconds, idempotencyKey: randomUUID() } });
    const jobId = created.jobs[0].id;
    let current, pickedUpMs = null;
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      current = await api(`/jobs/${jobId}`);
      if (pickedUpMs === null && current.status !== 'queued') pickedUpMs = Date.now() - queuedAt;
      if (['succeeded', 'failed', 'interrupted', 'cancelled'].includes(current.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    let cursor = -1, more = true, text = '';
    while (more) {
      const page = await api(`/jobs/${jobId}/output?after=${cursor}&limit=1000`);
      text += page.chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('');
      cursor = page.nextCursor; more = page.hasMore;
    }
    return { job: current, result: JSON.parse(text), pickedUpMs };
  }
  const listed = await runFiles({ action: 'list', path: sample });
  assert.equal(listed.job.status, 'succeeded', listed.job.summary);
  assert.ok(listed.pickedUpMs < 3000, `long-poll should start a job within moments (took ${listed.pickedUpMs} ms)`);
  const byName = Object.fromEntries(listed.result.entries.map(entry => [entry.name, entry]));
  assert.equal(byName['report ü.bin'].size, payloadBytes.length);
  assert.equal(byName['Sub Folder'].type, 'directory');
  const drives = await runFiles({ action: 'list', path: '' });
  assert.ok(drives.result.drives.some(drive => drive.name.toUpperCase() === 'C:\\'), 'drive list includes C:');

  const copied = await runFiles({ action: 'copy', sources: [join(sample, 'report ü.bin')], destinationDirectory: join(sample, 'Sub Folder') });
  assert.equal(copied.job.status, 'succeeded', copied.job.summary);
  assert.deepEqual(await readFile(join(sample, 'Sub Folder', 'report ü.bin')), payloadBytes);
  const made = await runFiles({ action: 'mkdir', path: join(sample, 'New folder') });
  assert.equal(made.job.status, 'succeeded', made.job.summary);
  const removed = await runFiles({ action: 'delete', paths: [join(sample, 'Sub Folder'), join(sample, 'New folder'), join(sample, 'missing.txt')], recursive: true });
  assert.equal(removed.job.status, 'failed', 'one missing item makes the job report a failure');
  assert.equal(removed.result.succeeded, 2); assert.equal(removed.result.failed, 1);
  assert.ok(!existsSync(join(sample, 'Sub Folder')) && !existsSync(join(sample, 'New folder')), 'deleted folders are gone');
  const refused = await runFiles({ action: 'delete', paths: [join(agentDir, 'agent.json')], recursive: false });
  assert.equal(refused.result.failed, 1, 'the agent data folder is protected');
  assert.ok(existsSync(join(agentDir, 'agent.json')));

  const fetched = await runFiles({ action: 'download', path: join(sample, 'report ü.bin') }, 600);
  assert.equal(fetched.job.status, 'succeeded', fetched.job.summary);
  assert.equal(fetched.result.chunks, 3, 'a 5 MiB file is sent in 2 MiB chunks');
  const file = await fetch(base + `/api/jobs/${fetched.job.id}/file`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(30000) });
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''report%20%C3%BC\.bin/);
  const received = Buffer.from(await file.arrayBuffer());
  assert.ok(received.equals(payloadBytes), 'downloaded bytes match the file on the endpoint');
  assert.equal(file.headers.get('x-content-sha256'), fetched.result.sha256);
  console.log(`PASS file explorer: list (picked up in ${listed.pickedUpMs} ms), drives, copy, mkdir, per-item delete, protected refusal, ${payloadBytes.length}-byte download identical.`);

  // Folder download: the agent zips the folder and sends the zip through the same transfer.
  phase('File explorer: download a folder as a zip and compare every extracted file.');
  const zipSource = join(sample, 'Zip Me ü');
  await mkdir(join(zipSource, 'nested', 'empty'), { recursive: true });
  const nestedBytes = randomBytes(3 * 1024 * 1024 + 77);
  await writeFile(join(zipSource, 'nested', 'data.bin'), nestedBytes);
  await writeFile(join(zipSource, 'readme.txt'), 'folder download ✓');
  const zipped = await runFiles({ action: 'download', path: zipSource }, 600);
  assert.equal(zipped.job.status, 'succeeded', zipped.job.summary);
  assert.equal(zipped.result.archive, true);
  assert.equal(zipped.result.name, 'Zip Me ü.zip');
  assert.equal(zipped.result.files, 2);
  assert.equal(zipped.result.skippedCount, 0);
  const zipResponse = await fetch(base + `/api/jobs/${zipped.job.id}/file`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(30000) });
  assert.equal(zipResponse.status, 200);
  assert.match(zipResponse.headers.get('content-disposition'), /filename\*=UTF-8''Zip%20Me%20%C3%BC\.zip/);
  const zipPath = join(temp, 'received.zip');
  await writeFile(zipPath, Buffer.from(await zipResponse.arrayBuffer()));
  const extracted = join(temp, 'extracted');
  const expand = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:RMM_ZIP -DestinationPath $env:RMM_OUT'],
    { encoding: 'utf8', env: { ...process.env, RMM_ZIP: zipPath, RMM_OUT: extracted } });
  assert.equal(expand.status, 0, expand.stderr);
  assert.deepEqual(await readFile(join(extracted, 'Zip Me ü', 'nested', 'data.bin')), nestedBytes);
  assert.equal(await readFile(join(extracted, 'Zip Me ü', 'readme.txt'), 'utf8'), 'folder download ✓');
  assert.ok(existsSync(join(extracted, 'Zip Me ü', 'nested', 'empty')), 'empty folders are kept');
  assert.ok(!existsSync(join(agentDir, 'download-staging')) || (await import('node:fs')).readdirSync(join(agentDir, 'download-staging')).length === 0, 'the temporary zip was removed from the endpoint');
  console.log(`PASS folder download: ${zipped.result.size}-byte zip, every extracted file identical, empty folder kept, staging cleaned.`);

  phase('Persistent terminal: state across separate authorized jobs, then explicit close while running.');
  const terminal = await api('/terminals', { method:'POST',body:{endpointId:enrolled.endpointId,idempotencyKey:randomUUID()} });
  const command = text => api(`/terminals/${terminal.id}/commands`, {method:'POST',body:{command:text,idempotencyKey:randomUUID(),timeoutSeconds:60}});
  async function finishedTerminal(id) {
    let state;
    const deadline = Date.now()+45000;
    while(Date.now()<deadline) {
      state=await api(`/jobs/${id}`);
      if(['succeeded','failed','interrupted','cancelled'].includes(state.status)) break;
      await new Promise(r=>setTimeout(r,200));
    }
    let after=-1, more=true, stdout='';
    while(more) { const page=await api(`/jobs/${id}/output?after=${after}&limit=100`); stdout+=page.chunks.filter(c=>c.stream==='stdout').map(c=>c.text).join(''); after=page.nextCursor;more=page.hasMore; }
    return {state,stdout};
  }
  const targetDirectory=sample.replaceAll("'","''");
  const firstTerminal=await command(`$persisted=12345; function Read-Persisted { 'saved-function' }; Set-Location '${targetDirectory}'; 'terminal-one'`);
  const one=await finishedTerminal(firstTerminal.id); assert.equal(one.state.status,'succeeded',one.state.summary+logs);
  const secondTerminal=await command('"$persisted $(Read-Persisted)"; $PWD.Path; [Console]::Write("terminal-α中文🙂")');
  const two=await finishedTerminal(secondTerminal.id); assert.equal(two.state.status,'succeeded',two.state.summary+logs);
  // GitHub runners report temp paths in 8.3 short form (RUNNER~1) while PowerShell prints the long
  // form, so compare canonical long paths case-insensitively.
  const longSample = realpathSync.native(sample).toLowerCase();
  const samePath = value => typeof value === 'string' && realpathSync.native(value.trim()).toLowerCase() === longSample;
  const printedPath = two.stdout.split(/\r?\n/).map(line => line.trim()).find(line => /^[a-z]:\\/i.test(line));
  assert.ok(two.stdout.includes('12345 saved-function') && samePath(printedPath) && two.stdout.endsWith('terminal-α中文🙂'),two.stdout);
  assert.ok(samePath((await api(`/terminals/${terminal.id}`)).workingDirectory), 'terminal working directory');
  const waiting=await command("[Console]::Write('terminal-waiting'); Start-Sleep -Seconds 40");
  const untilRunning=Date.now()+10000;
  while(Date.now()<untilRunning) { if((await api(`/jobs/${waiting.id}`)).status==='running')break; await new Promise(r=>setTimeout(r,100)); }
  await new Promise(r=>setTimeout(r,500));
  await api(`/terminals/${terminal.id}/close`,{method:'POST',body:{}});
  const closed=await finishedTerminal(waiting.id); assert.equal(closed.state.status,'interrupted',closed.state.summary);
  assert.ok(closed.stdout.includes('terminal-waiting'),'Partial command output retained after closing');
  assert.equal((await api(`/terminals/${terminal.id}`)).status,'closed');
  assert.equal((await api('/agent/jobs/claim',{method:'POST',body:{},agentToken:enrolled.agentToken})).job,null,'Terminal commands never re-dispatch');
  console.log('PASS real persistent terminal/API: variables/functions/cwd retained across jobs, Unicode output retained, close kills running shell with partial output and no replay.');
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
