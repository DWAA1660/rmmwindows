import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { cookies, hashToken, randomToken } from './security.mjs';
import { transaction } from './db.mjs';

const terminal = new Set(['declined', 'stopped', 'expired', 'failed']);
const open = socket => socket?.readyState === WebSocket.OPEN;
const iso = () => new Date().toISOString();
const roles = new Set(['admin', 'operator']);
const actions = new Set(['move', 'down', 'up', 'wheel', 'keyDown', 'keyUp', 'releaseAll']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const attentionMessages = Object.freeze({
  sent: 'Ctrl+Alt+Del requested. Secure desktop viewing is unavailable.',
  policy_not_enabled: 'Windows policy does not permit software Ctrl+Alt+Del.',
  not_available: 'Ctrl+Alt+Del is unavailable for this session.',
  failed: 'Windows could not request Ctrl+Alt+Del.'
});
const keys = /^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Backspace|Tab|Enter|Escape|Space|Delete|Insert|Home|End|PageUp|PageDown|CapsLock|NumLock|ScrollLock|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Numpad(?:Add|Subtract|Multiply|Divide|Decimal|Enter))$/;

// Only live display frames may be dropped. Durable job output never passes through this relay.
export function relayFrame(socket, frame, maxBufferedBytes = 1024 * 1024) {
  if (!open(socket) || socket.bufferedAmount > maxBufferedBytes) return false;
  socket.send(frame, { binary: true });
  return true;
}

