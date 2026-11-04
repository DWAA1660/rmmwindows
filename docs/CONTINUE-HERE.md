# Copyable handoff — 2026-11-04

User asked to stop implementation and prepare a handoff because usage is nearly exhausted. Parallel agents `windows_agent` and `agent_updater` were interrupted. Do not assume their unfinished changes are tested or deployed. Do not discard the dirty working tree.

## Project and authorization

- Windows RMM for Park County Library. Repository: `C:\Users\datnip\Coding\rmmwindows`, private GitHub `https://github.com/DWAA1660/rmmwindows`.
- Live console: https://rmm.parkcountylibrary.org. Linux host: `root@170.205.30.132`, Ubuntu, existing Nginx and multiple unrelated Docker websites.
- User wants elevated noninteractive PowerShell, complete untruncated results, software/domain/IP/disk inventory, storage exploration, script library, schedules, bulk actions and reboot-loop prevention. Action1 software deployment later; currently website installer.
- Latest unfinished requests: (1) live progress for SFC/DISM and long native commands; (2) automatic agent self-update on every agent-service startup.
- User explicitly authorized subagents for parallel work earlier. Claude may also work here; document changes and coordinate file ownership.
- Read AGENTS.md, PROGRESS.md, ARCHITECTURE.md, API.md. Keep PR `maintainer_can_modify:true` for DWAA1660. No secrets in Git. Screen assistance must be consented with a visible indicator; covert capture/control is not implemented.

## Deployed and verified

- Latest deployed/committed application SHA: `1fdb0d01c30b861b3a7a42875871eeac1bc663a4`. Local HEAD matched it at handoff, before this documentation-only commit. CI green: https://github.com/DWAA1660/rmmwindows/actions/runs/41923406688.
- Node24/Express + SQLite WAL server (`server/`), React/TypeScript/Vite (`web/`), .NET10 Windows LocalSystem worker (`agent/`). Local system SDK is8; supported SDK10.0.403 is installed ONLY under ignored `artifacts/dotnet-sdk/dotnet.exe`. Use that for local .NET builds. WindowsServices NuGet10.0.14.
- Agents poll outbound HTTPS, heartbeat30s, inventory15min, jobs10s, output uploader2s, web output poll2.5s. Current metrics are snapshots, not historical telemetry.
- Server consumes queued jobs into dispatched BEFORE execution and grants start once. NEVER automatically requeue/replay after reboot, rollback, timeout or lost ACK. Uncertain jobs stay consumed. Output chunks contiguous from0, byte-limited per chunk, exact retries deduplicated, all accepted output retained/paginated/full download. Restoring an OLD SERVER database can revive old queued work: reconcile before reconnecting agents.
- Elevated PowerShell, software/domain/IP/disks, read-only bounded storage sizes, scripts, schedules, bulk inventory/reboot, audit, web app updates work. Reboot result means request accepted, not verified subsequent boot. Screen viewing and Action1 integration remain future work.
- Public install routes: `/install.ps1`, `/api/agent-download`, `/downloads/library-rmm-agent-win-x64.zip`, adjacent `.sha256`. Bootstrap validates HTTPS and archive hash, extracts, securely prompts for separate expiring/use-limited enrollment token, invokes existing installer. No GitHub login on endpoints. `-DownloadOnly` verifies/extracts without installing. Re-running installer preserves identity.
- Docker cross-publishes the Windows x64 agent and includes a freshly built package/checksum manifest. Current project/package version is STILL0.1.0. Private release v0.1.0 exists; no0.1.1 yet.
- Account management is DONE/live under Settings: own email/password, admin create users, edit email/roles, reset password, disable/re-enable. Roles admin/operator/viewer enforced server-side (including path casing/trailing slashes). Current-password confirmation for account changes; session revocation on password/access changes; last enabled admin protected. Email is contact-only, login remains username, no SMTP/reset-email workflow. Migration schema v2 preserves existing admin/password/session. No production credentials were changed in testing.
- Account UI verified and screenshot saved `artifacts/account-settings-verified.png`.12server tests + web build passed, full CI passed. No test users were created in production.
- User has now installed an actual endpoint `RESEARCH`. A user-started SFC/PowerShell job was running with only initial authorization output. DO NOT cancel/replay it, reboot it, or stop/update its service while the scan is active. No agent was installed by Codex.

