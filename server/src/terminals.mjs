import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { hashToken } from './security.mjs';

const iso = () => new Date().toISOString();
const roles = new Set(['admin', 'operator']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };

// Terminal runspaces live only inside the enrolled Windows service. The server
// grants each immutable command once and stores output through ordinary jobs.
export function mountTerminal({ db, audit, fail, str, insertJob, jobView, getJob, validationIntervalMs = 5000 }) {
  let stopped = false;
  const get = id => db.prepare('SELECT t.*,e.display_name endpoint_name FROM terminal_sessions t JOIN endpoints e ON e.id=t.endpoint_id WHERE t.id=?').get(id);
  const view = row => ({ id: row.id, endpointId: row.endpoint_id, endpointName: row.endpoint_name, operatorName: row.operator_name,
    status: row.status, workingDirectory: row.working_directory, expiresAt: row.expires_at, createdAt: row.created_at,
    closedAt: row.closed_at, reason: row.close_reason });
  const id = (value, name) => { if (typeof value !== 'string' || !uuid.test(value)) fail(400, `${name} must be a UUID.`); return value; };
  const exact = (body, fields) => { if (Object.keys(body).some(key => !fields.includes(key))) fail(400, 'Unexpected terminal request field.'); };
  const requireRole = req => { if (!roles.has(req.operator.role)) fail(403, 'Terminal sessions require an operator account.'); };
  const supported = endpoint => {
    const version = parse(endpoint.inventory).agentVersion;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return false;
    const parts = version.split('.').map(Number);
    return parts[0] > 0 || parts[1] > 1 || (parts[1] === 1 && parts[2] >= 7);
  };

  function close(sessionId, reason, actor = 'terminal') {
    const current = get(sessionId);
    if (!current || current.status !== 'open') return current;
    transaction(db, () => {
      db.prepare("UPDATE terminal_sessions SET status='closed',closed_at=?,close_reason=? WHERE id=? AND status='open'").run(iso(), reason, sessionId);
      // A consumed command can never be recalled/requeued. The agent's periodic
      // validation kills its process, while durable jobs retain their evidence.
      db.prepare(`UPDATE jobs SET status='cancelled',completed_at=?,summary='Terminal closed before command dispatch'
        WHERE status='queued' AND id IN (SELECT job_id FROM terminal_commands WHERE terminal_id=?)`).run(iso(), sessionId);
      audit(actor, 'terminal.closed', sessionId, { reason });
    });
    return get(sessionId);
  }
  function valid(row) {
    if (!row || row.status !== 'open') return false;
    if (Date.parse(row.expires_at) <= Date.now()) { close(row.id, 'session_expired'); return false; }
    const current = db.prepare(`SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled=0`).get(row.operator_session_hash, row.operator_id, iso());
    if (!current || !roles.has(current.role)) { close(row.id, 'operator_session_revoked'); return false; }
    if (!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(row.endpoint_id)) { close(row.id, 'endpoint_revoked'); return false; }
    return true;
  }
  function cleanup() {
    for (const row of db.prepare("SELECT * FROM terminal_sessions WHERE status='open'").all()) valid(row);
  }
  function owned(req) {
    requireRole(req);
    const row = get(req.params.id);
    // A second login by the same account cannot adopt a persistent runspace.
    if (!row || row.operator_id !== req.operator.user_id || row.operator_session_hash !== req.operator.token_hash) fail(404, 'Terminal session not found.');
    valid(row);
    return get(row.id);
  }
  function agentOwned(req) {
    const row = get(req.params.id);
    if (!row || row.endpoint_id !== req.endpoint.id) fail(404, 'Terminal session not found.');
    return row;
  }
  function runningCommand(row, jobId, requireRunning = true) {
    id(jobId, 'jobId');
    const job = getJob(jobId);
    const command = db.prepare('SELECT * FROM terminal_commands WHERE terminal_id=? AND job_id=?').get(row.id, jobId);
    if (!command || !job || job.endpoint_id !== row.endpoint_id || job.kind !== 'terminal' || parse(job.payload).sessionId !== row.id) fail(404, 'Terminal command not found.');
    if (requireRunning && job.status !== 'running') fail(409, 'Terminal command must have a fresh running-job authorization.');
    if (!requireRunning && !['running', 'succeeded', 'failed', 'interrupted'].includes(job.status)) fail(409, 'Terminal command has not started.');
    return command;
  }
  // Process memory, runspace variables and live agent ownership never survive a
  // server restart. Closing rows preserves both history and consumed grants.
  for (const row of db.prepare("SELECT id FROM terminal_sessions WHERE status='open'").all()) close(row.id, 'server_restarted');
  const timer = setInterval(cleanup, validationIntervalMs); timer.unref();

  function mountConsole(router) {
    router.post('/terminals', (req, res) => {
      requireRole(req); exact(req.body, ['endpointId', 'idempotencyKey']);
      const endpointId = id(req.body.endpointId, 'endpointId');
      const key = str(req.body.idempotencyKey, 'idempotencyKey', { max: 128 });
      const requestHash = hashToken(JSON.stringify({ endpointId }));
      cleanup();
      const previous = db.prepare('SELECT * FROM terminal_sessions WHERE operator_session_hash=? AND idempotency_key=?').get(req.operator.token_hash, key);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'Idempotency key was already used for another terminal.');
        return res.json(view(get(previous.id)));
      }
      const endpoint = db.prepare('SELECT * FROM endpoints WHERE id=? AND revoked=0').get(endpointId);
      if (!endpoint) fail(404, 'Endpoint not found.');
      if (!supported(endpoint)) fail(409, 'Upgrade this endpoint to agent 0.1.7 or later to use persistent terminals.');
      const result = transaction(db, () => {
        if (db.prepare("SELECT COUNT(*) count FROM terminal_sessions WHERE endpoint_id=? AND status='open'").get(endpointId).count >= 4) fail(409, 'This endpoint already has four open terminal sessions. Close one first.');
        const sessionId = randomUUID(); const created = iso();
        const expires = new Date(Date.now() + 2 * 3600000).toISOString();
        db.prepare(`INSERT INTO terminal_sessions(id,endpoint_id,operator_id,operator_session_hash,operator_name,status,created_at,expires_at,idempotency_key,request_hash)
          VALUES (?,?,?,?,?,'open',?,?,?,?)`).run(sessionId, endpointId, req.operator.user_id, req.operator.token_hash, req.operator.username, created, expires, key, requestHash);
        audit(req.operator.username, 'terminal.created', sessionId, { endpointId });
        return view(get(sessionId));
      });
      res.status(201).json(result);
    });
    router.get('/terminals/:id', (req, res) => {
      const row = owned(req);
      const commands = db.prepare('SELECT job_id FROM terminal_commands c JOIN jobs j ON j.id=c.job_id WHERE c.terminal_id=? ORDER BY j.created_at,j.id').all(row.id);
      res.json({ ...view(row), jobs: commands.map(command => jobView(getJob(command.job_id))) });
    });
    router.post('/terminals/:id/commands', (req, res) => {
      const row = owned(req); exact(req.body, ['command', 'idempotencyKey', 'timeoutSeconds']);
      const script = str(req.body.command, 'command', { max: 262144 });
      if (!script.trim()) fail(400, 'Enter a PowerShell command.');
      const key = str(req.body.idempotencyKey, 'idempotencyKey', { max: 128 });
      const timeout = req.body.timeoutSeconds === undefined ? 900 : req.body.timeoutSeconds;
      if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) fail(400, 'timeoutSeconds must be an integer from 1 to 3600.');
      const requestHash = hashToken(JSON.stringify({ script, timeout }));
      const previous = db.prepare('SELECT * FROM terminal_commands WHERE terminal_id=? AND idempotency_key=?').get(row.id, key);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'Idempotency key was already used for another command.');
        return res.json(jobView(getJob(previous.job_id)));
      }
      if (row.status !== 'open') fail(409, 'Terminal is closed. Open a new session.');
      const result = transaction(db, () => {
        const pending = db.prepare(`SELECT j.id FROM terminal_commands c JOIN jobs j ON j.id=c.job_id
          WHERE c.terminal_id=? AND j.status IN ('queued','dispatched','running') LIMIT 1`).get(row.id);
        if (pending) fail(409, 'Wait for the current command to finish, or close this terminal. Commands are never replayed.');
        const job = insertJob(row.endpoint_id, 'terminal', { sessionId: row.id, script }, timeout, req.operator.username);
        db.prepare('INSERT INTO terminal_commands(terminal_id,job_id,idempotency_key,request_hash) VALUES (?,?,?,?)').run(row.id, job.id, key, requestHash);
        audit(req.operator.username, 'terminal.command.created', row.id, { jobId: job.id, timeoutSeconds: timeout });
        return job;
      });
      res.status(201).json(result);
    });
    router.post('/terminals/:id/close', (req, res) => {
      const row = owned(req); exact(req.body, []);
      res.json(view(close(row.id, 'operator_closed', req.operator.username)));
    });
  }

  function mountAgent(router) {
    router.post('/terminals/validate', (req, res) => {
      exact(req.body, ['instanceId', 'sessionIds']);
      const instanceId = id(req.body.instanceId, 'instanceId'); const ids = req.body.sessionIds;
      if (!Array.isArray(ids) || ids.length > 8) fail(400, 'sessionIds must contain at most eight UUIDs.');
      ids.forEach(value => id(value, 'sessionId'));
      const allowed = [];
      for (const sessionId of new Set(ids)) {
        const row = get(sessionId);
        // Never mutate or reveal another endpoint's terminal, even with its ID.
        if (!row || row.endpoint_id !== req.endpoint.id || !valid(row)) continue;
        if (row.instance_id && row.instance_id !== instanceId) { close(row.id, 'agent_restarted', `agent:${req.endpoint.id}`); continue; }
        if (row.instance_id === instanceId) allowed.push(row.id);
      }
      res.json({ allowed });
    });
    router.post('/terminals/:id/authorize', (req, res) => {
      exact(req.body, ['jobId', 'instanceId']);
      const row = agentOwned(req); const instanceId = id(req.body.instanceId, 'instanceId');
      if (!valid(row)) fail(409, 'Terminal is closed or its original operator login is no longer valid.');
      const command = runningCommand(row, req.body.jobId);
      if (row.instance_id && row.instance_id !== instanceId) {
        close(row.id, 'agent_restarted', `agent:${req.endpoint.id}`);
        fail(409, 'Terminal cannot resume in a new agent process.');
      }
      if (command.authorized_at !== null) fail(409, 'This terminal command authorization has already been consumed.');
      transaction(db, () => {
        db.prepare('UPDATE terminal_sessions SET instance_id=? WHERE id=?').run(instanceId, row.id);
        const granted = db.prepare('UPDATE terminal_commands SET authorized_at=? WHERE job_id=? AND authorized_at IS NULL').run(iso(), command.job_id);
        if (!granted.changes) fail(409, 'This terminal command authorization has already been consumed.');
        audit(`agent:${req.endpoint.id}`, 'terminal.command.authorized', row.id, { jobId: command.job_id });
      });
      res.json({ expiresAt: row.expires_at, workingDirectory: row.working_directory });
    });
    router.post('/terminals/:id/state', (req, res) => {
      exact(req.body, ['instanceId', 'jobId', 'status', 'workingDirectory']);
      const row = agentOwned(req); const instanceId = id(req.body.instanceId, 'instanceId');
      if (!['open', 'closed'].includes(req.body.status)) fail(400, 'status must be open or closed.');
      if (!valid(row)) fail(409, 'Terminal is closed or its original operator login is no longer valid.');
      // Ending an idle helper is allowed with its last authorized completed job;
      // this never authorizes input or execution. Open updates still need running.
      const command = runningCommand(row, req.body.jobId, req.body.status === 'open');
      if (row.instance_id !== instanceId || !command.authorized_at) fail(409, 'Terminal process ownership is not authorized.');
      if (req.body.workingDirectory !== undefined) {
        const directory = req.body.workingDirectory === null ? null : str(req.body.workingDirectory, 'workingDirectory', { min: 0, max: 4096 });
        db.prepare('UPDATE terminal_sessions SET working_directory=? WHERE id=?').run(directory, row.id);
      }
      if (req.body.status === 'closed') close(row.id, 'agent_closed', `agent:${req.endpoint.id}`);
      res.json(view(get(row.id)));
    });
  }
  const shutdown = () => {
    if (stopped) return; stopped = true; clearInterval(timer);
    for (const row of db.prepare("SELECT id FROM terminal_sessions WHERE status='open'").all()) close(row.id, 'server_shutdown');
  };
  return { mountConsole, mountAgent, shutdown, cleanup };
}
