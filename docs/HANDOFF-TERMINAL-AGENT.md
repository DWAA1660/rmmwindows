# Terminal agent checkpoint — 2026-11-04

**Paused for the user's usage-budget handoff. No more implementation, builds, packaging, service actions or endpoint actions after this checkpoint.** The persistent-terminal implementation is not ready to claim reliable boundaries yet: the isolated test intermittently ends a valid first command because it counts the legitimate Windows console host as a background descendant.

## Owned files and current edits

Coordinator assigned this contributor temporary ownership of `agent/TerminalShell.cs` and `agent/TerminalSelfTests.cs`; coordinator owns TerminalManager, entry points, API, relay and packaging.

Edits currently present:

- `TerminalSelfTests.cs`: initial-command failure now includes interruption flag, exit code, interruption reason, actual/expected working directory, stdout and stderr. Working-directory comparison uses normalized full Windows paths with case-insensitive comparison.
- `TerminalShell.cs`: interruption result includes the exception message for concrete diagnosis. Added `TerminalProcessJob.ActiveProcessIds`, using `QueryInformationJobObject(JobObjectBasicProcessIdList)` with bounded growing buffers, and temporary per-PID process/image diagnostics in the existing `ActiveProcesses > 1` rejection.
- **No descendant-classification fix is applied yet.** Existing behavior still rejects every job count above one, including a valid system `conhost.exe`.
- **No early output-pump-failure fix is applied yet.** ExecuteAsync still waits for the pipe result before awaiting stdout/stderr pumps; a failing durable-output callback can therefore stop draining a pipe and delay termination until the command deadline.

## Confirmed reproduction

An ignored harness invokes only `TerminalSelfTests.RunAsync` ten times, not the full agent suite:

```powershell
& .\artifacts\dotnet-sdk\dotnet.exe build agent/LibraryRmm.Agent.csproj --configuration Release --output artifacts/terminal-current
& .\artifacts\dotnet-sdk\dotnet.exe run --project artifacts/terminal-check/check.csproj --configuration Release
```

`artifacts/terminal-check/check.csproj` currently references the compiled DLL in `../terminal-current/LibraryRmm.Agent.dll`; Program loops ten repetitions. This avoids touching a live integration-test DLL. The diagnostic build passed with zero warnings/errors.

Both diagnostic attempts passed repetition 1 and failed repetition 2 on the first benign command. The full failure established:

```text
interrupted=True; exit=-1
reason=IOException: A command left background descendants running ...
stdout=first
stderr=(empty)
job process identities:
  powershell.exe — C:\WINDOWS\system32\WindowsPowerShell\v1.0\powershell.exe
  conhost.exe    — C:\WINDOWS\system32\conhost.exe
```

This is the suspected legitimate-console-host race, now confirmed by PID/image enumeration; it is not an initial command/CWD/script error. Existing self-tests otherwise passed state persistence, functions, 300KB Unicode stdout/stderr, live progress, error recovery and timeout/no-resume on repetition 1.

## Processes that must not be stopped

**PID36808 is the coordinator's isolated real integration agent, associated with root integration process16368. DO NOT STOP IT.** It holds the ordinary `agent/bin/Release/net10.0-windows/LibraryRmm.Agent.dll` open. A normal-output build failed on that lock; diagnostics correctly switched to ignored `artifacts/terminal-current`. This contributor did not terminate that process or any coordinator process. Coordinator should finish/diagnose its own integration run.

## Exact next work

1. Replace the raw `ActiveProcesses > 1` rule with actual active job PID inspection. Ignore the terminal's own PowerShell PID and only legitimate console infrastructure whose **full executable path** matches the real Windows system console host (e.g. `%SystemRoot%\System32\conhost.exe`), not arbitrary matching process names. Ignore PIDs already exited between enumeration and inspection. Treat unknown/live non-console descendants as boundary violations. A job accounting count may briefly lag actual active PID state.
2. Keep kill-on-close job containment and at-most-once terminal lifetime. A genuinely background child must end the terminal and be killed; never recreate/retry a command/session after uncertainty.
3. Observe stdout/stderr pump faults concurrently with the pipe boundary read using a fault signal/`Task.WhenAny`; kill immediately if output cannot be durably retained. Observe/cancel the pending boundary read and preserve all already accepted chunks. Return an explicit output-retention/interruption reason, never silently drop output or retry execution.
4. Add isolated tests for a real owned background PowerShell child (capture its PID, prove job cleanup kills it), cancellation, and a synthetic IOException in the output callback (prove termination happens promptly rather than at the long command timeout). No service install, network probe, domain query or endpoint job needed.
5. Re-run the ten-repetition isolated harness to completion; then coordinator runs the full suite and real agent/API terminal integration. Only after those pass should final packaging/CI/deployment resume.

## Other contributor slices already handed off

Inventory additions are implemented in InventoryCollector/InventorySelfTests and documented in `HANDOFF-ENDPOINT-INVENTORY.md`; new tests passed (including the agent-suite entry). Directory probing is an isolated hard-five-second process; real AD connectivity remains unverified.

Dual-monitor and independent notice/details settings are implemented in SupportProtocol/SupportSelfTests and companion files; both project builds and pure tests passed. `HANDOFF-REMOTE-AGENT.md` records the FINAL user override: notice and session details are independent, including both off (no notice/window/banner/icon/tray), with the emergency hotkey/controller/expiry/revocation checks retained. Native WTS/UI/capture/input/hot-plug lifecycle is still unverified. Coordinator must complete relay/browser settings and display-message integration before exercising the changed companion.
