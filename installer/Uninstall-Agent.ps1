#requires -Version 5.1
<##
.SYNOPSIS
Removes the Library RMM Agent. Also used by Control Panel > Programs and Features and
Settings > Apps, which run the copy installed in the agent's install directory.
.DESCRIPTION
Stops and deletes only the LibraryRmmAgent service, removes the agent's own directories
(verified by ownership markers, never through junctions) and its Programs and Features entry.
With -RemoveEnrollment it also deletes the enrollment data and first asks the server to retire
this endpoint so the console shows it as revoked. Never reboots.
##>
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'LibraryRmm'),
    [string]$DataDirectory = (Join-Path $env:ProgramData 'LibraryRmm'),
    [switch]$RemoveEnrollment,
    # Used by QuietUninstallString: no pause at the end.
    [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
$serviceName = 'LibraryRmmAgent'
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LibraryRmmAgent'

# Programs and Features may start this unelevated; relaunch elevated (UAC prompt) if needed.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'),
        '-InstallDirectory', ('"' + $InstallDirectory + '"'), '-DataDirectory', ('"' + $DataDirectory + '"'))
    if ($RemoveEnrollment) { $arguments += '-RemoveEnrollment' }
    if ($Quiet) { $arguments += '-Quiet' }
    try { Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs | Out-Null }
    catch { Write-Host 'Administrator approval is required to uninstall Library RMM Agent.'; if (-not $Quiet) { Start-Sleep -Seconds 5 }; exit 1 }
    exit 0
}

try {
    $absoluteInstall = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
    $absoluteData = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\')
    # Verify all recursive deletion targets are explicit, local, non-root directories. Reparse
    # points are rejected so cleanup cannot follow a junction into unrelated user/system files.
    foreach ($target in @($absoluteInstall, $absoluteData)) {
        if ($target -notmatch '^[A-Za-z]:\.+' -or $target.StartsWith('\') -or
            [IO.Path]::GetFileName($target) -ne 'LibraryRmm') {
            throw 'Automatic uninstall cleanup requires explicitly resolved directories named LibraryRmm below a local drive root.'
        }
        $current = New-Object IO.DirectoryInfo($target)
        while ($current) {
            if ($current.Exists -and ($current.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Refusing cleanup through a reparse point.' }
            $current = $current.Parent
        }
    }
    foreach ($ownedTarget in @(@{ path = $absoluteInstall; role = 'install' }, @{ path = $absoluteData; role = 'data' })) {
        if (-not (Test-Path -LiteralPath $ownedTarget.path -PathType Container)) { continue }
        if (-not (Get-ChildItem -LiteralPath $ownedTarget.path -Force | Select-Object -First 1)) { continue }
        $markerPath = Join-Path $ownedTarget.path '.library-rmm-owned.json'
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'Refusing to remove a nonempty directory without a Library RMM ownership marker.' }
        $markerFile = Get-Item -LiteralPath $markerPath -Force
        if ($markerFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing an ownership marker reparse point.' }
        try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { throw 'Invalid Library RMM ownership marker.' }
        if ($marker.product -ne 'ParkCountyLibrary.LibraryRmm' -or $marker.directoryRole -ne $ownedTarget.role -or $marker.schemaVersion -ne 1) {
            throw 'Refusing to remove a directory owned by another product or installation role.'
        }
    }
    $expectedExe = Join-Path $absoluteInstall 'LibraryRmm.Agent.exe'
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing) {
        $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
        if ($serviceInfo.PathName -notlike ('"' + $expectedExe + '"*')) { throw 'Service path does not match the requested installation directory.' }
        if ($existing.Status -ne 'Stopped') {
            Stop-Service -Name $serviceName -Force
            $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
        }
        & sc.exe delete $serviceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Unable to remove the Windows service.' }
        $running = Get-Process -Name 'LibraryRmm.Agent' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $expectedExe }
        if ($running) { $running | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue }
    }
    $configPath = Join-Path $absoluteData 'agent.json'
    if ($RemoveEnrollment -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        # Best effort: mark this endpoint revoked in the console. Uninstall continues offline.
        try {
            $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
            $token = $config.PSObject.Properties['agentToken']
            if ($token -and $token.Value) {
                [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                Invoke-RestMethod -Method Post -Uri ($config.serverUrl.TrimEnd('/') + '/api/agent/retire') -Headers @{ Authorization = 'Bearer ' + $token.Value } `
                    -ContentType 'application/json' -Body '{}' -TimeoutSec 15 | Out-Null
                Write-Host 'The RMM console now shows this endpoint as revoked.'
            }
        } catch { Write-Host 'Could not reach the RMM server; revoke this endpoint in the console if it still appears.' }
    }
    if (Test-Path -LiteralPath $absoluteInstall) { Remove-Item -LiteralPath $absoluteInstall -Recurse -Force }
    if ($RemoveEnrollment -and (Test-Path -LiteralPath $absoluteData)) { Remove-Item -LiteralPath $absoluteData -Recurse -Force }
    if (Test-Path -LiteralPath $uninstallKey) { Remove-Item -LiteralPath $uninstallKey -Recurse -Force }
    Write-Host 'Library RMM Agent was uninstalled. No reboot is needed.'
    if (-not $RemoveEnrollment) {
        Write-Host 'Enrollment identity and pending output were retained for a future reinstall.'
        Write-Host 'Revoke this endpoint in the RMM console if it should no longer be allowed to connect.'
    }
    $exitCode = 0
} catch {
    Write-Host ('Uninstall failed: ' + $_.Exception.Message)
    $exitCode = 1
}
if (-not $Quiet) { Start-Sleep -Seconds 5 }
exit $exitCode
