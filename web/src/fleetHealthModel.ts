// Fleet health checks (pure; tested in web/test/fleet-health.test.mjs).
export type HealthDisk = { name: string; totalBytes: number; freeBytes: number };
export type HealthEndpoint = {
  id: string; hostname: string; displayName?: string; online: boolean; revoked?: boolean; lastSeen: string;
  inventory?: { agentVersion?: string; disks?: HealthDisk[]; pendingReboot?: boolean | null; pendingRebootReasons?: string[]; uptimeSeconds?: number | null; bootTime?: string };
};
export type HealthIssue = { key: 'offline' | 'disk' | 'reboot' | 'agent' | 'uptime'; title: string; advice: string; endpoints: { id: string; name: string; detail: string }[] };

const GB = 1024 ** 3;
export const LOW_DISK_PERCENT = 10, LOW_DISK_BYTES = 10 * GB, OFFLINE_HOURS = 24, LONG_UPTIME_DAYS = 30;

/** Plain x.y.z comparison; anything unparsable counts as older so it gets attention. */
export function olderVersion(version: string | undefined, latest: string | undefined): boolean {
  if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return false;
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return true;
  const a = version.split(/[.+-]/).slice(0, 3).map(Number), b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

const days = (seconds: number) => Math.floor(seconds / 86400);
const ago = (hours: number) => hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.floor(hours)} hours`;

export function fleetHealth(endpoints: HealthEndpoint[], latestAgent?: string, now = Date.now()): HealthIssue[] {
  const active = endpoints.filter(endpoint => !endpoint.revoked);
  const name = (endpoint: HealthEndpoint) => endpoint.displayName || endpoint.hostname;
  const issues: HealthIssue[] = [];
  const offline = active.flatMap(endpoint => {
    const hours = (now - Date.parse(endpoint.lastSeen)) / 3600000;
    return !endpoint.online && hours >= OFFLINE_HOURS ? [{ id: endpoint.id, name: name(endpoint), detail: `last seen ${ago(hours)} ago` }] : [];
  });
  issues.push({ key: 'offline', title: 'Offline for over a day', advice: 'Check that the computer is powered on and connected. Jobs wait until it reconnects.', endpoints: offline });
  const disk = active.flatMap(endpoint => {
    const low = (endpoint.inventory?.disks ?? []).filter(item => item.totalBytes > 0 && (item.freeBytes / item.totalBytes * 100 < LOW_DISK_PERCENT || item.freeBytes < LOW_DISK_BYTES));
    return low.length ? [{ id: endpoint.id, name: name(endpoint), detail: low.map(item => `${item.name} ${(item.freeBytes / GB).toFixed(1)} GB free`).join(', ') }] : [];
  });
  issues.push({ key: 'disk', title: 'Low disk space', advice: `Less than ${LOW_DISK_PERCENT}% or ${LOW_DISK_BYTES / GB} GB free. The "Clean temporary files" starter script usually helps.`, endpoints: disk });
  const reboot = active.filter(endpoint => endpoint.inventory?.pendingReboot === true)
    .map(endpoint => ({ id: endpoint.id, name: name(endpoint), detail: (endpoint.inventory?.pendingRebootReasons ?? []).slice(0, 2).join('; ') || 'restart pending' }));
  issues.push({ key: 'reboot', title: 'Waiting for a restart', advice: 'Updates or configuration changes finish after a restart. Schedule it when the computer is not in use.', endpoints: reboot });
  const agent = latestAgent ? active.filter(endpoint => endpoint.inventory && olderVersion(endpoint.inventory.agentVersion, latestAgent))
    .map(endpoint => ({ id: endpoint.id, name: name(endpoint), detail: `agent ${endpoint.inventory?.agentVersion ?? 'unknown'} → ${latestAgent}` })) : [];
  issues.push({ key: 'agent', title: 'Agent update available', advice: 'Agent 0.1.8 and later checks periodically while idle. Older agents check at service startup; use an agent-service-only restart or the installer when idle. A computer reboot is not required for an agent update. Agents older than 0.1.1 need the install command run once.', endpoints: agent });
  const uptime = active.flatMap(endpoint => {
    const seconds = endpoint.inventory?.uptimeSeconds ?? (endpoint.inventory?.bootTime ? (now - Date.parse(endpoint.inventory.bootTime)) / 1000 : null);
    return typeof seconds === 'number' && Number.isFinite(seconds) && days(seconds) >= LONG_UPTIME_DAYS ? [{ id: endpoint.id, name: name(endpoint), detail: `up ${days(seconds)} days` }] : [];
  });
  issues.push({ key: 'uptime', title: `Not restarted in ${LONG_UPTIME_DAYS}+ days`, advice: 'Review long uptime alongside pending Windows restart indicators and endpoint health. Schedule any maintenance restart when the computer is not in use.', endpoints: uptime });
  return issues;
}
