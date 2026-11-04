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

## 2026-11-04 — Accounts and roles

- Settings now includes own email/password changes and admin user creation, email editing, role selection, disabling/re-enabling and password resets. Roles are administrator, operator and viewer; permissions are enforced by the API including URL case/trailing-slash variants.
- Additive schema v2 preserves existing account credentials and durable management state. Last-admin protection, sensitive-action current-password confirmation, CSRF/origin checks, rate limits, audit without secrets, immediate session revocation on password/access changes, and case-insensitive unique usernames implemented.
- Email is contact-only, not a login identifier or verified/reset-email channel. Disabled accounts retain historical attribution; no destructive user deletion route.
- Twelve server tests and frontend production compilation pass. One existing random test port landed in a Windows reserved range; listener setup now retries bind conflicts instead of failing unrelated tests.
- Deployment 1fdb0d01c30b861b3a7a42875871eeac1bc663a4 is live/healthy. Existing administrator session survived migration; live Settings shows own email/password forms and admin user management. Add user form verified with viewer/operator/admin choices. No production credentials were changed and no test accounts were created on production. Screenshot: ignored artifacts/account-settings-verified.png.

## 2026-11-04 — Live command progress (Claude, continuing Codex handoff)

- User reported SFC/DISM progress appears only after completion. Safe native-child test reproduced buffering of flushed carriage-return progress in the agent's forced PowerShell `Out-String` pipeline; direct PowerShell partial output was already delivered early.
- Fix 1: wrapper no longer pipes the whole script through `Out-String`; native tools inherit the redirected handles and their partial writes stream immediately.
- Fix 2: `agent/AdaptiveOutputDecoder.cs` reads raw pipe bytes and switches between UTF-8 (PowerShell, DISM under the UTF-8 console code page) and UTF-16LE (sfc.exe writes raw UTF-16 to pipes). Detection: UTF-16 BOM or two `(ASCII,0x00)` code units; back to UTF-8 after three code units whose bytes are all printable ASCII. Bytes are held only when they could start a switch, so whole progress writes are emitted immediately. Limit: unmarked CJK UTF-16 text could occasionally be misread as UTF-8; documented in the class.
- Agent self-tests: 12/12 pass, including mixed UTF-8/UTF-16LE decoding at every split point and byte-by-byte, plus synthetic native UTF-8 and UTF-16LE children that must deliver CR progress before exit. No real SFC/DISM repair was run.
- Web renders carriage-return progress as readable history and shows the latest percentage actually emitted by the command. Original server chunks and full downloads remain unchanged. Two frontend progress tests pass; CI now runs them.
- Running endpoints keep the old behavior until their agent is upgraded. The production scan that was in flight was not cancelled or replayed.

