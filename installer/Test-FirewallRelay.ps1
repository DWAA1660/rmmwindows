#requires -Version 5.1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$folder = Join-Path ([IO.Path]::GetTempPath()) ('library-rmm-relay-test-' + [guid]::NewGuid().ToString('N'))
$worker = Join-Path $PSScriptRoot 'FirewallRelay.ps1'
$config = Join-Path $folder 'relay.json'
$status = Join-Path $folder 'Status\status.json'
$errors = Join-Path $folder 'error.txt'
$client = [Net.Sockets.UdpClient]::new()
$probe = [Net.Sockets.UdpClient]::new([Net.IPEndPoint]::new([Net.IPAddress]::Loopback, 0))
$port = $probe.Client.LocalEndPoint.Port
$probe.Dispose()
$workerProcess = $null
try {
    New-Item -ItemType Directory -Path (Split-Path -Parent $status) -Force | Out-Null
    $key = [Text.Encoding]::ASCII.GetBytes(('A' * 43))
    $protected = [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($key, $null, 'LocalMachine'))
    @{
        protectedKey = $protected; relayUrl = 'https://127.0.0.1:1'; listenAddress = '127.0.0.1'
        listenPort = $port; fireboxAddress = '127.0.0.1'
    } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
    $windowsPowerShell = Join-Path $env:windir 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -File "{0}" -ConfigPath "{1}"' -f $worker, $config
    $workerProcess = Start-Process -FilePath $windowsPowerShell -ArgumentList $arguments -WindowStyle Hidden -RedirectStandardError $errors -PassThru
    for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $status); $i++) {
        if ($workerProcess.HasExited) { throw (Get-Content -LiteralPath $errors -Raw) }
        Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $status)) { throw 'The relay worker did not start.' }
    foreach ($message in '<142>Allow 192.0.2.1 198.51.100.2 https/tcp 1025 443 A B Allowed (Test)', '<150>Ignored facility') {
        $data = [Text.Encoding]::UTF8.GetBytes($message)
        $null = $client.Send($data, $data.Length, '127.0.0.1', $port)
    }
    for ($i = 0; $i -lt 100; $i++) {
        if ($workerProcess.HasExited) { throw (Get-Content -LiteralPath $errors -Raw) }
        $state = Get-Content -LiteralPath $status -Raw | ConvertFrom-Json
        if ($state.queued -eq 1 -and $state.rejectedLocally -eq 1 -and $state.lastHttp -eq 'No response') {
            Write-Host 'PASS Windows relay received Local1, rejected other facilities, and retained pending traffic while HTTPS was unavailable.'
            return
        }
        Start-Sleep -Milliseconds 250
    }
    throw "The relay did not report the expected queue state. $(ConvertTo-Json $state -Compress)"
} finally {
    $client.Dispose()
    if ($workerProcess -and -not $workerProcess.HasExited) {
        $workerProcess.Kill()
        $workerProcess.WaitForExit()
    }
    foreach ($file in @($errors, $config, $status, "$status.tmp")) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
    $statusFolder = Split-Path -Parent $status
    if (Test-Path -LiteralPath $statusFolder) { Remove-Item -LiteralPath $statusFolder }
    if (Test-Path -LiteralPath $folder) { Remove-Item -LiteralPath $folder }
}
