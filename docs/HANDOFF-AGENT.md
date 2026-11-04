# Windows agent and installer handoff — 2026-11-04

## Implemented

- `agent/LibraryRmm.Agent.csproj`: .NET 10 LTS Windows worker service, package `Microsoft.Extensions.Hosting.WindowsServices` 10.0.14, built with warnings treated as errors. The final package uses .NET 10 rather than .NET 8, whose support ends November 10, 2026. See [Microsoft's support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core).
- `Program.cs` / `Models.cs`: Windows-service hosting, protected ProgramData config, HTTPS-only bearer client, separate loopback-only HTTP option for explicit integration tests, versioned user agent. No listener ports, user desktop capture, or remote input.
- `AgentWorker.cs`: outbound claim/start protocol, a single nonretried start request, explicit `mayExecute:true` gate before side effects, serial job execution, background heartbeat and output upload. Authentication/network errors never trigger command replay.
- `OutputSpool.cs`: durable atomic output chunks and completion journal, sequenced across stdout/stderr/system streams, 16 KiB UTF-8 chunks, uploaded contiguously, upload cursor and server duplicate protection. A completion snapshot is taken before chunk enumeration to avoid deleting concurrently finalized output. Startup recovery marks old unfinished journals interrupted and only delivers output/completion. Completion conflicts are quarantined with evidence instead of replayed.
- `PowerShellRunner.cs`: hidden/noninteractive Windows PowerShell 5.1, administrator capability through LocalSystem identity, per-job UTF-8 script files with BOM, stdout/stderr chunk streaming including long lines and Unicode, wide formatting, process-tree timeout termination, explicit interruption if a descendant retains an output pipe. Closed stdin prevents interactive prompts from hanging the service. Output-spool failures terminate execution and remain explicit.
- `InventoryCollector.cs`: OS, architecture, domain join/domain, IPv4, logged-on user, boot timestamp, CPU/memory, fixed-disk sizes, installed software from both uninstall registry views plus loaded user profiles. Full inventory defaults to 15 minutes and is configurable; heartbeat every 30 seconds; jobs poll every 10 seconds. Software from unloaded profiles and Store/MSIX packages is not yet covered. Inventory metrics are snapshots, not continuous samples.
- `StorageExplorer.cs`: read-only local directory sizes, 200,000-entry/90-second/64-depth/5,000-root-child budgets, partial and error indicators, no file-content reads, no UNC/device paths, no reparse point/junction traversal. Logical sizes may double count hard links. This is bounded exploration, not exact allocated-byte accounting.
- `installer/Install-Agent.ps1`: administrator-only install/update, secure enrollment-token prompt, immediate local persistence of returned identity, preserves enrollment on updates, restricted SYSTEM/Administrators ACLs, LocalSystem service, automatic service restart recovery. Both target paths validate before any ACL mutation: absolute local dedicated LibraryRmm leaf, no Windows/profile tree, no reparse ancestors, no preexisting nonempty unowned directory. Role-specific ownership markers permit recognized updates. Does not reboot or run jobs as part of installation.
- `installer/Uninstall-Agent.ps1`: safe explicit path/ownership checks, removes only this service/binaries; credentials and pending output retained unless `-RemoveEnrollment` is requested. Automatic recursive cleanup is restricted to directories named LibraryRmm with valid matching ownership markers.
- `installer/Build-Agent.ps1`: self-contained single-file win-x64 (or optional win-arm64) publish, release zip, executable SHA256 manifest and archive checksum. Package includes install/uninstall scripts and instructions. `installer/README.md` is the operator guide.

## Verification

Executed successfully on the development Windows machine:

```powershell
& .\artifacts\dotnet-sdk\dotnet.exe build agent/LibraryRmm.Agent.csproj --configuration Release
& .\artifacts\dotnet-sdk\dotnet.exe agent/bin/Release/net10.0-windows/LibraryRmm.Agent.dll --self-test
.\installer\Test-InstallerPaths.ps1
.\installer\Build-Agent.ps1 -DotnetPath '.\artifacts\dotnet-sdk\dotnet.exe'
```

Build: zero warnings/errors. **Eight agent checks passed**:

1. Long Unicode output chunk integrity and byte budgets.
2. Fresh true authorization required; false/null/lost responses do not execute or retry.
3. Recovery delivers prior output and interruption, with no claim/start requests.
4. Failed output upload retains journal, retries only delivery, sends completion after accepted output.
5. Repeated job ID cannot replace its original journal/evidence.
6. Real benign PowerShell preserves a 150,000-character line, Unicode, and stderr.
7. Real PowerShell timeout terminates the command and reports interruption.
8. Unsafe storage paths are rejected.

All installer scripts parsed successfully with the Windows PowerShell AST parser. The pure `Test-InstallerPaths.ps1` extracts actual installer validation functions and verifies system/profile/shared/relative path refusal, correct default path acceptance, existing unrelated folder rejection, wrong/invalid ownership marker rejection, and valid ownership acceptance. It never executes the install body or changes ACLs.

The local SDK is 10.0.403, downloaded through Microsoft's official non-admin dotnet-install script into ignored `artifacts/dotnet-sdk`, without changing system SDK/PATH. Final self-contained .NET 10 executable passes the same eight checks. No service was installed, no endpoint was rebooted, and no shutdown command was invoked by these checks. Root/server agents independently passed a real .NET 10 agent/API integration in 5.1 seconds: 300,000 UTF-8 stdout bytes including emoji, stderr, 67 chunks, exact pagination/full download, and no redispatch.

## Release artifact

`artifacts/library-rmm-agent-0.1.0-win-x64.zip`

SHA256 for the current .NET 10 build: `5af229d0288addd4a8380fd475647e53c2dcc504b8da4939a4d6211ac17721bb`.

The adjacent `.sha256` is authoritative if the package is rebuilt. Build staging directories are retained for inspection and ignored by Git. Package does not require an installed .NET runtime. Installer has not been run against a real endpoint yet; a disposable Windows VM service install/update/uninstall smoke test remains required before fleet rollout. Packages are unsigned; signed MSI/EXE/Authenticode releases and Action1 software deployment are follow-up work.

## Integration notes and limits

- API contract is `docs/API.md`. Server confirmed new output must arrive contiguously from sequence 0; agent does so. Matching duplicate chunks/completions are retried safely.
- Server accepts `interrupted` completion for dispatched or running jobs, covering a lost start response. Terminal outcome conflicts are retained in `spool/conflict-*` and never cause execution.
- Reboot job completion means **Windows accepted a scheduled reboot**, not that a later boot was verified. Minimum delay is 30 seconds. Start authorization precedes scheduling. The agent tries to deliver results during the delay, but a server outage can postpone delivery until reconnect. Reboot jobs are never replayed.
- Full text retention covers text actually emitted by the process. PowerShell custom formatting can shorten objects before emission; use `Format-List *` or `ConvertTo-Json` to expose every field. Native encodings and stdout/stderr observation order have the usual process-stream limitations.
- Local administrators/SYSTEM can read the protected bearer config and script spool. Those principals are trusted endpoint administrators; do not share their access with untrusted users.
- Output has no silent local byte limit; a full disk is an explicit job failure. Production deployment needs disk monitoring/backups/retention planning. Do not automatically clear undelivered spool files.
- This first release uses process-tree termination. Scripts can deliberately detach child processes or schedule their own actions; those script side effects are outside an exactly-once guarantee. Never claim universal exactly-once execution.
- Screen assistance remains deferred to a separately designed consented desktop companion with a visible indicator.
