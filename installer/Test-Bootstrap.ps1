#requires -Version 5.1
# Pure download/verification smoke tests: no service/enrollment/administrator changes.
$ErrorActionPreference = 'Stop'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('LibraryRmm-Bootstrap-Test-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $fixture 'source'
New-Item -ItemType Directory -Path (Join-Path $source 'agent') -Force | Out-Null
$sentinel = Join-Path $fixture 'INSTALL-MUST-NOT-RUN'
Set-Content -LiteralPath (Join-Path $source 'Install-Agent.ps1') -Value ("Set-Content -LiteralPath '" + $sentinel.Replace("'", "''") + "' -Value 'unexpected'")
Set-Content -LiteralPath (Join-Path $source 'agent\LibraryRmm.Agent.exe') -Value 'test fixture, never execute'
$global:LibraryRmmBootstrapTestState = @{ archive = (Join-Path $fixture 'fixture.zip'); badHash = $false; badUrl = $false; downloadCount = 0; lastDownload = $null }
Compress-Archive -Path (Join-Path $source '*') -DestinationPath $global:LibraryRmmBootstrapTestState.archive
$global:LibraryRmmBootstrapTestState.hash = (Get-FileHash -LiteralPath $global:LibraryRmmBootstrapTestState.archive -Algorithm SHA256).Hash.ToLowerInvariant()
function Invoke-RestMethod {
    param($Uri, $TimeoutSec)
    return [pscustomobject]@{ version = '0.1.0'; runtime = 'win-x64'; sha256 = $(if ($global:LibraryRmmBootstrapTestState.badHash) { '0' * 64 } else { $global:LibraryRmmBootstrapTestState.hash }); downloadUrl = $(if ($global:LibraryRmmBootstrapTestState.badUrl) { 'https://attacker.invalid/payload.zip' } else { '/downloads/library-rmm-agent-win-x64.zip' }) }
}
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec, [switch]$UseBasicParsing)
    $global:LibraryRmmBootstrapTestState.downloadCount++
    $global:LibraryRmmBootstrapTestState.lastDownload = $OutFile
    Copy-Item -LiteralPath $global:LibraryRmmBootstrapTestState.archive -Destination $OutFile
}
$bootstrap = Join-Path $PSScriptRoot 'Bootstrap-Agent.ps1'
& $bootstrap -ServerUrl 'https://rmm.parkcountylibrary.org' -DownloadOnly
if (Test-Path -LiteralPath $sentinel) { throw 'DownloadOnly executed the installer.' }
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $global:LibraryRmmBootstrapTestState.lastDownload -Parent) 'package\Install-Agent.ps1'))) { throw 'Valid package was not extracted.' }
$global:LibraryRmmBootstrapTestState.badHash = $true
$rejected = $false
try { & $bootstrap -ServerUrl 'https://rmm.parkcountylibrary.org' -DownloadOnly } catch { $rejected = $_.Exception.Message -like '*SHA256 verification failed*' }
if (-not $rejected -or (Test-Path -LiteralPath (Join-Path (Split-Path $global:LibraryRmmBootstrapTestState.lastDownload -Parent) 'package'))) { throw 'Corrupt archive was not refused before extraction.' }
$global:LibraryRmmBootstrapTestState.badHash = $false
$global:LibraryRmmBootstrapTestState.badUrl = $true
$before = $global:LibraryRmmBootstrapTestState.downloadCount
$rejected = $false
try { & $bootstrap -ServerUrl 'https://rmm.parkcountylibrary.org' -DownloadOnly } catch { $rejected = $_.Exception.Message -like '*invalid agent package manifest*' }
if (-not $rejected -or $global:LibraryRmmBootstrapTestState.downloadCount -ne $before) { throw 'Unexpected download origin was not rejected.' }
Write-Host 'PASS bootstrap: verified download/extraction, download-only never installs, bad hash refused, foreign download URL refused.'
$global:LibraryRmmBootstrapTestState.badUrl = $false

