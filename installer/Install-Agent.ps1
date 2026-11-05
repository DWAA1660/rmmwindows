#requires -Version 5.1
#requires -RunAsAdministrator
<##
.SYNOPSIS
Installs or updates the Library RMM LocalSystem service. Run from the extracted release zip.
.DESCRIPTION
Enrollment credentials are collected as SecureString and never printed. Existing enrollment is
preserved during updates. Only the dedicated LibraryRmm directories have ACLs restricted.
The service performs outbound HTTPS only. This installer does not reboot the computer.
##>
[CmdletBinding()]
param(
    [uri]$ServerUrl = 'https://rmm.parkcountylibrary.org',
    [Security.SecureString]$EnrollmentToken,
    [string]$BinaryDirectory = (Join-Path $PSScriptRoot 'agent'),
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'LibraryRmm'),
    [string]$DataDirectory = (Join-Path $env:ProgramData 'LibraryRmm'),
    [ValidateRange(5, 300)][int]$PollSeconds = 10,
    [ValidateRange(1, 1440)][int]$InventoryMinutes = 15,
    [switch]$AllowInsecureLocalhost,
    # Use the older enrollment-token flow instead of requesting approval in the console.
    [switch]$PromptForToken
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$serviceName = 'LibraryRmmAgent'

function Protect-Directory([string]$Path) {
    New-Item -Path $Path -ItemType Directory -Force | Out-Null
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sidValue in @('S-1-5-18', 'S-1-5-32-544')) {
        $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Only this non-secret executable subtree is readable by the interactive staff account.
# The service executable, agent.json and output spool retain their SYSTEM/Admin-only ACLs.
function Protect-CompanionDirectory([string]$Path) {
    Protect-Directory $Path
    $acl = Get-Acl -LiteralPath $Path
    $users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Assert-LocalDirectory([string]$Path) {
    if ($Path -notmatch '^[A-Za-z]:\\') { throw 'Install/data directories must be absolute local drive paths.' }
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($resolved -notmatch '^[A-Za-z]:\\.+' -or $resolved.StartsWith('\\') -or $resolved -match '[\r\n"]') {
        throw 'Install/data directories must be absolute local paths below a drive root.'
    }
    $resolved = $resolved.TrimEnd('\')
    if ([IO.Path]::GetFileName($resolved) -ne 'LibraryRmm') {
        throw 'Install/data directories must use a dedicated LibraryRmm leaf directory, never a shared system or profile root.'
    }
    $forbiddenTrees = @($env:SystemRoot, (Join-Path ([IO.Path]::GetPathRoot($env:SystemRoot)) 'Users'), [Environment]::GetFolderPath('UserProfile'))
    foreach ($forbiddenTree in $forbiddenTrees) {
        if (-not $forbiddenTree) { continue }
        $forbiddenRoot = [IO.Path]::GetFullPath($forbiddenTree).TrimEnd('\')
        if ($resolved.Equals($forbiddenRoot, [StringComparison]::OrdinalIgnoreCase) -or $resolved.StartsWith($forbiddenRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Install/data directories must not be inside Windows or user profile directories.'
        }
    }
    $candidate = New-Object IO.DirectoryInfo($resolved)
    while ($candidate) {
        if ($candidate.Exists -and ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Install/data directories must not traverse junctions or reparse points.'
        }
        $candidate = $candidate.Parent
    }
    return $resolved
}

function Assert-OwnedDirectory([string]$Path, [ValidateSet('install', 'data')][string]$Role) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { throw 'Install/data target is an existing file.' }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    # Avoid stopping an upstream PowerShell pipeline with Select-Object -First.
    # Enumeration is read-only and includes hidden ownership markers.
    $iterator = [IO.Directory]::EnumerateFileSystemEntries($Path).GetEnumerator()
    try { $hasEntries = $iterator.MoveNext() } finally { $iterator.Dispose() }
    if (-not $hasEntries) { return }
    $markerPath = Join-Path $Path '.library-rmm-owned.json'
    $valid = $false
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        $markerFile = Get-Item -LiteralPath $markerPath -Force
        if (-not ($markerFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            try {
                $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
                $valid = $marker.product -eq 'ParkCountyLibrary.LibraryRmm' -and $marker.directoryRole -eq $Role -and $marker.schemaVersion -eq 1
            } catch { $valid = $false }
        }
    }
    if (-not $valid) { throw 'Existing nonempty install/data directory is not marked as owned by Library RMM. No permissions or files were changed.' }
}

function Write-OwnershipMarker([string]$Path, [string]$Role) {
    $marker = @{ product = 'ParkCountyLibrary.LibraryRmm'; directoryRole = $Role; schemaVersion = 1 } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $Path '.library-rmm-owned.json'), $marker, (New-Object Text.UTF8Encoding($false)))
}

if ($ServerUrl.UserInfo -or $ServerUrl.Query -or $ServerUrl.Fragment -or $ServerUrl.AbsolutePath -ne '/') {
    throw 'ServerUrl must be an origin without credentials, query, or path.'
}
if ($ServerUrl.Scheme -ne 'https' -and -not ($AllowInsecureLocalhost -and $ServerUrl.IsLoopback -and $ServerUrl.Scheme -eq 'http')) {
    throw 'HTTPS is required. HTTP can only be explicitly enabled for a localhost test.'
}
$InstallDirectory = Assert-LocalDirectory $InstallDirectory
$DataDirectory = Assert-LocalDirectory $DataDirectory
if ($InstallDirectory -eq $DataDirectory -or $InstallDirectory.StartsWith($DataDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or $DataDirectory.StartsWith($InstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Install and data directories must be separate, non-nested paths.'
}
# Validate BOTH targets before any ACL or filesystem mutation. A typo must never change the
# permissions of Program Files, ProgramData, Windows, a profile, or an unrelated existing folder.
Assert-OwnedDirectory $InstallDirectory 'install'
Assert-OwnedDirectory $DataDirectory 'data'
$sourceExe = Join-Path $BinaryDirectory 'LibraryRmm.Agent.exe'
if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) { throw "Agent binary not found. Extract the release zip first: $sourceExe" }
$sourceCompanion = Join-Path $BinaryDirectory 'companion'
$targetCompanion = Join-Path $InstallDirectory 'companion'
# Validate every source/destination entry before stopping the service or copying. Never follow
# a pre-existing junction into another product's directory during an update.
foreach ($tree in @($sourceCompanion, $targetCompanion)) {
    if (Test-Path -LiteralPath $tree) {
        $pending = New-Object 'Collections.Generic.Queue[string]'
        $pending.Enqueue($tree)
        while ($pending.Count -gt 0) {
            $item = Get-Item -LiteralPath $pending.Dequeue() -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Support companion files cannot contain reparse points.' }
            if ($item.PSIsContainer) {
                foreach ($child in (Get-ChildItem -LiteralPath $item.FullName -Force)) { $pending.Enqueue($child.FullName) }
            }
        }
    }
}
$manifestPath = Join-Path $PSScriptRoot 'package-manifest.json'
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $actualHash = (Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($manifest.agentSha256 -ne $actualHash) { throw 'Agent SHA256 does not match this release package manifest.' }
    $companionHashProperty = $manifest.PSObject.Properties['companionSha256']
    if ($companionHashProperty) {
        $supportExe = Join-Path $sourceCompanion 'LibraryRmm.Support.exe'
        if (-not (Test-Path -LiteralPath $supportExe -PathType Leaf) -or
            (Get-FileHash -LiteralPath $supportExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $companionHashProperty.Value) {
            throw 'Support companion SHA256 does not match this release package manifest.'
        }
    }
}
Protect-Directory $InstallDirectory
Protect-Directory $DataDirectory
Write-Host 'Update checkpoint: installation directories validated and protected.'
Write-OwnershipMarker $InstallDirectory 'install'
Write-OwnershipMarker $DataDirectory 'data'
$configPath = Join-Path $DataDirectory 'agent.json'
$joinPending = $false
$serverOrigin = $ServerUrl.GetLeftPart([UriPartial]::Authority)
if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($config.serverUrl.TrimEnd('/') -ne $serverOrigin) { throw 'Existing enrollment points to another server. Uninstall with -RemoveEnrollment before changing servers.' }
    # StrictMode throws on missing properties; a join-pending config has no token yet.
    $field = { param($name) $property = $config.PSObject.Properties[$name]; if ($property) { [string]$property.Value } else { '' } }
    $enrolled = (& $field 'agentToken') -and (& $field 'endpointId')
    $joinPending = -not (& $field 'agentToken') -and (& $field 'joinSecret').Length -ge 32
    if (-not (& $field 'deviceId') -or -not ($enrolled -or $joinPending)) { throw 'Existing enrollment is incomplete; refusing to overwrite it.' }
    if ($joinPending) { Write-Host 'This computer is still waiting for approval in the console; its join request will be preserved.' }
    else { Write-Host 'Existing endpoint enrollment will be preserved.' }
} elseif (-not $EnrollmentToken -and -not $PromptForToken) {
    # Default: no token. The service asks the server to join and waits for an operator to
    # approve this computer under Add endpoints. No credential exists until approval.
    $secretBytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($secretBytes) } finally { $generator.Dispose() }
    $config = [pscustomobject]@{
        serverUrl = $serverOrigin; deviceId = [guid]::NewGuid().ToString('D')
        joinSecret = [Convert]::ToBase64String($secretBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        pollSeconds = $PollSeconds; inventoryMinutes = $InventoryMinutes
        allowInsecureLocalhost = [bool]$AllowInsecureLocalhost
    }
    $temporary = $configPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $configPath
    $joinPending = $true
} else {
    if (-not $EnrollmentToken) { $EnrollmentToken = Read-Host 'Enrollment token from the RMM console' -AsSecureString }
    $pointer = [IntPtr]::Zero
    $plainToken = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($EnrollmentToken)
        $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $deviceId = [guid]::NewGuid().ToString('D')
        $body = @{ enrollmentToken = $plainToken; deviceId = $deviceId; hostname = $env:COMPUTERNAME } | ConvertTo-Json -Compress
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try {
            $enrollment = Invoke-RestMethod -Method Post -Uri ($serverOrigin + '/api/agent/enroll') -ContentType 'application/json' -Body $body -TimeoutSec 30
        } catch {
            throw 'Enrollment failed. Verify the server URL and a fresh, valid token. No service was installed; credentials were not logged.'
        }
        if (-not $enrollment.endpointId -or -not $enrollment.agentToken) { throw 'The enrollment response was incomplete. Create a new enrollment token and investigate the server before retrying.' }
        $config = [pscustomobject]@{
            serverUrl = $serverOrigin; deviceId = $deviceId
            endpointId = $enrollment.endpointId; agentToken = $enrollment.agentToken
            pollSeconds = $PollSeconds; inventoryMinutes = $InventoryMinutes
            allowInsecureLocalhost = [bool]$AllowInsecureLocalhost
        }
        # Write the returned identity immediately, before binary/service operations. If enrollment
        # succeeds but the connection is lost before this response, never guess/reuse credentials.
        $temporary = $configPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        $encoding = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($temporary, ($config | ConvertTo-Json -Compress), $encoding)
        Move-Item -LiteralPath $temporary -Destination $configPath
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $plainToken = $null; $body = $null; $enrollment = $null
    }
}
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$targetExe = Join-Path $InstallDirectory 'LibraryRmm.Agent.exe'
if ($existing) {
    Write-Host 'Update checkpoint: stopping the agent service.'
    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($serviceInfo.PathName -notlike ('"' + $targetExe + '"*')) { throw 'The service name is already used at another path. Refusing to replace it.' }
    Stop-Service -Name $serviceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    # SCM can report Stopped slightly before the process releases its executable image.
    $running = Get-Process -Name 'LibraryRmm.Agent' -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -eq $targetExe }
    if ($running) { $running | Wait-Process -Timeout 30 -ErrorAction SilentlyContinue }
}
Get-ChildItem -LiteralPath $BinaryDirectory -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDirectory $_.Name) -Force
}
Write-Host 'Update checkpoint: agent binaries copied.'
if (Test-Path -LiteralPath $sourceCompanion -PathType Container) {
    Protect-CompanionDirectory $targetCompanion
    Get-ChildItem -LiteralPath $sourceCompanion -Force | Copy-Item -Destination $targetCompanion -Recurse -Force
    # Reset copied/previous file ACLs to inherit from this dedicated RX-only subtree.
    & icacls.exe $targetCompanion /reset /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to reset support companion file permissions.' }
    Protect-CompanionDirectory $targetCompanion
}
# Register in Control Panel > Programs and Features and Settings > Apps, with an uninstaller
# that lives next to the agent (the setup folder may be a deleted temporary directory).
$uninstallScript = Join-Path $InstallDirectory 'Uninstall-Agent.ps1'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Uninstall-Agent.ps1') -Destination $uninstallScript -Force
$displayVersion = (Get-Item -LiteralPath $targetExe).VersionInfo.ProductVersion
if ($displayVersion) { $displayVersion = ($displayVersion -split '\+')[0] }
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) { $displayVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version }
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$uninstallCommand = '"' + $powershellExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $uninstallScript + '" -InstallDirectory "' + $InstallDirectory + '" -DataDirectory "' + $DataDirectory + '" -RemoveEnrollment'
$uninstallKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\LibraryRmmAgent'
New-Item -Path $uninstallKey -Force | Out-Null
$sizeKb = [int]((Get-ChildItem -LiteralPath $InstallDirectory -File | Measure-Object -Property Length -Sum).Sum / 1024)
$entries = @{
    DisplayName = 'Library RMM Agent'; DisplayVersion = [string]$displayVersion; Publisher = 'Park County Library IT'
    InstallLocation = $InstallDirectory; DisplayIcon = $targetExe; UninstallString = $uninstallCommand
    QuietUninstallString = $uninstallCommand + ' -Quiet'; URLInfoAbout = $serverOrigin
}
foreach ($name in $entries.Keys) { New-ItemProperty -Path $uninstallKey -Name $name -Value $entries[$name] -PropertyType String -Force | Out-Null }
foreach ($name in 'NoModify', 'NoRepair') { New-ItemProperty -Path $uninstallKey -Name $name -Value 1 -PropertyType DWord -Force | Out-Null }
New-ItemProperty -Path $uninstallKey -Name 'EstimatedSize' -Value $sizeKb -PropertyType DWord -Force | Out-Null
$binaryPath = '"' + $targetExe + '" --data-dir "' + $DataDirectory + '"'
if ($existing) {
    $changed = Invoke-CimMethod -InputObject $serviceInfo -MethodName Change -Arguments @{ PathName = $binaryPath; StartMode = 'Automatic'; StartName = 'LocalSystem' }
    if ($changed.ReturnValue -ne 0) { throw 'Unable to update the Windows service configuration.' }
} else {
    New-Service -Name $serviceName -BinaryPathName $binaryPath -DisplayName 'Library RMM Agent' -StartupType Automatic -Description 'Park County Library endpoint inventory and authorized administrative job service. Outbound HTTPS; commands are never automatically repeated.' | Out-Null
}
& sc.exe failure $serviceName reset= 86400 actions= restart/60000/restart/120000/restart/300000 | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to configure service recovery.' }
Start-Service -Name $serviceName
Write-Host 'Update checkpoint: agent service start requested.'
$installedService = Get-Service -Name $serviceName
$installedService.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
if ($joinPending) {
    Write-Host ('Library RMM Agent installed and running. ' + $env:COMPUTERNAME + ' is now waiting for approval:')
    Write-Host '  open the RMM console > Add endpoints > Waiting for approval, then click Approve.'
} else {
    Write-Host ('Library RMM Agent installed and running. Endpoint ID: ' + $config.endpointId)
}
Write-Host 'Inventory appears after the next successful outbound check-in. No reboot was performed.'
