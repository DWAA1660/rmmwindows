import type { AccountUser } from './AccountSettings';
import type { AgentUpdateStatus } from './agentUpdateHealthModel';

export type Disk = {
  name: string;
  label?: string;
  totalBytes: number;
  freeBytes: number;
};

export type Software = {
  name: string;
  version?: string;
  publisher?: string;
  installDate?: string;
};

export type Inventory = {
  hostname?: string;
  osName?: string;
  osVersion?: string;
  architecture?: string;
  domain?: string;
  domainJoined?: boolean;
  ipv4?: string[];
  loggedOnUser?: string;
  bootTime?: string;
  cpuPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  agentVersion?: string;
  disks?: Disk[];
  software?: Software[];
  pendingReboot?: boolean | null;
  pendingRebootReasons?: string[];
  uptimeSeconds?: number | null;
  directory?: { canonicalName?: string | null; organizationalUnits?: string[] } | null;
};

export type Endpoint = {
  updateStatus?: AgentUpdateStatus | null;
  groupId?: string;
  groupName?: string;
  id: string;
  hostname: string;
  displayName?: string;
  lastSeen: string;
  online: boolean;
  revoked?: boolean;
  tags?: string[];
  inventory?: Inventory;
};

export type Job = {
  id: string;
  endpointId: string;
  kind: string;
  payload?: Record<string, unknown>;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  exitCode?: number;
};

export type Script = {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
};

export type Schedule = {
  id: string;
  name: string;
  scriptId: string;
  endpointIds: string[];
  intervalMinutes: number;
  nextRunAt: string;
  enabled: boolean;
};

export type Audit = {
  id: string;
  action: string;
  actor?: string;
  createdAt: string;
  details?: unknown;
  targetId?: string;
};

export type RunSummary = {
  id: string;
  name: string;
  createdAt: string;
  endpointCount: number;
  counts: Record<string, number>;
};

export type User = AccountUser;

export type View =
  | 'overview'
  | 'endpoints'
  | 'software'
  | 'network'
  | 'firewall'
  | 'scripts'
  | 'schedules'
  | 'activity'
  | 'enrollment'
  | 'audit'
  | 'settings';

export type Chunk = { sequence: number; stream: string; text: string };

export type StorageResult = {
  path: string;
  partial?: boolean;
  scannedEntries?: number;
  note?: string;
  errors?: string[];
  entries: {
    name: string;
    path: string;
    isDirectory: boolean;
    sizeBytes?: number;
    skippedReparsePoint?: boolean;
    partial?: boolean;
    errors?: string[];
  }[];
};

export type RequestFn = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
