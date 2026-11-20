// Network scanner model (pure functions, unit tested in web/test/netscan-model.test.mjs).

export type Risk = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type PortInfo = { port: number; service: string; category: string; risk: Risk; note: string };
export type Expectation = 'discover' | 'reachable' | 'blocked';
export type Speed = 'gentle' | 'normal' | 'fast';
export type ScanHost = { ip: string; rtt: number | null; ttl: number | null; open: number[]; closed: number[]; closedCount: number; filtered: number; mac: string | null; name: string | null; arpOnly: boolean };
export type ScanInterface = { name: string; ip: string; prefix: number | null; mac: string; gateways: string[] };
export type ScanTest = { expect: Expectation; checked: number; failed: number; passed: number; verdict: 'pending' | 'pass' | 'fail'; failures?: { ip: string; port: number }[] };
export type ScanSource = {
  endpointId: string; endpointName: string; finished: boolean; complete: boolean; error: string | null; hostsUp: number; openPorts: number;
  job: { id: string; status: string; summary?: string | null; startedAt?: string | null; completedAt?: string | null; createdAt: string };
  progress: { phase: string; done: number; total: number; elapsedMs: number | null } | null;
  started: { computer: string; addresses: number | null; ports: number | null } | null;
  test: ScanTest | null; interfaces?: ScanInterface[]; hosts?: ScanHost[];
};
export type Scan = {
  id: string; name: string; testId: string | null; createdBy: string; createdAt: string; runId: string | null;
  targets: { input: string; kind: string; count: number }[]; ports: number[]; speed: Speed; ping: boolean; resolveNames: boolean; onlyResponsive: boolean;
  expect: Expectation; addresses: number; estimateSeconds: number; status: 'queued' | 'running' | 'finished'; verdict: 'pending' | 'pass' | 'fail' | null;
  sources: ScanSource[];
};
export type Preset = {
  id: string; kind: 'targets' | 'ports' | 'test'; name: string; description: string; createdBy: string; updatedAt: string;
  targets?: string[]; ports?: number[]; speed?: Speed; ping?: boolean; resolveNames?: boolean; onlyResponsive?: boolean; expect?: Expectation; endpointIds?: string[];
};

export const LIMITS = { addresses: 4096, ports: 1024, probes: 131072, targets: 64 } as const;
export const SPEEDS: Record<Speed, { concurrency: number; timeoutMs: number; label: string; hint: string }> = {
  gentle: { concurrency: 64, timeoutMs: 1500, label: 'Gentle', hint: 'Slow links, Wi-Fi or VPN' },
  normal: { concurrency: 256, timeoutMs: 800, label: 'Normal', hint: 'Most wired networks' },
  fast: { concurrency: 512, timeoutMs: 400, label: 'Fast', hint: 'Local wired subnets' },
};

