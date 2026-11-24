#requires -Version 5.1
param([Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Add-Type -AssemblyName System.Net.Http, System.Security
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$bytes = [Security.Cryptography.ProtectedData]::Unprotect(
    [Convert]::FromBase64String($config.protectedKey), $null, 'LocalMachine')
$key = [Text.Encoding]::ASCII.GetString($bytes)
[Array]::Clear($bytes, 0, $bytes.Length)
$target = [uri]$config.relayUrl
if ($target.Scheme -ne 'https' -or $target.UserInfo) { throw 'The relay requires an HTTPS destination.' }
$bind = [Net.IPEndPoint]::new([Net.IPAddress]::Parse($config.listenAddress), [int]$config.listenPort)
$socket = [Net.Sockets.UdpClient]::new($bind)
$decoder = [Text.UTF8Encoding]::new($false, $true)
$handler = [Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$http = [Net.Http.HttpClient]::new($handler)
$http.Timeout = [TimeSpan]::FromSeconds(12)
$http.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $key)
$key = $null
$queue = [Collections.Generic.Queue[object]]::new()
$receive = $socket.ReceiveAsync()
$send = $null
$content = $null
$countSent = 0
$rejected = 0
$dropped = 0
$forwarded = 0
$ignored = 0
$lastHttp = $null
$lastSuccess = $null
$nextSend = [datetime]::UtcNow
$nextStatus = [datetime]::MinValue
$backoff = 2
$statusPath = Join-Path (Split-Path -Parent $ConfigPath) 'Status\status.json'

try {
    while ($true) {
        for ($i = 0; $i -lt 100 -and $receive.IsCompleted; $i++) {
            $packet = $receive.GetAwaiter().GetResult()
            $receive = $socket.ReceiveAsync()
            if ($packet.RemoteEndPoint.Address.ToString() -ne $config.fireboxAddress -or
                $packet.Buffer.Length -lt 1 -or $packet.Buffer.Length -gt 8192) { $rejected++; continue }
            try { $raw = $decoder.GetString($packet.Buffer) }
            catch [Text.DecoderFallbackException] { $rejected++; continue }
            if ($raw -notmatch '^<(13[6-9]|14[0-3])>') { $rejected++; continue }
            if ($queue.Count -ge 1000) { $dropped++; continue }
            $queue.Enqueue(@{ id = [guid]::NewGuid().ToString(); raw = $raw })
        }

        if ($null -ne $send -and $send.IsCompleted) {
            $response = $null
            try {
                $response = $send.GetAwaiter().GetResult()
                $lastHttp = [int]$response.StatusCode
                if (-not $response.IsSuccessStatusCode) { throw 'Relay upload refused.' }
                $result = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
                if ($result.acknowledged -ne $countSent) { throw 'Incomplete relay acknowledgment.' }
                for ($i = 0; $i -lt $countSent; $i++) { $null = $queue.Dequeue() }
                $forwarded += $result.stored
                $ignored += $result.ignored
                $lastSuccess = [datetime]::UtcNow.ToString('o')
                $backoff = 2
                $nextSend = [datetime]::UtcNow.AddSeconds(1)
            } catch {
                if ($null -eq $response) { $lastHttp = 'No response' }
                $nextSend = [datetime]::UtcNow.AddSeconds($backoff)
                $backoff = [Math]::Min(60, $backoff * 2)
            } finally {
                if ($null -ne $response) { $response.Dispose() }
                $content.Dispose()
                $content = $null
                $send = $null
            }
        }

        if ($null -eq $send -and $queue.Count -gt 0 -and [datetime]::UtcNow -ge $nextSend) {
            $events = @($queue.ToArray() | Select-Object -First 50)
            do {
                $countSent = $events.Count
                $json = @{ events = $events } | ConvertTo-Json -Depth 4 -Compress
                if ([Text.Encoding]::UTF8.GetByteCount($json) -le 240KB) { break }
                $events = @($events | Select-Object -First ([int][Math]::Floor($countSent / 2)))
            } while ($events.Count -gt 0)
            $content = [Net.Http.StringContent]::new($json, [Text.Encoding]::UTF8, 'application/json')
            $send = $http.PostAsync($target, $content)
        }

        if ([datetime]::UtcNow -ge $nextStatus) {
            $summary = @{
                time = [datetime]::UtcNow.ToString('o'); listening = $bind.ToString()
                queued = $queue.Count; forwarded = $forwarded; ignoredByServer = $ignored
                rejectedLocally = $rejected; dropped = $dropped
                lastHttp = $lastHttp; lastSuccess = $lastSuccess
            } | ConvertTo-Json -Compress
            try {
                [IO.File]::WriteAllText("$statusPath.tmp", $summary)
                if (Test-Path -LiteralPath $statusPath) {
                    [IO.File]::Replace("$statusPath.tmp", $statusPath, [NullString]::Value)
                } else {
                    [IO.File]::Move("$statusPath.tmp", $statusPath)
                }
            } catch [IO.IOException] {
                # A status reader can briefly hold the previous file open.
            }
            $nextStatus = [datetime]::UtcNow.AddSeconds(10)
        }
        Start-Sleep -Milliseconds 50
    }
} finally {
    if ($null -ne $content) { $content.Dispose() }
    $http.Dispose()
    $socket.Dispose()
}
