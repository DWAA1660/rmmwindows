import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS endpoints (id TEXT PRIMARY KEY, device_id TEXT UNIQUE NOT NULL, hostname TEXT NOT NULL, display_name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, tags TEXT NOT NULL DEFAULT '[]', inventory TEXT NOT NULL DEFAULT '{}', boot_id TEXT, last_seen TEXT NOT NULL, created_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS enrollment_tokens (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, max_uses INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scripts (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, name TEXT NOT NULL, script_id TEXT NOT NULL REFERENCES scripts(id), endpoint_ids TEXT NOT NULL, interval_minutes INTEGER NOT NULL, next_run_at TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schedule_occurrences (schedule_id TEXT NOT NULL, due_at TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(schedule_id,due_at));
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id), kind TEXT NOT NULL, payload TEXT NOT NULL, timeout_seconds INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, dispatched_at TEXT, dispatch_hash TEXT, started_at TEXT, completed_at TEXT, exit_code INTEGER, summary TEXT, created_by TEXT NOT NULL, occurrence_key TEXT);
    CREATE INDEX IF NOT EXISTS jobs_queued ON jobs(endpoint_id,status,created_at);
    CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_occurrence ON jobs(endpoint_id,occurrence_key) WHERE occurrence_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS output_chunks (job_id TEXT NOT NULL REFERENCES jobs(id), sequence INTEGER NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(job_id,sequence));
    CREATE TABLE IF NOT EXISTS job_requests (idempotency_key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, job_ids TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, details TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at);
  `);
  // Additive v2 migration preserves existing accounts, sessions and consumed jobs.
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
  transaction(db, () => {
    if (!userColumns.has('email')) db.exec("ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT ''");
    if (!userColumns.has('role')) db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'");
    if (!userColumns.has('disabled')) db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase ON users(lower(username)); PRAGMA user_version=2;');
  });
  // Additive v3: tokenless "request to join" enrollment. Only the hash of each device's
  // join secret is stored; an agent credential is issued only after operator approval.
  db.exec(`CREATE TABLE IF NOT EXISTS join_requests (id TEXT PRIMARY KEY, device_id TEXT UNIQUE NOT NULL, secret_hash TEXT NOT NULL,
      hostname TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', remote_ip TEXT, status TEXT NOT NULL, endpoint_id TEXT,
      created_at TEXT NOT NULL, last_poll_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT);
    CREATE INDEX IF NOT EXISTS join_requests_status ON join_requests(status, created_at);
    PRAGMA user_version=3;`);
  // Additive v4: remote file explorer downloads. Bytes live on disk next to the database (never in
  // the web root); these rows track progress, integrity and expiry so disk use stays bounded.
  db.exec(`CREATE TABLE IF NOT EXISTS file_transfers (job_id TEXT PRIMARY KEY REFERENCES jobs(id), endpoint_id TEXT NOT NULL,
      path TEXT NOT NULL, name TEXT, status TEXT NOT NULL, size_bytes INTEGER, sha256 TEXT, received_bytes INTEGER NOT NULL DEFAULT 0,
      next_sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX IF NOT EXISTS file_transfers_status ON file_transfers(status, created_at);
    CREATE TABLE IF NOT EXISTS file_transfer_chunks (job_id TEXT NOT NULL REFERENCES file_transfers(job_id), sequence INTEGER NOT NULL,
      byte_offset INTEGER NOT NULL, length INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(job_id, sequence));
    PRAGMA user_version=4;`);
  // v5: every enrolled endpoint belongs to one organizational group.
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS endpoint_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      INSERT OR IGNORE INTO endpoint_groups(id,name,created_at) VALUES ('new-endpoints','New endpoints',strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    if (!db.prepare('PRAGMA table_info(endpoints)').all().some(column => column.name === 'group_id'))
      db.exec("ALTER TABLE endpoints ADD COLUMN group_id TEXT NOT NULL DEFAULT 'new-endpoints'");
    db.exec('CREATE INDEX IF NOT EXISTS endpoints_group ON endpoints(group_id); PRAGMA user_version=5;');
    db.exec('CREATE TABLE IF NOT EXISTS job_runs (id TEXT PRIMARY KEY,name TEXT NOT NULL,endpoint_ids TEXT NOT NULL,created_at TEXT NOT NULL);');
    if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'run_id')) db.exec('ALTER TABLE jobs ADD COLUMN run_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS jobs_run ON jobs(run_id);');
  });
  // v6: attended remote support. Credentials/tickets are hashes; no screen or input data is stored.
  db.exec(`CREATE TABLE IF NOT EXISTS support_sessions (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
      operator_id TEXT NOT NULL REFERENCES users(id), operator_session_hash TEXT NOT NULL, operator_name TEXT NOT NULL,
      status TEXT NOT NULL, requested_control INTEGER NOT NULL, control_approved INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
      job_id TEXT REFERENCES jobs(id), credential_hash TEXT, device_connected INTEGER NOT NULL DEFAULT 0,
      consent_user TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, UNIQUE(operator_id,idempotency_key));
    CREATE UNIQUE INDEX IF NOT EXISTS support_endpoint_active ON support_sessions(endpoint_id)
      WHERE status IN ('requested','awaiting_consent','active');
    CREATE TABLE IF NOT EXISTS support_tickets (token_hash TEXT PRIMARY KEY, support_id TEXT NOT NULL REFERENCES support_sessions(id),
      operator_session_hash TEXT NOT NULL, expires_at TEXT NOT NULL);
    PRAGMA user_version=6;`);
  // v7: administrator support notification policy is durable and snapshotted per session.
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS support_settings (id INTEGER PRIMARY KEY CHECK(id=1),
      approval_required INTEGER NOT NULL DEFAULT 1 CHECK(approval_required IN (0,1)),
      approval_seconds INTEGER NOT NULL DEFAULT 15 CHECK(approval_seconds BETWEEN 1 AND 300));
      INSERT OR IGNORE INTO support_settings(id) VALUES (1);`);
    const supportColumns = new Set(db.prepare('PRAGMA table_info(support_sessions)').all().map(column => column.name));
    if (!supportColumns.has('approval_required')) db.exec('ALTER TABLE support_sessions ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 1');
    if (!supportColumns.has('approval_seconds')) db.exec('ALTER TABLE support_sessions ADD COLUMN approval_seconds INTEGER NOT NULL DEFAULT 15');
    db.exec('PRAGMA user_version=7;');
  });
  // v8: persistent PowerShell terminal sessions. Session/process lifetime is
  // separate from immutable per-command jobs; authorization is consumed once.
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL REFERENCES endpoints(id),
        operator_id TEXT NOT NULL REFERENCES users(id), operator_session_hash TEXT NOT NULL,
        operator_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')),
        instance_id TEXT, working_directory TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        closed_at TEXT, close_reason TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        UNIQUE(operator_session_hash,idempotency_key));
      CREATE INDEX IF NOT EXISTS terminal_endpoint_status ON terminal_sessions(endpoint_id,status);
      CREATE TABLE IF NOT EXISTS terminal_commands (
        terminal_id TEXT NOT NULL REFERENCES terminal_sessions(id), job_id TEXT PRIMARY KEY REFERENCES jobs(id),
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, authorized_at TEXT,
        UNIQUE(terminal_id,idempotency_key));`);
    const settingColumns = new Set(db.prepare('PRAGMA table_info(support_settings)').all().map(column => column.name));
    const supportColumns = new Set(db.prepare('PRAGMA table_info(support_sessions)').all().map(column => column.name));
    if (!settingColumns.has('show_session_details')) db.exec('ALTER TABLE support_settings ADD COLUMN show_session_details INTEGER NOT NULL DEFAULT 1');
    if (!supportColumns.has('show_session_details')) db.exec('ALTER TABLE support_sessions ADD COLUMN show_session_details INTEGER NOT NULL DEFAULT 1');
    db.exec('PRAGMA user_version=8;');
  });
  return db;
}

// Synchronous SQLite operations run on one Node thread. BEGIN IMMEDIATE also serializes
// claims against another server process using the same DB. Never hold this across await.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
