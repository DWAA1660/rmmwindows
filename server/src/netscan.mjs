import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
// Tables live in db.mjs (schema v12).

// Network reachability scanner. A scan runs as an ordinary at-most-once `powershell` job per
// source computer whose script is written entirely by the server from validated numbers, so every
// existing agent can run it without an update. The script only makes TCP connection attempts,
// ICMP echo requests, reads the local ARP cache and does reverse DNS; it changes nothing.

export const LIMITS = Object.freeze({ addresses: 4096, ports: 1024, probes: 131072, targets: 64, sources: 250 });
export const SPEEDS = Object.freeze({
  gentle: { concurrency: 64, timeoutMs: 1500 },
  normal: { concurrency: 256, timeoutMs: 800 },
  fast: { concurrency: 512, timeoutMs: 400 },
});
export const EXPECTATIONS = ['discover', 'reachable', 'blocked'];
const MARKER = 'RMMSCAN ';

class ScanInputError extends Error {}
const bad = message => { throw new ScanInputError(message); };

function ipNumber(text) {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}
export const ipText = n => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.');
const forbidden = n => n < 0x01000000 || (n >= 0x7f000000 && n <= 0x7fffffff) || n >= 0xe0000000;

/** Parses one target: a whole subnet (CIDR), an address range, or a single IPv4 address. */
export function parseTarget(raw) {
  if (typeof raw !== 'string') bad('Each target must be text.');
  const input = raw.trim();
  if (!input || input.length > 64) bad('Enter a subnet (10.0.0.0/24), a range (10.0.0.10-10.0.0.50 or 10.0.0.10-50) or a single IP.');
  let kind, start, end;
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(input);
  const range = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(input);
  if (cidr) {
    const base = ipNumber(cidr[1]); const bits = Number(cidr[2]);
    if (base === null || bits > 32) bad(`“${input}” is not a valid subnet.`);
    if (bits < 20) bad(`“${input}” is too large. Use /20 (4,096 addresses) or smaller, or split it into several subnets.`);
    const size = 2 ** (32 - bits);
    const network = base - (base % size);
    kind = 'subnet';
    // Every usable address: a /30 or larger skips the network and broadcast addresses.
    start = bits <= 30 ? network + 1 : network;
    end = bits <= 30 ? network + size - 2 : network + size - 1;
  } else if (range) {
    start = ipNumber(range[1]);
    end = /^\d{1,3}$/.test(range[2]) && start !== null ? Math.floor(start / 256) * 256 + Number(range[2]) : ipNumber(range[2]);
    if (start === null || end === null || (/^\d+$/.test(range[2]) && Number(range[2]) > 255)) bad(`“${input}” is not a valid range.`);
    if (end < start) bad(`“${input}” ends before it starts.`);
    kind = 'range';
  } else {
    start = end = ipNumber(input);
    if (start === null) bad(`“${input}” is not an IPv4 address, range or subnet.`);
    kind = 'ip';
  }
  if (forbidden(start) || forbidden(end) || (start < 0x7f000000 && end >= 0x7f000000)) bad(`“${input}” includes loopback, multicast or reserved addresses, which cannot be scanned.`);
  const count = end - start + 1;
  if (count > LIMITS.addresses) bad(`“${input}” has ${count.toLocaleString('en-US')} addresses; the limit is ${LIMITS.addresses.toLocaleString('en-US')} per scan.`);
  return { input, kind, start, end, count };
}

/** Validates a target list and merges overlapping ranges so each address is probed once. */
export function parseTargets(list) {
  if (!Array.isArray(list) || list.length < 1) bad('Add at least one target: a subnet, range or IP address.');
  if (list.length > LIMITS.targets) bad(`Use at most ${LIMITS.targets} targets per scan.`);
  const targets = list.map(parseTarget);
  const sorted = targets.map(t => [t.start, t.end]).sort((a, b) => a[0] - b[0]);
  const ranges = [];
  for (const [start, end] of sorted) {
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end); else ranges.push([start, end]);
  }
  const addresses = ranges.reduce((sum, [start, end]) => sum + end - start + 1, 0);
  if (addresses > LIMITS.addresses) bad(`These targets cover ${addresses.toLocaleString('en-US')} addresses; the limit is ${LIMITS.addresses.toLocaleString('en-US')} per scan.`);
  return { targets: targets.map(({ input, kind, count }) => ({ input, kind, count })), ranges, addresses };
}