- Regression found and fixed before 0.1.1: commit 8121a8a's wrapper ran the script without `Out-String -Width`, so (a) wide tables were cut at the hidden console's 120 columns with `...`, and (b) the wrapper's `exit` discarded table output the formatter had not flushed yet (a script ending in `Get-Service` could print nothing). The wrapper now widens the hidden console buffer to 32766 columns and runs `& script | Out-Default`, which flushes formatting before `exit` while still letting native tools write progress straight to the pipe. A self-test now covers implicit and explicit wide tables. Endpoints that installed from the website between 8121a8a and 0.1.1 should be upgraded by re-running the install command (or will self-update to 0.1.1 only if they already run 0.1.1+; 8121a8a builds still report 0.1.0 and lack the updater).
- `$?` semantics for script errors were compared against the old wrapper and are unchanged (non-terminating errors behaved the same; thrown errors exit 1 via the wrapper's catch).

## 2026-11-04 — Agent 0.1.1: automatic update at service startup

- `agent/AgentUpdater.cs`, called first in `AgentWorker.ExecuteAsync` only when running as the Windows service, before recovery, heartbeats or any job claim, so an update never interrupts a command.
- Flow: GET `/api/agent-download` from the enrolled origin (no redirects, TLS validation on) → accept only a strictly newer plain `x.y.z` win-x64 package at the fixed `/downloads/library-rmm-agent-win-x64.zip` path → persist the attempt in `%ProgramData%\LibraryRmm\updates\update-state.json` BEFORE downloading → stream the download with size and SHA-256 checks → extract with path-traversal and size limits → verify the inner `package-manifest.json` version and agent exe SHA-256 → launch a detached `apply-update.ps1` that runs the package's own `Install-Agent.ps1` (enrollment preserved, only LibraryRmmAgent restarted, never reboots). On failure the helper restarts the existing service. Log: `%ProgramData%\LibraryRmm\updates\update-<version>.log`.
- Loop protection: max 3 attempts per package digest with 30-minute then 2-hour backoff; a new digest resets the counter. On restore-on-reboot machines the state file is rolled back with the disk, which yields at most one update per boot, never a loop within a boot.
- If the helper never stops the service within 10 minutes, the old agent resumes normal work. Opt-out per endpoint: `"autoUpdate": false` in `agent.json`.
- `Install-Agent.ps1` now waits for the old agent process to exit after the service stops before copying files.
- Version bumped to 0.1.1 (`agent/LibraryRmm.Agent.csproj`); `Build-Agent.ps1` now defaults to that version and works under Windows PowerShell 5.1.
- Tests: 14/14 agent self-tests (source build and the packaged single-file exe), including version ordering, manifest validation, backoff/attempt limits, verified staging, tampered archive, traversal, inner-version and exe-hash rejection. Integration test passes (teardown now retries a briefly locked folder). NOT yet verified: a real service-to-service update on a disposable VM.
- Existing 0.1.0 agents have no updater. Each needs one manual upgrade by re-running the website install command (identity is preserved). After that, every service start checks for updates.

## 2026-11-04 — Public repository and tokenless "request to join" enrollment

- User asked for the GitHub repo to be public (unlimited CI). Full history (13 commits) was scanned first: only placeholders and test-only passwords, no real credentials; the server IP in docs is already public via DNS. Repo is now PUBLIC. Keep it that way only if no secret is ever committed.
- New default enrollment: the installer no longer asks for a token. It writes `agent.json` with a `deviceId` and a random 32-byte `joinSecret`; the service calls `POST /api/agent/join` and waits. The computer appears under **Add endpoints → Waiting for approval** (with hostname, OS, domain, agent version, source IP); an operator/admin clicks Approve (with a confirmation) or Deny. The nav item shows a badge with the waiting count. On approval the agent collects its token on its next 30 s poll and writes it into `agent.json`. Enrollment tokens remain as an optional path (`-PromptForToken` / `-EnrollmentToken`).
- Security model: anyone who can reach the site can create a pending request (rate limited, capped at 200 pending), but nothing is trusted until approved. Approve only computers you recognize. See API.md for rotation and revoke rules. Schema v3 adds `join_requests` additively.
- Code: `server/src/join-requests.mjs`, `agent/AgentJoin.cs`, `web/src/JoinRequests.tsx`, installer/bootstrap changes. `AgentApi` now reads the bearer token per request and refuses calls while awaiting approval.
- Tests: server 14/14 (new join lifecycle test: pending, hijack refused, CSRF, approve, token issue + rotation, deny, revoke never re-issued, remove/re-request, audit). Agent 15/15 (new join loop test with fake server: no bearer sent, intervals, credential persisted with identity kept). The real-agent integration test now starts the agent WITHOUT a token, approves it through the console API, waits for the agent to collect its credential, then runs the 300 KB PowerShell job: PASS. UI checked in a local browser: badge, request rows, Deny moved the row to Recent decisions. Not yet tested: the installer's tokenless branch on a real Windows install (scripts parse; the generated config shape is the one the integration test uses).

## 2026-11-04 — Uninstall from Control Panel

- User could not find the agent in Control Panel. `Install-Agent.ps1` now copies `Uninstall-Agent.ps1` into the install directory and registers `HKLM\...\Uninstall\LibraryRmmAgent` (name, version, publisher, icon, size, NoModify/NoRepair, UninstallString and QuietUninstallString with `-RemoveEnrollment`). Every install and every self-update re-registers it.
- `Uninstall-Agent.ps1` self-elevates through UAC when started unelevated (Programs and Features does this), stops/deletes the service, waits for the process to exit, best-effort calls the new agent-authenticated `POST /api/agent/retire` (revokes the endpoint, cancels its queued jobs, audited `endpoint.retired.uninstalled`), removes the owned directories and the registry entry, and pauses 5 s so the result is readable (`-Quiet` skips the pause).
- Tests: server join test extended (retire revokes the credential and cancels queued work). All installer scripts parse; installer path and bootstrap tests pass. NOT yet run on a real machine: the registry entry and the Control Panel uninstall (installing a service on the developer PC was not appropriate). Verify on the next real install/upgrade.

## 2026-11-04 — Password policy and lockout recovery

- Minimum password length is now 8 (`MIN_PASSWORD_LENGTH` in `server/src/security.mjs`; UI `minLength` matches). Existing passwords are unaffected.
- Break-glass reset for a locked-out account, run on the Linux host: `docker exec -it library-rmm-rmm-1 node src/reset-password.mjs <username>`. Reads the password from a hidden prompt (or stdin), re-enables the account, revokes its sessions and writes an audit row. Covered by a server test (13/13 pass).

## Current limitations / next milestones

- MFA/SSO and email delivery/verification remain future work.
- Metrics are inventory snapshots (15-minute full inventory by default), not a historical time-series telemetry system.
- No actual screen viewing until a consented visible desktop companion is built; no remote input control.
- Unsigned PowerShell installer package; signed MSI/EXE and Action1 integration remain later.
- Uncertain dispatched/running jobs stay consumed. There is no automatic inference of success or replay. Older server-database restoration requires pending-job reconciliation before reconnecting agents.

## Collaboration rules

Each contributor owns separate paths; record shipped features, test commands/results, unresolved risks here or a dedicated docs/HANDOFF-*.md. Keep API.md aligned with final behavior. Do not commit secrets. At-most-once dispatch and nontruncated output are required invariants.