const p = (port: number, service: string, category: string, risk: Risk, note: string): PortInfo => ({ port, service, category, risk, note });
/** Common TCP ports, what they are, and what an open one usually means for hardening. */
export const PORT_CATALOG: PortInfo[] = [
  p(20, 'FTP data', 'File transfer', 'high', 'Plain-text FTP. Replace with SFTP/FTPS.'),
  p(21, 'FTP', 'File transfer', 'high', 'Credentials and files travel unencrypted. Disable or replace with SFTP.'),
  p(22, 'SSH', 'Remote access', 'medium', 'Allow only from admin networks; use keys and disable password login.'),
  p(23, 'Telnet', 'Remote access', 'critical', 'Unencrypted remote shell. Disable it and use SSH.'),
  p(25, 'SMTP', 'Email', 'medium', 'Only mail servers should accept SMTP; check it is not an open relay.'),
  p(53, 'DNS', 'Infrastructure', 'low', 'Expected on DNS servers and routers. Elsewhere, find out why.'),
  p(67, 'DHCP (TCP)', 'Infrastructure', 'info', 'Rare on TCP; usually harmless.'),
  p(69, 'TFTP (TCP)', 'File transfer', 'high', 'No authentication. Limit to provisioning networks.'),
  p(80, 'HTTP', 'Web', 'low', 'Unencrypted web. Fine for redirects; admin pages should use HTTPS.'),
  p(88, 'Kerberos', 'Windows & AD', 'info', 'Expected on domain controllers only.'),
  p(110, 'POP3', 'Email', 'medium', 'Plain-text mail retrieval. Prefer POP3S (995).'),
  p(111, 'RPC portmapper', 'Infrastructure', 'high', 'Exposes NFS/RPC services. Block from user networks.'),
  p(119, 'NNTP', 'Email', 'low', 'Rarely needed; disable if unused.'),
  p(123, 'NTP (TCP)', 'Infrastructure', 'info', 'Time service.'),
  p(135, 'MS RPC', 'Windows & AD', 'high', 'Windows RPC endpoint mapper. Block between workstations and from guest networks.'),
  p(137, 'NetBIOS name', 'Windows & AD', 'medium', 'Legacy name service. Disable NetBIOS over TCP/IP where possible.'),
  p(138, 'NetBIOS datagram', 'Windows & AD', 'medium', 'Legacy. Disable NetBIOS over TCP/IP where possible.'),
  p(139, 'NetBIOS session', 'Windows & AD', 'high', 'Legacy SMB transport. Block between workstations and from guest networks.'),
  p(143, 'IMAP', 'Email', 'medium', 'Plain-text mail. Prefer IMAPS (993).'),
  p(161, 'SNMP (TCP)', 'Infrastructure', 'medium', 'Use SNMPv3; never default community strings.'),
  p(179, 'BGP', 'Infrastructure', 'medium', 'Routing protocol; should only face peers.'),
  p(389, 'LDAP', 'Windows & AD', 'medium', 'Directory queries in plain text. Expected on domain controllers; prefer LDAPS.'),
  p(443, 'HTTPS', 'Web', 'info', 'Encrypted web. Check what it serves and who needs it.'),
  p(445, 'SMB', 'Windows & AD', 'high', 'File sharing. Workstations and guest networks should not reach each other on 445.'),
  p(464, 'Kerberos password', 'Windows & AD', 'info', 'Expected on domain controllers only.'),
  p(465, 'SMTPS', 'Email', 'low', 'Encrypted mail submission.'),
  p(500, 'IKE (TCP)', 'Infrastructure', 'low', 'VPN negotiation.'),
  p(512, 'rexec', 'Remote access', 'critical', 'Legacy unauthenticated remote execution. Disable.'),
  p(513, 'rlogin', 'Remote access', 'critical', 'Legacy unencrypted login. Disable.'),
  p(514, 'rsh / syslog', 'Remote access', 'critical', 'Legacy remote shell. Disable.'),
  p(515, 'LPD printing', 'Printing', 'low', 'Legacy printer protocol. Expected on printers and print servers only.'),
  p(548, 'AFP', 'File transfer', 'medium', 'Apple file sharing. Disable if unused.'),
  p(554, 'RTSP', 'IoT & cameras', 'high', 'Camera video stream. Keep cameras on their own network.'),
  p(587, 'SMTP submission', 'Email', 'low', 'Mail submission; should require authentication.'),
  p(631, 'IPP printing', 'Printing', 'low', 'Expected on printers and print servers.'),
  p(636, 'LDAPS', 'Windows & AD', 'info', 'Encrypted LDAP. Expected on domain controllers.'),
  p(873, 'rsync', 'File transfer', 'high', 'Often unauthenticated. Restrict to backup hosts.'),
  p(902, 'VMware ESXi', 'Remote access', 'high', 'Hypervisor management. Restrict to admin networks.'),
  p(989, 'FTPS data', 'File transfer', 'low', 'Encrypted FTP.'),
  p(990, 'FTPS', 'File transfer', 'low', 'Encrypted FTP.'),
  p(993, 'IMAPS', 'Email', 'info', 'Encrypted mail.'),
  p(995, 'POP3S', 'Email', 'info', 'Encrypted mail.'),
  p(1080, 'SOCKS proxy', 'Infrastructure', 'high', 'An open proxy lets anyone bypass filtering. Restrict or remove.'),
  p(1194, 'OpenVPN (TCP)', 'Infrastructure', 'low', 'VPN endpoint.'),
  p(1433, 'Microsoft SQL Server', 'Databases', 'high', 'Databases should only accept connections from their application servers.'),
  p(1521, 'Oracle DB', 'Databases', 'high', 'Restrict to application servers.'),
  p(1723, 'PPTP VPN', 'Infrastructure', 'high', 'PPTP is broken. Replace with a modern VPN.'),
  p(1883, 'MQTT', 'IoT & cameras', 'high', 'IoT messaging, often without authentication. Isolate IoT devices.'),
  p(2049, 'NFS', 'File transfer', 'high', 'Network file system. Restrict exports and source networks.'),
  p(2375, 'Docker API (plain)', 'Containers & dev', 'critical', 'Unauthenticated Docker API gives full control of the host. Close it now.'),
  p(2376, 'Docker API (TLS)', 'Containers & dev', 'high', 'Docker remote API. Restrict to admin hosts.'),
  p(3000, 'Dev web / Grafana', 'Web', 'medium', 'Often a development or dashboard server. Check it needs to be reachable.'),
  p(3128, 'Squid proxy', 'Infrastructure', 'medium', 'Proxy. Make sure it is not open to everyone.'),
  p(3268, 'AD Global Catalog', 'Windows & AD', 'info', 'Expected on domain controllers.'),
  p(3269, 'AD Global Catalog SSL', 'Windows & AD', 'info', 'Expected on domain controllers.'),
  p(3306, 'MySQL / MariaDB', 'Databases', 'high', 'Restrict to application servers.'),
  p(3389, 'Remote Desktop', 'Remote access', 'high', 'RDP should only be reachable from admin networks or through a gateway, with NLA on.'),
  p(4444, 'Metasploit / shells', 'Containers & dev', 'critical', 'Common backdoor port. Investigate this host.'),
  p(4899, 'Radmin', 'Remote access', 'high', 'Third-party remote control. Remove if not sanctioned.'),
  p(5000, 'UPnP / dev web / Synology', 'Web', 'medium', 'Often a NAS or development server. Check what it is.'),
  p(5060, 'SIP', 'Infrastructure', 'medium', 'VoIP signalling. Keep phones on a voice network.'),
  p(5432, 'PostgreSQL', 'Databases', 'high', 'Restrict to application servers.'),
  p(5800, 'VNC (web)', 'Remote access', 'high', 'Remote control. Remove or restrict to admin networks.'),
  p(5900, 'VNC', 'Remote access', 'critical', 'Remote control, often weakly protected. Remove or restrict to admin networks.'),
  p(5938, 'TeamViewer', 'Remote access', 'medium', 'Remote control tool. Remove if not sanctioned.'),
  p(5984, 'CouchDB', 'Databases', 'high', 'Restrict to application servers.'),
  p(5985, 'WinRM (HTTP)', 'Remote access', 'high', 'PowerShell remoting. Allow only from admin hosts.'),
  p(5986, 'WinRM (HTTPS)', 'Remote access', 'medium', 'PowerShell remoting. Allow only from admin hosts.'),
  p(6000, 'X11', 'Remote access', 'high', 'Remote X display. Disable network listening.'),
  p(6379, 'Redis', 'Databases', 'critical', 'Often unauthenticated. Never expose beyond its application.'),
  p(6568, 'AnyDesk', 'Remote access', 'medium', 'Remote control tool. Remove if not sanctioned.'),
  p(7070, 'AnyDesk / RealServer', 'Remote access', 'medium', 'Remote control or streaming. Check it is sanctioned.'),
  p(8000, 'HTTP alt / camera', 'Web', 'medium', 'Alternate web, common on cameras and dev servers.'),
  p(8008, 'HTTP alt', 'Web', 'low', 'Alternate web port.'),
  p(8080, 'HTTP proxy / alt', 'Web', 'medium', 'Alternate web or proxy. Check what it is.'),
  p(8081, 'HTTP alt', 'Web', 'low', 'Alternate web port.'),
  p(8443, 'HTTPS alt / admin', 'Web', 'medium', 'Often a device admin console. Restrict to admin networks.'),
  p(8554, 'RTSP alt', 'IoT & cameras', 'high', 'Camera video stream. Keep cameras isolated.'),
  p(8883, 'MQTT over TLS', 'IoT & cameras', 'medium', 'IoT messaging.'),
  p(8888, 'HTTP alt', 'Web', 'low', 'Alternate web port.'),
  p(9000, 'Portainer / PHP-FPM', 'Containers & dev', 'high', 'Container or app management. Restrict to admin hosts.'),
  p(9090, 'Cockpit / Prometheus', 'Containers & dev', 'medium', 'Server management or metrics. Restrict.'),
  p(9100, 'Raw printing (JetDirect)', 'Printing', 'low', 'Expected on printers. Guest networks usually should not print directly.'),
  p(9200, 'Elasticsearch', 'Databases', 'critical', 'Often unauthenticated. Restrict to its application.'),
  p(9389, 'AD Web Services', 'Windows & AD', 'info', 'Expected on domain controllers.'),
  p(9443, 'HTTPS admin', 'Web', 'medium', 'Often a management console. Restrict.'),
  p(10000, 'Webmin / backup', 'Remote access', 'high', 'Server administration. Restrict to admin hosts.'),
  p(11211, 'Memcached', 'Databases', 'critical', 'Unauthenticated cache. Never expose.'),
  p(27017, 'MongoDB', 'Databases', 'critical', 'Often unauthenticated. Restrict to its application.'),
  p(34567, 'DVR / NVR', 'IoT & cameras', 'high', 'Cheap DVR control port with a poor security record. Isolate it.'),
  p(37777, 'Dahua DVR', 'IoT & cameras', 'high', 'Camera recorder control. Isolate it.'),
  p(47001, 'WinRM listener', 'Windows & AD', 'low', 'Windows remote management service.'),
  p(49152, 'UPnP / Windows RPC', 'Infrastructure', 'medium', 'Dynamic RPC or UPnP. Check what listens.'),
];
const catalogByPort = new Map(PORT_CATALOG.map(item => [item.port, item]));
export const portInfo = (port: number): PortInfo => catalogByPort.get(port) ?? { port, service: 'Unknown', category: 'Other', risk: 'medium', note: 'Not a well-known service. Find out what is listening.' };
export const RISK_ORDER: Risk[] = ['critical', 'high', 'medium', 'low', 'info'];
export const riskRank = (risk: Risk) => RISK_ORDER.indexOf(risk);