/** Ports as integers, or text such as "22, 80, 8000-8010". */
export function parsePorts(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,;]+/).filter(Boolean) : bad('Ports must be a list.');
  const ports = new Set();
  for (const item of items) {
    if (Number.isSafeInteger(item)) { if (item < 1 || item > 65535) bad(`Port ${item} is outside 1–65535.`); ports.add(item); continue; }
    const match = typeof item === 'string' ? /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item.trim()) : null;
    if (!match) bad(`“${String(item).slice(0, 40)}” is not a port or port range.`);
    const from = Number(match[1]); const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > 65535 || to < from) bad(`“${item}” is not a valid port range (1–65535).`);
    if (to - from + 1 + ports.size > LIMITS.ports * 4) bad(`Use at most ${LIMITS.ports} ports per scan.`);
    for (let port = from; port <= to; port++) ports.add(port);
  }
  if (ports.size > LIMITS.ports) bad(`Use at most ${LIMITS.ports} ports per scan (${ports.size} given).`);
  return [...ports].sort((a, b) => a - b);
}

/** Full validated scan configuration. Throws ScanInputError with an operator-facing message. */
export function scanConfig(body) {
  const { targets, ranges, addresses } = parseTargets(body.targets);
  const ports = parsePorts(body.ports ?? []);
  const speed = body.speed ?? 'normal';
  if (!Object.hasOwn(SPEEDS, speed)) bad('speed must be gentle, normal or fast.');
  const flag = (name, fallback) => { const v = body[name] ?? fallback; if (typeof v !== 'boolean') bad(`${name} must be true or false.`); return v; };
  const ping = flag('ping', true); const resolveNames = flag('resolveNames', true); const onlyResponsive = flag('onlyResponsive', false);
  const expect = body.expect ?? 'discover';
  if (!EXPECTATIONS.includes(expect)) bad('expect must be discover, reachable or blocked.');
  if (!ports.length && !ping) bad('Choose at least one port, or turn on ping.');
  if (!ports.length && expect !== 'discover') bad('A reachable/blocked test needs at least one port.');
  if (onlyResponsive && !ping) bad('“Only probe hosts that answer” needs ping turned on.');
  if (addresses * ports.length > LIMITS.probes) bad(`${addresses.toLocaleString('en-US')} addresses × ${ports.length} ports is ${(addresses * ports.length).toLocaleString('en-US')} probes; the limit is ${LIMITS.probes.toLocaleString('en-US')}. Narrow the targets or ports.`);
  return { targets, ranges, addresses, ports, speed, ping, resolveNames, onlyResponsive, expect };
}

/** Worst-case run time in seconds, used for the job timeout and the console estimate. */
export function estimateSeconds(config) {
  const { concurrency, timeoutMs } = SPEEDS[config.speed];
  const pingSeconds = config.ping ? Math.ceil(config.addresses / concurrency) * (timeoutMs + 300) / 1000 : 0;
  const tcpSeconds = Math.ceil(config.addresses * config.ports.length / concurrency) * (timeoutMs + 200) / 1000;
  const dnsSeconds = config.resolveNames ? Math.ceil(config.addresses / 64) * 3 : 0;
  return Math.ceil(pingSeconds + tcpSeconds + dnsSeconds + 10);
}
export const jobTimeoutSeconds = config => Math.min(14400, Math.max(300, Math.ceil(estimateSeconds(config) * 1.5) + 120));

