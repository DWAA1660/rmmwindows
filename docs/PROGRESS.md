# Progress and handoff

## 2026-11-04 — Initial implementation underway

- Repository started empty; Git initialized on main.
- Requirements and initial protocol documented in ARCHITECTURE.md and API.md.
- DNS A record currently resolves to 170.205.30.132. SSH attempt with default saved identities failed authentication. Existing host containers have not been changed.
- Parallel work: server API/tests, React console, .NET Windows agent/installer. Root owns integration, deployment/update infrastructure, QA and handoff.
- User requested a GitHub-backed Docker image update path and an admin UI button to pull/restart the application. Must preserve other Docker websites.
- Action1 release deployment later. Installer first. Screen viewing deferred to a visible, consented assistance design.

## Implementation completed so far

- API: authenticated operator sessions, enrollment/revocation, inventory, bulk jobs, immutable dispatch/start authorization, sequenced output storage/pagination/download, scripts, schedules, audit and settings/update proxy. Seven integration tests pass; see HANDOFF-SERVER.md.
- Agent: .NET Windows worker, outbound HTTPS, hidden noninteractive PowerShell, inventory/software/disks/domain/IP, bounded read-only storage scans, reboot scheduling, durable local output spool. Eight self-tests pass including real benign PowerShell long output/Unicode/stderr and timeout; see HANDOFF-AGENT.md.
- Installer: self-contained win-x64 zip built under artifacts; PowerShell administrator installer/update/uninstall scripts parse. No local service installation or reboot. Disposable VM installer lifecycle test remains before fleet rollout.
- Web: React/TypeScript console builds. Local signed-in empty-fleet layout visually verified, API-connected pages and update settings implemented. Storage results visual enhancement underway.
- Deployment: private GitHub repository DWAA1660/rmmwindows created, host-specific read-only deploy key registered. GitHub host key fingerprint verified against official GitHub docs. SSH connected via supplied password after default key authentication failed. Four scoped updater/backup tests pass on Linux.
- Real cross-language Windows-agent/API test now passes on final .NET 10: complete 300,000 UTF-8 stdout bytes plus stderr, pagination, exact full download and no redispatch. It caught and fixed Unicode HTTP streaming/backpressure behavior; server regression added (8 tests now pass).
- Final package uses .NET 10 LTS (SDK 10.0.403 installed only under ignored artifacts/dotnet-sdk; WindowsServices 10.0.14). Packaged self-contained executable passes all eight checks. Installer paths/ownership markers are validated before any ACL changes, with a dedicated harmless validation test.
- Initial production deployment succeeded: https://rmm.parkcountylibrary.org returns HTTPS 200 and /api/health is healthy; unauthenticated inventory returns 401. Container library-rmm-rmm-1 is healthy on loopback 8088. Dedicated updater systemd service active. Let’s Encrypt certificate issued with automatic renewal; expiration 2027-02-02.
- All ten pre-existing host containers remain running with original uptimes; no existing application container was restarted.
- Production login/update-button verification and GitHub CI/release publication are in progress.
- Automatic approval review rejected cleanup of an abandoned isolated test folder under the developer temp directory (`library-rmm-e2e-gzLBS0`) with only `rejected: blocked by policy`, including a safer explicit-file cleanup attempt. It was left intact; contains disposable test DB/config only, not production credentials. No further deletion attempted.

## Current limitations / next milestones

- One administrator role, no MFA/SSO or account/password-management UI yet.
- Metrics are inventory snapshots (15-minute full inventory by default), not a historical time-series telemetry system.
- No actual screen viewing until a consented visible desktop companion is built; no remote input control.
- Unsigned PowerShell installer package; signed MSI/EXE and Action1 integration remain later.
- Uncertain dispatched/running jobs stay consumed. There is no automatic inference of success or replay. Older server-database restoration requires pending-job reconciliation before reconnecting agents.

## Collaboration rules

Each contributor owns separate paths; record shipped features, test commands/results, unresolved risks here or a dedicated docs/HANDOFF-*.md. Keep API.md aligned with final behavior. Do not commit secrets. At-most-once dispatch and nontruncated output are required invariants.
