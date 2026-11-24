export type FirewallRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type FirewallSource = { address: string; name: string; enabled: boolean; lastReceivedAt: string | null; hasRelayKey: boolean };
export type TrafficAction = 'allow' | 'deny' | 'unparsed';
export type TrafficFilters = {
  sender?: string; action?: TrafficAction; srcIp?: string; dstIp?: string;
  dstPort?: string; protocol?: string; policy?: string; application?: string; host?: string; messageId?: string;
};
export const actions = { allow: 'Allowed', deny: 'Denied', unparsed: 'Unparsed' } as const;
export const ranges = { '1': 'Last hour', '6': 'Last 6 hours', '24': 'Last 24 hours', '168': 'Last 7 days' } as const;
export type FirewallRange = keyof typeof ranges;
export const filterLabels = {
  sender: 'Firebox', action: 'Action', srcIp: 'Source IP', dstIp: 'Destination IP',
  dstPort: 'Destination port', protocol: 'Protocol', policy: 'Policy', application: 'Application', host: 'Hostname', messageId: 'Message ID',
} satisfies Record<keyof TrafficFilters, string>;
export const formatFirewallTime = (value: string) => new Date(value).toLocaleString();
export const firewallError = (error: unknown) => error instanceof Error ? error.message : 'Firewall request failed.';

export type AlertDraft = {
  name: string; kind: 'traffic' | 'silence'; enabled: boolean;
  windowMinutes: number; threshold: number; cooldownMinutes: number; filters: TrafficFilters;
};
export type AlertRule = AlertDraft & { id: string; lastNotifiedAt: string | null };
export type FirewallAlert = {
  id: number; ruleId: string; ruleName: string; kind: AlertDraft['kind']; firedAt: string;
  observed: number; windowMinutes: number; threshold: number; filters: TrafficFilters;
  acknowledgedAt: string | null; acknowledgedBy: string | null;
};
export type AlertInbox = { rules: AlertRule[]; alerts: FirewallAlert[]; open: number; nextBefore: number | null };

export function alertSummary(alert: FirewallAlert) {
  if (alert.kind === 'silence') return `No traffic received for ${alert.observed.toLocaleString()} min.`;
  return `${alert.observed.toLocaleString()} matching events within ${alert.windowMinutes} min · Threshold ${alert.threshold.toLocaleString()}`;
}

export function formatFirewallBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const power = Math.min(units.length, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[power - 1]}`;
}