/** The fixed PowerShell scanner. Only validated numbers/booleans are embedded (as base64 JSON). */
export function scanScript(config) {
  const { concurrency, timeoutMs } = SPEEDS[config.speed];
  const settings = { v: 1, ranges: config.ranges.map(([s, e]) => ({ s, e })), ports: config.ports, timeoutMs, concurrency,
    ping: config.ping, resolveNames: config.resolveNames, onlyResponsive: config.onlyResponsive };
  const encoded = Buffer.from(JSON.stringify(settings), 'utf8').toString('base64');
  return `# Library RMM network scan (written by the server). Read-only: it makes TCP connection attempts,
# ICMP echo requests and reverse DNS lookups from this computer and reads its ARP cache.
$ErrorActionPreference = 'Stop'
$cfg = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$timeout = [int]$cfg.timeoutMs
$width = [int]$cfg.concurrency
$ports = [int[]]@($cfg.ports)
$writer = [Console]::Out
$clock = [Diagnostics.Stopwatch]::StartNew()
$script:lastProgress = -10000
function Send-ScanRecord($record) { $writer.WriteLine('${MARKER}' + (ConvertTo-Json -InputObject $record -Compress -Depth 5)); $writer.Flush() }
function Send-Progress([string]$phase, [int64]$done, [int64]$total, [switch]$Force) {
  if ($Force -or $clock.ElapsedMilliseconds - $script:lastProgress -ge 1000) {
    $script:lastProgress = $clock.ElapsedMilliseconds
    Send-ScanRecord @{ t = 'progress'; phase = $phase; done = $done; total = $total; elapsedMs = $clock.ElapsedMilliseconds }
  }
}
function Format-Ip([int64]$n) { '{0}.{1}.{2}.{3}' -f (($n -shr 24) -band 255), (($n -shr 16) -band 255), (($n -shr 8) -band 255), ($n -band 255) }
$hosts = @{}
function Get-HostState([string]$ip) {
  $state = $hosts[$ip]
  if ($null -eq $state) {
    $state = @{ ip = $ip; rtt = $null; ttl = $null; open = (New-Object 'System.Collections.Generic.List[int]'); closed = (New-Object 'System.Collections.Generic.List[int]'); filtered = 0; sent = $false }
    $hosts[$ip] = $state
  }
  $state
}
function Test-Alive($state) { $null -ne $state -and ($null -ne $state.rtt -or $state.open.Count -gt 0 -or $state.closed.Count -gt 0) }
function Send-Host($state) {
  if ($state.sent -or -not (Test-Alive $state)) { return }
  $state.sent = $true
  $closed = @(); if ($state.closed.Count -le 64) { $closed = $state.closed.ToArray() }
  Send-ScanRecord @{ t = 'host'; ip = $state.ip; rtt = $state.rtt; ttl = $state.ttl; open = $state.open.ToArray(); closed = $closed; closedCount = $state.closed.Count; filtered = $state.filtered }
}
try {
  $interfaces = @()
  foreach ($nic in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    if ($nic.OperationalStatus -ne 'Up' -or $nic.NetworkInterfaceType -eq 'Loopback') { continue }
    $props = $nic.GetIPProperties()
    $gateways = @($props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.Address.ToString() })
    foreach ($unicast in $props.UnicastAddresses) {
      if ($unicast.Address.AddressFamily -ne 'InterNetwork') { continue }
      $prefix = $null; try { $prefix = [int]$unicast.PrefixLength } catch { }
      $interfaces += @{ name = $nic.Name; ip = $unicast.Address.ToString(); prefix = $prefix; gateways = $gateways; mac = $nic.GetPhysicalAddress().ToString() }
    }
  }
  $addresses = New-Object 'System.Collections.Generic.List[string]'
  foreach ($range in @($cfg.ranges)) { for ($n = [int64]$range.s; $n -le [int64]$range.e; $n++) { $addresses.Add((Format-Ip $n)) } }
  $inScan = New-Object 'System.Collections.Generic.HashSet[string]' (,[string[]]$addresses.ToArray())
  Send-ScanRecord @{ t = 'start'; v = 1; computer = $env:COMPUTERNAME; addresses = $addresses.Count; ports = $ports.Length; interfaces = $interfaces }

  if ($cfg.ping) {
    for ($i = 0; $i -lt $addresses.Count; $i += $width) {
      $count = [Math]::Min($width, $addresses.Count - $i)
      $batch = $addresses.GetRange($i, $count)
      $pingers = New-Object 'System.Collections.Generic.List[object]'
      $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
      foreach ($ip in $batch) { $pinger = New-Object System.Net.NetworkInformation.Ping; $pingers.Add($pinger); $tasks.Add($pinger.SendPingAsync($ip, $timeout)) }
      try { $null = [System.Threading.Tasks.Task]::WaitAll($tasks.ToArray(), $timeout + 2000) } catch { }
      for ($k = 0; $k -lt $count; $k++) {
        $task = $tasks[$k]
        if ($task.Status -eq 'RanToCompletion' -and $task.Result.Status -eq 'Success') {
          $state = Get-HostState $batch[$k]
          $state.rtt = [int]$task.Result.RoundtripTime
          if ($null -ne $task.Result.Options) { $state.ttl = [int]$task.Result.Options.Ttl }
        }
        try { $pingers[$k].Dispose() } catch { }
      }
      Send-Progress 'ping' ($i + $count) $addresses.Count
    }
    Send-Progress 'ping' $addresses.Count $addresses.Count -Force
  }

  $neighbors = @{}
  function Read-Neighbors {
    try {
      foreach ($entry in @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop)) {
        $mac = [string]$entry.LinkLayerAddress
        if ([string]$entry.State -notin 'Reachable', 'Stale', 'Delay', 'Probe', 'Permanent') { continue }
        if (-not $mac -or $mac -match '^(00-){5}00$|^(FF-){5}FF$|^01-00-5E|^33-33') { continue }
        if ($inScan.Contains([string]$entry.IPAddress)) { $neighbors[[string]$entry.IPAddress] = $mac }
      }
    } catch { }
  }

  $targets = $addresses
  if ($cfg.onlyResponsive) {
    Read-Neighbors
    $targets = New-Object 'System.Collections.Generic.List[string]'
    foreach ($ip in $addresses) { if ((Test-Alive $hosts[$ip]) -or $neighbors.ContainsKey($ip)) { $targets.Add($ip) } }
  }
  $probeTotal = [int64]$targets.Count * $ports.Length
  # Fail a connection immediately when the target answers with a reset (closed port) instead of
  # retrying the SYN: SIO_TCP_INITIAL_RTO with TCP_INITIAL_RTO_NO_SYN_RETRANSMISSIONS.
  $noSynRetry = [byte[]](0xFF, 0xFF, 0xFE, 0x00)
  for ([int64]$index = 0; $index -lt $probeTotal; $index += $width) {
    $count = [int][Math]::Min([int64]$width, $probeTotal - $index)
    $clients = New-Object object[] $count; $tasks = New-Object object[] $count
    $waiting = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
    for ($k = 0; $k -lt $count; $k++) {
      $n = $index + $k
      $ip = $targets[[int][Math]::Floor($n / $ports.Length)]; $port = $ports[[int]($n % $ports.Length)]
      try {
        $client = New-Object System.Net.Sockets.TcpClient([System.Net.Sockets.AddressFamily]::InterNetwork)
        $clients[$k] = $client
        try { $null = $client.Client.IOControl(-1744830447, $noSynRetry, $null) } catch { }
        $tasks[$k] = $client.ConnectAsync([System.Net.IPAddress]::Parse($ip), $port)
        $waiting.Add($tasks[$k])
      } catch { }
    }
    if ($waiting.Count) { try { $null = [System.Threading.Tasks.Task]::WaitAll($waiting.ToArray(), $timeout) } catch { } }
    for ($k = 0; $k -lt $count; $k++) {
      $n = $index + $k
      $ipIndex = [int][Math]::Floor($n / $ports.Length); $portIndex = [int]($n % $ports.Length)
      $ip = $targets[$ipIndex]; $port = $ports[$portIndex]; $task = $tasks[$k]
      $outcome = 'filtered'
      if ($null -ne $task) {
        if ($task.Status -eq 'RanToCompletion') { $outcome = 'open' }
        elseif ($task.Status -eq 'Faulted') {
          $failure = $task.Exception.InnerException
          if ($failure -is [System.Net.Sockets.SocketException] -and [string]$failure.SocketErrorCode -eq 'ConnectionRefused') { $outcome = 'closed' }
        }
      }
      if ($null -ne $clients[$k]) { try { $clients[$k].Close() } catch { } }
      $state = $hosts[$ip]
      if ($outcome -ne 'filtered' -or $null -ne $state) {
        $state = Get-HostState $ip
        if ($outcome -eq 'open') { $state.open.Add($port) } elseif ($outcome -eq 'closed') { $state.closed.Add($port) } else { $state.filtered++ }
      }
      if ($portIndex -eq $ports.Length - 1 -and $null -ne $state) { Send-Host $state }
    }
    Send-Progress 'tcp' ([Math]::Min($index + $count, $probeTotal)) $probeTotal
  }
  if ($probeTotal -gt 0) { Send-Progress 'tcp' $probeTotal $probeTotal -Force }
  foreach ($state in @($hosts.Values)) { Send-Host $state }

  Read-Neighbors
  if ($neighbors.Count) {
    Send-ScanRecord @{ t = 'arp'; items = @($neighbors.GetEnumerator() | ForEach-Object { @{ ip = $_.Key; mac = $_.Value } }) }
  }

  $alive = @($hosts.Values | Where-Object { Test-Alive $_ } | ForEach-Object { $_.ip }) + @($neighbors.Keys) | Select-Object -Unique
  if ($cfg.resolveNames -and $alive.Count) {
    for ($i = 0; $i -lt $alive.Count; $i += 64) {
      $batch = @($alive[$i..([Math]::Min($i + 63, $alive.Count - 1))])
      $tasks = New-Object 'System.Collections.Generic.List[System.Threading.Tasks.Task]'
      foreach ($ip in $batch) { $tasks.Add([System.Net.Dns]::GetHostEntryAsync($ip)) }
      try { $null = [System.Threading.Tasks.Task]::WaitAll($tasks.ToArray(), 3000) } catch { }
      $names = @()
      for ($k = 0; $k -lt $batch.Count; $k++) {
        $task = $tasks[$k]
        if ($task.Status -eq 'RanToCompletion' -and $task.Result.HostName -and $task.Result.HostName -ne $batch[$k]) { $names += @{ ip = $batch[$k]; name = $task.Result.HostName } }
      }
      if ($names.Count) { Send-ScanRecord @{ t = 'names'; items = $names } }
      Send-Progress 'names' ([Math]::Min($i + 64, $alive.Count)) $alive.Count
    }
  }
  $openCount = 0; foreach ($state in $hosts.Values) { $openCount += $state.open.Count }
  Send-ScanRecord @{ t = 'end'; elapsedMs = $clock.ElapsedMilliseconds; up = $alive.Count; open = $openCount }
} catch {
  Send-ScanRecord @{ t = 'error'; message = [string]$_.Exception.Message }
  exit 1
}
`;
}

