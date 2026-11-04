#requires -Version 5.1
<# Downloads the agent from this RMM server, verifies SHA256, then runs its installer.
   No enrollment secret is embedded in this public script or sent in a URL. #>
[CmdletBinding()]
param(
    [uri]$ServerUrl = '__SERVER_ORIGIN__',
    [Security.SecureString]$EnrollmentToken,
    [switch]$DownloadOnly,
    # Use an enrollment token instead of approving the computer in the console.
    [switch]$PromptForToken
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
if ($ServerUrl.Scheme -ne 'https' -or $ServerUrl.UserInfo -or $ServerUrl.Query -or $ServerUrl.Fragment -or $ServerUrl.AbsolutePath -ne '/') {
    throw 'ServerUrl must be an HTTPS origin without a path or credentials.'
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'This download supports Windows x64. An ARM64 package is not currently hosted.'
}
if (-not $DownloadOnly) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Open Windows PowerShell as administrator, then run this install command again.'
    }
}
$origin = $ServerUrl.GetLeftPart([UriPartial]::Authority)
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
