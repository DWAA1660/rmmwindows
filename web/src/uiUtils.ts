export type UiDisk = {
  name: string;
  label?: string;
  totalBytes: number;
  freeBytes: number;
};

export type UiEndpoint = {
  id: string;
  hostname: string;
  displayName?: string;
  lastSeen: string;
  online: boolean;
  revoked?: boolean;
  groupId?: string;
  groupName?: string;
  tags?: string[];
  inventory?: {
    ipv4?: string[];
    domain?: string;
    domainJoined?: boolean;
    loggedOnUser?: string;
    osName?: string;
    agentVersion?: string;
    disks?: UiDisk[];
    pendingReboot?: boolean | null;
    directory?: { canonicalName?: string | null; organizationalUnits?: string[] } | null;
  };
};

export type UiJob = {
  id: string;
  endpointId: string;
  kind: string;
  status: string;
  createdAt: string;
  summary?: string;
};

export function formatBytes(n?: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1099511627776) return `${(n / 1099511627776).toFixed(1)} TB`;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n).toLocaleString()} B`;
}

export function formatTimestamp(value?: string | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : '—';
}

export function formatRelativeTime(value?: string | null, nowMs = Date.now()): string {
  if (!value) return 'Never';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 'Never';
  const diff = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function titleCaseAction(value: string): string {
  if (!value) return '';
  return value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

export function endpointDisplayName(ep?: Pick<UiEndpoint, 'displayName' | 'hostname'> | null): string {
  return ep?.displayName || ep?.hostname || 'Unknown endpoint';
}

export function usedDiskPercent(disk: Pick<UiDisk, 'totalBytes' | 'freeBytes'>): number {
  if (!disk.totalBytes || disk.totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100));
}

export function getPrimaryDisk<T extends UiDisk>(ep: { inventory?: { disks?: T[] } }): T | undefined {
  return ep.inventory?.disks?.find((d) => d.name.startsWith('C')) || ep.inventory?.disks?.[0];
}

export function isActiveJob(job: Pick<UiJob, 'status'>): boolean {
  return job.status === 'queued' || job.status === 'dispatched' || job.status === 'running';
}

export function canStartRemoteSupport(agentVersion?: string | null): boolean {
  if (!agentVersion) return false;
  const parts = agentVersion.split('.').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) return false;
  const [major, minor, patch] = parts;
  if (major > 0) return true;
  if (minor > 1) return true;
  return minor === 1 && patch >= 6;
}

export function matchesEndpointSearch(ep: UiEndpoint, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    endpointDisplayName(ep),
    ep.hostname,
    ep.inventory?.ipv4?.join(' '),
    ep.inventory?.domain,
    ep.tags?.join(' '),
    ep.inventory?.loggedOnUser,
    ep.inventory?.osName,
    ep.inventory?.directory?.canonicalName,
    ep.groupName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