export const PORT_PROFILES: { id: string; label: string; description: string; ports: number[] }[] = [
  { id: 'top', label: 'Top 20', description: 'Quick look at the most common services', ports: [21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 993, 1433, 3306, 3389, 5900, 8080, 8443, 9100] },
  { id: 'windows', label: 'Windows & AD', description: 'File sharing, RPC, RDP, WinRM, domain services', ports: [53, 88, 135, 139, 389, 445, 464, 636, 3268, 3269, 3389, 5985, 5986, 9389] },
  { id: 'remote', label: 'Remote access', description: 'Ways to control a computer remotely', ports: [22, 23, 3389, 4899, 5800, 5900, 5938, 5985, 5986, 6568, 7070, 10000] },
  { id: 'web', label: 'Web & admin pages', description: 'Web servers and device admin consoles', ports: [80, 443, 3000, 5000, 8000, 8008, 8080, 8081, 8443, 8888, 9443, 10000] },
  { id: 'printing', label: 'Printers', description: 'Printing protocols and printer web pages', ports: [80, 443, 515, 631, 9100] },
  { id: 'iot', label: 'Cameras & IoT', description: 'Cameras, recorders and smart devices', ports: [23, 80, 443, 554, 1883, 8000, 8554, 8883, 34567, 37777] },
  { id: 'databases', label: 'Databases', description: 'Database and cache servers', ports: [1433, 1521, 3306, 5432, 5984, 6379, 9200, 11211, 27017] },
  { id: 'risky', label: 'Risky legacy', description: 'Services that should almost never be reachable', ports: [21, 23, 111, 135, 139, 445, 512, 513, 514, 1723, 2375, 4444, 5900, 6379, 11211] },
  { id: 'all', label: `All common (${PORT_CATALOG.length})`, description: 'Every port in the catalog', ports: PORT_CATALOG.map(item => item.port) },
];

