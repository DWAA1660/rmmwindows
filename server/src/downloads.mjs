import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public distribution contains no enrollment credentials. The bearer enrollment
// token remains separately created by an authenticated operator and entered locally.
export function mountAgentDownloads(app, { env, directory, bootstrapPath } = {}) {
  const root = resolve(directory || env.AGENT_DOWNLOAD_DIRECTORY || resolve(dirname(fileURLToPath(import.meta.url)), '../../downloads'));
  const archive = resolve(root, 'library-rmm-agent-win-x64.zip');
  const manifestPath = resolve(root, 'manifest.json');
  const template = bootstrapPath || resolve(dirname(fileURLToPath(import.meta.url)), '../../installer/Bootstrap-Agent.ps1');
  let manifest = null;
  if (existsSync(manifestPath) && existsSync(archive)) {
    const candidate = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
    if (candidate.runtime !== 'win-x64' || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(candidate.version) || candidate.sha256 !== actual) {
      throw new Error('Bundled agent package manifest/integrity is invalid.');
    }
    manifest = { version: candidate.version, runtime: candidate.runtime, sha256: actual, sizeBytes: statSync(archive).size, downloadUrl: '/downloads/library-rmm-agent-win-x64.zip', installScriptUrl: '/install.ps1' };
  }
  const available = (req, res, next) => manifest ? next() : res.status(503).json({ error: 'Agent download is not included in this server build.' });
  app.get('/api/agent-download', available, (req, res) => res.json(manifest));
  app.get('/downloads/library-rmm-agent-win-x64.zip', available, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.download(archive, `library-rmm-agent-${manifest.version}-win-x64.zip`);
  });
  app.get('/downloads/library-rmm-agent-win-x64.zip.sha256', available, (req, res) => {
    res.set('Cache-Control', 'no-cache').type('text/plain').send(`${manifest.sha256}  library-rmm-agent-win-x64.zip\n`);
  });
  app.get('/install.ps1', available, (req, res) => {
    // Never derive executable script content from untrusted Host/forwarded headers.
    const origin = new URL(env.PUBLIC_ORIGIN || 'https://rmm.parkcountylibrary.org');
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      return res.status(503).json({ error: 'An HTTPS PUBLIC_ORIGIN is required for agent installation.' });
    }
    const script = readFileSync(template, 'utf8').replaceAll('__SERVER_ORIGIN__', origin.origin.replaceAll("'", "''"));
    res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="Install-LibraryRmm.ps1"' }).type('text/plain').send(script);
  });
  return { manifest: () => manifest };
}
