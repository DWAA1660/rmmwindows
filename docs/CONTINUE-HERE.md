# Continue here — updated 2026-11-04 (Claude)

The Codex handoff that used to live here has been worked through. Current state:

## Done since the Codex handoff

- **Live SFC/DISM progress** (commit 8121a8a + 40ea457): wrapper no longer buffers native output; `agent/AdaptiveOutputDecoder.cs` decodes UTF-8 and UTF-16LE (sfc.exe) from raw pipe bytes; web shows CR progress as history plus the latest emitted percentage. Wide tables are full width (hidden console buffer widened to 32766; script piped to `Out-Default` so formatting flushes before `exit`).
- **Agent self-update at service start** (40ea457, agent 0.1.1): `agent/AgentUpdater.cs`. See PROGRESS.md "Agent 0.1.1" for the safety rules.
- **Passwords**: minimum length 8 (`MIN_PASSWORD_LENGTH`). Break-glass reset on the host: `docker exec -it library-rmm-rmm-1 node src/reset-password.mjs <username>`.

## Still open

1. **Disposable-VM lifecycle test of the updater**: install 0.1.1 on a throwaway VM, publish 0.1.2 (bump csproj `<Version>`, push), restart the service, confirm the log in `%ProgramData%\LibraryRmm\updates\`, the new version in the console, and that enrollment survived. Also test a deliberately broken package (bad hash) to confirm backoff and that the old service keeps running.
2. **Initial manual upgrade of existing endpoints** (e.g. RESEARCH) from 0.1.0 → 0.1.1 by re-running the website install command, only after any running job there finishes. 0.1.0 has no updater.
3. Real SFC/DISM run on a test endpoint to confirm progress appears live in the console (only synthetic native children were tested).
4. Later features from the original brief: consented screen viewing with a visible indicator, Action1 deployment, signed packages, MFA/SMTP.

## Rules that still apply

At-most-once job dispatch (never requeue), never truncate output, consented visible screen viewing only, no secrets in Git, pushing `main` auto-deploys to production (keep half-finished work off `main`). The admin SSH key on this PC is NOT accepted by the server; key-based access would need to be set up by the user. Local .NET 10 SDK: `artifacts/dotnet-sdk/dotnet.exe`.
