# Windows agent installer

## Install directly from the RMM website

Open **Add endpoints** in the console, create an enrollment token, and copy the install command. On the endpoint, open **Windows PowerShell as administrator** and run:

```powershell
$installer = Join-Path $env:TEMP 'Install-LibraryRmm.ps1'
Invoke-WebRequest -UseBasicParsing 'https://rmm.parkcountylibrary.org/install.ps1' -OutFile $installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
```

The bootstrap downloads the agent from this server, checks its SHA256 before extraction, then starts the installer and securely prompts for a token. Nothing needs to be downloaded from private GitHub on the endpoint. Re-running it upgrades an existing installation while preserving enrollment. Do not put tokens into download URLs or a shared script.

Direct ZIP: `https://rmm.parkcountylibrary.org/downloads/library-rmm-agent-win-x64.zip`. The website currently hosts x64 only. The Docker build cross-publishes the current agent and bundles its installer package with the web app, so future source updates keep downloads synchronized. Setup files remain in a uniquely named local temporary folder for inspection.

To check download/checksum/extraction without enrollment, services or administrator changes:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer -DownloadOnly
```

## Install from an extracted release ZIP

Extract the release zip into a local folder. In an **administrator Windows PowerShell** window:

```powershell
.\Install-Agent.ps1 -ServerUrl 'https://rmm.parkcountylibrary.org'
```

The installer prompts securely for an enrollment token created in the web console. To pass a token without putting it in the command line/history:

```powershell
$enrollment = Read-Host 'Enrollment token' -AsSecureString
.\Install-Agent.ps1 -EnrollmentToken $enrollment
```

The package is self-contained; endpoints do not need the .NET SDK/runtime. Supported target: Windows 10/11 and Windows Server with Windows PowerShell 5.1, administrator access, and outbound HTTPS to the server. The initial release is win-x64; build win-arm64 explicitly if needed. Keep the agent directory, scripts, README, and package manifest together. The manifest checks package integrity, not publisher identity; signed release binaries remain future work.

The visible **Library RMM Agent** service runs as LocalSystem. Authenticated IT administrators can run noninteractive administrative PowerShell jobs, refresh inventory, inspect storage sizes, and request a reboot. Jobs are fresh processes, not a persistent interactive shell. The agent does not listen on a network port or capture screens. Screen assistance requires a future visible, consented per-user companion.

Files are installed under `%ProgramFiles%\LibraryRmm`; credentials and output delivery journals under `%ProgramData%\LibraryRmm`. Both dedicated directories allow only SYSTEM and local administrators. Custom destinations must be absolute local paths ending in `LibraryRmm`, outside Windows and user profile trees. Existing nonempty directories are accepted only when marked by this installer with the correct ownership role; unrelated directories are refused before any permissions are changed. Machine administrators can read credentials by design; treat those accounts as trusted. Initial full inventory and periodic refresh run through CIM and read-only uninstall registry keys. Full inventory defaults to every 15 minutes; online heartbeat every 30 seconds; polling every 10 seconds. `-InventoryMinutes` and `-PollSeconds` configure new installations. Current metrics are inventory snapshots, not continuous sampling. Per-user software is included for loaded profiles only; Store/MSIX package inventory is not yet collected.

Re-run the installer from a newer extracted package to update the service while preserving its endpoint identity. Existing config intervals remain unchanged; edit the protected `agent.json` and restart the service to change them. The installer never reboots. Windows service recovery restarts only the agent process and never repeats endpoint commands.

```powershell
.\Uninstall-Agent.ps1
# Retains enrollment and pending output for reinstall.

.\Uninstall-Agent.ps1 -RemoveEnrollment
# Permanently removes local enrollment and pending output as well.
```

Revoke the endpoint in the console after decommissioning. The uninstall script automatically cleans only dedicated directories named `LibraryRmm` with the expected ownership markers. Unrelated existing directories are refused.

## Output and interruption behavior

Output is delivered in ordered, UTF-8 chunks and retained on disk until the server acknowledges the output and final result. Long lines and Unicode are preserved; stdout/stderr are separate streams and their interleaving reflects observation order. A server outage retries delivery, never the command. Restarting/rolling back the endpoint marks uncompleted local jobs interrupted. A lost authorization response also leaves the job interrupted: explicitly create a new job only after inspecting the endpoint. This prevents reboot/script loops when restore software rolls back local state.

PowerShell is configured for UTF-8 and a wide formatting width. The transport does not truncate output, but a command's own `Format-Table` or custom formatting may shorten objects before text is emitted. Prefer `Format-List *`, `ConvertTo-Json -Depth 10`, or explicit string output when you need every field. If output cannot be written to the protected local spool, the command fails rather than silently dropping output. A descendant retaining inherited pipes after the command ends is reported as interrupted with potentially incomplete output.

Reboot results mean Windows **accepted a scheduled reboot**, not that the endpoint subsequently booted. The minimum delay is 30 seconds, allowing delivery of the result before the reboot. Windows may display the normal reboot notification. No job is automatically reissued when the endpoint reconnects.

Storage exploration lists one directory level with recursive logical sizes, an entry/time/depth budget, explicit partial/error flags, and no file-content reads. UNC paths, device paths, and directory reparse points/junctions are rejected/skipped. Hard links may be counted more than once. An inaccessible or bounded scan is approximate, not an accounting of physical allocated storage.

## Building and checks

From the repository root with the supported .NET SDK 10 LTS on Windows:

```powershell
dotnet build agent/LibraryRmm.Agent.csproj --configuration Release
dotnet run --project agent/LibraryRmm.Agent.csproj --configuration Release -- --self-test
.\installer\Build-Agent.ps1
.\installer\Test-InstallerPaths.ps1
```

For a checkout-local SDK, pass `-DotnetPath '.\artifacts\dotnet-sdk\dotnet.exe'` to the build script. The self-contained agent bundles .NET 10, so endpoints do not need a separate runtime installation. Self-tests exercise long output, Unicode, stderr, timeouts, recovery delivery, authorization gating and path restrictions. The installer validation check extracts the actual validation functions and tests rejection of system/profile roots and unrelated existing folders without changing ACLs. These checks do not install the service, enroll an endpoint, or run shutdown. Releases are created under `artifacts/` with SHA256 checksums. Authenticode signing and a signed MSI/EXE installer are pending. Action1 deployment integration is deferred.
