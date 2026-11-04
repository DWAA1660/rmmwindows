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
- Production browser login verified. Settings helper reachable through bearer-authenticated private bridge route. Clicking “Pull latest & restart app” pulled commit 6edeb2e9b94a8eb770d11abfeace6893d27cf86e, rebuilt and restarted only RMM, and returned “Succeeded / Application updated and healthy.” Session persisted and public health reports the new commit. Screenshots saved locally under ignored artifacts/live-dashboard.png and artifacts/live-update-verified.png.
- Automatic source checks enabled every 300 seconds. Runtime dependency audits for server and web report zero known vulnerabilities.
- Automatic update path independently verified: first scheduled cycle began 2026-11-04 21:48:56 UTC, pulled final documentation commit 25238b007b6e5dbf56593d2e1d35526e5e99bb1e, rebuilt/restarted RMM and completed healthy at 21:49:09 UTC. The updater listens only on private bridge gateway 172.29.60.1:9441; RMM remains bound to host loopback 127.0.0.1:8088.
- GitHub Actions initial and final full runs succeeded across Linux server/web/updater tests, Windows agent/installer/real integration, and Docker/GHCR publication. Final source run: https://github.com/DWAA1660/rmmwindows/actions/runs/41918988615.
- Private preview release published: https://github.com/DWAA1660/rmmwindows/releases/tag/v0.1.0, with self-contained .NET 10 win-x64 installer zip and SHA256 file. Current archive SHA256: 5af229d0288addd4a8380fd475647e53c2dcc504b8da4939a4d6211ac17721bb.
- Initial login saved root-only on the host and downloaded into local ignored artifacts/admin-access.txt with ACL restricted to current user and SYSTEM. No credentials are committed.
- Automatic approval review rejected cleanup of an abandoned isolated test folder under the developer temp directory (`library-rmm-e2e-gzLBS0`) with only `rejected: blocked by policy`, including a safer explicit-file cleanup attempt. It was left intact; contains disposable test DB/config only, not production credentials. No further deletion attempted.

## Current limitations / next milestones

- One administrator role, no MFA/SSO or account/password-management UI yet.
- Metrics are inventory snapshots (15-minute full inventory by default), not a historical time-series telemetry system.
- No actual screen viewing until a consented visible desktop companion is built; no remote input control.
- Unsigned PowerShell installer package; signed MSI/EXE and Action1 integration remain later.
- Uncertain dispatched/running jobs stay consumed. There is no automatic inference of success or replay. Older server-database restoration requires pending-job reconciliation before reconnecting agents.

## Collaboration rules

Each contributor owns separate paths; record shipped features, test commands/results, unresolved risks here or a dedicated docs/HANDOFF-*.md. Keep API.md aligned with final behavior. Do not commit secrets. At-most-once dispatch and nontruncated output are required invariants.