/** Incrementally folds scanner output records into a result. Unknown/garbled lines are ignored. */
export function emptyResult() {
  return { started: null, interfaces: [], hosts: new Map(), progress: null, end: null, error: null };
}
export function applyLine(result, line) {
  if (!line.startsWith(MARKER)) return;
  let record; try { record = JSON.parse(line.slice(MARKER.length)); } catch { return; }
  if (!record || typeof record !== 'object') return;
  const host = ip => {
    if (typeof ip !== 'string' || ipNumber(ip) === null) return null;
    let entry = result.hosts.get(ip);
    if (!entry) { entry = { ip, rtt: null, ttl: null, open: [], closed: [], closedCount: 0, filtered: 0, mac: null, name: null, arpOnly: false }; result.hosts.set(ip, entry); }
    return entry;
  };
  const ints = value => (Array.isArray(value) ? value : value == null ? [] : [value]).filter(Number.isSafeInteger);
  const num = value => Number.isFinite(value) ? value : null;
  switch (record.t) {
    case 'start':
      result.started = { computer: String(record.computer ?? ''), addresses: num(record.addresses), ports: num(record.ports) };
      result.interfaces = (Array.isArray(record.interfaces) ? record.interfaces : record.interfaces ? [record.interfaces] : []).slice(0, 64).map(item => ({
        name: String(item?.name ?? ''), ip: String(item?.ip ?? ''), prefix: num(item?.prefix), mac: String(item?.mac ?? ''),
        gateways: (Array.isArray(item?.gateways) ? item.gateways : item?.gateways ? [item.gateways] : []).map(String).slice(0, 8),
      }));
      break;
    case 'progress':
      result.progress = { phase: String(record.phase), done: num(record.done) ?? 0, total: num(record.total) ?? 0, elapsedMs: num(record.elapsedMs) };
      break;
    case 'host': {
      const entry = host(record.ip); if (!entry) break;
      Object.assign(entry, { rtt: num(record.rtt), ttl: num(record.ttl), open: ints(record.open), closed: ints(record.closed), closedCount: num(record.closedCount) ?? 0, filtered: num(record.filtered) ?? 0, arpOnly: false });
      break;
    }
    case 'arp':
      for (const item of Array.isArray(record.items) ? record.items : record.items ? [record.items] : []) {
        const known = result.hosts.has(item?.ip); const entry = host(item?.ip); if (!entry) continue;
        entry.mac = String(item.mac ?? '').slice(0, 40) || null;
        if (!known) entry.arpOnly = true;
      }
      break;
    case 'names':
      for (const item of Array.isArray(record.items) ? record.items : record.items ? [record.items] : []) {
        const entry = result.hosts.get(item?.ip); if (entry && typeof item.name === 'string') entry.name = item.name.slice(0, 255);
      }
      break;
    case 'end': result.end = { elapsedMs: num(record.elapsedMs), up: num(record.up), open: num(record.open) }; break;
    case 'error': result.error = String(record.message ?? 'The scan failed.').slice(0, 1000); break;
  }
}

