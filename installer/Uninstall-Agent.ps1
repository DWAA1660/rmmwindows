#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'LibraryRmm'),
    [string]$DataDirectory = (Join-Path $env:ProgramData 'LibraryRmm'),
    [switch]$RemoveEnrollment
)
$ErrorActionPreference = 'Stop'
$serviceName = 'LibraryRmmAgent'
$absoluteInstall = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
$absoluteData = [IO.Path]::GetFullPath($DataDirectory).TrimEnd('\')
# Verify all recursive deletion targets are explicit, local, non-root directories. Reparse
# points are rejected so cleanup cannot follow a junction into unrelated user/system files.
foreach ($target in @($absoluteInstall, $absoluteData)) {
    if ($target -notmatch '^[A-Za-z]:\\.+' -or $target.StartsWith('\\') -or
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
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($existing) {
    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    $expectedExe = Join-Path $absoluteInstall 'LibraryRmm.Agent.exe'
    if ($serviceInfo.PathName -notlike ('"' + $expectedExe + '"*')) { throw 'Service path does not match the requested installation directory.' }
    Stop-Service -Name $serviceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    & sc.exe delete $serviceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to remove the Windows service.' }
}
if (Test-Path -LiteralPath $absoluteInstall) { Remove-Item -LiteralPath $absoluteInstall -Recurse -Force }
if ($RemoveEnrollment -and (Test-Path -LiteralPath $absoluteData)) { Remove-Item -LiteralPath $absoluteData -Recurse -Force }
Write-Host 'Library RMM service and binaries removed.'
if (-not $RemoveEnrollment) { Write-Host 'Enrollment identity and pending output were retained for a future reinstall.' }
Write-Host 'Revoke this endpoint in the RMM console if it should no longer be allowed to connect.'