// ---- Targets (mirrors server/src/netscan.mjs so the console can preview before sending) ----
export type Target = { input: string; kind: 'subnet' | 'range' | 'ip'; start: number; end: number; count: number };
export function ipNumber(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}
export const ipText = (n: number) => [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.');
const reserved = (n: number) => n < 0x01000000 || (n >= 0x7f000000 && n <= 0x7fffffff) || n >= 0xe0000000;

/** Returns the parsed target or an operator-facing error message. */
export function parseTarget(raw: string): Target | string {
  const input = raw.trim();
  if (!input) return 'Enter a subnet, range or IP address.';
  let kind: Target['kind']; let start: number | null; let end: number | null;
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(input);
  const range = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(input);
  if (cidr) {
    const base = ipNumber(cidr[1]); const bits = Number(cidr[2]);
    if (base === null || bits > 32) return `“${input}” is not a valid subnet.`;
    if (bits < 20) return `“${input}” is too large. Use /20 or smaller.`;
    const size = 2 ** (32 - bits); const network = base - (base % size);
    kind = 'subnet'; start = bits <= 30 ? network + 1 : network; end = bits <= 30 ? network + size - 2 : network + size - 1;
  } else if (range) {
    start = ipNumber(range[1]);
    end = /^\d{1,3}$/.test(range[2]) && start !== null ? Math.floor(start / 256) * 256 + Number(range[2]) : ipNumber(range[2]);
    if (start === null || end === null || (/^\d+$/.test(range[2]) && Number(range[2]) > 255)) return `“${input}” is not a valid range.`;
    if (end < start) return `“${input}” ends before it starts.`;
    kind = 'range';
  } else {
    start = end = ipNumber(input);
    if (start === null) return `“${input}” is not an IP address, range or subnet.`;
    kind = 'ip';
  }
  if (reserved(start) || reserved(end!) || (start < 0x7f000000 && end! >= 0x7f000000)) return `“${input}” includes loopback, multicast or reserved addresses.`;
  const count = end! - start + 1;
  if (count > LIMITS.addresses) return `“${input}” has ${count.toLocaleString()} addresses; the limit is ${LIMITS.addresses.toLocaleString()}.`;
  return { input, kind, start, end: end!, count };
}
/** Unique address count after merging overlapping targets. */
export function addressCount(targets: Target[]): number {
  const sorted = targets.map(t => [t.start, t.end]).sort((a, b) => a[0] - b[0]);
  let total = 0; let last: number[] | null = null;
  for (const [start, end] of sorted) {
    if (last && start <= last[1] + 1) { if (end > last[1]) { total += end - last[1]; last[1] = end; } }
    else { total += end - start + 1; last = [start, end]; }
  }
  return total;
}
/** Splits pasted text ("10.0.0.0/24, 10.0.1.5\n10.0.2.1-20") into target strings. */
export const splitTargets = (text: string) => text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
export const describeTarget = (t: Target) => t.kind === 'subnet' ? `Whole subnet · ${t.count.toLocaleString()} IPs` : t.kind === 'range' ? `Range · ${t.count.toLocaleString()} IPs` : 'Single IP';

/** Ports text such as "22, 80 8000-8010" -> sorted unique list, or an error message. */
export function parsePortsText(text: string): number[] | string {
  const ports = new Set<number>();
  for (const item of text.split(/[\s,;]+/).filter(Boolean)) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item);
    if (!match) return `“${item}” is not a port or range.`;
    const from = Number(match[1]); const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || to > 65535 || to < from) return `“${item}” must be within 1–65535.`;
    if (to - from + ports.size >= LIMITS.ports) return `Use at most ${LIMITS.ports} ports.`;
    for (let port = from; port <= to; port++) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
