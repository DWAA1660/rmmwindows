import { hashToken } from './security.mjs';

// Wire catalog intentionally matches agent/UpdateDiagnostics.cs. Accepting raw
// exception/transcript text here could retain URLs, paths, or credentials.
export const UPDATE_ERROR_SUMMARIES = Object.freeze({
  disabled: 'Automatic updates are disabled.',
  group_disabled: "Automatic updates are turned off for this computer's group.",
  unsupported_install: 'Automatic update requires a supported service installation.',
  deferred_busy: 'Update check deferred while endpoint work is active.',
  dns_error: 'Update server name could not be resolved.',
  tls_error: 'Update connection failed TLS validation.',
  network_error: 'Update server could not be reached.',
  request_timeout: 'Update request timed out.',
  http_error: 'Update server returned an unsuccessful response.',
  manifest_invalid: 'Update package metadata was invalid.',
  checksum_mismatch: 'Downloaded package integrity verification failed.',
  extract_failed: 'Verified update package could not be extracted.',
  launch_failed: 'Update helper could not be started.',
  install_failed: 'Update installation failed.',
  pipeline_stopped: 'Update installer PowerShell pipeline stopped unexpectedly.',
  helper_stalled: 'Update helper did not finish within the expected time.',
  attempt_limit: 'Automatic update attempt limit reached for this package.',
  retry_backoff: 'Update retry is waiting for its backoff period.',
  state_invalid: 'Previous update state could not be read safely.',
  cancelled: 'Update operation was cancelled.',
  unknown_failure: 'Update operation failed.'
});
export const UPDATE_PHASE_SUMMARIES = Object.freeze({
  checking: 'Checking for an agent update.', current: 'Installed agent is up to date.',
  disabled: 'Automatic updates are disabled.', deferred: 'Update check is deferred.',
  downloading: 'Downloading the agent update.', verifying: 'Verifying the agent update.',
  installing: 'Installing the verified agent update.', failed: 'Update operation failed.',
  retry_wait: 'Waiting before retrying the agent update.', unsupported: 'Automatic update is unavailable for this installation.'
});
const stages = new Set(['manifest', 'download', 'verify', 'extract', 'launch', 'install', 'complete', 'policy']);
const fields = new Set(['schemaVersion', 'installedVersion', 'availableVersion', 'phase', 'stage', 'checkedAt', 'lastAttemptAt', 'nextRetryAt', 'attempts', 'errorCode', 'summary', 'packageSha256']);
const versionPattern = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:[-+][A-Za-z0-9.-]{1,80})?$/;
const timestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const own = (value, field) => Object.prototype.hasOwnProperty.call(value, field);

