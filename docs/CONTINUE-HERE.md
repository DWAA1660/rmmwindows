# Continue here — updated 2026-11-04 (Claude)

## Latest Codex work — remote support

Endpoint groups and persisted bulk results are deployed (commit04874b8). Remote support merged through PR#1 and deployed as344c6af after all Windows/Linux/container CI passed: dedicated browser window, non-elevated Windows companion, live cursor/mouse/keyboard, admin notice policy (default15second auto-approval; configurable1–300; optional form bypass), always-visible indicator and Ctrl+Alt+Shift+F12 local emergency end. Agent0.1.6 required and publicly downloadable. Native Ctrl+Alt+Delete uses a scoped service broker and existing Windows services SAS policy; no fake key chord or policy rewrite. Production schema7,36endpoints and settings UI verified; no production session started. See component handoffs/latest PROGRESS.

**Windows sign-in/secure desktop view/control remains unimplemented.** The current helper needs an active signed-in user and pauses at Winlogon/UAC/lock. A test VM endpoint has been requested for developing/validating that additional SYSTEM desktop transport. Never describe the CAD request as sign-in control. No real staff screen, native SAS or service/companion launch has been exercised by Codex for this feature yet. Earlier historical items below may already be completed; use latest PROGRESS evidence.

The Codex handoff that used to live here has been worked through. Current state:

## Done since the Codex handoff

- **Live SFC/DISM progress** (commit 8121a8a + 40ea457): wrapper no longer buffers native output; `agent/AdaptiveOutputDecoder.cs` decodes UTF-8 and UTF-16LE (sfc.exe) from raw pipe bytes; web shows CR progress as history plus the latest emitted percentage. Wide tables are full width (hidden console buffer widened to 32766; script piped to `Out-Default` so formatting flushes before `exit`).
- **Agent self-update at service start** (40ea457, agent 0.1.1): `agent/AgentUpdater.cs`. See PROGRESS.md "Agent 0.1.1" for the safety rules.
- **Request-to-join enrollment** and **public repo**: see PROGRESS.md. Installer default no longer needs a token.
- **Passwords**: minimum length 8 (`MIN_PASSWORD_LENGTH`). Break-glass reset on the host: `docker exec -it library-rmm-rmm-1 node src/reset-password.mjs <username>`.

## Still open

1. **Disposable-VM lifecycle test of the updater**: install 0.1.1 on a throwaway VM, publish 0.1.2 (bump csproj `<Version>`, push), restart the service, confirm the log in `%ProgramData%\LibraryRmm\updates\`, the new version in the console, and that enrollment survived. Also test a deliberately broken package (bad hash) to confirm backoff and that the old service keeps running.
2. **Initial manual upgrade of existing endpoints** (e.g. RESEARCH) from 0.1.0 → 0.1.1 by re-running the website install command, only after any running job there finishes. 0.1.0 has no updater.
3. Real SFC/DISM run on a test endpoint to confirm progress appears live in the console (only synthetic native children were tested).
4. Test the tokenless installer on a real Windows VM: install, approve in the console, confirm it appears and runs a job. Then confirm "Library RMM Agent" appears in Programs and Features and that Uninstall removes the service, folders and entry and shows the endpoint as revoked.
5. Later features: Windows sign-in/secure desktop support, signed packages, MFA/SMTP. Remote ordinary-desktop support is now implemented; see current feature handoffs.

## Rules that still apply

At-most-once job dispatch (never requeue), never truncate output, visible screen support following the latest admin-configured notice policy, no secrets in Git, pushing `main` auto-deploys to production (keep half-finished work off `main`). The admin SSH key on this PC is NOT accepted by the server; key-based access would need to be set up by the user. Local .NET10 SDK: `artifacts/dotnet-sdk/dotnet.exe`.