/** Pass/fail for a reachable/blocked test: every (address, port) pair is checked. */
export function evaluate(config, result, finished) {
  if (config.expect === 'discover') return null;
  const wantOpen = config.expect === 'reachable';
  const openBy = new Map([...result.hosts.values()].map(h => [h.ip, new Set(h.open)]));
  const failures = [];
  let checked = 0, failed = 0;
  for (const [start, end] of config.ranges) for (let n = start; n <= end; n++) {
    const ip = ipText(n); const open = openBy.get(ip);
    for (const port of config.ports) {
      checked++;
      if (wantOpen !== Boolean(open?.has(port))) { failed++; if (failures.length < 500) failures.push({ ip, port }); }
    }
  }
  return { expect: config.expect, checked, failed, passed: checked - failed, failures, verdict: !finished ? 'pending' : failed ? 'fail' : 'pass' };
}

export function mountNetscan(router, { db, audit, fail, str, insertJob, getJob, jobView, hashToken }) {

  const nowIso = () => new Date().toISOString();
  const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
  const guard = fn => { try { return fn(); } catch (error) { if (error instanceof ScanInputError) fail(400, error.message); throw error; } };

  // ---- Saved target lists, port lists and tests ----
  const presetView = row => ({ id: row.id, kind: row.kind, name: row.name, description: row.description, ...parse(row.data, {}), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at });
  function presetData(kind, body) {
    return guard(() => {
      if (kind === 'targets') return { targets: parseTargets(body.targets).targets.map(t => t.input) };
      if (kind === 'ports') return { ports: parsePorts(body.ports) };
      const config = scanConfig(body);
      const endpointIds = body.endpointIds === undefined ? [] : body.endpointIds;
      if (!Array.isArray(endpointIds) || endpointIds.length > LIMITS.sources || endpointIds.some(id => typeof id !== 'string' || id.length > 100)) bad('endpointIds must list at most 250 computers.');
      return { targets: config.targets.map(t => t.input), ports: config.ports, speed: config.speed, ping: config.ping, resolveNames: config.resolveNames,
        onlyResponsive: config.onlyResponsive, expect: config.expect, endpointIds: [...new Set(endpointIds)] };
    });
  }
  const presetInput = body => {
    const kind = body.kind;
    if (!['targets', 'ports', 'test'].includes(kind)) fail(400, 'kind must be targets, ports or test.');
    const name = str(body.name, 'name', { max: 100 }).trim(); if (!name) fail(400, 'Enter a name.');
    return { kind, name, description: str(body.description, 'description', { min: 0, max: 1000, fallback: '' }), data: presetData(kind, body) };
  };
  const unique = (kind, name, id = '') => { if (db.prepare('SELECT id FROM netscan_presets WHERE kind=? AND lower(name)=lower(?) AND id<>?').get(kind, name, id)) fail(409, 'Something with this name is already saved.'); };
  router.get('/netscan/presets', (req, res) => res.json(db.prepare('SELECT * FROM netscan_presets ORDER BY kind, name COLLATE NOCASE').all().map(presetView)));
  router.post('/netscan/presets', (req, res) => {
    const input = presetInput(req.body); unique(input.kind, input.name);
    const id = randomUUID(); const now = nowIso();
    db.prepare('INSERT INTO netscan_presets VALUES (?,?,?,?,?,?,?,?)').run(id, input.kind, input.name, input.description, JSON.stringify(input.data), req.operator.username, now, now);
    audit(req.operator.username, 'netscan.preset.created', id, { kind: input.kind, name: input.name, ...input.data });
    res.status(201).json(presetView(db.prepare('SELECT * FROM netscan_presets WHERE id=?').get(id)));
  });
  router.put('/netscan/presets/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM netscan_presets WHERE id=?').get(req.params.id); if (!row) fail(404, 'Saved item not found.');
    const input = presetInput({ ...req.body, kind: row.kind }); unique(row.kind, input.name, row.id);
    db.prepare('UPDATE netscan_presets SET name=?,description=?,data=?,updated_at=? WHERE id=?').run(input.name, input.description, JSON.stringify(input.data), nowIso(), row.id);
    audit(req.operator.username, 'netscan.preset.updated', row.id, { kind: row.kind, name: input.name, ...input.data });
    res.json(presetView(db.prepare('SELECT * FROM netscan_presets WHERE id=?').get(row.id)));
  });
  router.delete('/netscan/presets/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM netscan_presets WHERE id=?').get(req.params.id); if (!row) fail(404, 'Saved item not found.');
    db.prepare('DELETE FROM netscan_presets WHERE id=?').run(row.id);
    audit(req.operator.username, 'netscan.preset.deleted', row.id, { kind: row.kind, name: row.name });
    res.json({ ok: true });
  });
  router.post('/netscan/validate', (req, res) => {
    // Lets the console check targets/ports and show the server's own limits and time estimate.
    const config = guard(() => scanConfig(req.body));
    res.json({ targets: config.targets, addresses: config.addresses, ports: config.ports.length, probes: config.addresses * config.ports.length, estimateSeconds: estimateSeconds(config) });
  });

  // ---- Results: stdout is folded incrementally and cached per job (bounded). ----
  const cache = new Map();
  function jobResult(jobId) {
    let entry = cache.get(jobId);
    if (!entry) { entry = { sequence: -1, buffer: '', result: emptyResult() }; cache.set(jobId, entry); }
    else { cache.delete(jobId); cache.set(jobId, entry); }
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    const chunks = db.prepare("SELECT sequence,stream,text FROM output_chunks WHERE job_id=? AND sequence>? ORDER BY sequence").all(jobId, entry.sequence);
    for (const chunk of chunks) {
      entry.sequence = chunk.sequence;
      if (chunk.stream !== 'stdout') continue;
      entry.buffer += chunk.text;
      const lines = entry.buffer.split('\n'); entry.buffer = lines.pop();
      if (entry.buffer.length > 1048576) entry.buffer = '';
      for (const line of lines) applyLine(entry.result, line.replace(/\r$/, ''));
    }
    return entry.result;
  }
  const finalStates = ['succeeded', 'failed', 'interrupted', 'cancelled'];
  function scanView(row, { full }) {
    const config = parse(row.config, {});
    const jobs = db.prepare('SELECT j.*, e.display_name endpoint_name FROM netscan_jobs n JOIN jobs j ON j.id=n.job_id JOIN endpoints e ON e.id=n.endpoint_id WHERE n.scan_id=? ORDER BY e.display_name COLLATE NOCASE').all(row.id);
    const sources = jobs.map(job => {
      const result = jobResult(job.id);
      const finished = finalStates.includes(job.status);
      const hosts = [...result.hosts.values()].sort((a, b) => ipNumber(a.ip) - ipNumber(b.ip));
      const test = evaluate(config, result, finished && Boolean(result.end));
      const base = { endpointId: job.endpoint_id, endpointName: job.endpoint_name, job: jobView(job), progress: result.progress, started: result.started,
        finished, complete: Boolean(result.end), error: result.error, hostsUp: hosts.length, openPorts: hosts.reduce((sum, h) => sum + h.open.length, 0),
        test: test && { ...test, failures: full ? test.failures : undefined } };
      return full ? { ...base, interfaces: result.interfaces, hosts } : base;
    });
    const done = sources.filter(s => s.finished).length;
    const verdicts = sources.map(s => s.test?.verdict).filter(Boolean);
    return { id: row.id, name: row.name, testId: row.test_id, createdBy: row.created_by, createdAt: row.created_at, runId: row.run_id,
      targets: config.targets, ports: config.ports, speed: config.speed, ping: config.ping, resolveNames: config.resolveNames, onlyResponsive: config.onlyResponsive,
      expect: config.expect, addresses: config.addresses, estimateSeconds: estimateSeconds(config),
      status: done === sources.length ? 'finished' : sources.some(s => s.job.status === 'running') ? 'running' : 'queued',
      verdict: config.expect === 'discover' ? null : verdicts.includes('fail') ? 'fail' : verdicts.length && verdicts.every(v => v === 'pass') && done === sources.length ? 'pass' : 'pending',
      sources };
  }
  router.get('/netscans', (req, res) => {
    const rows = db.prepare('SELECT * FROM netscans ORDER BY created_at DESC LIMIT 60').all();
    res.json(rows.map(row => scanView(row, { full: false })));
  });
  router.get('/netscans/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM netscans WHERE id=?').get(req.params.id); if (!row) fail(404, 'Scan not found.');
    res.json(scanView(row, { full: true }));
  });
  router.post('/netscans', (req, res) => {
    const value = req.body.endpointIds;
    if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.sources || value.some(id => typeof id !== 'string' || id.length > 100)) fail(400, 'Choose 1 to 250 computers to scan from.');
    const ids = [...new Set(value)];
    for (const id of ids) if (!db.prepare('SELECT id FROM endpoints WHERE id=? AND revoked=0').get(id)) fail(400, 'One of the chosen computers is unavailable or revoked.');
    let testId = null;
    if (req.body.testId !== undefined && req.body.testId !== null) {
      testId = str(req.body.testId, 'testId', { max: 100 });
      if (!db.prepare("SELECT id FROM netscan_presets WHERE id=? AND kind='test'").get(testId)) fail(404, 'Saved test not found.');
    }
    const config = guard(() => scanConfig(req.body));
    const idempotencyKey = str(req.body.idempotencyKey, 'idempotencyKey', { max: 128 });
    const fallbackName = config.expect === 'discover' ? `Network scan · ${config.targets.map(t => t.input).join(', ')}` : `${config.expect === 'reachable' ? 'Must reach' : 'Must block'} · ${config.targets.map(t => t.input).join(', ')}`;
    const name = str(req.body.name, 'name', { min: 0, max: 150, fallback: '' }).trim() || fallbackName.slice(0, 150);
    const scopedKey = `${req.operator.user_id}:netscan:${idempotencyKey}`;
    const requestHash = hashToken(JSON.stringify({ ids: [...ids].sort(), config, name, testId }));
    const payload = { script: scanScript(config) };
    const timeout = jobTimeoutSeconds(config);
    const result = transaction(db, () => {
      const previous = db.prepare('SELECT * FROM job_requests WHERE idempotency_key=?').get(scopedKey);
      if (previous) {
        if (previous.request_hash !== requestHash) fail(409, 'This request key was already used for a different scan.');
        const scanId = db.prepare('SELECT scan_id FROM netscan_jobs WHERE job_id=?').get(parse(previous.job_ids, [])[0])?.scan_id;
        return { id: scanId, duplicate: true };
      }
      const scanId = randomUUID(); const runId = randomUUID(); const now = nowIso();
      db.prepare('INSERT INTO job_runs VALUES (?,?,?,?)').run(runId, name, JSON.stringify(ids), now);
      db.prepare('INSERT INTO netscans VALUES (?,?,?,?,?,?,?,?)').run(scanId, name, testId, JSON.stringify(config), JSON.stringify(ids), runId, req.operator.username, now);
      const jobs = ids.map(id => insertJob(id, 'powershell', payload, timeout, req.operator.username));
      for (const job of jobs) {
        db.prepare('UPDATE jobs SET run_id=? WHERE id=?').run(runId, job.id);
        db.prepare('INSERT INTO netscan_jobs VALUES (?,?,?)').run(job.id, scanId, job.endpointId);
      }
      db.prepare('INSERT INTO job_requests VALUES (?,?,?,?)').run(scopedKey, requestHash, JSON.stringify(jobs.map(job => job.id)), now);
      audit(req.operator.username, 'netscan.created', scanId, { name, testId, endpointIds: ids, jobIds: jobs.map(job => job.id),
        targets: config.targets.map(t => t.input), ports: config.ports, expect: config.expect, speed: config.speed });
      return { id: scanId, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(scanView(db.prepare('SELECT * FROM netscans WHERE id=?').get(result.id), { full: true }));
  });
}
