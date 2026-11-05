# Agent update health UI handoff — 2026-11-05

## Delivered on `fix/agent-update-health`

- New `web/src/AgentUpdateHealth.tsx` / scoped CSS provide the read-only dashboard report panel and compact endpoint detail block. No main.tsx changes by this contributor; root owns integration.
- Exports `AgentUpdateHealth({endpoints,request,onOpenEndpoint})`, `AgentUpdateDetails({status?,agentVersion?,online?,latestVersion?})`, and shared `AgentUpdateStatus` / `AgentUpdateEndpoint` types. Endpoint props accept optional top-level `updateStatus`, separate from inventory.
- Dashboard reads `GET /api/agent-updates` and `/api/agent-download`, refreshes every20seconds/manual Refresh, and keeps last received reports when refresh fails. It shows attention/reported failures-and-retries/all filters, endpoint links, installed/available versions, the safe summary, check/retry times and safe error code. First8 matching rows are shown with an explicit Show all control; this is status presentation, not command-output retention.
- Details show phase/stage, installed/available versions, checkedAt (endpoint clock), receivedAt (server clock), lastAttemptAt, nextRetryAt, attempt count and errorCode. Only these whitelisted metadata fields and sanitized summary are rendered; no JSON dump, installer transcript or arbitrary log content.
- Distinct states: reported failure, installation not confirmed, retry wait, update available, old agent without diagnostics, newer agent awaiting telemetry, disabled/unsupported/deferred, operation in progress and current-at-last-check. Missing telemetry is never a failure. Older agents before0.1.8 are explicitly unable to report these diagnostics; an unreported result stays unknown.
- Freshness is based on server `receivedAt`, not endpoint clock. A report becomes stale after30minutes. An installing report received over30minutes ago is **Installation not confirmed**, explicitly not proof of failure. Agent-detected helper stalls can instead arrive as an actual `failed` report. Offline endpoints show their last-known evidence with an explicit statement that being offline does not confirm update failure.
- An error reported by an older installed version is not presented as a current failure after the endpoint reports a newer agent version. Merging avoids downgrading a fresher endpoint heartbeat/report with a slower dashboard poll, preserves current display names and excludes revoked endpoints.
- Existing `FleetHealth.tsx` no longer attaches the machine **Restart these…** action to agent-update issues. `fleetHealthModel.ts` advises periodic idle checks on0.1.8+, agent-service-only restart/installer when older agents are idle, and removes agent-update reasoning from the long-uptime reboot advice. Genuine Windows pending-reboot and long-uptime maintenance controls remain.

## API contract aligned with server contributor

`GET /api/agent-updates` returns an array of active endpoint rows:

```ts
{
  endpointId, endpointName, hostname, online, lastSeen,
  agentVersion: string | null,
  updateStatus: null | {
    schemaVersion: 1,
    installedVersion: string,
    availableVersion: string | null,
    phase: 'checking'|'current'|'disabled'|'deferred'|'downloading'|
           'verifying'|'installing'|'failed'|'retry_wait'|'unsupported',
    stage: string | null,
    checkedAt: string | null,
    lastAttemptAt: string | null,
    nextRetryAt: string | null,
    attempts: number,
    errorCode: string | null,
    summary: string, // server-approved safe constant; not arbitrary logs
    receivedAt: string // server UTC
  }
}
```

The same top-level updateStatus is returned on endpoint list/detail. Omission from an agent heartbeat preserves the prior report without refreshing receivedAt. Published latest version comes from `/api/agent-download`; it is not duplicated in the report response. Existing authenticated-role and output authorization remain owned by the server.

## Verification

- `npm test --prefix web`:23/23 passed (18 existing +5 new focused model/regression tests).
- `npm run build --prefix web`: strict TypeScript/Vite production build passed (1613 modules before root's pending main integration).
- New `web/test/agent-update-health.test.mjs` covers missing/legacy diagnostics versus actual failure; stale server receipts versus skewed endpoint clocks; retry versus unconfirmed installation; current/available/disabled/deferred/historical reports; version comparison; fresh report/checkin merging and revoked exclusion; corrected agent-versus-machine restart guidance.
- No endpoint jobs, service restarts, machine reboots, policy changes, installer execution or production browser actions by this contributor. Root owns local browser/production integration verification.

## Operational limits and rollout

- New reporting requires agent0.1.8. Existing0.1.6/0.1.7 endpoints have no update telemetry and must remain labeled unknown even if an out-of-band diagnostic found an installer failure. RESEARCH's current0.1.6 failure evidence is not automatically a new received updateStatus report.
- New0.1.8 periodic checks happen when idle; old agents check at service startup. A computer reboot is not required to update the agent. The UI does not initiate any restart or retry; operator endpoint actions remain separate.
- A stale/offline report or an unconfirmed installation is evidence of missing confirmation, not a diagnosis of the cause. No unsupported claim is made about the real PowerShell pipelineStopped error's root cause.
- Received status is the last agent report, not a continuously observed installer process. Timestamp clocks and explicit stage/results remain visible for assessment. Full local installer logs are intentionally not transmitted through this feature.
