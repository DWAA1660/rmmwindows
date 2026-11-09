// Remote file explorer: payload validation for the `files` job kind, downloads (endpoint -> console)
// and uploads (console -> endpoint).
//
// Download (endpoint -> server -> browser):
//   Agent:   PUT  /api/agent/jobs/:id/file/:sequence   raw application/octet-stream, <= 4 MiB per chunk,
//                                                      contiguous sequences from 0; identical duplicates accepted
//            POST /api/agent/jobs/:id/file/complete    {name, sizeBytes, sha256, chunks} -> server re-hashes
//   Console: GET  /api/jobs/:id/file                   attachment (operators/admins only)
//
// Upload (browser -> server -> endpoint):
//   Console: POST   /api/uploads {name,sizeBytes}         reserves space, returns {id,chunkBytes}
//            PUT    /api/uploads/:id/chunks/:sequence     raw chunks, same rules as above, creator only
//            POST   /api/uploads/:id/complete {}          server hashes the bytes; the upload becomes usable
//            DELETE /api/uploads/:id                      discard an unfinished/unused upload
//            then POST /api/jobs {kind:"files",payload:{action:"upload",uploadId,destinationDirectory,overwrite}}
//            (the server fills in name/sizeBytes/sha256 from its own record; the browser cannot set them)
//   Agent:   GET    /api/agent/jobs/:id/upload?offset=&length=   bytes of the upload, only for this
//            endpoint's own running upload job; the agent checks size and SHA-256 before writing the file.
//
// Bytes are stored under <database directory>/files (uploads in files/uploads), named by UUID, never by
// the user-supplied name and never in the web root. Disk use is bounded: a per-file cap, one total cap
// shared by downloads and uploads, and deletion after the retention period (uploads also an hour after
// every job delivering them finished, or a day if never used). Every transfer is audited.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { transaction } from './db.mjs';