/** Compact text for a port list: 22, 80, 8000-8010. */
export function portsText(ports: number[]): string {
  const sorted = [...new Set(ports)].sort((a, b) => a - b); const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i; while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}-${sorted[j]}` : j === i ? `${sorted[i]}` : `${sorted[i]}, ${sorted[j]}`);
    i = j;
  }
  return parts.join(', ');
}

export function estimateSeconds(addresses: number, ports: number, speed: Speed, ping: boolean, resolveNames: boolean): number {
  const { concurrency, timeoutMs } = SPEEDS[speed];
  const pingSeconds = ping ? Math.ceil(addresses / concurrency) * (timeoutMs + 300) / 1000 : 0;
  const tcpSeconds = Math.ceil(addresses * ports / concurrency) * (timeoutMs + 200) / 1000;
  return Math.ceil(pingSeconds + tcpSeconds + (resolveNames ? Math.ceil(addresses / 64) * 3 : 0) + 10);
}
export const duration = (seconds: number) => seconds < 60 ? `${Math.max(1, Math.round(seconds))} s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${(seconds / 3600).toFixed(1)} h`;

/** /24 networks the fleet's computers sit on, from their reported addresses. */
export type FleetNetworkEndpoint = { id: string; revoked?: boolean; inventory?: { ipv4?: string[]; networkAdapters?: { ipv4?: string[]; gateways?: string[] }[] } };
export function fleetSubnets(endpoints: FleetNetworkEndpoint[]): { cidr: string; endpointIds: string[] }[] {
  const subnets = new Map<string, Set<string>>();
  for (const endpoint of endpoints) {
    if (endpoint.revoked) continue;
    const addresses = new Set([...(endpoint.inventory?.ipv4 ?? []), ...(endpoint.inventory?.networkAdapters ?? []).flatMap(a => a.ipv4 ?? [])]);
    for (const address of addresses) {
      const n = ipNumber(address.split('/')[0]);
      if (n === null || reserved(n) || (n >>> 16) === 0xa9fe) continue; // skip link-local 169.254/16
      const cidr = `${ipText(n - (n % 256))}/24`;
      if (!subnets.has(cidr)) subnets.set(cidr, new Set());
      subnets.get(cidr)!.add(endpoint.id);
    }
  }
  return [...subnets.entries()].map(([cidr, ids]) => ({ cidr, endpointIds: [...ids] }))
    .sort((a, b) => b.endpointIds.length - a.endpointIds.length || ipNumber(a.cidr.split('/')[0])! - ipNumber(b.cidr.split('/')[0])!);
}

// ---- Interpreting results ----
export function osGuess(ttl: number | null): string | null {
  if (ttl === null || ttl <= 0) return null;
  return ttl <= 64 ? 'Linux, macOS or embedded' : ttl <= 128 ? 'Windows' : 'Network equipment';
}
export type DeviceKind = 'dc' | 'nas' | 'printer' | 'camera' | 'iot' | 'windows-server' | 'windows' | 'linux' | 'network' | 'web' | 'database' | 'unknown';
export const DEVICE_LABELS: Record<DeviceKind, string> = {
  dc: 'Domain controller', nas: 'File server / NAS', printer: 'Printer', camera: 'Camera / recorder', iot: 'IoT device', 'windows-server': 'Windows server',
  windows: 'Windows computer', linux: 'Linux / Unix host', network: 'Network device', web: 'Web device', database: 'Database server', unknown: 'Device',
};
export function deviceGuess(host: Pick<ScanHost, 'open' | 'ttl'>): DeviceKind {
  const open = new Set(host.open); const has = (...ports: number[]) => ports.some(port => open.has(port));
  if (open.has(88) && has(389, 636)) return 'dc';
  if (has(9100, 515, 631)) return 'printer';
  if (has(554, 8554, 37777, 34567)) return 'camera';
  if (has(1883, 8883)) return 'iot';
  if (has(1433, 1521, 3306, 5432, 6379, 9200, 27017)) return 'database';
  // SMB on a host whose TTL says Linux/embedded is almost always a NAS running Samba.
  if (has(139, 445, 548, 2049) && host.ttl !== null && host.ttl <= 64) return 'nas';
  const windowsish = has(135, 139, 445, 3389, 5985) || (host.ttl !== null && host.ttl > 64 && host.ttl <= 128);
  if (windowsish && has(80, 443, 1433, 53)) return 'windows-server';
  if (windowsish) return 'windows';
  if (host.ttl !== null && host.ttl > 128) return 'network';
  if (has(23, 161, 179) || (has(53) && has(80, 443))) return 'network';
  if (has(22)) return 'linux';
  if (has(80, 443, 8080, 8443)) return 'web';
  return 'unknown';
}
/** The worst risk among a host's open ports, or null when nothing is open. */
export function hostRisk(host: Pick<ScanHost, 'open'>): Risk | null {
  let worst: Risk | null = null;
  for (const port of host.open) { const risk = portInfo(port).risk; if (worst === null || riskRank(risk) < riskRank(worst)) worst = risk; }
  return worst;
}

export type Finding = { port: number; info: PortInfo; hosts: { ip: string; name: string | null; sources: string[] }[] };
/** Open services across all sources, worst first: "SMB is reachable on 12 hosts from 3 computers". */
export function findings(sources: Pick<ScanSource, 'endpointId' | 'hosts'>[]): Finding[] {
  const byPort = new Map<number, Map<string, { ip: string; name: string | null; sources: Set<string> }>>();
  for (const source of sources) for (const host of source.hosts ?? []) for (const port of host.open) {
    if (!byPort.has(port)) byPort.set(port, new Map());
    const hosts = byPort.get(port)!;
    if (!hosts.has(host.ip)) hosts.set(host.ip, { ip: host.ip, name: host.name, sources: new Set() });
    const entry = hosts.get(host.ip)!; entry.sources.add(source.endpointId); entry.name ??= host.name;
  }
  return [...byPort.entries()].map(([port, hosts]) => ({ port, info: portInfo(port),
    hosts: [...hosts.values()].map(h => ({ ip: h.ip, name: h.name, sources: [...h.sources] })).sort((a, b) => ipNumber(a.ip)! - ipNumber(b.ip)!) }))
    .sort((a, b) => riskRank(a.info.risk) - riskRank(b.info.risk) || b.hosts.length - a.hosts.length || a.port - b.port);
}

export type CompareRow = { ip: string; name: string | null; cells: ({ up: boolean; open: number[] } | null)[]; differs: boolean; ports: number[] };
/** One row per discovered host, one cell per source computer, flagging hosts that sources see differently. */
export function compareSources(sources: Pick<ScanSource, 'endpointId' | 'hosts'>[]): CompareRow[] {
  const ips = new Map<string, string | null>();
  for (const source of sources) for (const host of source.hosts ?? []) if (!ips.has(host.ip) || !ips.get(host.ip)) ips.set(host.ip, host.name);
  return [...ips.entries()].sort((a, b) => ipNumber(a[0])! - ipNumber(b[0])!).map(([ip, name]) => {
    const cells = sources.map(source => { const host = source.hosts?.find(h => h.ip === ip); return host ? { up: true, open: host.open } : null; });
    const signature = cells.map(cell => cell ? cell.open.join(',') : '-');
    const ports = [...new Set(cells.flatMap(cell => cell?.open ?? []))].sort((a, b) => a - b);
    return { ip, name, cells, ports, differs: new Set(signature).size > 1 };
  });
}

export type MapCell = { ip: string; state: 'outside' | 'down' | 'up' | 'open' | 'risky' | 'self'; host?: ScanHost };
/** 16×16 grids, one per /24 touched by the scan, for the subnet map. */
export function subnetGrids(scan: Pick<Scan, 'targets'>, hosts: ScanHost[], selfIps: string[] = []): { network: string; cells: MapCell[]; up: number }[] {
  const parsed = scan.targets.map(t => parseTarget(t.input)).filter((t): t is Target => typeof t !== 'string');
  const inScan = (n: number) => parsed.some(t => n >= t.start && n <= t.end);
  const byIp = new Map(hosts.map(h => [h.ip, h])); const self = new Set(selfIps);
  const networks = new Set<number>();
  for (const t of parsed) for (let base = t.start - (t.start % 256); base <= t.end; base += 256) { networks.add(base); if (networks.size >= 16) break; }
  return [...networks].sort((a, b) => a - b).map(base => {
    let up = 0;
    const cells = Array.from({ length: 256 }, (_, i): MapCell => {
      const ip = ipText(base + i); const host = byIp.get(ip);
      if (host) up++;
      if (self.has(ip)) return { ip, state: 'self', host };
      if (host) { const risk = hostRisk(host); return { ip, host, state: risk === 'critical' || risk === 'high' ? 'risky' : host.open.length ? 'open' : 'up' }; }
      return { ip, state: inScan(base + i) ? 'down' : 'outside' };
    });
    return { network: `${ipText(base)}/24`, cells, up };
  });
}

const csvCell = (value: unknown) => { const text = String(value ?? ''); const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text; return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; };
export function scanCsv(scan: Pick<Scan, 'sources'>): string {
  const rows = [['Scanned from', 'IP address', 'Name', 'MAC', 'Ping ms', 'TTL', 'Likely OS', 'Likely device', 'Open ports', 'Open services', 'Worst risk']];
  for (const source of scan.sources) for (const host of source.hosts ?? [])
    rows.push([source.endpointName, host.ip, host.name ?? '', host.mac ?? '', host.rtt ?? '', host.ttl ?? '', osGuess(host.ttl) ?? '', DEVICE_LABELS[deviceGuess(host)],
      host.open.join(' '), host.open.map(port => `${port}/${portInfo(port).service}`).join('; '), hostRisk(host) ?? ''].map(String));
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
