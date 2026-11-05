#requires -Version 5.1
<# Downloads the agent from this RMM server, verifies SHA256, then runs its installer.
   No enrollment secret is embedded in this public script or sent in a URL. #>
[CmdletBinding()]
param(
    [uri]$ServerUrl = '__SERVER_ORIGIN__',
    [Security.SecureString]$EnrollmentToken,
    [switch]$DownloadOnly,
    # Use an enrollment token instead of approving the computer in the console.
    [switch]$PromptForToken,
    # Internal: set only by the one-time scheduled task this script creates for itself when it
    # was started by an RMM job. Never pass it by hand.
    [string]$HandoffTaskName
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($ServerUrl.Scheme -ne 'https' -or $ServerUrl.UserInfo -or $ServerUrl.Query -or $ServerUrl.Fragment -or $ServerUrl.AbsolutePath -ne '/') {
    throw 'ServerUrl must be an HTTPS origin without a path or credentials.'
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This download supports Windows x64. An ARM64 package is not currently hosted.'
}
# Deployment tools such as Action1 "Run script" may start 32-bit PowerShell. Under WOW64,
# Program Files and the registry are redirected, so relaunch in native 64-bit PowerShell.
if (-not [Environment]::Is64BitProcess -and $env:PROCESSOR_ARCHITEW6432 -eq 'AMD64') {
    if ($EnrollmentToken) { throw 'Run from 64-bit PowerShell to pass -EnrollmentToken.' }
    $native = Join-Path $env:WINDIR 'sysnative\WindowsPowerShell\v1.0\powershell.exe'
    $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-ServerUrl', $ServerUrl.AbsoluteUri.TrimEnd('/'))
    if ($DownloadOnly) { $relaunch += '-DownloadOnly' }
    if ($PromptForToken) { $relaunch += '-PromptForToken' }
    Write-Host 'Started in 32-bit PowerShell; continuing in 64-bit PowerShell.'
    & $native @relaunch
    exit $LASTEXITCODE
}
Write-Host ('Library RMM setup running as ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name + ' (64-bit PowerShell ' + $PSVersionTable.PSVersion + ').')
if (-not $DownloadOnly) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open Windows PowerShell as administrator, then run this install command again.'
    }
}
$origin = $ServerUrl.GetLeftPart([UriPartial]::Authority)

# Returns $true when any ancestor of this PowerShell process is the Library RMM agent. That
# happens when this script runs as an RMM job or terminal command. The installer stops the
# agent service, and stopping the service ends the job's whole process tree, which would kill
# this script before it restarts the service and leave the computer offline.
function Test-StartedByRmmAgent {
    $seen = @{}
    $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID)
    for ($depth = 0; $current -and $depth -lt 16; $depth++) {
        $parentId = [int]$current.ParentProcessId
        if ($parentId -le 4 -or $seen.ContainsKey($parentId)) { return $false }
        $seen[$parentId] = $true
        $parent = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $parentId)
        # A reused PID belongs to a process created after its "child"; stop walking there.
        if (-not $parent -or ($parent.CreationDate -and $current.CreationDate -and $parent.CreationDate -gt $current.CreationDate)) { return $false }
        if ($parent.Name -ieq 'LibraryRmm.Agent.exe') { return $true }
        $current = $parent
    }
    return $false
}

