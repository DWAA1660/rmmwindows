import express from 'express';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from './db.mjs';
import { mountAgentDownloads } from './downloads.mjs';
import { mountGroups } from './groups.mjs';
import { mountSupport } from './support.mjs';
import { mountAccounts, publicUser } from './accounts.mjs';
import { mountJoinRequests } from './join-requests.mjs';
import { mountFiles, validateFilesPayload } from './files.mjs';
import { randomToken, hashToken, passwordHash, verifyPassword, equalText, cookies, rateLimiter, MIN_PASSWORD_LENGTH } from './security.mjs';

const nowIso = () => new Date().toISOString();
const parse = (text, fallback = {}) => { try { return JSON.parse(text); } catch { return fallback; } };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function str(value, name, { min = 1, max = 200, fallback } = {}) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(400, `${name} must be text between ${min} and ${max} characters.`);
  return value;
}
function integer(value, name, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${name} must be an integer from ${min} to ${max}.`);
  return value;
}
function bool(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') fail(400, `${name} must be true or false.`);
  return value;
}
function date(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(400, `${name} must be an ISO date.`);
  return new Date(value).toISOString();
}

function canonicalInventory(input, previousHostname) {
  if (!object(input)) fail(400, 'inventory must be an object.');
  const text = (value, name, max, fallback = null) => value === undefined || value === null ? fallback : str(value, name, { min: 0, max });
  const number = (value, name, max = Number.MAX_SAFE_INTEGER, whole = true) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max || (whole && !Number.isSafeInteger(value))) fail(400, `${name} must be a nonnegative ${whole ? 'integer' : 'number'} or null.`);
    return value;
  };
  const array = (value, name, limit) => {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value) || value.length > limit) fail(400, `${name} must be an array with at most ${limit} entries.`);
    return value;
  };
  const disks = array(input.disks, 'inventory.disks', 128).map(disk => {
    if (!object(disk)) fail(400, 'Each disk must be an object.');
    const totalBytes = number(disk.totalBytes, 'disk.totalBytes');
    const freeBytes = number(disk.freeBytes, 'disk.freeBytes');
    if (totalBytes !== null && freeBytes !== null && freeBytes > totalBytes) fail(400, 'disk.freeBytes cannot exceed disk.totalBytes.');
    return { name: str(disk.name, 'disk.name', { max: 260 }), label: text(disk.label, 'disk.label', 260, ''), totalBytes, freeBytes };
  });
  const software = array(input.software, 'inventory.software', 30000).map(item => {
    if (!object(item)) fail(400, 'Each software entry must be an object.');
    return { name: str(item.name, 'software.name', { max: 1000 }), version: text(item.version, 'software.version', 300, ''), publisher: text(item.publisher, 'software.publisher', 1000, ''), installDate: text(item.installDate, 'software.installDate', 100, '') };
  });
  return {
    hostname: str(input.hostname, 'inventory.hostname', { max: 200, fallback: previousHostname }),
    osName: text(input.osName, 'inventory.osName', 300), osVersion: text(input.osVersion, 'inventory.osVersion', 200),
    architecture: text(input.architecture, 'inventory.architecture', 50), domain: text(input.domain, 'inventory.domain', 255),
    domainJoined: input.domainJoined === null || input.domainJoined === undefined ? null : bool(input.domainJoined, 'inventory.domainJoined'),
    ipv4: array(input.ipv4, 'inventory.ipv4', 128).map(ip => str(ip, 'IP address', { max: 100 })),
    loggedOnUser: text(input.loggedOnUser, 'inventory.loggedOnUser', 500), bootTime: input.bootTime === null || input.bootTime === undefined ? null : date(input.bootTime, 'inventory.bootTime'),
    cpuPercent: number(input.cpuPercent, 'inventory.cpuPercent', 100, false), memoryTotalBytes: number(input.memoryTotalBytes, 'inventory.memoryTotalBytes'), memoryUsedBytes: number(input.memoryUsedBytes, 'inventory.memoryUsedBytes'),
    agentVersion: text(input.agentVersion, 'inventory.agentVersion', 100), disks, software
  };
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const databasePath = options.databasePath || env.DATABASE_PATH || resolve('data/rmm.db');
  const db = options.db || openDatabase(databasePath);
  // Downloaded endpoint files live beside the database (persistent volume), never in the web root.
  const fileDirectory = options.fileDirectory !== undefined ? options.fileDirectory
    : options.db || databasePath === ':memory:' ? null : resolve(dirname(databasePath), 'files');
  const publicOrigin = env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : null;
  const supportSocketOrigin = publicOrigin ? publicOrigin.replace(/^http/, 'ws') : '';
  // Full inventory interval pushed to agents on every heartbeat (1-1440 minutes, default 5).
  const inventoryMinutes = Math.min(1440, Math.max(1, Number.parseInt(env.INVENTORY_MINUTES || '5', 10) || 5));
  const secureCookie = env.COOKIE_SECURE === 'true' || publicOrigin?.startsWith('https://');
  const username = env.ADMIN_USERNAME;
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) {
    if (!username || !env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < MIN_PASSWORD_LENGTH) {
      if (!options.db) db.close();
      throw new Error(`First startup requires ADMIN_USERNAME and ADMIN_PASSWORD of at least ${MIN_PASSWORD_LENGTH} characters. No default account is created.`);
    }
    db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES (?,?,?,?)').run(randomUUID(), str(username, 'ADMIN_USERNAME', { max: 100 }), passwordHash(env.ADMIN_PASSWORD), nowIso());
  }
  const dummyPassword = passwordHash(randomToken());
  const app = express();
  app.disable('x-powered-by');
  // Enable only behind an owned proxy that overwrites X-Forwarded-For. The
  // container port must remain private so clients cannot forge their own IP.
  if (env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' ${supportSocketOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` });
    if (secureCookie) res.set('Strict-Transport-Security', 'max-age=31536000');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '2mb', strict: true }));
  mountAgentDownloads(app, { env, directory: options.downloadDirectory, bootstrapPath: options.bootstrapPath });
  // Agent file-download chunks are the only raw (non-JSON) bodies; their route parses them itself.
  const rawFileChunk = req => req.method === 'PUT' && /^\/agent\/jobs\/[^/]+\/file\/\d+$/.test(req.path) && req.is('application/octet-stream');
  app.use('/api', (req, res, next) => { if (['POST', 'PUT', 'PATCH'].includes(req.method) && !object(req.body) && !rawFileChunk(req)) return res.status(400).json({ error: 'A JSON object body is required.' }); next(); });
  const audit = (actor, action, target, details = {}) => db.prepare('INSERT INTO audit(id,actor,action,target,details,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), actor, action, target || null, JSON.stringify(details), nowIso());
  const expectedOrigin = req => publicOrigin || `http://${req.headers.host}`;
  function checkOrigin(req, res, next) {
    // Browsers always send Origin for same-origin fetch mutations. Requiring it also
    // blocks login CSRF; agents never pass through this operator middleware.
    if (!equalText(req.get('origin'), expectedOrigin(req))) return res.status(403).json({ error: 'A matching Origin header is required.' });
    next();
  }
  function operator(req, res, next) {
    const token = cookies(req.headers.cookie).rmm_session;
    if (!token) return res.status(401).json({ error: 'Sign in required.' });
    const session = db.prepare('SELECT s.*, u.username,u.email,u.role,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>? AND u.disabled=0').get(hashToken(token), nowIso());
    if (!session) return res.status(401).json({ error: 'Session expired. Sign in again.' });
    req.operator = session; next();
  }
  function csrf(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    checkOrigin(req, res, () => {
      if (!equalText(req.get('x-csrf-token'), req.operator.csrf_token)) return res.status(403).json({ error: 'Invalid CSRF token.' });
      next();
    });
  }
  function agent(req, res, next) {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token || token.length > 200) return res.status(401).json({ error: 'Agent authentication required.' });
    const endpoint = db.prepare('SELECT * FROM endpoints WHERE token_hash=? AND revoked=0').get(hashToken(token));
    if (!endpoint) return res.status(401).json({ error: 'Invalid or revoked agent credential.' });
    req.endpoint = endpoint; next();
  }
  const endpointView = row => row && ({ id: row.id, hostname: row.hostname, displayName: row.display_name, deviceId: row.device_id, groupId:row.group_id, groupName:db.prepare('SELECT name FROM endpoint_groups WHERE id=?').get(row.group_id)?.name || 'New endpoints', tags: parse(row.tags, []), inventory: parse(row.inventory), bootId: row.boot_id, lastSeen: row.last_seen, createdAt: row.created_at, revoked: Boolean(row.revoked), online: !row.revoked && Date.now() - Date.parse(row.last_seen) < 120000 });
  const jobView = row => row && ({ id: row.id, endpointId: row.endpoint_id, endpointName: row.endpoint_name, kind: row.kind, payload: parse(row.payload), timeoutSeconds: row.timeout_seconds, status: row.status, createdAt: row.created_at, dispatchedAt: row.dispatched_at, startedAt: row.started_at, completedAt: row.completed_at, exitCode: row.exit_code, summary: row.summary, createdBy: row.created_by });
  const getJob = id => db.prepare('SELECT j.*, e.display_name endpoint_name FROM jobs j JOIN endpoints e ON e.id=j.endpoint_id WHERE j.id=?').get(id);
  const scriptView = row => row && ({ id: row.id, name: row.name, description: row.description, body: row.body, updatedAt: row.updated_at });
  const scheduleView = row => ({ id: row.id, name: row.name, scriptId: row.script_id, endpointIds: parse(row.endpoint_ids, []), intervalMinutes: row.interval_minutes, nextRunAt: row.next_run_at, enabled: Boolean(row.enabled), createdAt: row.created_at });
  function endpointIds(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 250 || value.some(id => typeof id !== 'string' || id.length > 100)) fail(400, 'Select 1 to 250 endpoint IDs.');
    const ids = [...new Set(value)];
    for (const id of ids) if (!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(id)) fail(400, `Endpoint ${id} is unavailable or revoked.`);
    return ids;
  }
  function validatePayload(kind, payload) {
    if (!object(payload)) fail(400, 'payload must be an object.');
    if (kind === 'powershell') return { script: str(payload.script, 'script', { max: 262144 }) };
    if (kind === 'reboot') return { delaySeconds: integer(payload.delaySeconds, 'delaySeconds', 30, 3600, 30), reason: str(payload.reason, 'reason', { min: 0, max: 200, fallback: 'Library IT maintenance' }) };
    if (kind === 'inventory') return {};
    if (kind === 'storage') {
      const path = str(payload.path, 'path', { max: 1024 });
      if (!/^[a-zA-Z]:\\/.test(path) || path.includes('\0')) fail(400, 'Storage path must be an absolute local Windows path such as C:\\Users.');
      return { path };
    }
    if (kind === 'files') return validateFilesPayload(payload, { fail, str });
    fail(400, 'Unsupported job kind.');
  }
  // Long-poll claims wait on this per-endpoint signal (plus a periodic re-check as a safety net).
  const jobSignals = new EventEmitter();
  jobSignals.setMaxListeners(0);
  const claimWaiters = new Set();
  function insertJob(endpointId, kind, payload, timeoutSeconds, actor, occurrenceKey = null) {
    const id = randomUUID();
    db.prepare('INSERT INTO jobs(id,endpoint_id,kind,payload,timeout_seconds,status,created_at,created_by,occurrence_key) VALUES (?,?,?,?,?,?,?,?,?)').run(id, endpointId, kind, JSON.stringify(payload), timeoutSeconds, 'queued', nowIso(), actor, occurrenceKey);
    // Wake a long-polling claim for this endpoint. Deferred so the caller's transaction commits first.
    setImmediate(() => jobSignals.emit(endpointId));
    return jobView(getJob(id));
  }

  app.get('/api/health', (req, res) => { db.prepare('SELECT 1').get(); res.json({ status: 'ok', version: env.APP_VERSION || '0.1.0' }); });
  app.post('/api/auth/login', rateLimiter({ limit: 10, intervalMs: 15 * 60000 }), checkOrigin, (req, res) => {
    const login = str(req.body.username, 'username', { max: 100 });
    const password = str(req.body.password, 'password', { max: 1024 });
    const user = db.prepare('SELECT * FROM users WHERE lower(username)=lower(?)').get(login);
    const valid = verifyPassword(password, user?.password_hash || dummyPassword);
    if (!user || !valid || user.disabled) { audit('anonymous', 'auth.login.failed', null); return res.status(401).json({ error: 'Invalid username or password.' }); }
    const token = randomToken(); const csrfToken = randomToken();
    const expires = new Date(Date.now() + 12 * 3600000).toISOString();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(nowIso());
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(hashToken(token), user.id, csrfToken, expires);
    res.cookie('rmm_session', token, { httpOnly: true, secure: Boolean(secureCookie), sameSite: 'strict', maxAge: 12 * 3600000, path: '/' });
    audit(user.username, 'auth.login', null);
    res.json({ user: publicUser(user), csrfToken });
  });
  app.get('/api/auth/me', operator, (req, res) => res.json({ user: publicUser(req.operator), csrfToken: req.operator.csrf_token }));
  mountAccounts(app, { db, operator, csrf, audit, fail, str });
  app.post('/api/auth/logout', operator, csrf, (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.operator.token_hash);
    res.clearCookie('rmm_session', { path: '/', secure: Boolean(secureCookie), sameSite: 'strict', httpOnly: true });
    audit(req.operator.username, 'auth.logout'); res.json({ ok: true });
  });

  app.post('/api/agent/enroll', rateLimiter({ limit: 30, intervalMs: 60000 }), (req, res) => {
    const enrollmentToken = str(req.body.enrollmentToken, 'enrollmentToken', { max: 200 });
    const deviceId = str(req.body.deviceId, 'deviceId', { max: 200 });
    const hostname = str(req.body.hostname, 'hostname', { max: 200 });
    const result = transaction(db, () => {
      const enrollment = db.prepare('SELECT * FROM enrollment_tokens WHERE token_hash=? AND expires_at>? AND uses<max_uses').get(hashToken(enrollmentToken), nowIso());
      if (!enrollment) fail(403, 'Invalid, expired, or exhausted enrollment token.');
      const existing = db.prepare('SELECT * FROM endpoints WHERE device_id=?').get(deviceId);
      if (existing && !existing.revoked) fail(409, 'This device is already enrolled. Recover its existing credential, or revoke it before enrolling again.');
      const id = existing?.id || randomUUID(); const token = randomToken(); const now = nowIso();
      if (existing) db.prepare('UPDATE endpoints SET hostname=?,token_hash=?,revoked=0,last_seen=? WHERE id=?').run(hostname, hashToken(token), now, id);
      else db.prepare('INSERT INTO endpoints(id,device_id,hostname,display_name,token_hash,last_seen,created_at) VALUES (?,?,?,?,?,?,?)').run(id, deviceId, hostname, hostname, hashToken(token), now, now);
      db.prepare('UPDATE enrollment_tokens SET uses=uses+1 WHERE id=?').run(enrollment.id);
      audit(`agent:${id}`, 'agent.enrolled', id, { hostname, enrollmentId: enrollment.id });
      return { endpointId: id, agentToken: token };
    });
    res.status(201).json(result);
  });
  const mountJoinConsole = mountJoinRequests(app, { db, audit, fail, str });
  const agentRouter = express.Router();
  agentRouter.use(agent);
  agentRouter.post('/checkin', (req, res) => {
    const bootId = str(req.body.bootId, 'bootId', { max: 200, fallback: '' });
    const now = nowIso();
    if (req.body.inventory !== undefined) {
      const inventory = canonicalInventory(req.body.inventory, req.endpoint.hostname);
      if (Buffer.byteLength(JSON.stringify(inventory)) > 1500000) fail(413, 'Inventory is too large.');
      // Inventory is data, never HTML or a command. UI must render fields as text.
      const hostname = inventory.hostname;
      db.prepare('UPDATE endpoints SET last_seen=?,boot_id=?,inventory=?,hostname=? WHERE id=?').run(now, bootId, JSON.stringify(inventory), hostname, req.endpoint.id);
    } else db.prepare('UPDATE endpoints SET last_seen=?,boot_id=? WHERE id=?').run(now, bootId, req.endpoint.id);
    // inventoryMinutes lets the server keep every agent's inventory fresh (agents 0.1.3+).
    res.json({ endpointId: req.endpoint.id, serverTime: now, inventoryMinutes });
  });
  const claimOnce = endpointId => transaction(db, () => {
    const row = db.prepare("SELECT * FROM jobs WHERE endpoint_id=? AND status='queued' ORDER BY created_at,id LIMIT 1").get(endpointId);
    if (!row) return { job: null };
    const dispatchToken = randomToken();
    // Never put a dispatched job back in queued. Durable server state survives
    // endpoint rollback and is authoritative even if the claim response is lost.
    db.prepare("UPDATE jobs SET status='dispatched',dispatched_at=?,dispatch_hash=? WHERE id=? AND status='queued'").run(nowIso(), hashToken(dispatchToken), row.id);
    audit(`agent:${endpointId}`, 'job.dispatched', row.id);
    return { job: { id: row.id, kind: row.kind, payload: parse(row.payload), dispatchToken, timeoutSeconds: row.timeout_seconds } };
  });
  agentRouter.post('/jobs/claim', async (req, res) => {
    // {} keeps the original immediate answer. {waitSeconds:1-25} long-polls: the request is held
    // until a job is queued for this endpoint or the wait elapses. The claim itself is the same
    // atomic transaction either way, so a job is still consumed exactly once.
    const waitSeconds = req.body.waitSeconds === undefined ? 0 : integer(req.body.waitSeconds, 'waitSeconds', 1, 25);
    const endpointId = req.endpoint.id;
    let result = claimOnce(endpointId);
    if (result.job || !waitSeconds) return res.json(result);
    const disconnected = () => res.destroyed || res.writableEnded || req.socket.destroyed;
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        clearTimeout(timer); clearInterval(recheck);
        jobSignals.off(endpointId, attempt); res.off('close', finish); claimWaiters.delete(finish);
        resolve();
      };
      // Never consume a job for a client that already went away; it stays queued for the next claim.
      const attempt = () => {
        if (done) return;
        if (disconnected()) return finish();
        try { result = claimOnce(endpointId); } catch { return finish(); }
        if (result.job) finish();
      };
      const timer = setTimeout(finish, waitSeconds * 1000);
      const recheck = setInterval(attempt, 2000);
      jobSignals.on(endpointId, attempt);
      res.on('close', finish);
      claimWaiters.add(finish);
    });
    if (!disconnected()) res.json(result);
  });
  function ownedJob(req) {
    const job = db.prepare('SELECT * FROM jobs WHERE id=? AND endpoint_id=?').get(req.params.id, req.endpoint.id);
    if (!job) fail(404, 'Job not found.');
    return job;
  }
  agentRouter.post('/jobs/:id/start', (req, res) => {
    const dispatchToken = str(req.body.dispatchToken, 'dispatchToken', { max: 200 });
    const result = transaction(db, () => {
      const job = ownedJob(req);
      if (!equalText(job.dispatch_hash, hashToken(dispatchToken))) fail(403, 'Invalid dispatch token.');
      if (job.status !== 'dispatched') return { mayExecute: false, status: job.status };
      db.prepare("UPDATE jobs SET status='running',started_at=? WHERE id=?").run(nowIso(), job.id);
      audit(`agent:${req.endpoint.id}`, 'job.started', job.id);
      return { mayExecute: true, status: 'running' };
    });
    res.json(result);
  });
  agentRouter.put('/jobs/:id/output/:sequence', (req, res) => {
    const job = ownedJob(req);
    if (!['running', 'succeeded', 'failed', 'interrupted'].includes(job.status)) fail(409, 'Output is accepted after start authorization.');
    if (!/^\d+$/.test(req.params.sequence)) fail(400, 'Invalid output sequence.');
    const sequence = integer(Number(req.params.sequence), 'sequence', 0, Number.MAX_SAFE_INTEGER);
    const stream = req.body.stream;
    if (!['stdout', 'stderr', 'system'].includes(stream)) fail(400, 'Invalid output stream.');
    const text = str(req.body.text, 'text', { min: 0, max: 65536 });
    if (Buffer.byteLength(text, 'utf8') > 65536) fail(413, 'Output chunk exceeds 65536 UTF-8 bytes. Split it into more chunks.');
    const existing = db.prepare('SELECT * FROM output_chunks WHERE job_id=? AND sequence=?').get(job.id, sequence);
    if (existing) {
      if (existing.stream !== stream || existing.text !== text) fail(409, 'This output sequence already contains different data.');
      return res.json({ ok: true, duplicate: true });
    }
    const last = db.prepare('SELECT MAX(sequence) last FROM output_chunks WHERE job_id=?').get(job.id).last;
    if (sequence !== (last === null ? 0 : last + 1)) fail(409, 'Output chunks must arrive in sequence starting at zero; retry the earliest missing chunk first.');
    db.prepare('INSERT INTO output_chunks VALUES (?,?,?,?,?)').run(job.id, sequence, stream, text, nowIso());
    res.json({ ok: true, duplicate: false });
  });
  agentRouter.post('/jobs/:id/complete', (req, res) => {
    const status = req.body.status;
    if (!['succeeded', 'failed', 'interrupted'].includes(status)) fail(400, 'Invalid completion status.');
    const exitCode = req.body.exitCode === null || req.body.exitCode === undefined ? null : integer(req.body.exitCode, 'exitCode', -2147483648, 2147483647);
    const summary = str(req.body.summary, 'summary', { min: 0, max: 4000, fallback: '' });
    transaction(db, () => {
      const job = ownedJob(req);
      if (['succeeded', 'failed', 'interrupted'].includes(job.status)) {
        if (job.status !== status || job.exit_code !== exitCode || (job.summary || '') !== summary) fail(409, 'Job already completed with a different result.');
        return;
      }
      if (job.status !== 'running' && !(job.status === 'dispatched' && status === 'interrupted')) fail(409, 'Job cannot complete in its current state.');
      db.prepare('UPDATE jobs SET status=?,exit_code=?,summary=?,completed_at=? WHERE id=?').run(status, exitCode, summary, nowIso(), job.id);
      audit(`agent:${req.endpoint.id}`, `job.${status}`, job.id, { exitCode });
    });
    res.json({ ok: true });
  });
  // Called by the endpoint's uninstaller: the endpoint gives up its own credential. Queued jobs
  // are cancelled (never dispatched); jobs already dispatched keep their recorded state.
  agentRouter.post('/retire', (req, res) => {
    transaction(db, () => {
      db.prepare('UPDATE endpoints SET revoked=1 WHERE id=?').run(req.endpoint.id);
      db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,summary='Agent was uninstalled before dispatch' WHERE endpoint_id=? AND status='queued'").run(nowIso(), req.endpoint.id);
      audit(`agent:${req.endpoint.id}`, 'endpoint.retired.uninstalled', req.endpoint.id);
    });
    res.json({ ok: true });
  });
  const files = mountFiles({ db, audit, fail, str, integer, directory: fileDirectory,
    maxFileBytes: options.maxFileBytes, maxTotalBytes: options.maxTotalFileBytes, retentionMs: options.fileRetentionMs });
  const support = mountSupport({ db, audit, fail, str, insertJob, publicOrigin, validationIntervalMs: options.supportValidationIntervalMs });
  support.mountAgent(agentRouter);
  files.mountAgent(agentRouter);
  app.use('/api/agent', agentRouter);

  const admin = express.Router();
  admin.use(operator, csrf);
  admin.use((req, res, next) => {
    const role = req.operator.role;
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    if (!['admin', 'operator', 'viewer'].includes(role)) return res.status(403).json({error:'Account role is not authorized.'});
    if (role !== 'admin' && (path.startsWith('/settings/update') || path === '/audit')) return res.status(403).json({error:'Administrator access required.'});
    if (role === 'viewer' && !['GET','HEAD','OPTIONS'].includes(req.method)) return res.status(403).json({error:'Read-only accounts cannot change endpoints or run commands.'});
    next();
  });
  admin.get('/endpoints', (req, res) => res.json(db.prepare('SELECT * FROM endpoints ORDER BY display_name COLLATE NOCASE').all().map(endpointView)));
  mountGroups(admin, {db,audit,fail,str});
  admin.get('/endpoints/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM endpoints WHERE id=?').get(req.params.id);
    if (!row) fail(404, 'Endpoint not found.'); res.json(endpointView(row));
  });
  admin.patch('/endpoints/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM endpoints WHERE id=?').get(req.params.id);
    if (!row) fail(404, 'Endpoint not found.');
    const name = str(req.body.displayName, 'displayName', { max: 200, fallback: row.display_name });
    const tags = req.body.tags ?? parse(row.tags, []);
    if (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string' || tag.length > 50 || tag.length < 1)) fail(400, 'tags must contain at most 20 short labels.');
    db.prepare('UPDATE endpoints SET display_name=?,tags=? WHERE id=?').run(name, JSON.stringify([...new Set(tags)]), row.id);
    audit(req.operator.username, 'endpoint.updated', row.id); res.json(endpointView(db.prepare('SELECT * FROM endpoints WHERE id=?').get(row.id)));
  });
  admin.post('/endpoints/:id/revoke', (req, res) => {
    transaction(db, () => {
      const row = db.prepare('SELECT * FROM endpoints WHERE id=?').get(req.params.id); if (!row) fail(404, 'Endpoint not found.');
      db.prepare('UPDATE endpoints SET revoked=1 WHERE id=?').run(row.id);
      db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,summary='Endpoint credential revoked before dispatch' WHERE endpoint_id=? AND status='queued'").run(nowIso(), row.id);
      audit(req.operator.username, 'endpoint.revoked', row.id);
    }); res.json({ ok: true });
  });
  admin.get('/enrollment-tokens', (req, res) => res.json(db.prepare('SELECT * FROM enrollment_tokens ORDER BY created_at DESC').all().map(row => ({ id: row.id, label: row.label, maxUses: row.max_uses, uses: row.uses, expiresAt: row.expires_at, createdAt: row.created_at }))));
  admin.post('/enrollment-tokens', (req, res) => {
    const id = randomUUID(); const token = randomToken(); const createdAt = nowIso();
    const label = str(req.body.label, 'label', { max: 100 });
    const maxUses = integer(req.body.maxUses, 'maxUses', 1, 10000, 1);
    const hours = integer(req.body.expiresInHours, 'expiresInHours', 1, 720, 24);
    const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
    db.prepare('INSERT INTO enrollment_tokens(id,label,token_hash,max_uses,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(id, label, hashToken(token), maxUses, expiresAt, createdAt);
    audit(req.operator.username, 'enrollment.created', id, { label, maxUses, expiresAt });
    res.status(201).json({ id, token, label, maxUses, uses: 0, expiresAt, createdAt });
  });
  admin.get('/jobs', (req, res) => {
    const limit = integer(Number(req.query.limit || 500), 'limit', 1, 2000);
    const rows = req.query.endpointId ? db.prepare('SELECT j.*,e.display_name endpoint_name FROM jobs j JOIN endpoints e ON e.id=j.endpoint_id WHERE endpoint_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ?').all(String(req.query.endpointId), limit) : db.prepare('SELECT j.*,e.display_name endpoint_name FROM jobs j JOIN endpoints e ON e.id=j.endpoint_id ORDER BY j.created_at DESC,j.id DESC LIMIT ?').all(limit);
    res.json(rows.map(jobView));
  });
  admin.post('/jobs', (req, res) => {
    const ids = endpointIds(req.body.endpointIds); const kind = req.body.kind;
    const payload = validatePayload(kind, req.body.payload || {});
    const timeoutSeconds = integer(req.body.timeoutSeconds, 'timeoutSeconds', 10, 86400, 900);
    const idempotencyKey = req.body.idempotencyKey === undefined ? null : str(req.body.idempotencyKey, 'idempotencyKey', { max: 128 });
    const runName = str(req.body.runName,'runName',{max:150,fallback:kind});
    const requestHash = hashToken(JSON.stringify({ ids: [...ids].sort(), kind, payload, timeoutSeconds,runName }));
    const scopedKey = idempotencyKey ? `${req.operator.user_id}:${idempotencyKey}` : null;
    const result = transaction(db, () => {
      if (scopedKey) {
        const previous = db.prepare('SELECT * FROM job_requests WHERE idempotency_key=?').get(scopedKey);
        if (previous) {
          if (previous.request_hash !== requestHash) fail(409, 'Idempotency key was already used for different jobs.');
          return { jobs: parse(previous.job_ids, []).map(id => jobView(getJob(id))), duplicate: true };
        }
      }
      const jobs = ids.map(id => insertJob(id, kind, payload, timeoutSeconds, req.operator.username));
      const runId = randomUUID();
      db.prepare('INSERT INTO job_runs VALUES (?,?,?,?)').run(runId,runName,JSON.stringify(ids),nowIso());
      for(const job of jobs) db.prepare('UPDATE jobs SET run_id=? WHERE id=?').run(runId,job.id);
      if (scopedKey) db.prepare('INSERT INTO job_requests VALUES (?,?,?,?)').run(scopedKey, requestHash, JSON.stringify(jobs.map(job => job.id)), nowIso());
      audit(req.operator.username, 'jobs.created', null, { jobIds: jobs.map(job => job.id), kind, endpointIds: ids });
      // File explorer operations get their own audit entry with the exact paths involved.
      if (kind === 'files') audit(req.operator.username, `files.${payload.action}`, jobs.length === 1 ? jobs[0].id : null, { jobIds: jobs.map(job => job.id), endpointIds: ids, ...payload });
      return { jobs, runId, duplicate: false };
    }); res.status(result.duplicate ? 200 : 201).json(result);
  });
  admin.get('/runs',(req,res)=>{
    res.json(db.prepare('SELECT * FROM job_runs ORDER BY created_at DESC,id DESC LIMIT 100').all().map(run=>({id:run.id,name:run.name,createdAt:run.created_at,endpointCount:parse(run.endpoint_ids,[]).length,
      counts:Object.fromEntries(db.prepare('SELECT status,count(*) n FROM jobs WHERE run_id=? GROUP BY status').all(run.id).map(row=>[row.status,row.n]))})));
  });
  admin.get('/runs/:id',(req,res)=>{
    const run=db.prepare('SELECT * FROM job_runs WHERE id=?').get(req.params.id);if(!run) fail(404,'Run not found.');
    res.json({id:run.id,name:run.name,createdAt:run.created_at,endpointIds:parse(run.endpoint_ids,[]),jobs:db.prepare('SELECT id FROM jobs WHERE run_id=? ORDER BY created_at,id').all(run.id).map(row=>jobView(getJob(row.id)))});
  });
  admin.get('/jobs/:id', (req, res) => { const job = getJob(req.params.id); if (!job) fail(404, 'Job not found.'); res.json(jobView(job)); });
  admin.post('/jobs/:id/cancel', (req, res) => {
    const job = getJob(req.params.id); if (!job) fail(404, 'Job not found.');
    if (job.status !== 'queued') fail(409, 'Only queued jobs can be cancelled. A dispatched command cannot safely be recalled.');
    db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,summary='Cancelled by operator before dispatch' WHERE id=? AND status='queued'").run(nowIso(), job.id);
    audit(req.operator.username, 'job.cancelled', job.id); res.json(jobView(getJob(job.id)));
  });
  admin.get('/jobs/:id/output', (req, res) => {
    if (!getJob(req.params.id)) fail(404, 'Job not found.');
    const after = integer(Number(req.query.after ?? -1), 'after', -1, Number.MAX_SAFE_INTEGER);
    const limit = integer(Number(req.query.limit || 200), 'limit', 1, 1000);
    const rows = db.prepare('SELECT sequence,stream,text,created_at FROM output_chunks WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(req.params.id, after, limit + 1);
    const hasMore = rows.length > limit; const chunks = rows.slice(0, limit).map(row => ({ sequence: row.sequence, stream: row.stream, text: row.text, createdAt: row.created_at }));
    res.json({ chunks, nextCursor: chunks.at(-1)?.sequence ?? after, hasMore });
  });
  admin.get('/jobs/:id/download', async (req, res) => {
    const job = getJob(req.params.id); if (!job) fail(404, 'Job not found.');
    audit(req.operator.username, 'job.output.downloaded', job.id);
    res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="rmm-job-${job.id}.txt"` });
    // Page through SQLite and honor backpressure. No total output length cap or
    // ellipsis, including jobs whose output exceeds browser display capacity.
    let cursor = -1;
    while (!res.destroyed) {
      const rows = db.prepare('SELECT sequence,text FROM output_chunks WHERE job_id=? AND sequence>? ORDER BY sequence LIMIT 100').all(job.id, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = row.sequence;
        // Encode before writing. Explicit byte chunks avoid Unicode string-write
        // stalls observed with SQLite-backed astral text under HTTP backpressure.
        if (!res.write(Buffer.from(row.text, 'utf8'))) {
          await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
          if (res.destroyed) return;
        }
      }
    }
    res.end();
  });
  admin.get('/scripts', (req, res) => res.json(db.prepare('SELECT * FROM scripts ORDER BY name COLLATE NOCASE').all().map(scriptView)));
  function scriptInput(body) { return { name: str(body.name, 'name', { max: 150 }), description: str(body.description, 'description', { min: 0, max: 4000, fallback: '' }), body: str(body.body, 'body', { max: 262144 }) }; }
  admin.post('/scripts', (req, res) => {
    const input = scriptInput(req.body); const id = randomUUID();
    db.prepare('INSERT INTO scripts VALUES (?,?,?,?,?)').run(id, input.name, input.description, input.body, nowIso());
    audit(req.operator.username, 'script.created', id, { name: input.name }); res.status(201).json(scriptView(db.prepare('SELECT * FROM scripts WHERE id=?').get(id)));
  });
  admin.put('/scripts/:id', (req, res) => {
    if (!db.prepare('SELECT id FROM scripts WHERE id=?').get(req.params.id)) fail(404, 'Script not found.');
    const input = scriptInput(req.body);
    db.prepare('UPDATE scripts SET name=?,description=?,body=?,updated_at=? WHERE id=?').run(input.name, input.description, input.body, nowIso(), req.params.id);
    audit(req.operator.username, 'script.updated', req.params.id); res.json(scriptView(db.prepare('SELECT * FROM scripts WHERE id=?').get(req.params.id)));
  });
  admin.delete('/scripts/:id', (req, res) => {
    if (db.prepare('SELECT id FROM schedules WHERE script_id=?').get(req.params.id)) fail(409, 'Delete schedules referencing this script first.');
    const result = db.prepare('DELETE FROM scripts WHERE id=?').run(req.params.id); if (!result.changes) fail(404, 'Script not found.');
    audit(req.operator.username, 'script.deleted', req.params.id); res.json({ ok: true });
  });
  admin.get('/schedules', (req, res) => res.json(db.prepare('SELECT * FROM schedules ORDER BY created_at DESC').all().map(scheduleView)));
  admin.post('/schedules', (req, res) => {
    const name = str(req.body.name, 'name', { max: 150 }); const scriptId = str(req.body.scriptId, 'scriptId', { max: 100 });
    if (!db.prepare('SELECT id FROM scripts WHERE id=?').get(scriptId)) fail(400, 'Script not found.');
    const ids = endpointIds(req.body.endpointIds);
    const intervalMinutes = integer(req.body.intervalMinutes, 'intervalMinutes', 5, 525600);
    const startsAt = date(req.body.startsAt, 'startsAt', new Date(Date.now() + intervalMinutes * 60000).toISOString());
    if (Date.parse(startsAt) < Date.now() - 60000) fail(400, 'startsAt must be in the future.');
    const enabled = bool(req.body.enabled, 'enabled', true); const id = randomUUID();
    db.prepare('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?)').run(id, name, scriptId, JSON.stringify(ids), intervalMinutes, startsAt, enabled ? 1 : 0, nowIso());
    audit(req.operator.username, 'schedule.created', id, { name, scriptId, endpointIds: ids, intervalMinutes }); res.status(201).json(scheduleView(db.prepare('SELECT * FROM schedules WHERE id=?').get(id)));
  });
  admin.patch('/schedules/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM schedules WHERE id=?').get(req.params.id); if (!row) fail(404, 'Schedule not found.');
    const enabled = bool(req.body.enabled, 'enabled');
    // Re-enabling never catches up previously missed occurrences.
    const next = enabled && !row.enabled ? new Date(Date.now() + row.interval_minutes * 60000).toISOString() : row.next_run_at;
    db.prepare('UPDATE schedules SET enabled=?,next_run_at=? WHERE id=?').run(enabled ? 1 : 0, next, row.id);
    audit(req.operator.username, enabled ? 'schedule.enabled' : 'schedule.disabled', row.id); res.json(scheduleView(db.prepare('SELECT * FROM schedules WHERE id=?').get(row.id)));
  });
  admin.delete('/schedules/:id', (req, res) => { const result = db.prepare('DELETE FROM schedules WHERE id=?').run(req.params.id); if (!result.changes) fail(404, 'Schedule not found.'); audit(req.operator.username, 'schedule.deleted', req.params.id); res.json({ ok: true }); });
  admin.get('/audit', (req, res) => {
    const limit = integer(Number(req.query.limit || 100), 'limit', 1, 2000);
    res.json(db.prepare('SELECT * FROM audit ORDER BY created_at DESC,id DESC LIMIT ?').all(limit).map(row => ({ id: row.id, actor: row.actor, action: row.action, target: row.target, details: parse(row.details), createdAt: row.created_at })));
  });
  admin.get('/overview', (req, res) => {
    const endpoints = db.prepare('SELECT * FROM endpoints WHERE revoked=0').all().map(endpointView);
    const online = endpoints.filter(e => e.online).length;
    let diskTotalBytes = 0; let diskUsedBytes = 0; let lowDiskCount = 0;
    for (const endpoint of endpoints) for (const disk of Array.isArray(endpoint.inventory.disks) ? endpoint.inventory.disks : []) {
      if (Number.isFinite(disk.totalBytes) && Number.isFinite(disk.freeBytes) && disk.totalBytes > 0) { diskTotalBytes += disk.totalBytes; diskUsedBytes += Math.max(0, disk.totalBytes - disk.freeBytes); if (disk.freeBytes / disk.totalBytes < 0.1) lowDiskCount++; }
    }
    const counts = Object.fromEntries(db.prepare('SELECT status,COUNT(*) count FROM jobs GROUP BY status').all().map(row => [row.status, row.count]));
    res.json({ totalEndpoints: endpoints.length, onlineEndpoints: online, offlineEndpoints: endpoints.length - online, domainJoinedEndpoints: endpoints.filter(e => e.inventory.domainJoined).length, diskTotalBytes, diskUsedBytes, lowDiskCount, jobs: counts, activeJobs: (counts.queued || 0) + (counts.dispatched || 0) + (counts.running || 0), scriptCount: db.prepare('SELECT COUNT(*) count FROM scripts').get().count, scheduleCount: db.prepare('SELECT COUNT(*) count FROM schedules WHERE enabled=1').get().count });
  });
  const updateEnabled = Boolean(env.UPDATE_HELPER_URL && env.UPDATE_HELPER_TOKEN);
  admin.get('/settings', (req, res) => res.json({ version: env.APP_VERSION || '0.1.0', updateEnabled, updateImage: env.UPDATE_IMAGE || null, publicOrigin, screenViewingEnabled: Boolean(publicOrigin), executionPolicy: 'at-most-once' }));
  async function updateRequest(method, path) {
    if (!updateEnabled) fail(503, 'Application updates are not configured on this server.');
    try {
      const response = await fetch(new URL(path, env.UPDATE_HELPER_URL), { method, headers: { Authorization: `Bearer ${env.UPDATE_HELPER_TOKEN}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(10000) });
      const text = await response.text(); const data = parse(text, { error: 'Update helper returned an invalid response.' });
      if (!response.ok) fail(response.status >= 400 && response.status < 500 ? response.status : 502, data.error || 'Update helper request failed.');
      return data;
    } catch (error) { if (error instanceof HttpError) throw error; fail(502, 'Update helper is unavailable. Check host update service.'); }
  }
  admin.get('/settings/update', async (req, res) => res.json(await updateRequest('GET', '/status')));
  admin.post('/settings/update', async (req, res) => {
    audit(req.operator.username, 'application.update.requested');
    const result = await updateRequest('POST', '/update'); res.status(202).json(result);
  });
  support.mountConsole(admin);
  mountJoinConsole(admin);
  files.mountConsole(admin);
  app.use('/api', admin);
  app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found.' }));
  const webPath = options.webPath || resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(resolve(webPath, 'index.html'))) {
    app.use(express.static(webPath, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get('/{*path}', (req, res) => res.sendFile(resolve(webPath, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('API failure:', error.message);
    res.status(status).json({ error: status >= 500 && !(error instanceof HttpError) ? 'Server request failed. Check server logs.' : error.message });
  });

  function tickSchedules(now = new Date()) {
    const timestamp = now.toISOString();
    transaction(db, () => {
      for (const schedule of db.prepare('SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?').all(timestamp)) {
        const interval = schedule.interval_minutes * 60000;
        const due = Date.parse(schedule.next_run_at);
        // Advance directly beyond now. If downtime skipped an interval, skip the
        // stale occurrence entirely instead of replaying a backlog on boot.
        const skipped = now.getTime() - due >= interval;
        const nextRun = new Date(due + (Math.floor((now.getTime() - due) / interval) + 1) * interval).toISOString();
        const inserted = db.prepare('INSERT OR IGNORE INTO schedule_occurrences VALUES (?,?,?)').run(schedule.id, schedule.next_run_at, timestamp);
        db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(nextRun, schedule.id);
        if (!inserted.changes || skipped) { if (skipped) audit('scheduler', 'schedule.missed.skipped', schedule.id); continue; }
        const script = db.prepare('SELECT * FROM scripts WHERE id=?').get(schedule.script_id);
        if (!script) continue;
        const jobs = [];
        for (const id of parse(schedule.endpoint_ids, [])) {
          if (!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(id)) continue;
          // Do not accumulate scheduled jobs for offline endpoints, and do not
          // overlap another outstanding occurrence of the same schedule.
          const lastSeen = db.prepare('SELECT last_seen FROM endpoints WHERE id=?').get(id).last_seen;
          const pending = db.prepare("SELECT id FROM jobs WHERE endpoint_id=? AND occurrence_key LIKE ? AND status IN ('queued','dispatched','running') LIMIT 1").get(id, `${schedule.id}:%`);
          if (Date.parse(lastSeen) < now.getTime() - 120000 || pending) continue;
          jobs.push(insertJob(id, 'powershell', { script: script.body }, 900, 'scheduler', `${schedule.id}:${schedule.next_run_at}`).id);
        }
        audit('scheduler', 'schedule.executed', schedule.id, { jobIds: jobs, dueAt: schedule.next_run_at });
      }
    });
  }
  // Answer every held long-poll claim with {job:null} (used on shutdown so the listener can close).
  const releaseClaimWaiters = () => { for (const finish of [...claimWaiters]) finish(); };
  return { app, db, tickSchedules, releaseClaimWaiters, attachSupport: support.attach, stopSupport: support.shutdown, cleanupFiles: files.cleanup,
    close: () => { support.shutdown(); releaseClaimWaiters(); files.close(); db.close(); } };
}