export function mountUpdateHealth({ db, audit, fail, str }) {
  const version = (value, name, optional = false) => {
    if (optional && (value === undefined || value === null)) return null;
    const result = str(value, name, { max: 104 });
    if (!versionPattern.test(result)) fail(400, `${name} must be a bounded agent version.`);
    return result;
  };
  const timestamp = (value, name, optional = false) => {
    if (optional && (value === undefined || value === null)) return null;
    const result = str(value, name, { max: 64 });
    if (!timestampPattern.test(result) || !Number.isFinite(Date.parse(result))) fail(400, `${name} must be an ISO timestamp with a timezone.`);
    return new Date(result).toISOString();
  };
  function canonical(value) {
    // Absence means no report, not an invented failure or clearing old evidence.
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'updateStatus must be a structured report.');
    if (Object.keys(value).some(key => !fields.has(key))) fail(400, 'Unexpected updater report field.');
    if (value.schemaVersion !== 1) fail(400, 'Unsupported updater report schema.');
    if (typeof value.phase !== 'string' || !own(UPDATE_PHASE_SUMMARIES, value.phase)) fail(400, 'Unknown updater phase.');
    if (typeof value.stage !== 'string' || !stages.has(value.stage)) fail(400, 'Unknown updater stage.');
    if (!Number.isSafeInteger(value.attempts) || value.attempts < 0 || value.attempts > 3) fail(400, 'Updater attempts must be an integer from 0 to 3.');
    const errorCode = value.errorCode === undefined || value.errorCode === null ? null : str(value.errorCode, 'updateStatus.errorCode', { max: 80 });
    if (errorCode !== null && !own(UPDATE_ERROR_SUMMARIES, errorCode)) fail(400, 'Unknown updater error code.');
    const summary = errorCode === null ? UPDATE_PHASE_SUMMARIES[value.phase] : UPDATE_ERROR_SUMMARIES[errorCode];
    if (value.summary !== undefined && value.summary !== null) {
      if (str(value.summary, 'updateStatus.summary', { max: 400 }) !== summary) fail(400, 'Updater summary must match its fixed safe catalog.');
    }
    const packageSha256 = value.packageSha256 === undefined || value.packageSha256 === null ? null : str(value.packageSha256, 'updateStatus.packageSha256', { min: 64, max: 64 });
    if (packageSha256 !== null && !/^[a-fA-F0-9]{64}$/.test(packageSha256)) fail(400, 'Updater package digest must be a SHA-256 hex value.');
    return { schemaVersion: 1, installedVersion: version(value.installedVersion, 'updateStatus.installedVersion'),
      availableVersion: version(value.availableVersion, 'updateStatus.availableVersion', true), phase: value.phase, stage: value.stage,
      checkedAt: timestamp(value.checkedAt, 'updateStatus.checkedAt'), lastAttemptAt: timestamp(value.lastAttemptAt, 'updateStatus.lastAttemptAt', true),
      nextRetryAt: timestamp(value.nextRetryAt, 'updateStatus.nextRetryAt', true), attempts: value.attempts, errorCode, summary,
      packageSha256: packageSha256?.toLowerCase() || null };
  }
  const read = row => row ? { ...JSON.parse(row.report_json), receivedAt: row.received_at } : null;
  const get = endpointId => read(db.prepare('SELECT report_json,received_at FROM endpoint_update_status WHERE endpoint_id=?').get(endpointId));
  // Caller wraps this with the endpoint heartbeat/inventory in one transaction.
  // Only canonical() output is passed here; raw request text never enters SQLite.
  function record(endpointId, report, receivedAt) {
    if (report === undefined) return;
    const previous = db.prepare('SELECT transition_hash,report_json FROM endpoint_update_status WHERE endpoint_id=?').get(endpointId);
    // Timestamp-only heartbeat changes refresh latest evidence, not history.
    const transitionHash = hashToken(JSON.stringify({ installedVersion: report.installedVersion, availableVersion: report.availableVersion,
      phase: report.phase, stage: report.stage, attempts: report.attempts, errorCode: report.errorCode, packageSha256: report.packageSha256 }));
    const reportJson = JSON.stringify(report);
    db.prepare(`INSERT INTO endpoint_update_status(endpoint_id,report_json,transition_hash,received_at) VALUES (?,?,?,?)
      ON CONFLICT(endpoint_id) DO UPDATE SET report_json=excluded.report_json,transition_hash=excluded.transition_hash,received_at=excluded.received_at`).run(endpointId, reportJson, transitionHash, receivedAt);
    if (previous?.transition_hash === transitionHash) return;
    db.prepare('INSERT INTO endpoint_update_history(endpoint_id,report_json,transition_hash,received_at) VALUES (?,?,?,?)').run(endpointId, reportJson, transitionHash, receivedAt);
    db.prepare(`DELETE FROM endpoint_update_history WHERE endpoint_id=? AND id NOT IN
      (SELECT id FROM endpoint_update_history WHERE endpoint_id=? ORDER BY id DESC LIMIT 100)`).run(endpointId, endpointId);
    if (report.phase === 'failed' || (report.phase === 'retry_wait' && report.errorCode && report.errorCode !== 'retry_backoff')) {
      audit(`agent:${endpointId}`, 'agent.update.failure', endpointId, { phase: report.phase, stage: report.stage, errorCode: report.errorCode,
        attempts: report.attempts, installedVersion: report.installedVersion, availableVersion: report.availableVersion });
    }
  }
  function mountConsole(router) {
    router.get('/agent-updates', (req, res) => {
      const rows = db.prepare('SELECT e.id,e.hostname,e.display_name,e.last_seen,e.inventory,s.report_json,s.received_at FROM endpoints e LEFT JOIN endpoint_update_status s ON s.endpoint_id=e.id WHERE e.revoked=0 ORDER BY e.display_name COLLATE NOCASE').all();
      res.json(rows.map(row => ({ endpointId: row.id, endpointName: row.display_name, hostname: row.hostname,
        online: Date.now() - Date.parse(row.last_seen) < 120000, lastSeen: row.last_seen,
        agentVersion: JSON.parse(row.inventory).agentVersion || null, updateStatus: read(row.report_json ? row : null) })));
    });
  }
  return { canonical, record, get, mountConsole };
}
