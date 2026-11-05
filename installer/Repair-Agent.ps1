#requires -Version 5.1
<#
.SYNOPSIS
Brings a stopped Library RMM agent back online. Run as Administrator/SYSTEM OUTSIDE the RMM,
for example with Action1 "Run script" or an elevated PowerShell on the computer.
.DESCRIPTION
1. Agent service already running: nothing is changed.
2. Agent service stopped: start it. Every agent from 0.1.1 on checks for a newer published
   version at startup and updates itself, so this alone also brings the computer current.
3. Service cannot start (missing or damaged files): download the verified installer from the
   RMM server and reinstall. The existing enrollment, endpoint ID and history are preserved.
Computers with no agent service are left alone. This script never reboots Windows and never
re-runs or requeues RMM commands.
#>
[CmdletBinding()]
param([uri]$ServerUrl = 'https://rmm.parkcountylibrary.org')
$ErrorActionPreference = 'Stop'
$serviceName = 'LibraryRmmAgent'
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if (-not $service) {
    Write-Host ($env:COMPUTERNAME + ': the Library RMM agent is not installed here. Nothing was changed.')
    exit 0
}
if ($service.Status -eq 'Running') {
    Write-Host ($env:COMPUTERNAME + ': the agent service is already running. Nothing was changed.')
    exit 0
}
Write-Host ($env:COMPUTERNAME + ': the agent service is ' + $service.Status + '; starting it.')
try {
    if ($service.Status -ne 'Stopped') { $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
    Start-Service -Name $serviceName
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    Write-Host ($env:COMPUTERNAME + ': the agent service is running again. It updates itself to the published version within a few minutes.')
    exit 0
} catch {
    Write-Host ($env:COMPUTERNAME + ': the service did not start (' + $_.Exception.Message + '). Reinstalling from the RMM server; enrollment is preserved.')
}
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$installer = Join-Path ([IO.Path]::GetTempPath()) ('Install-LibraryRmm-' + [guid]::NewGuid().ToString('N') + '.ps1')
Invoke-WebRequest -UseBasicParsing -Uri ($ServerUrl.GetLeftPart([UriPartial]::Authority) + '/install.ps1') -OutFile $installer -TimeoutSec 60
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File $installer
if ($LASTEXITCODE -ne 0) { throw ($env:COMPUTERNAME + ': reinstall failed with exit code ' + $LASTEXITCODE + '.') }
Write-Host ($env:COMPUTERNAME + ': reinstalled and running.')