if ($HandoffTaskName) {
    # Running from the scheduled task, outside the agent's process tree. Wait briefly so the
    # RMM job that created the task can report completion before the installer stops the
    # agent service. The task has no trigger and deletes itself when this run ends.
    Write-Host ('Detached update task ' + $HandoffTaskName + ' started.')
    Start-Sleep -Seconds 20
} elseif (-not $DownloadOnly -and (Test-StartedByRmmAgent)) {
    if ($EnrollmentToken) { throw 'An enrollment token cannot be passed through an RMM job. Run this as a normal administrator command instead.' }
    # Copy this exact script into a new SYSTEM/Administrators-only folder so no standard user
    # can alter what the SYSTEM task runs.
    $handoffId = [guid]::NewGuid().ToString('N')
    $handoffDirectory = Join-Path $env:SystemRoot ('Temp\LibraryRmm-Update-' + $handoffId)
    New-Item -Path $handoffDirectory -ItemType Directory -ErrorAction Stop | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @('S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $handoffDirectory -AclObject $acl
    $handoffScript = Join-Path $handoffDirectory 'Install-LibraryRmm.ps1'
    Copy-Item -LiteralPath $PSCommandPath -Destination $handoffScript
    $taskName = 'LibraryRmm-Update-' + $handoffId
    $log = Join-Path $handoffDirectory 'update.log'
    $powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # The transcript keeps a local record of the detached run for troubleshooting.
    $command = "Start-Transcript -LiteralPath '" + $log.Replace("'", "''") + "' | Out-Null; try { & '" + $handoffScript.Replace("'", "''") + "' -ServerUrl '" + $origin.Replace("'", "''") + "' -HandoffTaskName '" + $taskName + "'; `$code = 0 } catch { Write-Host ('Update failed: ' + `$_.Exception.Message); `$code = 1 } finally { try { `$s = Get-Service -Name 'LibraryRmmAgent' -ErrorAction SilentlyContinue; if (`$s -and `$s.Status -ne 'Running') { Start-Service -Name 'LibraryRmmAgent' -ErrorAction SilentlyContinue } } catch { }; try { Unregister-ScheduledTask -TaskName '" + $taskName + "' -Confirm:`$false -ErrorAction Stop } catch { }; Stop-Transcript | Out-Null }; exit `$code"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action = New-ScheduledTaskAction -Execute $powershellExe -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $encoded)
    $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Description 'One-time Library RMM agent update started from the RMM console. Removes itself when it starts.' | Out-Null
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'Started from an RMM job, so the update now continues in a one-time Windows scheduled task outside the agent.'
    Write-Host 'In about 20 seconds the agent service restarts with the new version; this computer reconnects within about a minute.'
    Write-Host ('Local update log: ' + $log)
    exit 0
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$metadata = Invoke-RestMethod -Uri ($origin + '/api/agent-download') -TimeoutSec 30
if ($metadata.runtime -ne 'win-x64' -or $metadata.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
    $metadata.downloadUrl -ne '/downloads/library-rmm-agent-win-x64.zip') {
    throw 'The server returned an invalid agent package manifest. Nothing was installed.'
}
# A unique directory avoids replacing existing files; keep verified setup files for review.
$stage = Join-Path ([IO.Path]::GetTempPath()) ('LibraryRmm-Setup-' + [guid]::NewGuid().ToString('N'))
New-Item -Path $stage -ItemType Directory -ErrorAction Stop | Out-Null
$archive = Join-Path $stage 'agent.zip'
$package = Join-Path $stage 'package'
Write-Host ('Downloading Library RMM Agent ' + $metadata.version + ' (Windows x64)...')
Invoke-WebRequest -UseBasicParsing -Uri ($origin + $metadata.downloadUrl) -OutFile $archive -TimeoutSec 300
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $metadata.sha256.ToLowerInvariant()) {
    throw 'Agent package SHA256 verification failed. Nothing was extracted or installed. Retry the download if the server was updated during transfer.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $package
$installer = Join-Path $package 'Install-Agent.ps1'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $package 'agent\LibraryRmm.Agent.exe') -PathType Leaf)) {
    throw 'The verified archive is missing installer files. Nothing was installed.'
}
Write-Host ('SHA256 verified. Setup files: ' + $package)
if ($DownloadOnly) {
    Write-Host 'Download-only check complete. No enrollment, service installation, or reboot was performed.'
    return
}
$parameters = @{ ServerUrl = $origin }
if ($EnrollmentToken) { $parameters.EnrollmentToken = $EnrollmentToken }
if ($PromptForToken) { $parameters.PromptForToken = $true }
# By default a new computer requests to join and waits for approval in the console;
# upgrades keep their existing identity.
& $installer @parameters
