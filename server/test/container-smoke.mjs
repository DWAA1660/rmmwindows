// Run inside the completed image as its non-root runtime user; no host volumes/network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.mjs';
assert.notEqual(process.getuid?.(), 0, 'Container must run as an unprivileged user.');
const service = createApp({ databasePath: ':memory:', env: { ADMIN_USERNAME: 'isolated-container-test',
  ADMIN_PASSWORD: 'isolated-container-test-password', PUBLIC_ORIGIN: 'https://rmm.parkcountylibrary.org' } });
const listener = service.app.listen(0, '127.0.0.1');
await new Promise(resolve => listener.once('listening', resolve));
const base = `http://127.0.0.1:${listener.address().port}`;
try {
  const metadataResponse = await fetch(base + '/api/agent-download');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  const archive = await fetch(base + metadata.downloadUrl);
  assert.equal(archive.status, 200);
  const bytes = Buffer.from(await archive.arrayBuffer());
  assert.ok(bytes.length > 1000000);
  assert.equal(bytes.length, metadata.sizeBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  const script = await (await fetch(base + '/install.ps1')).text();
  assert.ok(script.includes("[uri]$ServerUrl = 'https://rmm.parkcountylibrary.org'"));
  assert.ok(!script.includes('__SERVER_ORIGIN__'));
  assert.equal((await fetch(base + '/api/endpoints')).status, 401);
  assert.equal((await fetch(base + '/')).status, 200);
  console.log(`PASS non-root container: UI, bootstrap, ${metadata.sizeBytes} package bytes, exact SHA256, authenticated management.`);
} finally {
  listener.closeAllConnections();
  await new Promise(resolve => listener.close(resolve));
  service.close();
}
