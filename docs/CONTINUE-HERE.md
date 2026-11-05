# Continue here — updated 2026-11-05 ~00:10 MST (Claude)

## Current state (read this first)

- **PR #2** https://github.com/DWAA1660/rmmwindows/pull/2 (branch `feature/endpoint-terminal`): endpoint directory/AD inventory, persistent terminal (race FIXED), group deletion, multi-monitor support, independent support prompt/indicator policy, agent+companion 0.1.7. **All 4 CI checks green, mergeable, NOT merged**: the overnight session's `gh pr merge` (which deploys to production) was blocked by the permission classifier. The user must merge it (or explicitly allow it).
- **PR #3** https://github.com/DWAA1660/rmmwindows/pull/3 (branch `feature/qol-fleet-tools`, stacked on #2): Software page with CSV export, 17 starter scripts, Ctrl+K quick search, Activity filters, Needs-reboot tab/badge, run-dialog timeout selector, Fleet health panel. Web 18/18 + build locally; check its CI with `gh pr checks 3`. Merge #2 first; GitHub retargets #3 to main.
- Production (rmm.parkcountylibrary.org) is still on main `065dc07` (agent 0.1.6) until #2 is merged. Merging main auto-deploys within ~5 minutes; verify with `curl https://rmm.parkcountylibrary.org/api/health` and `/api/agent-download`.
- If merging is blocked again, do NOT work around it: leave PRs green and tell the user one click merges them.
- Verified overnight: all suites (server 42/42, web 18/18, agent 32/32, companion, installer, bootstrap, real-agent integration incl. persistent terminal) and browser QA against a local server + real agent on this domain-joined PC (real AD OU/DN shown, terminal state persists, starter script runs end to end).
- Local QA helper (not in repo) used: start a server with a temp DB + a real console agent auto-approved; never install the service.

## Good next steps

1. Merge #2, then #3 (after CI), confirm deploy and agent 0.1.7 download.
2. Ideas not started: scheduled starter scripts from the catalog, per-computer notes, software-version alerting (e.g. outdated Chrome), saved searches, dark mode, email/Teams alerts for offline/low-disk, maintenance windows for reboots.
3. Real-endpoint checks still pending: service-context terminal, multi-monitor capture/input, hidden-indicator support mode on a staff desktop.


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
