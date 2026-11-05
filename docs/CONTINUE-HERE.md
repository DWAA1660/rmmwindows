# Continue here — updated 2026-11-05 (fleet outage from the "Update Endpoint" script)

## Latest: PowellDC signed-out support fix in progress

Solo work (user said no sub-agents) on `fix/signed-out-support`, agent/companion0.1.12. User's latest clarification: preserve existing prompt/indicator settings; no banner/settings/UI changes in this fix. See final PROGRESS.md section for live session/job IDs and findings. PowellDC is online0.1.11, console3 at sign-in/no user, SAS policy1. Previous support cleanup escaped ObjectDisposedException and could leave its lease active forever; fixed idempotent channel disposal/unconditional Finished and added regression. Also fixed x64 WTS lock flag offset16 versus connection-state offset12. Builds/companion tests passed; full agent suite running. Next: complete tests/CI, publish0.1.12, update only PowellDC while idle using the official Update agent task handoff, verify fresh signed-out session/ending/repeated launch, preserve boot/identity and other host services. Never replay consumed jobs, sign in with credentials or reboot this domain controller for testing.

## Remote support takeover + Ctrl+Alt+Delete + smooth streaming — 2026-11-05 late (same branch, agent/companion 0.1.11, uncommitted at hand-off)

- What changed and why: see PROGRESS.md (last section) and ARCHITECTURE.md → Remote support (Takeover, Screen helper + notice, Frames). API additions in API.md under "Agent 0.1.11+".
- Code: `agent/SupportLauncher.cs` (lease with SYSTEM `engine` + user `notice` helpers, takeover, stray-helper cleanup), `agent/SupportProtocol.cs` (`SupportAccessPolicy`, `SupportNoticeBootstrap`, `SupportPipeMessages`, `SupportFrameFormat`), `companion/SupportEngine.cs` (replaces `SignInScreenSession.cs`), `companion/FrameEncoder.cs` (replaces `DesktopCapture.cs`), `companion/SupportWindow.cs` (notice only), `server/src/support.mjs` (takeover, `parseDeltaFrame`, acks/refresh/keyframe, `userConsent`, stop reasons), `web/src/supportFrames.ts` + `RemoteSupport.tsx` (ordered delta drawing, acks, fps).
- Next: merge/publish, then on one library PC test in this order: start a session with someone signed in (notice → approve), Ctrl+Alt+Delete → Lock → unlock by typing the password remotely, sign out → start a new session at the sign-in screen → sign in remotely (notice appears for the new user, approve, desktop resumes), start a second session while the first is open (first closes), and a UAC prompt. Watch the fps footer on a busy screen. If Ctrl+Alt+Delete reports the policy message, `SoftwareSASGeneration` must be set by GPO (this app never changes it).
- Known limits: sign-out/restart ends the session (no automatic reconnect by design); the notice cannot be shown for a user whose only token is elevated (UAC off) unless notice and indicator are both off; capture is GDI (no DXGI duplication yet), ~40–55 ms per 1080p frame.

## Remote support launch failures — 2026-11-05 evening (branch `fix/support-launch-diagnostics`)