## Incomplete live-progress fix (DIRTY LOCAL FILES, NOT DEPLOYED)

1. `agent/PowerShellRunner.cs`: removed whole-script `| Out-String -Stream -Width32767`; wrapper now invokes script directly and tries setting host buffer width. This fixes observed native CR-only buffering. Additional producer-failure handling may be present; review full diff.
2. `agent/AgentSelfTests.cs` + `agent/Program.cs`: added safe synthetic native child mode `--self-test-native-progress utf8|utf16le` emitting CR progress with sleeps, plus timing tests requiring first output before process exit. No real SFC/DISM repair was run.
3. Findings CONFIRMED by agent: old runner delivers direct `[Console]::Write` PowerShell output early, but buffers a flushed native UTF8 child until completion due to wrapper pipeline. Removing Out-String makes native UTF8 timing test pass. UTF16LE still fails/corrupts because PumpAsync is fixed UTF8. **UTF16 stream decoder is NOT implemented at handoff.** The current source still uses StreamReader/UTF8.
4. Finish streaming raw-byte decoding for UTF16LE/SFC (BOM/NUL pattern detection and incremental decoder, preserve Unicode across read boundaries). Account for a PowerShell process potentially emitting UTF8 and native UTF16 in one stream. Arbitrary unmarked mixed encodings cannot be detected perfectly; document limits. Keep stdout/stderr separate, timeouts, output durability and no replay. Consider ConPTY only if evidence requires it; it changes stderr/VT semantics.
5. `web/src/progress.ts` (NEW), `web/test/progress.test.mjs` (NEW), `web/src/main.tsx`, `web/src/styles.css`, `web/package.json`, `.github/workflows/build.yml`: frontend progress work is written and locally tested, NOT committed/deployed. CR updates display as separate history lines, latest emitted percentage shown, original server chunks/download unchanged. Two tests pass (split CRLF/percentage chunks, no fabricated percentages); web build passes. Review backspace/ANSI behavior if needed; current helper chiefly normalizes CR.
6. Project version is not bumped yet. After final agent fixes/update feature pass, bump to0.1.1 and update user agent/inventory version strings if hardcoded. Build/publish updated installer and release. Existing0.1.0 agent needs one initial manual upgrade; do not claim currently running scans will gain streaming retroactively.

## Automatic agent updater (REQUESTED, NOT IMPLEMENTED)

No `agent/AgentUpdater.cs` or updater tests existed at handoff. Agent `agent_updater` was interrupted before writing code. Design brief:

- Check at installed Windows SERVICE startup, BEFORE claiming any jobs; skip console/test runs using WindowsServiceHelpers.IsWindowsService.
- Fetch same-origin HTTPS `/api/agent-download`; require newer semantic version, win-x64, fixed expected archive URL and SHA256. No downgrade/equal-version loop, TLS validation stays on, no external redirects.
- Stage inside protected `%ProgramData%\LibraryRmm\updates`, SYSTEM/Admin permissions; refuse reparse paths and archive traversal. Verify hash before extract/execute.
- Running service cannot replace its own EXE. Launch an independent LocalSystem helper to stop only LibraryRmmAgent, run verified package Install-Agent.ps1 preserving protected config/identity and markers, and restart only that service. Validate actual installation path/service identity. Never reboot or run endpoint jobs as update steps.
- Persist pending/failed version+digest with backoff BEFORE handover so a bad update cannot create a service restart/update loop. Offline/update failure should safely continue existing agent. Add no-side-effect tests for version ordering, metadata/hash/URL validation, archive path safety, failure/backoff and identity preservation; disposable VM lifecycle test still required.
- Proposed API: static async TryUpdateAsync(configuration, logger, cancellationToken) returning whether handover began. Integrate in AgentWorker before polling; coordinate with DI/Program if needed. Root had NOT integrated anything.
- User was told 0.1.0 needs one manual upgrade to gain this feature; future starts can then update automatically. Do not silently interrupt active SFC to apply initial update.

