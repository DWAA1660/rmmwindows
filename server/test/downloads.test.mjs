import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';

test('public installer downloads expose only a checksum-verified package, never enrollment access', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'rmm-download-test-'));
  const payload = Buffer.from('isolated package fixture🙂');
  const sha256 = createHash('sha256').update(payload).digest('hex');
  writeFileSync(join(directory, 'library-rmm-agent-win-x64.zip'), payload);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: '0.1.0', runtime: 'win-x64', sha256, internalField: 'never expose' }));
  const service = createApp({ databasePath: ':memory:', downloadDirectory: directory, env: {
    ADMIN_USERNAME: 'download-test', ADMIN_PASSWORD: 'isolated-test-password', PUBLIC_ORIGIN: 'https://rmm.parkcountylibrary.org'
  } });
  const server = await listen(service.app);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'rmm-download-test-')));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = path => fetch(base + path, { headers: { Host: 'attacker.invalid' }, signal: AbortSignal.timeout(10000) });
  const metadata = await request('/api/agent-download');
  assert.equal(metadata.status, 200);
  const data = await metadata.json();
  assert.equal(data.sha256, sha256); assert.equal(data.sizeBytes, payload.length);
  assert.equal('internalField' in data, false);
  const binary = await request(data.downloadUrl);
  assert.equal(binary.status, 200); assert.match(binary.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), payload);
  assert.match(await (await request(data.downloadUrl + '.sha256')).text(), new RegExp(sha256));
  const scriptResponse = await request('/install.ps1');
  assert.equal(scriptResponse.status, 200); assert.equal(scriptResponse.headers.get('cache-control'), 'no-store');
  const script = await scriptResponse.text();
  assert.ok(script.includes("[uri]$ServerUrl = 'https://rmm.parkcountylibrary.org'"));
  assert.ok(script.includes('Get-FileHash')); assert.ok(script.includes('SecureString'));
  assert.ok(!script.includes('attacker.invalid') && !script.includes('__SERVER_ORIGIN__') && !script.includes('isolated-test-password'));
  assert.equal((await request('/api/endpoints')).status, 401);
  assert.equal((await request('/api/enrollment-tokens')).status, 401);
});

test('tampered bundled agent archives fail startup integrity validation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rmm-download-test-'));
  try {
    writeFileSync(join(directory, 'library-rmm-agent-win-x64.zip'), 'changed after manifest');
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ version: '0.1.0', runtime: 'win-x64', sha256: '0'.repeat(64) }));
    assert.throws(() => createApp({ databasePath: ':memory:', downloadDirectory: directory,
      env: { ADMIN_USERNAME: 'test', ADMIN_PASSWORD: 'isolated-test-password' } }), /integrity is invalid/);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), 'rmm-download-test-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
