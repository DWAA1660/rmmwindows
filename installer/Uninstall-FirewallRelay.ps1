#requires -Version 5.1
#requires -RunAsAdministrator
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$name = 'LibraryRmmFirewallRelay'
$install = Join-Path $env:ProgramFiles $name
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $name }
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
foreach ($folder in @($install, (Join-Path $install 'Status'))) {
    $item = Get-Item -LiteralPath $folder -Force -ErrorAction SilentlyContinue
    if ($item -and (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw "Expected an ordinary directory at $folder."
    }
}
foreach ($file in @('relay.json', 'FirewallRelay.ps1', 'Status\status.json', 'Status\status.json.tmp')) {
    $path = Join-Path $install $file
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path }
}
foreach ($folder in @((Join-Path $install 'Status'), $install)) {
    if ((Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Force)) {
        Remove-Item -LiteralPath $folder
    }
}
Write-Host 'Relay removed. Revoke its relay key in Fleet > Firewall if you are retiring it.'