export function mountSupport({ db, audit, fail, str, insertJob, publicOrigin, validationIntervalMs = 5000 }) {
  const connections = new Map();
  let closed = false;
  let attachedServer;
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('rmm-support') ? 'rmm-support' : false });
  const get = id => db.prepare('SELECT s.*,e.display_name endpoint_name FROM support_sessions s JOIN endpoints e ON e.id=s.endpoint_id WHERE s.id=?').get(id);
  const view = row => ({ id: row.id, endpointId: row.endpoint_id, endpointName: row.endpoint_name,
    operatorName: row.operator_name, status: row.status, expiresAt: row.expires_at, createdAt: row.created_at,
    requestedControl: Boolean(row.requested_control), controlApproved: Boolean(row.control_approved), jobId: row.job_id,
    approvalRequired: Boolean(row.approval_required), approvalSeconds: row.approval_seconds,
    showSessionDetails: Boolean(row.show_session_details),
    consentUser: row.consent_user || null, endedAt: row.ended_at || null, reason: row.end_reason || null });
  const runtime = id => {
    if (!connections.has(id)) connections.set(id, { paused: false, reason: null,
      capabilities: { type: 'capabilities', secureAttention: false, secureDesktop: false }, attentionIds: new Set(), displays: [] });
    return connections.get(id);
  };
  const send = (socket, data) => {
    if (!open(socket)) return;
    // Input/state must never accumulate behind a slow device or operator.
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(data));
  };
  const broadcast = id => {
    const row = get(id); if (!row) return;
    const rt = connections.get(id); if (!rt) return;
    const state = { type: 'state', session: view(row), paused: rt.paused, controllerConnected: open(rt.browser), reason: rt.reason || row.end_reason || null };
    send(rt.browser, state); send(rt.device, state);
  };
  function end(id, status, reason, actor = 'support') {
    const row = get(id); if (!row || terminal.has(row.status)) return;
    transaction(db, () => {
      db.prepare('UPDATE support_sessions SET status=?,ended_at=?,end_reason=?,credential_hash=NULL WHERE id=?').run(status, iso(), reason, id);
      db.prepare('DELETE FROM support_tickets WHERE support_id=?').run(id);
      // Only unconsumed launch jobs can be cancelled. Dispatched/running jobs are never replayed.
      db.prepare("UPDATE jobs SET status='cancelled',completed_at=?,summary=? WHERE id=? AND status='queued'").run(iso(), 'Remote support session ended before launch.', row.job_id);
      audit(actor, `support.${status}`, id, { reason });
    });
    const rt = connections.get(id);
    if (rt) {
      if (row.status === 'active' && row.control_approved) send(rt.device, { type: 'input', action: 'releaseAll' });
      broadcast(id);
      for (const socket of [rt.browser, rt.device]) if (open(socket)) {
        socket.close(1000, 'Support session ended');
        const timer = setTimeout(() => socket.terminate(), 1000); timer.unref();
      }
      connections.delete(id);
    }
  }
  function valid(row) {
    if (!row || terminal.has(row.status)) return false;
    if (Date.parse(row.expires_at) <= Date.now()) { end(row.id, 'expired', 'session_expired'); return false; }
    if (row.status !== 'active') {
      const launch = db.prepare('SELECT status FROM jobs WHERE id=?').get(row.job_id);
      if (!launch || ['failed', 'interrupted', 'cancelled'].includes(launch.status)) { end(row.id, 'failed', 'launch_failed'); return false; }
      // Offline endpoints and absent staff cannot reserve an endpoint indefinitely.
      const countdownGrace = row.status === 'awaiting_consent' && row.approval_required ? row.approval_seconds * 1000 : 0;
      if (Date.now() - Date.parse(row.created_at) >= 120000 + countdownGrace) { end(row.id, 'failed', 'launch_consent_timeout'); return false; }
    }
    const account = db.prepare(`SELECT u.role FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>? AND u.disabled=0`).get(row.operator_session_hash, row.operator_id, iso());
    if (!account || !roles.has(account.role)) { end(row.id, 'stopped', 'operator_session_revoked'); return false; }
    if (!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(row.endpoint_id)) {
      end(row.id, 'stopped', 'endpoint_revoked'); return false;
    }
    return true;
  }
  function owned(req) {
    const row = get(req.params.id);
    if (!row || row.operator_id !== req.operator.user_id) fail(404, 'Remote support session not found.');
    if (!roles.has(req.operator.role)) fail(403, 'Remote support requires an operator account.');
    valid(row);
    return get(row.id);
  }
  // Never resume a previous process's sessions, including after database/endpoint rollback.
  for (const row of db.prepare("SELECT id FROM support_sessions WHERE status IN ('requested','awaiting_consent','active')").all())
    end(row.id, 'stopped', 'server_restarted');
  db.prepare('DELETE FROM support_tickets').run();

  function mountConsole(router) {
    const policy = () => {
      const row = db.prepare('SELECT approval_required,approval_seconds,show_session_details FROM support_settings WHERE id=1').get();
      return { approvalRequired: Boolean(row.approval_required), approvalSeconds: row.approval_seconds, showSessionDetails: Boolean(row.show_session_details) };
    };
    router.get('/settings/support', (req, res) => {
      if (req.operator.role !== 'admin') fail(403, 'Administrator access required.');
      res.json(policy());
    });
    router.patch('/settings/support', (req, res) => {
      if (req.operator.role !== 'admin') fail(403, 'Administrator access required.');
      if (Object.keys(req.body).some(key => !['approvalRequired', 'approvalSeconds', 'showSessionDetails'].includes(key))) fail(400, 'Unsupported support policy field.');
      if (typeof req.body.approvalRequired !== 'boolean') fail(400, 'approvalRequired must be true or false.');
      if (!Number.isSafeInteger(req.body.approvalSeconds) || req.body.approvalSeconds < 1 || req.body.approvalSeconds > 300)
        fail(400, 'approvalSeconds must be an integer from 1 to 300.');
      if (req.body.showSessionDetails !== undefined && typeof req.body.showSessionDetails !== 'boolean') fail(400, 'showSessionDetails must be true or false.');
      const next = { approvalRequired: req.body.approvalRequired, approvalSeconds: req.body.approvalSeconds, showSessionDetails: req.body.showSessionDetails ?? policy().showSessionDetails };
      transaction(db, () => {
        const previous = policy();
        db.prepare('UPDATE support_settings SET approval_required=?,approval_seconds=?,show_session_details=? WHERE id=1').run(next.approvalRequired ? 1 : 0, next.approvalSeconds, next.showSessionDetails ? 1 : 0);
        audit(req.operator.username, 'support.settings.updated', null, { previous, next });
      });
      res.json(next);
    });
    router.post('/support/sessions', (req, res) => {
      if (!roles.has(req.operator.role)) fail(403, 'Remote support requires an operator account.');
      const endpointId = str(req.body.endpointId, 'endpointId', { max: 100 });
      const key = str(req.body.idempotencyKey, 'idempotencyKey', { max: 100 });
      if (typeof req.body.requestedControl !== 'boolean') fail(400, 'requestedControl must be true or false.');
      const requested = req.body.requestedControl;
      const requestHash = hashToken(JSON.stringify([endpointId, requested]));
      const existing = db.prepare('SELECT id,request_hash FROM support_sessions WHERE operator_id=? AND idempotency_key=?').get(req.operator.user_id, key);
      if (existing) {
        if (existing.request_hash !== requestHash) fail(409, 'Idempotency key already used for a different request.');
        valid(get(existing.id)); return res.json(view(get(existing.id)));
      }
      const endpoint = db.prepare('SELECT inventory FROM endpoints WHERE id=? AND revoked=0').get(endpointId);
      if (!endpoint) fail(400, 'Endpoint is unavailable or revoked.');
      let version;
      try { version = JSON.parse(endpoint.inventory).agentVersion; } catch { /* legacy inventory */ }
      const parsedVersion = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      if (!parsedVersion || (Number(parsedVersion[1]) === 0 && Number(parsedVersion[2]) === 1 && Number(parsedVersion[3]) < 6)
        || (Number(parsedVersion[1]) === 0 && Number(parsedVersion[2]) < 1))
        fail(409, 'Update the endpoint agent to version 0.1.6 or later before starting remote support.');
      if (!policy().showSessionDetails && Number(parsedVersion[1]) === 0 && Number(parsedVersion[2]) === 1 && Number(parsedVersion[3]) < 7)
        fail(409, 'Update the endpoint agent to version 0.1.7 or later to use the session indicator setting.');
      for (const current of db.prepare("SELECT id FROM support_sessions WHERE endpoint_id=? AND status IN ('requested','awaiting_consent','active')").all(endpointId)) valid(get(current.id));
      const id = randomUUID();
      transaction(db, () => {
        if (db.prepare("SELECT id FROM support_sessions WHERE endpoint_id=? AND status IN ('requested','awaiting_consent','active')").get(endpointId)) fail(409, 'This endpoint already has a remote support session.');
        const snapshot = policy();
        db.prepare(`INSERT INTO support_sessions(id,endpoint_id,operator_id,operator_session_hash,operator_name,status,requested_control,created_at,expires_at,idempotency_key,request_hash,approval_required,approval_seconds,show_session_details)
          VALUES (?,?,?,?,?,'requested',?,?,?,?,?,?,?,?)`).run(id, endpointId, req.operator.user_id, req.operator.token_hash, req.operator.username,
          requested ? 1 : 0, iso(), new Date(Date.now() + 30 * 60000).toISOString(), key, requestHash, snapshot.approvalRequired ? 1 : 0, snapshot.approvalSeconds, snapshot.showSessionDetails ? 1 : 0);
        const job = insertJob(endpointId, 'remote_support', { sessionId: id }, 120, req.operator.username);
        db.prepare('UPDATE support_sessions SET job_id=? WHERE id=?').run(job.id, id);
        audit(req.operator.username, 'support.created', id, { endpointId, requestedControl: requested, jobId: job.id, ...snapshot });
      });
      res.status(201).json(view(get(id)));
    });
    router.get('/support/sessions/:id', (req, res) => res.json(view(owned(req))));
    router.post('/support/sessions/:id/stop', (req, res) => {
      const row = owned(req); end(row.id, 'stopped', 'operator_stopped', req.operator.username); res.json(view(get(row.id)));
    });
    router.post('/support/sessions/:id/ticket', (req, res) => {
      const row = owned(req);
      if (terminal.has(row.status)) fail(409, 'Remote support session has ended.');
      if (row.operator_session_hash !== req.operator.token_hash) fail(403, 'Use the login session that started remote support.');
      if (connections.get(row.id)?.browser) fail(409, 'Operator is already connected.');
      const ticket = randomToken(); const expiresAt = new Date(Date.now() + 30000).toISOString();
      db.prepare('DELETE FROM support_tickets WHERE support_id=? OR expires_at<=?').run(row.id, iso());
      db.prepare('INSERT INTO support_tickets VALUES (?,?,?,?)').run(hashToken(ticket), row.id, req.operator.token_hash, expiresAt);
      res.json({ ticket, expiresAt });
    });
  }
  function mountAgent(router) {
    router.post('/support/:id/claim', (req, res) => {
      const row = get(req.params.id);
      if (!row || row.endpoint_id !== req.endpoint.id) fail(404, 'Remote support session not found.');
      if (!valid(row)) fail(409, 'Remote support session has ended.');
      if (req.body.jobId !== row.job_id) fail(409, 'The matching support launch job is required.');
      const credential = randomToken();
      transaction(db, () => {
        const job = db.prepare("SELECT id FROM jobs WHERE id=? AND endpoint_id=? AND kind='remote_support' AND status='running'").get(row.job_id, req.endpoint.id);
        if (!job) fail(409, 'Support launch is not authorized or has already been claimed.');
        const claimed = db.prepare("UPDATE support_sessions SET credential_hash=?,status='awaiting_consent' WHERE id=? AND status='requested' AND credential_hash IS NULL").run(hashToken(credential), row.id);
        if (!claimed.changes) fail(409, 'Support launch is not authorized or has already been claimed.');
        audit(`agent:${req.endpoint.id}`, 'support.launch.granted', row.id);
      });
      broadcast(row.id);
      res.json({ sessionId: row.id, operatorName: row.operator_name, expiresAt: row.expires_at, requestedControl: Boolean(row.requested_control),
        approvalRequired: Boolean(row.approval_required), approvalSeconds: row.approval_seconds, showSessionDetails: Boolean(row.show_session_details), credential });
    });
  }

  function reject(socket, status = 403) {
    socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
  function upgrade(req, socket, head) {
    if (closed) return reject(socket, 503);
    const match = /^\/api\/support\/([0-9a-f-]{36})\/stream$/.exec(req.url || '');
    if (!match) return reject(socket, 404);
    const row = get(match[1]); if (!valid(row)) return reject(socket);
    let side;
    const bearer = req.headers.authorization;
    if (bearer) {
      if (req.headers.origin || !/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer) || !row.credential_hash || hashToken(bearer.slice(7)) !== row.credential_hash || row.device_connected) return reject(socket);
      side = 'device';
    } else {
      // Production PUBLIC_ORIGIN is mandatory for browser upgrades. Never trust a forged Host.
      if (!publicOrigin || req.headers.origin !== publicOrigin) return reject(socket);
      const token = cookies(req.headers.cookie).rmm_session;
      const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(value => value.trim());
      const tickets = protocols.filter(value => /^ticket\.[A-Za-z0-9_-]{43}$/.test(value));
      if (!token || token.length > 200 || !protocols.includes('rmm-support') || tickets.length !== 1 || protocols.length !== 2) return reject(socket);
      const tokenHash = hashToken(token);
      if (tokenHash !== row.operator_session_hash || connections.get(row.id)?.browser) return reject(socket);
      const used = db.prepare('DELETE FROM support_tickets WHERE token_hash=? AND support_id=? AND operator_session_hash=? AND expires_at>? RETURNING token_hash')
        .get(hashToken(tickets[0].slice(7)), row.id, tokenHash, iso());
      if (!used) return reject(socket);
      side = 'browser';
    }
    wsServer.handleUpgrade(req, socket, head, ws => {
      if (side === 'device') db.prepare('UPDATE support_sessions SET device_connected=1 WHERE id=?').run(row.id);
      const rt = runtime(row.id); rt[side] = ws;
      ws.alive = true; ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => { if (!closed) end(row.id, 'failed', `${side}_transport_failed`); });
      ws.on('close', () => { if (!closed) end(row.id, 'stopped', `${side}_disconnected`); });
      let rateStart = Date.now(); let count = 0; let frames = 0;
      ws.on('message', (data, binary) => {
        if (closed) return;
        const current = get(row.id); if (!valid(current)) return;
        if (Date.now() - rateStart >= 1000) { rateStart = Date.now(); count = 0; frames = 0; }
        if (++count > (side === 'browser' ? 180 : 40)) return end(row.id, 'failed', 'message_rate_exceeded');
        if (binary) {
          if (side !== 'device') return end(row.id, 'failed', 'invalid_protocol');
          if (current.status !== 'active' || rt.paused || ++frames > 10) return;
          // JPEG magic/end marker; frames are immediately relayed and never saved.
          if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) return end(row.id, 'failed', 'invalid_frame');
          relayFrame(rt.browser, data); return;
        }
        if (data.length > 4096) return end(row.id, 'failed', 'invalid_protocol');
        let message;
        try { message = JSON.parse(data.toString()); } catch { return end(row.id, 'failed', 'invalid_protocol'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return end(row.id, 'failed', 'invalid_protocol');
        if (side === 'device') {
          if (message.type === 'stop') return end(row.id, 'stopped', 'staff_stopped');
          if (message.type === 'capabilities') {
            if (typeof message.secureAttention !== 'boolean' || message.secureDesktop !== false) return end(row.id, 'failed', 'invalid_capabilities');
            rt.capabilities = { type: 'capabilities', secureAttention: message.secureAttention, secureDesktop: false };
            send(rt.browser, rt.capabilities); return;
          }
          if (message.type === 'displays') {
            if (!Array.isArray(message.displays) || message.displays.length < 1 || message.displays.length > 16) return end(row.id, 'failed', 'invalid_displays');
            const ids = new Set(); const displays = [];
            for (const item of message.displays) {
              if (!item || typeof item.id !== 'string' || !item.id.length || item.id.length > 100 || ids.has(item.id)
                || typeof item.name !== 'string' || item.name.length > 150 || typeof item.isPrimary !== 'boolean'
                || ![item.width,item.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16000)) return end(row.id, 'failed', 'invalid_displays');
              ids.add(item.id); displays.push({ id:item.id,name:item.name,width:item.width,height:item.height,isPrimary:item.isPrimary });
            }
            rt.displays = displays; send(rt.browser, {type:'displays',displays}); return;
          }
          if (message.type === 'consent') {
            if (current.status !== 'awaiting_consent' || typeof message.approved !== 'boolean' || typeof message.control !== 'boolean' || typeof message.userName !== 'string' || message.userName.length > 200) return end(row.id, 'failed', 'invalid_consent');
            if (message.decision !== undefined && !['manual', 'automatic', 'unattended'].includes(message.decision)) return end(row.id, 'failed', 'invalid_consent');
            if (message.decision === 'unattended' && current.approval_required) return end(row.id, 'failed', 'invalid_consent');
            audit(`agent:${row.endpoint_id}`, 'support.consent', row.id, { approved: message.approved, control: message.approved && message.control && Boolean(current.requested_control), decision: message.decision || 'manual' });
            if (!message.approved) return end(row.id, 'declined', 'staff_declined');
            db.prepare("UPDATE support_sessions SET status='active',control_approved=?,consent_user=? WHERE id=?").run(current.requested_control && message.control ? 1 : 0, message.userName, row.id);
            if (current.requested_control && message.control) audit(`agent:${row.endpoint_id}`, 'support.control.granted', row.id);
            broadcast(row.id); return;
          }
          if (current.status !== 'active') return;
          if (message.type === 'secureAttentionResult') {
            if (typeof message.requestId !== 'string' || !uuid.test(message.requestId) || typeof message.success !== 'boolean'
              || typeof message.message !== 'string' || !Object.hasOwn(attentionMessages, message.message) || (message.success !== (message.message === 'sent')))
              return end(row.id, 'failed', 'invalid_secure_attention_result');
            if (rt.pendingAttention?.requestId !== message.requestId) return;
            rt.pendingAttention = null;
            send(rt.browser, { type: 'secureAttentionResult', requestId: message.requestId, success: message.success, message: attentionMessages[message.message] });
            audit(`agent:${row.endpoint_id}`, 'support.secureattention.result', row.id, { requestId: message.requestId, success: message.success, result: message.message });
            return;
          }
          if (message.type === 'display') {
            if (![message.width, message.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16000)) return end(row.id, 'failed', 'invalid_display');
            if (message.id !== undefined && (typeof message.id !== 'string' || !rt.displays.some(item => item.id === message.id))) return end(row.id, 'failed', 'invalid_display');
            if (rt.switchingTo && message.id !== rt.switchingTo) return end(row.id, 'failed', 'display_switch_mismatch');
            rt.display = { type: 'display', ...(message.id ? {id:message.id}:{}), width: message.width, height: message.height };
            if (rt.switchingTo) rt.switchReady = true;
            send(rt.browser, rt.display); return;
          }
          if (message.type === 'paused' && typeof message.paused === 'boolean') {
            if (!message.paused && rt.switchingTo) {
              if (!rt.switchReady) return end(row.id, 'failed', 'display_switch_unconfirmed');
              rt.switchingTo = null; rt.switchReady = false;
            }
            rt.paused = message.paused; rt.reason = rt.paused ? 'Desktop unavailable or paused by staff' : null;
            if (rt.paused) send(rt.device, { type: 'input', action: 'releaseAll' });
            broadcast(row.id); return;
          }
          return end(row.id, 'failed', 'invalid_protocol');
        }
        if (message.type === 'selectDisplay') {
          if (current.status !== 'active' || rt.paused || !open(rt.device)) return;
          if (typeof message.displayId !== 'string' || !rt.displays.some(item => item.id === message.displayId)) return end(row.id, 'failed', 'invalid_display_selection');
          if (rt.display?.id === message.displayId) return;
          send(rt.device, {type:'input',action:'releaseAll'});
          rt.paused = true; rt.reason = 'Switching monitor'; rt.switchingTo = message.displayId; rt.switchReady = false;
          broadcast(row.id);
          audit(current.operator_name, 'support.display.selected', row.id, {displayId:message.displayId});
          send(rt.device, {type:'selectDisplay',displayId:message.displayId}); return;
        }
        if (message.type === 'secureAttention') {
          if (typeof message.requestId !== 'string' || !uuid.test(message.requestId)) return end(row.id, 'failed', 'invalid_secure_attention');
          const denied = reason => send(rt.browser, { type: 'secureAttentionResult', requestId: message.requestId, success: false, message: reason });
          if (current.status !== 'active' || !current.control_approved || rt.paused || !open(rt.browser) || !open(rt.device) || !rt.capabilities.secureAttention)
            return denied(attentionMessages.not_available);
          if (rt.pendingAttention || Date.now() - (rt.lastAttentionAt || 0) < 5000)
            return denied('Wait five seconds before requesting Ctrl+Alt+Del again.');
          if (rt.attentionIds.has(message.requestId)) return denied('This Ctrl+Alt+Del request has already been used.');
          rt.attentionIds.add(message.requestId); rt.lastAttentionAt = Date.now();
          rt.pendingAttention = { requestId: message.requestId, deadline: Date.now() + 25000 };
          audit(current.operator_name, 'support.secureattention.requested', row.id, { requestId: message.requestId });
          send(rt.device, { type: 'secureAttention', requestId: message.requestId }); return;
        }
        if (message.type !== 'input' || !actions.has(message.action)) return end(row.id, 'failed', 'invalid_input');
        // Consent and pause are enforced here, not merely by the operator UI.
        if (current.status !== 'active' || !current.control_approved || rt.paused) return;
        const input = { type: 'input', action: message.action };
        if (['move', 'down', 'up', 'wheel'].includes(message.action)) {
          if (![message.x, message.y].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) return end(row.id, 'failed', 'invalid_input');
          input.x = message.x; input.y = message.y;
        }
        if (['down', 'up'].includes(message.action)) {
          if (![0, 1, 2].includes(message.button)) return end(row.id, 'failed', 'invalid_input');
          input.button = message.button;
        }
        if (message.action === 'wheel') {
          if (!Number.isSafeInteger(message.deltaY) || Math.abs(message.deltaY) > 1200) return end(row.id, 'failed', 'invalid_input');
          input.deltaY = message.deltaY;
        }
        if (message.action === 'keyDown' || message.action === 'keyUp') {
          if (typeof message.key !== 'string' || !keys.test(message.key)) return end(row.id, 'failed', 'invalid_input');
          input.key = message.key;
        }
        send(rt.device, input);
      });
      broadcast(row.id);
      if (side === 'browser') { send(ws, rt.capabilities); if (rt.displays.length) send(ws,{type:'displays',displays:rt.displays}); if (rt.display) send(ws, rt.display); }
    });
  }
  const timer = setInterval(() => {
    if (closed) return;
    for (const row of db.prepare("SELECT id FROM support_sessions WHERE status IN ('requested','awaiting_consent','active')").all()) {
      if (!valid(get(row.id))) continue;
      const rt = connections.get(row.id);
      if (rt?.pendingAttention && Date.now() >= rt.pendingAttention.deadline) {
        send(rt.browser, { type: 'secureAttentionResult', requestId: rt.pendingAttention.requestId, success: false, message: 'Ctrl+Alt+Del request timed out.' });
        rt.pendingAttention = null;
      }
      for (const socket of rt ? [rt.browser, rt.device] : []) if (open(socket)) {
        if (!socket.alive) { socket.terminate(); end(row.id, 'stopped', 'connection_lost'); break; }
        socket.alive = false; socket.ping();
      }
    }
    db.prepare('DELETE FROM support_tickets WHERE expires_at<=?').run(iso());
  }, validationIntervalMs);
  timer.unref();
  const shutdown = () => {
    if (closed) return;
    closed = true; clearInterval(timer);
    attachedServer?.off('upgrade', upgrade);
    for (const row of db.prepare("SELECT id FROM support_sessions WHERE status IN ('requested','awaiting_consent','active')").all()) end(row.id, 'stopped', 'server_shutdown');
    for (const socket of wsServer.clients) socket.terminate();
    wsServer.close();
  };
  return { mountConsole, mountAgent, shutdown, attach(server) {
    if (attachedServer) throw new Error('Support relay already attached.');
    attachedServer = server; server.on('upgrade', upgrade);
  } };
}