# Real process-tree detection: a PowerShell started by a process image named
# LibraryRmm.Agent.exe must be recognised; an ordinary PowerShell must not. No admin needed.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($bootstrap, [ref]$tokens, [ref]$errors)
$detector = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-StartedByRmmAgent' }, $true)
if (-not $detector) { throw 'Test-StartedByRmmAgent was not found in the bootstrap.' }
$probe = Join-Path $fixture 'probe.ps1'
Set-Content -LiteralPath $probe -Value ($detector.Extent.Text + "`nif (Test-StartedByRmmAgent) { 'AGENT' } else { 'PLAIN' }")
$nativePowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$fakeAgent = Join-Path $fixture 'LibraryRmm.Agent.exe'
Copy-Item -LiteralPath $nativePowerShell -Destination $fakeAgent
$quotedProbe = "'" + $probe.Replace("'", "''") + "'"
$underAgent = & $fakeAgent -NoProfile -NonInteractive -Command ("& '" + $nativePowerShell + "' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + $quotedProbe)
$plain = & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $probe
if (($underAgent | Select-Object -Last 1) -ne 'AGENT') { throw ('Child of LibraryRmm.Agent.exe was not detected: ' + ($underAgent -join ' ')) }
if (($plain | Select-Object -Last 1) -ne 'PLAIN') { throw ('Ordinary PowerShell was misdetected as an RMM job: ' + ($plain -join ' ')) }
Write-Host 'PASS bootstrap: RMM agent ancestry detected through a real process tree; ordinary PowerShell is not.'

# Handoff path: needs Administrator (CI runners are elevated). Task registration is mocked so
# no task is created and nothing is installed.
$principalCheck = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if ($principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $global:LibraryRmmBootstrapTestState.registered = $null
    $global:LibraryRmmBootstrapTestState.started = $null
    $now = Get-Date
    function Get-CimInstance {
        param($ClassName, $Filter)
        if ($Filter -eq ('ProcessId=' + $PID)) { return [pscustomobject]@{ Name = 'powershell.exe'; ParentProcessId = 999991; CreationDate = $now } }
        if ($Filter -eq 'ProcessId=999991') { return [pscustomobject]@{ Name = 'LibraryRmm.Agent.exe'; ParentProcessId = 700; CreationDate = $now.AddMinutes(-5) } }
        return $null
    }
    function Register-ScheduledTask { param($TaskName, $Action, $Principal, $Settings, $Description) $global:LibraryRmmBootstrapTestState.registered = @{ name = $TaskName; action = $Action; principal = $Principal } }
    function Start-ScheduledTask { param($TaskName) $global:LibraryRmmBootstrapTestState.started = $TaskName }
    $before = $global:LibraryRmmBootstrapTestState.downloadCount
    $output = & $bootstrap -ServerUrl 'https://rmm.parkcountylibrary.org' 6>&1 | Out-String
    $registered = $global:LibraryRmmBootstrapTestState.registered
    Remove-Item Function:\Get-CimInstance, Function:\Register-ScheduledTask, Function:\Start-ScheduledTask
    if (-not $registered) { throw 'Bootstrap under the agent did not hand off to a scheduled task.' }
    if ($global:LibraryRmmBootstrapTestState.started -ne $registered.name) { throw 'Handoff task was registered but not started.' }
    if (Test-Path -LiteralPath $sentinel) { throw 'Bootstrap ran the installer inside the RMM job.' }
    if ($global:LibraryRmmBootstrapTestState.downloadCount -ne $before) { throw 'Bootstrap downloaded inside the RMM job instead of in the detached task.' }
    $taskUser = [string]$registered.principal.UserId
    $taskSid = if ($taskUser -match '^S-1-') { $taskUser } else { (New-Object Security.Principal.NTAccount($taskUser)).Translate([Security.Principal.SecurityIdentifier]).Value }
    if ($taskSid -ne 'S-1-5-18' -or [string]$registered.principal.LogonType -ne 'ServiceAccount') { throw ('Handoff task does not run as SYSTEM: ' + $taskUser + ' / ' + $registered.principal.LogonType) }
    $encoded = ($registered.action.Arguments -split ' ')[-1]
    $command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
    if ($command -notmatch [regex]::Escape("-HandoffTaskName '" + $registered.name + "'") -or $command -notmatch 'Unregister-ScheduledTask' -or $command -notmatch "Start-Service -Name 'LibraryRmmAgent'") {
        throw 'Handoff command is missing its task name, self-removal or service restart safeguard.'
    }
    $copied = [regex]::Match($command, "& '([^']+Install-LibraryRmm\.ps1)'").Groups[1].Value
    if (-not $copied -or (Get-FileHash -LiteralPath $copied).Hash -ne (Get-FileHash -LiteralPath $bootstrap).Hash) { throw 'Handoff did not run an exact copy of this bootstrap.' }
    $handoffAcl = Get-Acl -LiteralPath (Split-Path $copied -Parent)
    if (-not $handoffAcl.AreAccessRulesProtected -or ($handoffAcl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18', 'S-1-5-32-544') })) {
        throw 'Handoff folder is writable by accounts other than SYSTEM and Administrators.'
    }
    if ($output -notmatch 'scheduled task outside the agent') { throw 'Handoff did not explain what happened in the job output.' }
    Remove-Item -LiteralPath (Split-Path $copied -Parent) -Recurse -Force
    Write-Host 'PASS bootstrap: under the agent it copies itself to a SYSTEM/Admin-only folder, hands off to a one-time SYSTEM task, and never installs inside the job.'
} else {
    Write-Host 'SKIP bootstrap handoff test: requires an elevated PowerShell (runs in CI).'
}
Write-Host ('Isolated fixture retained for inspection: ' + $fixture)
