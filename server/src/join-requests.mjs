// Tokenless enrollment: a newly installed agent asks to join and waits; an operator approves
// or denies it in the console. No credential exists for the device until approval.
//
// Agent:    POST /api/agent/join {deviceId, joinSecret, hostname, osName?, osVersion?, domain?}
//             -> {status:'pending'|'denied'} or {status:'approved', endpointId, agentToken}
// Console:  GET  /api/join-requests
//           POST /api/join-requests/:id/approve | /deny      DELETE /api/join-requests/:id
//
// The join secret is generated on the endpoint and stored only in its protected agent.json;
// the server keeps a hash. While a request is approved, each authenticated poll rotates the
// agent token and returns it. That lets an agent recover if the response was lost or if a
// restore-on-reboot product rolled agent.json back to its pre-approval state; the previous
// token stops working, so only one copy is ever valid. A revoked endpoint is never re-issued.
import { randomUUID } from 'node:crypto';
import { randomToken, hashToken, equalText, rateLimiter } from './security.mjs';
import { transaction } from './db.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_PENDING_REQUESTS = 200;
const STALE_PENDING_MS = 14 * 24 * 3600000;

export function mountJoinRequests(app, { db, audit, fail, str }) {
  const now = () => new Date().toISOString();
  const view = row => ({
    id: row.id, deviceId: row.device_id, hostname: row.hostname, details: JSON.parse(row.details || '{}'), remoteIp: row.remote_ip,
    status: row.status, endpointId: row.endpoint_id, createdAt: row.created_at, lastPollAt: row.last_poll_at, decidedBy: row.decided_by, decidedAt: row.decided_at
  });
  const optional = (value, name) => str(value, name, { min: 0, max: 200, fallback: '' });
  const pruneStale = () => db.prepare("DELETE FROM join_requests WHERE status='pending' AND last_poll_at<?").run(new Date(Date.now() - STALE_PENDING_MS).toISOString());

  app.post('/api/agent/join', rateLimiter({ limit: 30, intervalMs: 60000 }), (req, res) => {
    const deviceId = str(req.body.deviceId, 'deviceId', { max: 36 });
    if (!UUID.test(deviceId)) fail(400, 'deviceId must be a UUID.');
    const secret = str(req.body.joinSecret, 'joinSecret', { min: 32, max: 200 });
    const hostname = str(req.body.hostname, 'hostname', { max: 100 });
    const details = { osName: optional(req.body.osName, 'osName'), osVersion: optional(req.body.osVersion, 'osVersion'), domain: optional(req.body.domain, 'domain'), agentVersion: optional(req.body.agentVersion, 'agentVersion') };
    const remoteIp = String(req.ip || req.socket.remoteAddress || '').slice(0, 64);
    const result = transaction(db, () => {
      const stamp = now();
      let row = db.prepare('SELECT * FROM join_requests WHERE device_id=?').get(deviceId);
      if (!row) {
        if (db.prepare('SELECT id FROM endpoints WHERE device_id=?').get(deviceId)) fail(409, 'This device ID is already enrolled.');
        pruneStale();
        if (db.prepare("SELECT count(*) n FROM join_requests WHERE status='pending'").get().n >= MAX_PENDING_REQUESTS) fail(429, 'Too many computers are waiting for approval. Ask an administrator to review them.');
        const id = randomUUID();
        db.prepare('INSERT INTO join_requests(id,device_id,secret_hash,hostname,details,remote_ip,status,created_at,last_poll_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(id, deviceId, hashToken(secret), hostname, JSON.stringify(details), remoteIp, 'pending', stamp, stamp);
        audit(`device:${deviceId}`, 'agent.join.requested', id, { hostname, remoteIp });
        return { status: 'pending' };
      }
      // Never reveal anything about a request to a caller that does not hold its secret.
      if (!equalText(hashToken(secret), row.secret_hash)) fail(403, 'This device ID belongs to another join request.');
      if (row.status === 'pending') {
        db.prepare('UPDATE join_requests SET hostname=?,details=?,remote_ip=?,last_poll_at=? WHERE id=?').run(hostname, JSON.stringify(details), remoteIp, stamp, row.id);
        return { status: 'pending' };
      }
      db.prepare('UPDATE join_requests SET last_poll_at=? WHERE id=?').run(stamp, row.id);
      if (row.status !== 'approved') return { status: 'denied' };
      const token = randomToken();
      let endpoint = row.endpoint_id && db.prepare('SELECT * FROM endpoints WHERE id=?').get(row.endpoint_id);
      if (endpoint?.revoked) return { status: 'denied' };
      if (endpoint) db.prepare('UPDATE endpoints SET token_hash=? WHERE id=?').run(hashToken(token), endpoint.id);
      else {
        const id = randomUUID();
        db.prepare('INSERT INTO endpoints(id,device_id,hostname,display_name,token_hash,last_seen,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, deviceId, row.hostname, row.hostname, hashToken(token), stamp, stamp);
        db.prepare('UPDATE join_requests SET endpoint_id=? WHERE id=?').run(id, row.id);
        endpoint = { id };
      }
      audit(`agent:${endpoint.id}`, 'agent.join.credential.issued', endpoint.id, { joinRequestId: row.id, hostname: row.hostname });
      return { status: 'approved', endpointId: endpoint.id, agentToken: token };
    });
    res.json(result);
  });

  // Console routes are registered on the operator router (CSRF + roles) once it exists.
  return function mountConsole(admin) {
  admin.get('/join-requests', (req, res) => {
    pruneStale();
    const cutoff = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
    res.json(db.prepare("SELECT * FROM join_requests WHERE status='pending' OR coalesce(decided_at,created_at)>? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 500").all(cutoff).map(view));
  });
  const decide = (status) => (req, res) => {
    const result = transaction(db, () => {
      const row = db.prepare('SELECT * FROM join_requests WHERE id=?').get(req.params.id);
      if (!row) fail(404, 'Join request not found.');
      if (status === 'denied' && row.endpoint_id) fail(409, 'This computer already joined. Revoke the endpoint instead.');
      db.prepare('UPDATE join_requests SET status=?,decided_by=?,decided_at=? WHERE id=?').run(status, req.operator.username, now(), row.id);
      audit(req.operator.username, status === 'approved' ? 'agent.join.approved' : 'agent.join.denied', row.id, { hostname: row.hostname, deviceId: row.device_id });
      return view(db.prepare('SELECT * FROM join_requests WHERE id=?').get(row.id));
    });
    res.json(result);
  };
  admin.post('/join-requests/:id/approve', decide('approved'));
  admin.post('/join-requests/:id/deny', decide('denied'));
  admin.delete('/join-requests/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM join_requests WHERE id=?').get(req.params.id);
    if (!row) fail(404, 'Join request not found.');
    if (row.status === 'approved' && row.endpoint_id) fail(409, 'This computer already joined. Revoke the endpoint instead.');
    db.prepare('DELETE FROM join_requests WHERE id=?').run(row.id);
    audit(req.operator.username, 'agent.join.removed', row.id, { hostname: row.hostname });
    res.json({ ok: true });
  });
  };
}