export const FILE_ACTIONS = ['list', 'delete', 'move', 'copy', 'rename', 'mkdir', 'download', 'upload', 'extract'];
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 1024 ** 3;
export const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 ** 3;
export const DEFAULT_RETENTION_MS = 7 * 24 * 3600000;
const STALE_RECEIVING_MS = 24 * 3600000;
const UNUSED_UPLOAD_MS = 24 * 3600000;
const UPLOAD_AFTER_JOBS_MS = 3600000;
const MAX_OPEN_UPLOADS_PER_USER = 20;
const MAX_ITEMS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL_JOB = "('succeeded','failed','interrupted','cancelled')";
// The agent re-validates everything; this keeps obviously unsafe input out of the queue.
const LOCAL_PATH = /^[a-zA-Z]:\\/;
const BAD_PATH_CHARS = /[\u0000-\u001f*?"<>|]/;
const BAD_NAME_CHARS = /[\u0000-\u001f\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

/** A single file/folder name: no separators, wildcards, reserved device names or trailing dot/space. */
export function checkFileName(name, label, { fail, str }) {
  const text = str(name, label, { max: 255 });
  if (BAD_NAME_CHARS.test(text) || text === '.' || text === '..' || /[. ]$/.test(text) || RESERVED.test(text.split('.')[0].trimEnd()))
    fail(400, `${label} cannot contain \\ / : * ? " < > |, end with a dot or space, or be a reserved device name.`);
  return text;
}

export function validateFilesPayload(payload, { fail, str, resolveUpload }) {
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
    case 'rename': return { action, path: path(payload.path, 'path'), newName: checkFileName(payload.newName, 'newName', { fail, str }) };
    case 'mkdir': return { action, path: path(payload.path, 'path') };
    case 'download': return { action, path: path(payload.path, 'path') };
    case 'upload': {
      const uploadId = str(payload.uploadId, 'uploadId', { max: 36 });
      if (!UUID.test(uploadId)) fail(400, 'uploadId is not a valid upload.');
      if (!resolveUpload) fail(400, 'Uploads are not available here.');
      // Name, size and hash come from the server's own record of the finished upload, never the request.
      const upload = resolveUpload(uploadId);
      return { action, uploadId, name: upload.name, sizeBytes: upload.sizeBytes, sha256: upload.sha256,
        destinationDirectory: path(payload.destinationDirectory, 'destinationDirectory'), overwrite: flag(payload.overwrite, 'overwrite') };
    }
    case 'extract': {
      const source = path(payload.path, 'path');
      if (!/\.zip$/i.test(source)) fail(400, 'Only .zip files can be extracted.');
      return { action, path: source, destinationDirectory: path(payload.destinationDirectory, 'destinationDirectory'), overwrite: flag(payload.overwrite, 'overwrite') };
    }
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
  const uploadDirectory = () => join(directory, 'uploads');
  const uploadPartialPath = id => join(uploadDirectory(), `${id}.partial`);
  const uploadFinalPath = id => join(uploadDirectory(), `${id}.upload`);
  // Uploads reserve their full declared size up front so concurrent uploads cannot overshoot the cap.
  const storedBytes = () =>
    db.prepare("SELECT COALESCE(SUM(received_bytes),0) total FROM file_transfers WHERE status IN ('receiving','complete')").get().total +
    db.prepare("SELECT COALESCE(SUM(size_bytes),0) total FROM file_uploads WHERE status IN ('receiving','complete')").get().total;

  function removeUpload(id, status, actor, action) {
    rmSync(uploadPartialPath(id), { force: true }); rmSync(uploadFinalPath(id), { force: true });
    transaction(db, () => {
      db.prepare('UPDATE file_uploads SET status=?,updated_at=? WHERE id=?').run(status, now(), id);
      db.prepare('DELETE FROM file_upload_chunks WHERE upload_id=?').run(id);
    });
    audit(actor, action, id);
  }

  function cleanupUploads(at) {
    const iso = ms => new Date(at - ms).toISOString();
    // Expire: anything past retention; stalled partial uploads; finished uploads never used by a job
    // for a day; and uploads whose delivering jobs all finished more than an hour ago.
    const expired = db.prepare(`SELECT u.id FROM file_uploads u WHERE u.status IN ('receiving','complete') AND (
        u.created_at < ?
        OR (u.status='receiving' AND u.updated_at < ?)
        OR (u.status='complete' AND u.completed_at < ? AND NOT EXISTS (SELECT 1 FROM file_upload_jobs l WHERE l.upload_id=u.id))
        OR (u.status='complete' AND EXISTS (SELECT 1 FROM file_upload_jobs l WHERE l.upload_id=u.id)
            AND NOT EXISTS (SELECT 1 FROM file_upload_jobs l JOIN jobs j ON j.id=l.job_id WHERE l.upload_id=u.id
              AND (j.status NOT IN ${TERMINAL_JOB} OR j.completed_at IS NULL OR j.completed_at >= ?))))`)
      .all(iso(retentionMs), iso(STALE_RECEIVING_MS), iso(UNUSED_UPLOAD_MS), iso(UPLOAD_AFTER_JOBS_MS));
    for (const row of expired) if (!locks.has(row.id)) removeUpload(row.id, 'expired', 'retention', 'file.upload.expired');
    let entries = [];
    try { entries = readdirSync(uploadDirectory()); } catch { return expired.length; }
    const status = new Map(db.prepare("SELECT id,status FROM file_uploads WHERE status IN ('receiving','complete')").all().map(row => [row.id, row.status]));
    for (const name of entries) {
      const match = /^([0-9a-f-]{36})\.(partial|upload)$/i.exec(name);
      if (!match || locks.has(match[1])) continue;
      if (status.get(match[1]) === (match[2] === 'partial' ? 'receiving' : 'complete')) continue;
      try { if (statSync(join(uploadDirectory(), name)).isFile()) rmSync(join(uploadDirectory(), name), { force: true }); } catch { /* raced */ }
    }
    return expired.length;
  }

  function cleanup(at = Date.now()) {
    if (!directory) return 0;
    const expiredUploads = cleanupUploads(at);
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
    try { entries = readdirSync(directory); } catch { return expired.length + expiredUploads; }
    const status = new Map(db.prepare("SELECT job_id,status FROM file_transfers WHERE status IN ('receiving','complete')").all().map(row => [row.job_id, row.status]));
    for (const name of entries) {
      const match = /^([0-9a-f-]{36})\.(partial|bin)$/i.exec(name);
      if (!match || locks.has(match[1])) continue;
      const keep = status.get(match[1]) === (match[2] === 'partial' ? 'receiving' : 'complete');
      if (keep) continue;
      try { if (statSync(join(directory, name)).isFile()) rmSync(join(directory, name), { force: true }); } catch { /* raced with another cleanup */ }
    }
    return expired.length + expiredUploads;
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

    // Upload delivery: bytes of the upload named by this endpoint's own running upload job.
    agentRouter.get('/jobs/:id/upload', async (req, res) => {
      const job = db.prepare('SELECT * FROM jobs WHERE id=? AND endpoint_id=?').get(req.params.id, req.endpoint.id);
      if (!job) fail(404, 'Job not found.');
      let payload = {};
      try { payload = JSON.parse(job.payload); } catch { /* not an upload */ }
      if (job.kind !== 'files' || payload.action !== 'upload') fail(409, 'This job is not a file upload.');
      if (job.status !== 'running') fail(409, 'Upload bytes are served only while the upload job is running.');
      const upload = db.prepare('SELECT * FROM file_uploads WHERE id=?').get(payload.uploadId);
      if (!upload || upload.status !== 'complete' || upload.sha256 !== payload.sha256 || upload.size_bytes !== payload.sizeBytes)
        fail(410, 'The uploaded file is no longer on the server. Upload it again.');
      if (upload.size_bytes === 0) fail(416, 'The upload is empty; there are no bytes to fetch.');
      if (!/^\d{1,12}$/.test(String(req.query.offset ?? '')) || !/^\d{1,8}$/.test(String(req.query.length ?? ''))) fail(400, 'offset and length are required.');
      const offset = integer(Number(req.query.offset), 'offset', 0, Math.max(0, upload.size_bytes - 1));
      const length = integer(Number(req.query.length), 'length', 1, MAX_CHUNK_BYTES);
      const end = Math.min(upload.size_bytes, offset + length);
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - offset), 'X-Content-SHA256': upload.sha256 });
      const stream = createReadStream(uploadFinalPath(upload.id), { start: offset, end: end - 1 });
      await new Promise(resolve => {
        stream.on('error', () => { if (!res.headersSent) res.status(410).json({ error: 'The uploaded file is no longer on the server.' }); else res.destroy(); resolve(); });
        res.on('close', () => { stream.destroy(); resolve(); });
        stream.pipe(res);
      });
    });
  }

  const canTransfer = req => { if (!['admin', 'operator'].includes(req.operator.role)) fail(403, 'Transferring files requires operator access.'); };
  const uploadView = row => ({ id: row.id, name: row.name, sizeBytes: row.size_bytes, receivedBytes: row.received_bytes, status: row.status, sha256: row.sha256 || null, chunkBytes: MAX_CHUNK_BYTES });
  /** Only the account that created an upload can add to it, finish it, delete it or send it. */
  const ownedUpload = (id, operator) => {
    if (!UUID.test(String(id))) fail(404, 'Upload not found.');
    const row = db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
    if (!row || row.user_id !== operator.user_id) fail(404, 'Upload not found.');
    return row;
  };

  /** Used by job validation: the finished upload's server-side name, size and SHA-256. */
  function resolveUpload(id, operator) {
    const row = ownedUpload(id, operator);
    if (row.status === 'receiving') fail(409, 'The upload has not finished yet.');
    if (row.status !== 'complete') fail(410, 'This upload expired or was removed. Upload the file again.');
    return { name: row.name, sizeBytes: row.size_bytes, sha256: row.sha256 };
  }
  /** Records which jobs deliver an upload (inside the job-creation transaction) so cleanup can free it afterwards. */
  function linkUploadJobs(uploadId, jobIds) {
    for (const jobId of jobIds) db.prepare('INSERT OR IGNORE INTO file_upload_jobs(upload_id,job_id) VALUES (?,?)').run(uploadId, jobId);
  }

  function mountConsole(admin) {
    admin.post('/uploads', (req, res) => {
      canTransfer(req);
      const name = checkFileName(req.body.name, 'name', { fail, str });
      const sizeBytes = integer(req.body.sizeBytes, 'sizeBytes', 0, maxFileBytes);
      ensureDirectory();
      mkdirSync(uploadDirectory(), { recursive: true, mode: 0o700 });
      cleanup();
      const id = randomUUID();
      transaction(db, () => {
        const open = db.prepare("SELECT COUNT(*) count FROM file_uploads WHERE user_id=? AND status='receiving'").get(req.operator.user_id).count;
        if (open >= MAX_OPEN_UPLOADS_PER_USER) fail(429, 'You have too many unfinished uploads. Wait for them to finish or try again tomorrow.');
        if (storedBytes() + sizeBytes > maxTotalBytes) fail(507, 'The server file store is full. Wait for older transfers to expire or ask an administrator.');
        db.prepare("INSERT INTO file_uploads(id,user_id,created_by,name,size_bytes,status,created_at,updated_at) VALUES (?,?,?,?,?,'receiving',?,?)")
          .run(id, req.operator.user_id, req.operator.username, name, sizeBytes, now(), now());
        audit(req.operator.username, 'file.upload.started', id, { name, sizeBytes });
      });
      res.status(201).json(uploadView(db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id)));
    });

    admin.put('/uploads/:id/chunks/:sequence', express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES }), async (req, res) => {
      canTransfer(req);
      if (!/^\d{1,9}$/.test(req.params.sequence)) fail(400, 'Invalid upload chunk sequence.');
      const sequence = Number(req.params.sequence);
      const data = req.body;
      if (!Buffer.isBuffer(data) || data.length < 1) fail(400, 'A non-empty application/octet-stream body is required.');
      const { id } = ownedUpload(req.params.id, req.operator);
      const result = await withLock(id, async () => {
        const upload = db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
        if (upload.status !== 'receiving') fail(409, `This upload is already ${upload.status}.`);
        const digest = createHash('sha256').update(data).digest('hex');
        if (sequence < upload.next_sequence) {
          const existing = db.prepare('SELECT * FROM file_upload_chunks WHERE upload_id=? AND sequence=?').get(id, sequence);
          if (!existing || existing.sha256 !== digest || existing.length !== data.length) fail(409, 'This upload chunk sequence already contains different data.');
          return { ok: true, duplicate: true, receivedBytes: upload.received_bytes };
        }
        if (sequence !== upload.next_sequence) fail(409, 'Upload chunks must arrive in sequence starting at zero.');
        const offset = upload.received_bytes;
        if (offset + data.length > upload.size_bytes) fail(413, 'The upload is larger than the size declared when it started.');
        const handle = await open(uploadPartialPath(id), offset === 0 ? 'w' : 'r+', 0o600);
        try { await handle.write(data, 0, data.length, offset); } finally { await handle.close(); }
        transaction(db, () => {
          db.prepare('INSERT INTO file_upload_chunks(upload_id,sequence,length,sha256) VALUES (?,?,?,?)').run(id, sequence, data.length, digest);
          db.prepare('UPDATE file_uploads SET received_bytes=?,next_sequence=?,updated_at=? WHERE id=?').run(offset + data.length, sequence + 1, now(), id);
        });
        return { ok: true, duplicate: false, receivedBytes: offset + data.length };
      });
      res.json(result);
    });

    admin.post('/uploads/:id/complete', async (req, res) => {
      canTransfer(req);
      const { id } = ownedUpload(req.params.id, req.operator);
      const result = await withLock(id, async () => {
        const upload = db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
        if (upload.status === 'complete') return uploadView(upload);
        if (upload.status !== 'receiving') fail(410, 'This upload expired or was removed. Upload the file again.');
        if (upload.received_bytes !== upload.size_bytes) fail(409, `Received ${upload.received_bytes} of ${upload.size_bytes} bytes; send the remaining chunks first.`);
        if (upload.size_bytes === 0) { const handle = await open(uploadPartialPath(id), 'w', 0o600); await handle.close(); }
        const hash = createHash('sha256');
        for await (const piece of createReadStream(uploadPartialPath(id))) hash.update(piece);
        const sha256 = hash.digest('hex');
        await rename(uploadPartialPath(id), uploadFinalPath(id));
        transaction(db, () => {
          db.prepare("UPDATE file_uploads SET status='complete',sha256=?,completed_at=?,updated_at=? WHERE id=?").run(sha256, now(), now(), id);
          db.prepare('DELETE FROM file_upload_chunks WHERE upload_id=?').run(id);
          audit(req.operator.username, 'file.upload.received', id, { name: upload.name, sizeBytes: upload.size_bytes, sha256 });
        });
        return uploadView(db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id));
      });
      res.json(result);
    });

    admin.delete('/uploads/:id', async (req, res) => {
      canTransfer(req);
      const { id } = ownedUpload(req.params.id, req.operator);
      await withLock(id, async () => {
        const upload = db.prepare('SELECT * FROM file_uploads WHERE id=?').get(id);
        if (!['receiving', 'complete'].includes(upload.status)) return;
        const busy = db.prepare(`SELECT COUNT(*) count FROM file_upload_jobs l JOIN jobs j ON j.id=l.job_id WHERE l.upload_id=? AND j.status NOT IN ${TERMINAL_JOB}`).get(id).count;
        if (busy) fail(409, 'A computer is still receiving this upload; it is removed automatically afterwards.');
        removeUpload(id, 'cancelled', req.operator.username, 'file.upload.deleted');
      });
      res.json({ ok: true });
    });

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
  return { mountAgent, mountConsole, cleanup, close: () => clearInterval(timer), storedBytes, resolveUpload, linkUploadJobs };
}
