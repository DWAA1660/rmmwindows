#requires -Version 5.1
[CmdletBinding()]
param(
    # Defaults to <Version> in agent/LibraryRmm.Agent.csproj so packages and binaries never drift.
    [string]$Version = '',
    [ValidateSet('win-x64', 'win-arm64')][string]$Runtime = 'win-x64',
    [string]$DotnetPath = 'dotnet',
    [string]$OutputDirectory = ''
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 does not populate $PSScriptRoot inside param() defaults.
if (-not $OutputDirectory) { $OutputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts' }
if (-not $Version) {
    $projectXml = [xml](Get-Content -Raw -LiteralPath (Join-Path (Split-Path $PSScriptRoot -Parent) 'agent\LibraryRmm.Agent.csproj'))
    $Version = $projectXml.Project.PropertyGroup.Version | Where-Object { $_ } | Select-Object -First 1
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][A-Za-z0-9.-]+)?$') { throw 'Version must be a semantic version without path characters.' }
$sdkVersion = & $DotnetPath --version
if ($LASTEXITCODE -ne 0 -or $sdkVersion -notmatch '^10\.') { throw 'Building the agent requires the supported .NET 10 SDK. Use -DotnetPath to select it.' }
$repository = Split-Path $PSScriptRoot -Parent
$project = Join-Path $repository 'agent\LibraryRmm.Agent.csproj'
$absoluteOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -Path $absoluteOutput -ItemType Directory -Force | Out-Null
# Unique staging avoids deleting or mixing any previous build. The release zip is the installer.
$stage = Join-Path $absoluteOutput ('package-' + [guid]::NewGuid().ToString('N'))
$binaries = Join-Path $stage 'agent'
New-Item -Path $binaries -ItemType Directory -Force | Out-Null
& $DotnetPath publish $project --configuration Release --runtime $Runtime --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:Version=$Version --output $binaries
if ($LASTEXITCODE -ne 0) { throw 'Agent publish failed.' }
$companionBinaries = Join-Path $binaries 'companion'
& $DotnetPath publish (Join-Path $repository 'companion\LibraryRmm.Support.csproj') --configuration Release --runtime $Runtime --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:Version=$Version --output $companionBinaries
if ($LASTEXITCODE -ne 0) { throw 'Support companion publish failed.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Install-Agent.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-Agent.ps1') -Destination $stage
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination $stage
$agentHash = (Get-FileHash -LiteralPath (Join-Path $binaries 'LibraryRmm.Agent.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$companionHash = (Get-FileHash -LiteralPath (Join-Path $companionBinaries 'LibraryRmm.Support.exe') -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = @{ version = $Version; runtime = $Runtime; agentSha256 = $agentHash; companionSha256 = $companionHash; builtAtUtc = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'package-manifest.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
$archive = Join-Path $absoluteOutput ("library-rmm-agent-$Version-$Runtime.zip")
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($archive + '.sha256'), ($archiveHash + '  ' + [IO.Path]::GetFileName($archive) + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))
Write-Host "Release package: $archive"
Write-Host "SHA256: $archiveHash"
Write-Host "Staging retained for inspection: $stage"
