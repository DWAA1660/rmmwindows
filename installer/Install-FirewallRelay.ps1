#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ListenAddress,
    [Parameter(Mandatory)][string]$FireboxAddress,
    [ValidateRange(1024,65535)][int]$ListenPort = 5514,
    [uri]$ServerUrl = 'https://rmm.parkcountylibrary.org',
    [Security.SecureString]$RelayKey
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$name = 'LibraryRmmFirewallRelay'
$install = Join-Path $env:ProgramFiles $name
$status = Join-Path $install 'Status'
$config = Join-Path $install 'relay.json'
$program = Join-Path $install 'FirewallRelay.ps1'
if ($ServerUrl.Scheme -ne 'https' -or $ServerUrl.UserInfo -or
    $ServerUrl.AbsolutePath -ne '/' -or $ServerUrl.Query -or $ServerUrl.Fragment) {
    throw 'ServerUrl must be an HTTPS origin, such as https://rmm.parkcountylibrary.org.'
}
foreach ($address in @($ListenAddress, $FireboxAddress)) {
    $ip = [Net.IPAddress]::None
    if (-not [Net.IPAddress]::TryParse($address, [ref]$ip) -or $ip.ToString() -ne $address -or
        $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        [Net.IPAddress]::IsLoopback($ip) -or $ip.GetAddressBytes()[0] -eq 0 -or $ip.GetAddressBytes()[0] -ge 224) {
        throw 'Enter a specific unicast LAN IPv4 address for both the Windows PC and the Firebox.'
    }
}
if ($ListenAddress -eq $FireboxAddress -or -not (Get-NetIPAddress -AddressFamily IPv4 -IPAddress $ListenAddress -ErrorAction SilentlyContinue)) {
    throw 'ListenAddress must be an IPv4 address assigned to this Windows machine and distinct from the Firebox address.'
}
$relayScript = Join-Path $PSScriptRoot 'FirewallRelay.ps1'
if (-not (Test-Path -LiteralPath $relayScript -PathType Leaf)) { throw 'Extract the entire relay installer ZIP before running setup.' }
if (-not $RelayKey) { $RelayKey = Read-Host 'Enter the relay key from Fleet > Firewall' -AsSecureString }
Add-Type -AssemblyName System.Security
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($RelayKey)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
    if ($plain -cnotmatch '^[A-Za-z0-9_-]{43}$') { throw 'The relay key does not have the expected format.' }
    $bytes = [Text.Encoding]::ASCII.GetBytes($plain)
    try {
        $protected = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'LocalMachine'))
    } finally {
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
} finally {
    $plain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
}

function Set-RelayDirectory([string]$Path, [string]$RelayRights) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected an ordinary directory at $Path."
        }
    } else {
        New-Item -ItemType Directory -Path $Path | Out-Null
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', 'S-1-5-19')) {
        $rights = if ($sid -eq 'S-1-5-19') { $RelayRights } else { 'FullControl' }
        $identity = [Security.Principal.SecurityIdentifier]::new($sid)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, $rights,
            'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $name
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if ((Get-ScheduledTask -TaskName $name).State -ne 'Running') { break }
        Start-Sleep -Milliseconds 250
    }
}
$probe = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Parse($ListenAddress), $ListenPort))
$probe.Dispose()
Set-RelayDirectory $install 'ReadAndExecute'
Set-RelayDirectory $status 'Modify'
Copy-Item -LiteralPath $relayScript -Destination $program -Force
Unblock-File -LiteralPath $program
$relayUrl = [uri]::new($ServerUrl, "/api/firewall/relay/$FireboxAddress").AbsoluteUri
@{
    protectedKey = $protected; relayUrl = $relayUrl; listenAddress = $ListenAddress
    listenPort = $ListenPort; fireboxAddress = $FireboxAddress
} | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8

$powershell = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "{0}" -ConfigPath "{1}"' -f $program, $config
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount
$settings = New-ScheduledTaskSettingsSet -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

$rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
if ($rule) { $rule | Remove-NetFirewallRule }
New-NetFirewallRule -Name $name -DisplayName 'Library RMM Firebox syslog relay' -Direction Inbound -Action Allow -Protocol UDP -LocalAddress $ListenAddress -LocalPort $ListenPort -RemoteAddress $FireboxAddress -Profile Domain,Private -Program $powershell | Out-Null
Start-ScheduledTask -TaskName $name
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (Get-NetUDPEndpoint -LocalAddress $ListenAddress -LocalPort $ListenPort -ErrorAction SilentlyContinue) {
        Write-Host "Relay listening on $($ListenAddress):$ListenPort (UDP) for $FireboxAddress."
        Write-Host "Status file: $(Join-Path $status 'status.json')"
        return
    }
    Start-Sleep -Milliseconds 500
}
throw "Relay did not bind. Check the $name task in Task Scheduler."