- User report: TEEN05 support window showed "Session unavailable". Production evidence (read-only, via the signed-in console): sessions `712dad77…` and `2f1c1beb…` on TEEN05 (18:44 UTC) and `0bd1bc1d…` on DOORLOCKVM (17:01 UTC) all ended `launch_failed`; each launch job was `interrupted` within ~0.3 s with only "InvalidOperationException" and no `support.launch.granted`, so the agent failed **before claiming the session** (session choice/user token checks in `SupportLauncher`). A session on PKIDS04 (same PCLS\public user, same OS build) at 15:12 UTC succeeded (consent unattended, control granted), so the relay and helper work.
- DOORLOCKVM has no signed-in user, so its failure is expected. TEEN05 rebooted at 18:45:49 UTC right after both attempts and now shows PCLS\public signed in; most likely nobody was at the desktop at 18:44 (patron sign-out/reboot cycle), but the old agent hid the exact message, so this is **not proven**. A read-only diagnostic job on TEEN05 was not run (blocked by the session's permission policy).
- Fix (agent/companion **0.1.10**): `SupportLaunchException` with fixed codes/messages (`no_signed_in_user` with console state, `multiple_users`, `limited_token_unavailable`, `user_token_unavailable`, `helper_start_failed`, `helper_no_response`, `helper_failed` with exit code, `already_active`, `companion_missing`, `companion_path_invalid`). The worker completes such jobs as `failed` with that text. Server session view adds `reason` + `launchSummary`; the support window shows the explanation and drops the misleading "support connection closed" banner once the server confirms the session ended.
- Verified: agent self-tests 35/35 (new pure session-choice/message test), companion builds clean, server 49/49 (new launch-summary assertion), web 25/25 + build, local browser check with a fake endpoint showing the reason. Not verified on a real endpoint; publishing needs the PR merged (groups with automatic updates on will take 0.1.10).
- **Then the user asked for support "whether someone is signed in or not, like Action1".** Same branch adds sign-in screen mode (see ARCHITECTURE.md → Sign-in screen mode): with nobody signed in (or a locked console under the both-off policy) the service starts the companion as SYSTEM on the Winlogon desktop; it follows the input desktop, consents as `signin_screen`, polls Ctrl+Alt+Shift+F12, and ends on a user's own desktop unless notice and indicator are both off. Files: `agent/SupportLauncher.cs` (SignInScreenTarget, IsLocked, claim-then-pipe order), `agent/SupportProtocol.cs` (`SignInScreen` bootstrap flag, `SignInScreenPolicy`), `companion/SignInScreenSession.cs`, `companion/Program.cs`, `server/src/support.mjs`, `web/src/RemoteSupport.tsx`.
- Verified: agent 35/35 (policy and bootstrap compatibility checks added), server 50/50 (new sign-in consent test), web 25/25 + build, companion `--self-test` and new manual `--desktop-smoke-test` (as a normal user: input-desktop attach, 2 monitors, one in-memory frame), local browser QA with a fake sign-in device and the default approval-required policy. **Not verified: anything running as SYSTEM on a real sign-in/lock screen** (token session move, Winlogon capture/input, SendSAS without impersonation, hotkey polling). First real test: an idle signed-out PC after 0.1.10 is published.

## Incident 2026-11-05 15:36 UTC — read first

- The user ran the script-library entry **Update Endpoint** (downloads `/install.ps1` and runs it) as an RMM job on the fleet. **34 computers went offline between 15:35:59 and 15:36:49 UTC**, ITASSISTANT included.
- Cause: the job runs as a child of the agent. The installer stops the agent service; the stopping agent kills the job's whole process tree (`PowerShellRunner.TryKill`, `entireProcessTree`), so the installer died before its `Start-Service`. SCM recovery doesn't fire because the stop was clean. Evidence on ITASSISTANT: Windows PowerShell log shows the job `invoke.ps1` and `C:\WINDOWS\TEMP\Install-LibraryRmm.ps1` starting at 08:36:16 local with no engine-stopped event; the service logged "stopped successfully" at 08:36:42. Remote SCM from this PC is blocked by the firewall ("RPC server is unavailable").
- Fix (branch `fix/update-handoff`): `Bootstrap-Agent.ps1` detects an ancestor `LibraryRmm.Agent.exe`. In that case it copies itself into a new SYSTEM/Admin-only `C:\Windows\Temp\LibraryRmm-Update-<guid>`, registers a trigger-less one-time SYSTEM scheduled task, starts it and exits 0. The task waits 20s (so the job can report completion), installs, always tries `Start-Service` if the service isn't running, removes its task and keeps a transcript in that folder. The agent's own updater is unaffected (it doesn't use the bootstrap). Once deployed, the existing library script works unchanged, because it downloads the bootstrap fresh.
- Recovery for computers already offline: `installer/Repair-Agent.ps1`, run **outside** the RMM (Action1 or an elevated prompt). It starts a stopped service (the agent then self-updates at startup) or, if the service can't start, reinstalls while keeping the enrollment. Rebooting also works (the service is Automatic).
- Verified: real process-tree detection test passes locally; the mocked elevated handoff test runs in CI only (local shell not elevated); installer path tests and 47 server tests pass. Not verified on a real endpoint yet.

- Same PR also adds the **Update agent** button and a **per-group automatic updates** switch (agent 0.1.9, schema 10). Merging publishes agent 0.1.9: groups with updates on will self-update to it. Restore-protected PCs need one thaw → Update agent → freeze so 0.1.9 is in their image, then turn their group's updates off.

## Previous checkpoint

- PR #5 merged as `dc44403388e3187323dbd86c2f9cac808bc5d5a2` after complete Windows agent, server/web and Linux container CI passed (run `42051042776`). Production deployment succeeded at 15:08 UTC: healthy website, public agent **0.1.8** (78,887,530 bytes), schema **9**. Other ten Docker containers retained their existing uptime.
- RESEARCH / Cody Public was actually running **0.1.6**. Its verified 0.1.7 package was staged, but installer transcript stopped with "The pipeline has been stopped" before enrollment preservation. The following Windows reboot occurred inside the update attempt's 30-minute backoff. The old agent checks only at service startup, leaving it old after that reboot. Exact original installer interruption cause remains unproven; staged installer directory validation passed independently.
- New agent: startup plus **15-minute idle checks**, defers while a terminal/support session is active, retains bounded per-package backoff/attempt limits, reports safe structured update evidence before inventory and on heartbeats. It never requeues commands or reboots Windows. Download body has a ten-minute deadline. Installer directory enumeration avoids early-termination pipelines and now logs setup checkpoints.
- Dashboard: Agent updates panel and endpoint update details show stage, fixed failure reason/code, retry time, attempts, version and server receipt age. Missing reports from old agents mean unknown, never fabricated failure. Server stores latest report plus at most 100 transitions per endpoint; command output is unaffected. See `HANDOFF-UPDATE-AGENT.md`, `HANDOFF-UPDATE-SERVER.md`, `HANDOFF-UPDATE-WEB.md` and API.md.
- Verified locally: server 47 tests, web 23 tests/build, agent 33 self-tests, companion self-tests, installer/bootstrap checks, full real console-agent/API integration (complete output, no replay, files, persistent stateful terminal). CI independently passed packaging and non-root container/public download smoke. No staff screen capture/control was used.
- **RESEARCH repaired and verified:** one delayed service-only restart exercised its own automatic updater; installed **0.1.8** at 15:09 UTC, same endpoint ID and Windows boot time (15:03:12.500 UTC before and after this maintenance). Its signed-in desktop was untouched. Structured report says current/complete, attempt1, correct published SHA256, no error. Live file browser successfully listed drives and C:\\ after upgrading. Two live terminal commands succeeded in the same PowerShell PID14180, preserving variable/current folder, and confirmed Running service/version0.1.8/unchanged boot. Test terminal explicitly ended. Ignored proofs: artifacts/research-files-production.png and artifacts/research-terminal-production.png.
- Restart launcher job `10ae3d27-657c-4d45-a2ba-e3ec6f927eda` retained its scheduling output but old 0.1.6 marked it interrupted because a child retained an output pipe. **Do not rerun it**: its one scheduled restart and automatic update both succeeded. Earlier diagnostic jobs remain untouched. The website initially showed a historical retry-eligibility timestamp even for a successful current report; a small UI follow-up hides that and labels retry as Not needed (build passed).
- Remaining verification limit: new 15-minute idle scheduling/backoff is tested locally, but no newer package has yet been published to observe a second live periodic upgrade. Real staff screen capture/control and Windows secure desktop were not tested by this work.

---

## Current state (read this first)

- **Everything is merged and live.** The user approved the merge on 2026-11-05: PR #2 (`feature/endpoint-terminal`) merged as `d5f6ada`, then PR #3 (`feature/qol-fleet-tools`, retargeted to main first) merged as `a055401`. Both PRs and main CI were green (server-web, agent, container).
- Production (rmm.parkcountylibrary.org) reports `/api/health` version `a0554015…`, and `/api/agent-download` serves agent **0.1.7**. The live web bundle contains Fleet health, Starter scripts and Needs reboot.
- Endpoints pick up agent 0.1.7 on their next service start; no fleet restart was forced. Not yet confirmed that any endpoint has updated.
- Live features now include: endpoint directory/AD inventory, persistent terminal, group deletion, multi-monitor support, independent support prompt/indicator policy, Software page with CSV export, 17 starter scripts, Ctrl+K quick search, Activity filters, Needs-reboot tab/badge, run-dialog timeout selector, Fleet health panel.
- The one-time scheduled task `rmm-continue-after-limit-reset` ran at 04:35, stalled on a permission prompt and was stopped by the user's request; it is spent and nothing else is scheduled.
- Local QA helper (not in repo) used: start a server with a temp DB + a real console agent auto-approved; never install the service.

## Good next steps

1. Watch a few endpoints report agent 0.1.7 after their next restart.
2. Real-endpoint checks still pending: service-context terminal, multi-monitor capture/input, hidden-indicator support mode on a staff desktop.
3. Ideas not started: scheduled starter scripts from the catalog, per-computer notes, software-version alerting (e.g. outdated Chrome), saved searches, dark mode, email/Teams alerts for offline/low-disk, maintenance windows for reboots.


## Earlier handoff (endpoint/terminal work)

Updated2026-11-04 at the user's explicit request to document immediately before usage runs out.

## Start here

- Workspace: C:\Users\datnip\Coding\rmmwindows.
- Current branch: **feature/endpoint-terminal**, based on main065dc07. This new feature work is UNFINISHED and NOT DEPLOYED. Changes are currently in the shared working tree; inspect git status before editing. Do not reset/overwrite contributors' files.
- Production: https://rmm.parkcountylibrary.org, last deployed main065dc070253732f20f9213db32580bd99cbfbc35, agent download0.1.6, schema7. All remote-support preview CI passed previously; real service/desktop lifecycle and sign-in control remain unverified/unimplemented respectively.
- User now says **no test machines available**. Continue using synthetic HTTP/WS tests and isolated ordinary Windows console-agent processes; do not install a service, capture a staff desktop or alter production groups as a test.
- Read docs/HANDOFF-ENDPOINT-TERMINAL.md, latest docs/PROGRESS.md, docs/ARCHITECTURE.md, docs/API.md and the component HANDOFF files.

## Latest user requirements — preserve these

1. Make group deletion easy to find, keeping computers/history when deleting a group.
2. Clicking a computer should show its Active Directory OU hierarchy, distinguished/canonical names, domain controller and useful diagnostics.
3. A real persistent remote PowerShell terminal: run a command, then another in the SAME window AND SAME PowerShell process, preserving variables/functions/current directory. Keep full live output, individual saved jobs, at-most-once execution and no replay after disconnect/reboot/rollback.
4. Dual/multiple monitor support with a browser monitor selector and correct selected-screen mouse mapping.
5. **Prompt and session indicator must be independent admin settings, INCLUDING BOTH OFF.** User explicitly rejected a banner, icon and any requirement that invisible mode must have a prompt. Latest override supersedes earlier project instructions requiring a permanent visible indicator or an initial prompt. Preserve defaults on/15seconds/indicatoron; do not silently change production settings. Runtime hotkey Ctrl+Alt+Shift+F12, expiry, cookie/role scope, audit and operator End remain.
6. Windows sign-in/UAC/secure-desktop control remains separate unfinished work. Current helper is a non-elevated user process and cannot provide it; do not claim Ctrl+Alt+Delete means sign-in control works.

## Current implementation

- Agent+companion source version bumped to0.1.7, not released.
- Extended inventory: agent/InventoryCollector.cs + InventorySelfTests.cs; server canonicalInventory/app.mjs + endpoint-inventory tests; EndpointDirectory component/model/CSS/tests. Root wired EndpointDirectory into endpoint overview. Full field contract and bounded AD behavior in HANDOFF-ENDPOINT-INVENTORY/SERVER/WEB.
- Group deletion: EndpointGroups.tsx/CSS adds obvious selected-group Delete, inline impact/destination confirmation. Existing DELETE/groups/:id{moveToGroupId} is already deployed; new UI not deployed.
- Persistent terminal server: server/src/terminals.mjs + schema8 in db.mjs +7HTTP tests. Root imported/mounted module in app.mjs and added shutdown to close(). Internal jobkindterminal, no public generic job creation. Exact API in HANDOFF-TERMINAL-SERVER.
- Agent terminal: TerminalShell.cs persistent hidden PowerShell process with private PID-checked same-user pipe, random per-command stdout/stderr byte fences, state-preserving dot-source, live AdaptiveOutputDecoder, kill-on-close Windows job object. TerminalManager.cs volatile instance ownership, one-time extra command grant,5second validation with5second networkdeadline, ends shells on denial/network loss. Worker switch/DI integrated.
- Terminal UI: new TerminalConsole.tsx/CSS written by server contributor. Root imported/wired terminalEndpoint modal state and endpoint PowerShell action now opens Terminal. Component integration/build/review still pending; see HANDOFF-TERMINAL-UI if present.
- Support: Windows companion now advertises displays, switches selected monitor, maps input using selected native bounds, supports ShowSessionDetails=false with no banner/icon/tray and both-off no window flash. Hidden sessions end on lock/UAC/display configuration changes. Root relay support.mjs now adds policy field/snapshots/claim and monitor validation/switch pause gates. Web RemoteSupport/SupportSettings support third policy field and safe monitor-switch UI. New policy/monitor HTTP/WS tests are STILL NEEDED.

## Status update 2026-11-05 (Claude)

The terminal blocker is FIXED and every suite is green (see the 2026-11-05 section of PROGRESS.md for root cause, fixes and exact results). Support policy/monitor tests were added. Remaining: publish this branch via PR + CI, merge to deploy, then follow-up quality work. Real AD lookup was verified against this domain-joined PC through a local agent.

## Verification so far

- New inventory pure tests pass, including actual script AST parse, DN OU escaping/root→leaf order/UTF8hex, bounded/partial discovery. No live LDAP probe requested by these tests.
- New inventory HTTP tests3/3 pass; terminal protocol HTTP tests7/7 pass; accounts migration tests3/3 pass with schema8.
- Most recent full server run:39/40passed; sole failure was support policy expected2fields while new GET adds showSessionDetails. That assertion has since been fixed, but whole suite NOT rerun after latest root policy/monitor edits. Earlier stale schema7 assertion was fixed to8.
- Endpoint frontend tests7/7 and production build passed before TerminalConsole main integration / final relay work. Remote support UI final build passed independently. Full current build still needs running.
- Both .NET projects built clean before final terminal diagnostic edits. Companion pure tests/negative monitor geometry pass. Full agent suite is NOT currently green because terminal bug above.
- Latest real console-agent integration: agent0.1.7,97software entries; exact300000-byte PowerShell stdout/stderr, full download/no redispatch; file list pickup7ms; byte-identical5247201-byte download all PASS. Persistent terminal section FAILS as above. No actual service, remote monitor capture/input or SAS invoked.
- No PR, push, CI, package release, browser QA or production deployment for this feature branch yet.

## Next steps in order

1. Finish/read all contributor handoffs. Fix and repeatedly test TerminalShell background descendant false positive and immediate failure kill; preserve no-replay and complete output.
2. Review TerminalManager lifecycle/concurrency with process failure, close while running, output spool failure, account revocation, expiry and network failure. Run the expanded real-agent integration to completion.
3. Finish TerminalConsole integration/build; verify same modal accepts successive commands, cwd/state persists, paginated/full output, errors preserve session, explicit uncertain-send retry uses SAME idempotency key, close ends server session and shell.
4. Add meaningful HTTP/WS tests for showSessionDetails independent combinations/defaults/snapshot/old-agent gating; monitor advertisements/known IDs/view-only selection/input+frames blocked during switch/matching display+resume/new frame. Root support.mjs currently needs those tests and a regression pass.
5. Run full server/web/.NET/companion/bootstrap/installer checks, local isolated browser QA with real console-agent terminal + synthetic monitor frames. Do NOT use staff desktops or production deletion for QA.
6. Update API/architecture/progress with final behavior and limits. Build0.1.7 Windows package and Linux Docker CI on a feature PR. Enable maintainer_can_modify:true if GitHub supports it; same-repo PRs reject fork-collaboration flag.
7. Only after green checks merge/deploy through existing main updater. Preserve all other Docker websites, ledger/output, endpoint identity and groups. Publish0.1.7; endpoints get it on next service start/re-run installer when idle. Never force fleet restarts or replay old jobs.

## Commands

    npm test --prefix server
    npm test --prefix web
    npm run build --prefix web
    ./artifacts/dotnet-sdk/dotnet.exe run --project agent/LibraryRmm.Agent.csproj -c Release -- --self-test
    ./artifacts/dotnet-sdk/dotnet.exe run --project companion/LibraryRmm.Support.csproj -c Release -- --self-test
    node deploy/test-agent-integration.mjs
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/Test-InstallerPaths.ps1
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/Test-Bootstrap.ps1

No credentials are included here. SSH host/root operational paths are in DEPLOYMENT.md; saved local key was previously not accepted. Never commit credentials, enrollment/agent tokens or production DB. main auto-deploys; keep unfinished work on the feature branch.
