// Remote file explorer: payload validation for the `files` job kind and the download transfer.
//
// Agent:    PUT  /api/agent/jobs/:id/file/:sequence   raw application/octet-stream, <= 4 MiB per chunk,
//                                                     contiguous sequences from 0; identical duplicates accepted
//           POST /api/agent/jobs/:id/file/complete    {name, sizeBytes, sha256, chunks} -> server re-hashes
// Console:  GET  /api/jobs/:id/file                   attachment (operators/admins only)
//
// Files are stored under <database directory>/files, never in the web root. Disk use is bounded:
// a per-file cap, a total cap across all stored files, and deletion after the retention period.
// Every transfer and every download is audited.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { transaction } from './db.mjs';

export const FILE_ACTIONS = ['list', 'delete', 'move', 'copy', 'rename', 'mkdir', 'download'];
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 1024 ** 3;
export const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 ** 3;
export const DEFAULT_RETENTION_MS = 7 * 24 * 3600000;
const STALE_RECEIVING_MS = 24 * 3600000;
const MAX_ITEMS = 500;
// The agent re-validates everything; this keeps obviously unsafe input out of the queue.
const LOCAL_PATH = /^[a-zA-Z]:\\/;
const BAD_PATH_CHARS = /[\u0000-\u001f*?"<>|]/;
const BAD_NAME_CHARS = /[\u0000-\u001f\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

export function validateFilesPayload(payload, { fail, str }) {
  const action = payload.action;
  if (!FILE_ACTIONS.includes(action)) fail(400, `files action must be one of ${FILE_ACTIONS.join(', ')}.`);
  const path = (value, name) => {
    const text = str(value, name, { max: 4096 });
    if (!LOCAL_PATH.test(text) || BAD_PATH_CHARS.test(text) || text.indexOf(':', 2) >= 0 || text.includes('/'))
      fail(400, `${name} must be an absolute local Windows path such as C:\\Users (no network paths or wildcards).`);
    return text;
  };
  const paths = (value, name) => {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) fail(400, `${name} must list 1 to ${MAX_ITEMS} paths.`);
    const list = value.map((item, index) => path(item, `${name}[${index}]`));
    if (new Set(list.map(item => item.toLowerCase())).size !== list.length) fail(400, `${name} contains duplicates.`);
    return list;
  };
  const flag = (value, name) => {
    if (value === undefined) return false;
    if (typeof value !== 'boolean') fail(400, `${name} must be true or false.`);
    return value;
  };
  switch (action) {
    case 'list': {
      if (payload.path === undefined || payload.path === '') return { action, path: '' };
      return { action, path: path(payload.path, 'path') };
    }
    case 'delete': return { action, paths: paths(payload.paths, 'paths'), recursive: flag(payload.recursive, 'recursive') };
    case 'move':
    case 'copy': return { action, sources: paths(payload.sources, 'sources'), destinationDirectory: path(payload.destinationDirectory, 'destinationDirectory'), overwrite: flag(payload.overwrite, 'overwrite') };
    case 'rename': {
      const newName = str(payload.newName, 'newName', { max: 255 });
      if (BAD_NAME_CHARS.test(newName) || newName === '.' || newName === '..' || /[. ]$/.test(newName) || RESERVED.test(newName.split('.')[0].trimEnd()))
        fail(400, 'newName cannot contain \\ / : * ? " < > |, end with a dot or space, or be a reserved device name.');
      return { action, path: path(payload.path, 'path'), newName };
    }
    case 'mkdir': return { action, path: path(payload.path, 'path') };
    case 'download': return { action, path: path(payload.path, 'path') };
  }
}

/** Safe attachment headers: ASCII fallback plus RFC 5987 UTF-8 name. */
export function contentDisposition(name) {
  const clean = String(name || 'download').replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, '_').slice(0, 200) || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/[%;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

export function mountFiles({ db, audit, fail, str, integer, directory, maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES, retentionMs = DEFAULT_RETENTION_MS }) {
  const now = () => new Date().toISOString();
  const locks = new Map();
  // Serialize work per job so a retried chunk can never interleave with the original.
  const withLock = (id, fn) => {
    const previous = locks.get(id) || Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.catch(() => {});
    locks.set(id, settled);
    settled.then(() => { if (locks.get(id) === settled) locks.delete(id); });
    return next;
  };
  const partialPath = id => join(directory, `${id}.partial`);
  const finalPath = id => join(directory, `${id}.bin`);
  const ensureDirectory = () => {
    if (!directory) fail(503, 'File transfers are not configured on this server.');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  };
  const storedBytes = () => db.prepare("SELECT COALESCE(SUM(received_bytes),0) total FROM file_transfers WHERE status IN ('receiving','complete')").get().total;

  function cleanup(at = Date.now()) {
    if (!directory) return 0;
    const expired = db.prepare("SELECT job_id FROM file_transfers WHERE status IN ('receiving','complete') AND (created_at<? OR (status='receiving' AND updated_at<?))")
      .all(new Date(at - retentionMs).toISOString(), new Date(at - STALE_RECEIVING_MS).toISOString());
    for (const row of expired) {
      if (locks.has(row.job_id)) continue;
      rmSync(partialPath(row.job_id), { force: true }); rmSync(finalPath(row.job_id), { force: true });
      transaction(db, () => {
        db.prepare("UPDATE file_transfers SET status='expired',updated_at=? WHERE job_id=?").run(now(), row.job_id);
        db.prepare('DELETE FROM file_transfer_chunks WHERE job_id=?').run(row.job_id);
      });
      audit('retention', 'file.transfer.expired', row.job_id);
    }
    // Anything on disk without a live record (crash between write and commit, old rows) is removed too.
    let entries = [];
    try { entries = readdirSync(directory); } catch { return expired.length; }
    const status = new Map(db.prepare("SELECT job_id,status FROM file_transfers WHERE status IN ('receiving','complete')").all().map(row => [row.job_id, row.status]));
    for (const name of entries) {
      const match = /^([0-9a-f-]{36})\.(partial|bin)$/i.exec(name);
      if (!match || locks.has(match[1])) continue;
      const keep = status.get(match[1]) === (match[2] === 'partial' ? 'receiving' : 'complete');
      if (keep) continue;
      try { if (statSync(join(directory, name)).isFile()) rmSync(join(directory, name), { force: true }); } catch { /* raced with another cleanup */ }
    }
    return expired.length;
  }

  const downloadJob = (req, endpointId) => {
    const job = db.prepare('SELECT * FROM jobs WHERE id=? AND endpoint_id=?').get(req.params.id, endpointId);
    if (!job) fail(404, 'Job not found.');
    let payload = {};
    try { payload = JSON.parse(job.payload); } catch { /* invalid payload is not a download */ }
    if (job.kind !== 'files' || payload.action !== 'download') fail(409, 'This job is not a file download.');
    return { job, payload };
  };

  function mountAgent(agentRouter) {
    agentRouter.put('/jobs/:id/file/:sequence', express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES }), async (req, res) => {
      if (!/^\d{1,9}$/.test(req.params.sequence)) fail(400, 'Invalid file chunk sequence.');
      const sequence = Number(req.params.sequence);
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length < 1) fail(400, 'A non-empty application/octet-stream body is required.');
      const { job, payload } = downloadJob(req, req.endpoint.id);
      const result = await withLock(job.id, async () => {
        const current = db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id);
        if (current.status !== 'running') fail(409, 'File chunks are accepted only while the download job is running.');
        let transfer = db.prepare('SELECT * FROM file_transfers WHERE job_id=?').get(job.id);
        if (transfer && transfer.status !== 'receiving') fail(409, `This file transfer is already ${transfer.status}.`);
        const digest = createHash('sha256').update(data).digest('hex');
        if (transfer && sequence < transfer.next_sequence) {
          const existing = db.prepare('SELECT * FROM file_transfer_chunks WHERE job_id=? AND sequence=?').get(job.id, sequence);
          if (!existing || existing.sha256 !== digest || existing.length !== data.length) fail(409, 'This file chunk sequence already contains different data.');
          return { ok: true, duplicate: true };
        }
        const expected = transfer ? transfer.next_sequence : 0;
        if (sequence !== expected) fail(409, 'File chunks must arrive in sequence starting at zero; retry the earliest missing chunk first.');
        ensureDirectory();
        if (!transfer) cleanup();
        const offset = transfer ? transfer.received_bytes : 0;
        if (offset + data.length > maxFileBytes) fail(413, `The file exceeds the ${maxFileBytes}-byte download limit.`);
        if (storedBytes() + data.length > maxTotalBytes) fail(507, 'The server file store is full. Wait for older downloads to expire (7 days) or ask an administrator.');
        if (!transfer) {
          db.prepare("INSERT INTO file_transfers(job_id,endpoint_id,path,status,received_bytes,next_sequence,created_at,updated_at) VALUES (?,?,?,'receiving',0,0,?,?)")
            .run(job.id, req.endpoint.id, String(payload.path || '').slice(0, 4096), now(), now());
          rmSync(partialPath(job.id), { force: true });
        }
        const handle = await open(partialPath(job.id), offset === 0 ? 'w' : 'r+', 0o600);
        try { await handle.write(data, 0, data.length, offset); } finally { await handle.close(); }
        transaction(db, () => {
          db.prepare('INSERT INTO file_transfer_chunks(job_id,sequence,byte_offset,length,sha256) VALUES (?,?,?,?,?)').run(job.id, sequence, offset, data.length, digest);
          db.prepare('UPDATE file_transfers SET received_bytes=?,next_sequence=?,updated_at=? WHERE job_id=?').run(offset + data.length, sequence + 1, now(), job.id);
        });
        return { ok: true, duplicate: false };
      });
      res.json(result);
    });

    agentRouter.post('/jobs/:id/file/complete', async (req, res) => {
      const name = str(req.body.name, 'name', { max: 255 });
      const sizeBytes = integer(req.body.sizeBytes, 'sizeBytes', 0, maxFileBytes);
      const chunks = integer(req.body.chunks, 'chunks', 0, 1e9);
      const sha256 = str(req.body.sha256, 'sha256', { min: 64, max: 64 });
      if (!/^[0-9a-f]{64}$/.test(sha256)) fail(400, 'sha256 must be 64 lowercase hex characters.');
      const { job, payload } = downloadJob(req, req.endpoint.id);
      const result = await withLock(job.id, async () => {
        let transfer = db.prepare('SELECT * FROM file_transfers WHERE job_id=?').get(job.id);
        if (transfer?.status === 'complete') {
          if (transfer.sha256 !== sha256 || transfer.size_bytes !== sizeBytes) fail(409, 'This file transfer already completed with a different result.');
          return { ok: true, duplicate: true };
        }
        if (db.prepare('SELECT status FROM jobs WHERE id=?').get(job.id).status !== 'running') fail(409, 'The download job is not running.');
        if (transfer && transfer.status !== 'receiving') fail(409, `This file transfer is already ${transfer.status}.`);
        ensureDirectory();
        if (!transfer) {
          // A zero-byte file sends no chunks.
          if (sizeBytes !== 0 || chunks !== 0) fail(409, 'No file chunks were received.');
          db.prepare("INSERT INTO file_transfers(job_id,endpoint_id,path,status,received_bytes,next_sequence,created_at,updated_at) VALUES (?,?,?,'receiving',0,0,?,?)")
            .run(job.id, req.endpoint.id, String(payload.path || '').slice(0, 4096), now(), now());
          const handle = await open(partialPath(job.id), 'w', 0o600); await handle.close();
          transfer = db.prepare('SELECT * FROM file_transfers WHERE job_id=?').get(job.id);
        }
        if (transfer.received_bytes !== sizeBytes || transfer.next_sequence !== chunks) fail(409, `Received ${transfer.received_bytes} bytes in ${transfer.next_sequence} chunks, but the agent reported ${sizeBytes} bytes in ${chunks}.`);
        const hash = createHash('sha256');
        for await (const piece of createReadStream(partialPath(job.id))) hash.update(piece);
        const actual = hash.digest('hex');
        if (actual !== sha256) fail(422, 'The received file does not match the SHA-256 reported by the agent.');
        await rename(partialPath(job.id), finalPath(job.id));
        transaction(db, () => {
          db.prepare("UPDATE file_transfers SET status='complete',name=?,size_bytes=?,sha256=?,completed_at=?,updated_at=? WHERE job_id=?").run(name, sizeBytes, sha256, now(), now(), job.id);
          db.prepare('DELETE FROM file_transfer_chunks WHERE job_id=?').run(job.id);
          audit(`agent:${req.endpoint.id}`, 'file.transfer.received', job.id, { path: transfer.path, name, sizeBytes, sha256 });
        });
        return { ok: true, duplicate: false };
      });
      res.json(result);
    });
  }

  function mountConsole(admin) {
    admin.get('/jobs/:id/file', async (req, res) => {
      if (!['admin', 'operator'].includes(req.operator.role)) fail(403, 'Downloading endpoint files requires operator access.');
      const transfer = db.prepare('SELECT * FROM file_transfers WHERE job_id=?').get(req.params.id);
      if (!transfer) fail(404, 'No file was received for this job.');
      if (transfer.status === 'expired') fail(410, 'This downloaded file expired and was removed from the server. Create a new download.');
      if (transfer.status !== 'complete') fail(409, 'The file is still being transferred from the computer.');
      let size;
      try { size = statSync(finalPath(transfer.job_id)).size; } catch { fail(410, 'The stored file is no longer available. Create a new download.'); }
      audit(req.operator.username, 'file.downloaded', transfer.job_id, { endpointId: transfer.endpoint_id, path: transfer.path, sizeBytes: size, sha256: transfer.sha256 });
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), 'Content-Disposition': contentDisposition(transfer.name), 'X-Content-SHA256': transfer.sha256 });
      const stream = createReadStream(finalPath(transfer.job_id));
      await new Promise(resolve => {
        stream.on('error', () => { res.destroy(); resolve(); });
        res.on('close', () => { stream.destroy(); resolve(); });
        stream.pipe(res);
      });
    });
  }

  let timer = null;
  if (directory) {
    try { cleanup(); } catch (error) { console.error('File store cleanup failed:', error.message); }
    timer = setInterval(() => { try { cleanup(); } catch (error) { console.error('File store cleanup failed:', error.message); } }, 3600000);
    timer.unref();
  }
  return { mountAgent, mountConsole, cleanup, close: () => clearInterval(timer), storedBytes };
}