## Deployment / access memories

- Shared host files: `/opt/library-rmm/source`, reviewed `/opt/library-rmm/compose.yml`, `/opt/library-rmm/update-helper.py`, `/opt/library-rmm/.env`, `/opt/library-rmm/updater.env`, persistent `/opt/library-rmm/data/rmm.db`, backups under `/opt/library-rmm/backups`.
- Docker project `library-rmm`, service `rmm`, container `library-rmm-rmm-1`, host loopback8088. Nginx terminates valid Let's Encrypt HTTPS. Ten unrelated containers stayed running with original uptimes; do not restart/prune/alter them.
- Root-owned systemd `library-rmm-updater` polls private GitHub main every300s via READ-ONLY deploy key. Builds/tests before switching, consistent DB backup, health check, previous-image rollback on failure, failed commit suppression. Admin web Settings button triggers same helper. Helper binds only private172.29.60.1:9441; token in protected env. Web NEVER gets Docker socket.
- **PUSHING MAIN AUTO-DEPLOYS**. Keep incomplete work uncommitted or on a feature branch. Avoid pushing half-finished progress/updater code. Infrastructure files outside source do not auto-update.
- Important Docker fix: updater umask0077 makes rewritten Git files root-only. Keep runtime `COPY --chown=node:node` for source/assets/downloads/bootstrap or non-root container fails EACCES. Completed-image smoke test checks actual unprivileged runtime/package hash/UI/auth.
- Do not roll back to pre-account-management images once restricted users exist; old code lacks role enforcement.
- SSH default saved id_rsa was NOT accepted; supplied root password worked. Do not put password in repo or copyable prompt. Existing root shell exec session71122 may still be open; sessions may not survive handoff. Root credentials were supplied earlier in original chat. Use existing credentials/key configuration, not guesses.
- GitHub CLI is authenticated as DWAA1660: `C:\Program Files\GitHub CLI\gh.exe`; connector cannot create repos, CLI was used for repo/releases/push/CI. No need to expose GH tokens.
- Initial web credentials are in root-only `/opt/library-rmm/bootstrap-access.txt`; local user-private ignored `artifacts/admin-access.txt`. They may become stale after user changes password. NEVER print/commit secrets.
- Old cleanup of isolated temp folder `library-rmm-e2e-gzLBS0` was rejected by automatic review with only `blocked by policy`; left intact, disposable test-only DB/config, not production credentials. Do not retry deletion as a workaround.

## Useful checks / finish order

```powershell
cd C:\Users\datnip\Coding\rmmwindows
git status --short
git diff
npm test --prefix server
npm test --prefix web
npm run build --prefix web
& .\artifacts\dotnet-sdk\dotnet.exe build agent/LibraryRmm.Agent.csproj -c Release
& .\artifacts\dotnet-sdk\dotnet.exe run --project agent/LibraryRmm.Agent.csproj -c Release -- --self-test
node deploy/test-agent-integration.mjs
.\installer\Test-InstallerPaths.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/Test-Bootstrap.ps1
.\installer\Build-Agent.ps1 -Version 0.1.1 -DotnetPath '.\artifacts\dotnet-sdk\dotnet.exe'
```

Finish native UTF16/live timing tests and updater implementation FIRST; integrate and test without touching production scan. Update docs, commit coherent code, push, follow full CI and scoped app deployment, verify public0.1.1 package and safe download-only checks. Then guide user through initial agent upgrade after active task completes; confirm future startup updates on disposable VM first. Preserve all existing output and at-most-once guarantees throughout.
