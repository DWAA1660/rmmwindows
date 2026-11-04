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

## 2026-11-04 — Website agent installation

- Added public `/install.ps1`, `/downloads/library-rmm-agent-win-x64.zip`, checksum file, and `/api/agent-download` metadata. Management/enrollment-token creation remains authenticated. Public scripts/artifacts contain no enrollment secret; bootstrap prompts through the existing SecureString installer.
- Add endpoints now has direct install-script/ZIP buttons, package version/size/checksum, and a copyable administrator PowerShell command.
- Docker build cross-publishes the .NET 10 Windows x64 service and packages the installer with each app image; avoids private GitHub login on endpoints and keeps web downloads synchronized with source.
- Bootstrap validates HTTPS origin and expected download path, checks SHA256 before extraction, supports `-DownloadOnly`, and never reboots. Existing endpoint enrollment remains preserved by the underlying installer.
- Local verification: ten server tests pass (including unauthenticated downloads, management still401, Host header injection resistance, checksum validation/tamper refusal); web TypeScript/production build passes; real Windows PowerShell 5.1 mocked bootstrap checks pass for good download, no execution in DownloadOnly, bad hash refusal before extraction, and foreign URL refusal.
- Linux Docker cross-publish succeeded. First runtime deployment rejected unreadable source files because the privileged updater's private checkout permissions were retained in Docker COPY; automatic rollback restored the previous healthy version. Runtime source/assets now explicitly belong to the non-root node user. A completed-image smoke check was added for bundled ZIP/hash, bootstrap, UI and management authentication.
- Corrected deployment 61aeb7a8d5d39b9fb2227e19dd179dad10578be5 is live/healthy. Finished image passes the non-root isolated smoke check: UI, bootstrap, 32,681,739-byte public ZIP, exact checksum and management401. All ten unrelated containers retain their original uptimes.
- Real Windows PowerShell 5.1 downloaded `/install.ps1` from production and ran `-DownloadOnly`: metadata fetch, public archive download, SHA256 verification and extraction succeeded without enrollment/service installation/reboot. The actual Linux-published Windows EXE from that website package then passed all eight agent self-tests.
- Live browser Add endpoints page shows both downloads, package version/size/checksum and the correct three-line command. Copy command changed to “Copied.” Screenshot saved to ignored artifacts/website-agent-install.png. Existing admin session survived deployment/rollback.
- Final GitHub Actions source run is green across server/web, Windows agent/bootstrap/installer/integration and completed-image smoke/GHCR publication: https://github.com/DWAA1660/rmmwindows/actions/runs/41921368385. All requested website-installation work is deployed and verified; service lifecycle testing on a disposable endpoint remains the preview limitation.

## Current limitations / next milestones

## 2026-11-04 — Accounts and roles

- Settings now includes own email/password changes and admin user creation, email editing, role selection, disabling/re-enabling and password resets. Roles are administrator, operator and viewer; permissions are enforced by the API including URL case/trailing-slash variants.
- Additive schema v2 preserves existing account credentials and durable management state. Last-admin protection, sensitive-action current-password confirmation, CSRF/origin checks, rate limits, audit without secrets, immediate session revocation on password/access changes, and case-insensitive unique usernames implemented.
- Email is contact-only, not a login identifier or verified/reset-email channel. Disabled accounts retain historical attribution; no destructive user deletion route.
- Local server account lifecycle/migration tests and frontend production compilation pass. Deployment and live UI verification pending.

## Current limitations / next milestones

- MFA/SSO and email delivery/verification remain future work.
- Metrics are inventory snapshots (15-minute full inventory by default), not a historical time-series telemetry system.
- No actual screen viewing until a consented visible desktop companion is built; no remote input control.
- Unsigned PowerShell installer package; signed MSI/EXE and Action1 integration remain later.
- Uncertain dispatched/running jobs stay consumed. There is no automatic inference of success or replay. Older server-database restoration requires pending-job reconciliation before reconnecting agents.

## Collaboration rules

Each contributor owns separate paths; record shipped features, test commands/results, unresolved risks here or a dedicated docs/HANDOFF-*.md. Keep API.md aligned with final behavior. Do not commit secrets. At-most-once dispatch and nontruncated output are required invariants.
