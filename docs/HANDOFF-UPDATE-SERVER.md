# Agent update health server handoff — 2026-11-05

## Implemented

`server/src/update-health.mjs` owns structured updater telemetry canonicalization, latest evidence, bounded transition history and read-only operator API. `server/src/app.mjs` has only the coordinated integration changes: mount/import, endpoint `updateStatus`, heartbeat transaction and a startup telemetry route. Additive SQLite schema **9** creates `endpoint_update_status` and `endpoint_update_history`; existing credentials, inventories, jobs, terminal grants and command output are preserved. Account/support migration assertions now expect9.

## Agent routes and atomicity

- `POST /api/agent/checkin` accepts optional top-level `updateStatus` alongside `bootId` and optional `inventory`. Both report and inventory are validated before mutation; endpoint heartbeat/inventory and safe report storage then commit in one SQLite transaction. Invalid telemetry returns400 without changing inventory, hostname, boot identity, lastSeen or prior report. Invalid inventory likewise does not change telemetry.
- `POST /api/agent/update-status {updateStatus}` permits startup progress reporting **before normal inventory or job claims**. It requires the same enrolled endpoint bearer credential. Body allows only `updateStatus`, which is required. On success it returns `{endpointId,serverTime}`. It updates endpoint lastSeen and updater evidence in one transaction, preserving bootId and inventory. This route neither creates nor authorizes commands.

Operator cookies/CSRF tokens never impersonate agents; reports are always assigned to the bearer endpoint. Revoked credentials cannot report. `updateStatus` omission in ordinary checkin preserves the prior report **and its receivedAt**; it does not falsely refresh diagnostic evidence. Explicit null is an invalid report, not a wipe operation.

## Strict versioned report

```text
schemaVersion: 1
installedVersion: bounded version string
availableVersion?: bounded version string|null
phase: disabled|checking|current|deferred|downloading|verifying|installing|failed|retry_wait|unsupported
stage: manifest|download|verify|extract|launch|install|complete|policy
checkedAt: ISO timestamp with timezone
lastAttemptAt?: ISO timestamp with timezone|null
nextRetryAt?: ISO timestamp with timezone|null
attempts: integer 0..3
errorCode?: closed safe code|null
summary?: matching fixed catalog text|null
packageSha256?: 64 hexadecimal characters|null
```

The safe summaries exactly match `agent/UpdateDiagnostics.cs`; a contract test detects drift. Server derives the summary from errorCode when present, else phase. Supplied summaries must equal that fixed string; arbitrary exception messages, paths, URLs or transcript text are rejected, never retained or echoed. Summary maximum400 characters; error code maximum80 and must be a known lowercase ASCII enum. Unknown properties—including raw logs, token, endpointId and caller-supplied receivedAt—are rejected. Objects/arrays cannot hide inside scalar fields.

Error codes: `disabled`, `unsupported_install`, `deferred_busy`, `dns_error`, `tls_error`, `network_error`, `request_timeout`, `http_error`, `manifest_invalid`, `checksum_mismatch`, `extract_failed`, `launch_failed`, `install_failed`, `pipeline_stopped`, `helper_stalled`, `attempt_limit`, `retry_backoff`, `state_invalid`, `cancelled`, `unknown_failure`.

Versions follow ASCII `N.N.N` (1–6 digits per component), optional bounded prerelease/build suffix matching the agent catalog, at most104 characters. Timestamps require explicit timezone, at most64 characters, and normalize to UTC milliseconds. A package SHA normalizes to lowercase. No missing error code or report invents a failure. The report is evidence supplied by the endpoint, not an independent guarantee that a future installation or reboot succeeded.

## Console response contract

`GET /api/agent-updates` is authenticated read-only for existing admin/operator/viewer roles and returns an **array** of active, nonrevoked endpoints:

```text
{endpointId, endpointName, hostname, online, lastSeen, agentVersion, updateStatus}
```

`updateStatus` is either null (no supported telemetry reported; explicitly unknown), or the canonical report plus **receivedAt**, a server UTC timestamp. The same nullable `updateStatus` property is added to each `/api/endpoints` and `/api/endpoints/:id` response, separate from inventory. `agentVersion` in the fleet report comes from ordinary inventory and may lag `updateStatus.installedVersion`; neither is overwritten to manufacture agreement.

Use `receivedAt` for report freshness because checkedAt uses the endpoint's clock. Root/web obtains the current website package version independently from existing `/api/agent-download`; this module does not guess or duplicate package metadata. An older0.1.6/0.1.7 endpoint with no new report remains unknown, including RESEARCH until independent evidence or a pilot upgrade supplies telemetry.

## Retention and audit

Every valid report refreshes latest evidence and server receipt time. Transition identity includes installed/available versions, phase, stage, attempts, error code and package digest; checkedAt/attempt/retry timestamp-only changes do not append history. Only semantic changes append a row. History is capped at the latest **100 transitions per endpoint** by deleting updater-history rows only. No job, output chunk, authorization or output retention is changed. History is currently stored for diagnostics, not exposed as a new mutation/command API.

Failure/retry-failure transitions emit `agent.update.failure` audit events with fixed phase/stage/error code, attempts and bounded versions. Repeated identical failure heartbeats do not spam history/audit. No raw logs, URLs, local paths, credentials, script text or exception text are accepted or audited. Normal disabled/deferred/current states do not require a diagnostic remote command.

## Verification

`cd server; npm test` — **47/47 pass** on Node26.13.0, including five new updater tests:

- Bearer/startup scoping, cookie/CSRF isolation, revoked credentials, all three read roles, startup boot/inventory preservation and no-telemetry null for older agents.
- Server-clock receivedAt, canonical time/hash normalization, atomic invalid heartbeat rejection, old-heartbeat omission preservation and invalid-inventory refusal before telemetry storage.
-25 malformed/secret-bearing reports rejected without retaining or echoing test credentials, including unknown properties, arbitrary summaries, invalid enums, field sizes, counts, versions and dates.
- Timestamp-only deduplication, failure-transition audit deduplication,100-transition cap, and exact preservation of an existing running job/output during pruning.
- Byte-exact safe catalog agreement with the agent source, plus successful reporting of every declared phase and error code.

These are synthetic real HTTP/SQLite tests only; they perform no real endpoint diagnostic command, service update, installer execution, screenshot or production change. Root owns the live RESEARCH diagnosis, worker startup/runtime scheduling, integration/pilot upgrade, packaging and rollout. Agent updater and web contributors own their separate component evidence.
