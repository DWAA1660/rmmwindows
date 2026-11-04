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
Write-Host ('Isolated fixture retained for inspection: ' + $fixture)
