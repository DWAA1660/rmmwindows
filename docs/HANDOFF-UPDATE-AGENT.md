# Agent update diagnostics handoff — 2026-11-05

## Scope and files

- `agent/UpdateDiagnostics.cs`: closed schema1 `AgentUpdateStatus` model, fixed safe error/phase summaries, atomic status persistence, sanitized loading and old/new helper-outcome reconciliation.
- `agent/UpdateDiagnosticsTests.cs`: pure isolated files/fakeHTTP tests; no installer, service, native Windows policy or production endpoint calls.
- `agent/AgentUpdater.cs`: reports disabled/unsupported/checking/current/retry policy/download/verify/extract/launch/failure decisions; retains existing three-attempt per-package backoff. Generated helper writes a separate atomic result on ordinary completion/failure.

Root owns Worker heartbeat/idle scheduling, installer diagnosis/checkpoints, version0.1.8 and orchestration. Server/web agents own telemetry ingestion/history and display. No real endpoint was updated/restarted by this contributor. Root is investigating the reported real0.1.6→0.1.7 installer failure; these changes do not claim its underlying cause is proven fixed.

## Wire/status contract

Protected local `updates/update-status.json` is serialized by `AgentConfiguration.Json` as:

`{schemaVersion:1,installedVersion,availableVersion?,phase,stage,checkedAt,lastAttemptAt?,nextRetryAt?,attempts:0..3,errorCode?,summary,packageSha256?}`.

Phases: checking/current/disabled/deferred/downloading/verifying/installing/failed/retry_wait/unsupported. Stages: manifest/download/verify/extract/launch/install/complete/policy. Summary is always derived from a closed phase/error catalog. The server copied the exact strings from this source and validates them. No exception message, raw transcript, URL/path, token, arbitrary helper text or unknown extra field is included. Available versions and digests are bounded/validated; installed version is always from the running assembly.

Fixed error codes: disabled, unsupported_install, deferred_busy, dns_error, tls_error, network_error, request_timeout, http_error, manifest_invalid, checksum_mismatch, extract_failed, launch_failed, install_failed, pipeline_stopped, helper_stalled, attempt_limit, retry_backoff, state_invalid, cancelled, unknown_failure.

`UpdateDiagnostics.Load(configuration)` returns the sanitized/reconciled object for checkin or the dedicated update-status endpoint. `PublishReport(configuration, phase, stage, errorCode=null, availableVersion=null, packageSha256=null, attemptState=null, nextRetryAt=null, now=null)` lets Worker publish policy/deferred outcomes. It may throw an I/O error if diagnostics cannot be persisted; Updater wraps its own calls so diagnostics I/O alone never stops the installed agent. `Load` returns a safe state_invalid object if existing status/state cannot be read safely.

## Helper and legacy outcome reconciliation

Helper result: `updates/update-result.json`; root installer result: `updates/installer-result.json`. Both use `{schemaVersion:1,version,success,errorCode?,completedAt}` (additional stage is allowed but not trusted). Only matching target version and outcomes no older than the last attempt are considered. Unknown errors become fixed install_failed; no helper summary is accepted.

When current assembly version reaches/exceeds available version, status becomes current/complete. Legacy `update-state.json` without structured status infers an in-progress handoff. Installing without an outcome for10minutes becomes helper_stalled. A bounded32KiB transcript tail is inspected only for the exact known phrase “pipeline has been stopped”; if its write time belongs to this attempt, that maps to pipeline_stopped immediately, including while waiting for retry. Transcript content never leaves the endpoint. Backoff is30minutes, then2hours; after3 attempts per version/digest no automatic attempt remains. Corrupt attempt state now fails closed as state_invalid rather than silently granting unlimited first attempts.

Generated helper wraps Start-Transcript inside try, attempts to restart only the existing service on failure, and writes fixed structured success/failure via temporary file plus File.Replace/Move in finally. PowerShell PipelineStoppedException maps to a fixed pipeline_stopped code. An abruptly killed process can still prevent finally from running; stale-handoff reconciliation covers that missing-result case. `BuildHelperScript` is exposed internally as a pure string builder for parsing/quoting verification, never executed by tests.

## Verification completed

- Separate-output .NET10 agent build:0warnings/errors. Default agent/bin was temporarily locked by root's own integration process PID21584; it was left alone and validation used ignored artifacts outputs.
- Isolated harness invoked `UpdateDiagnosticsTests.RunAsync`: PASS legacy stalled/pipeline evidence, helper result reconciliation, actual-installed version resolution, disabled policy, fake HTTP403 mapping/redaction, checksum failure, persisted attempt/backoff, DNS/TLS/timeout mapping, sanitized malicious state, helper fixed-result/quoting contracts.
- Generated helper was emitted to ignored artifacts/helper-diagnostics-parse.ps1 and parsed successfully with PowerShell AST parser. It was NOT executed.
- Root added the new test entry into `AgentSelfTests`; full integrated suites/package/pilot deployment are owned by root.

Commands used locally (SDK is checkout-local):

```powershell
& .\artifacts\dotnet-sdk\dotnet.exe build agent/LibraryRmm.Agent.csproj -c Release --output artifacts/update-diagnostics-validation
& .\artifacts\dotnet-sdk\dotnet.exe run --project artifacts/update-diagnostics-harness/Harness.csproj -c Release -p:OutputPath=C:\Users\datnip\Coding\rmmwindows\artifacts\diagnostic-harness-run\
```

Harness/setup files are ignored, contain only synthetic test values, and do not contact production. No endpoint job is requeued, replayed, cancelled or executed by this work.
