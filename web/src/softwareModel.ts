// Fleet-wide software aggregation (pure functions, unit tested in web/test/software-model.test.mjs).
export type FleetSoftware = { name: string; version?: string; publisher?: string; installDate?: string };
export type FleetEndpoint = { id: string; hostname: string; displayName?: string; online?: boolean; revoked?: boolean; inventory?: { software?: FleetSoftware[] } };
export type VersionGroup = { version: string; endpointIds: string[] };
export type SoftwareGroup = { key: string; name: string; publisher: string; versions: VersionGroup[]; endpointIds: string[] };

const clean = (value?: string) => (value ?? '').replace(/\s+/g, ' ').trim();
export const softwareKey = (name: string) => clean(name).toLowerCase();

/** Groups every installed program by name, with the computers per version. Revoked endpoints are ignored. */
export function groupSoftware(endpoints: FleetEndpoint[]): SoftwareGroup[] {
  const groups = new Map<string, { name: string; publishers: Map<string, number>; versions: Map<string, Set<string>>; endpoints: Set<string> }>();
  for (const endpoint of endpoints) {
    if (endpoint.revoked) continue;
    for (const item of endpoint.inventory?.software ?? []) {
      const name = clean(item.name);
      if (!name) continue;
      const key = softwareKey(name);
      let group = groups.get(key);
      if (!group) groups.set(key, group = { name, publishers: new Map(), versions: new Map(), endpoints: new Set() });
      const publisher = clean(item.publisher);
      if (publisher) group.publishers.set(publisher, (group.publishers.get(publisher) ?? 0) + 1);
      const version = clean(item.version) || 'Unknown version';
      if (!group.versions.has(version)) group.versions.set(version, new Set());
      group.versions.get(version)!.add(endpoint.id);
      group.endpoints.add(endpoint.id);
    }
  }
  return [...groups.entries()].map(([key, group]) => ({
    key, name: group.name,
    publisher: [...group.publishers.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '',
    versions: [...group.versions.entries()].map(([version, ids]) => ({ version, endpointIds: [...ids].sort() }))
      .sort((a, b) => compareVersions(b.version, a.version)),
    endpointIds: [...group.endpoints].sort(),
  })).sort((a, b) => b.endpointIds.length - a.endpointIds.length || a.name.localeCompare(b.name));
}

/** Newest-first friendly version comparison: numeric parts compare as numbers, "Unknown" sorts last. */
export function compareVersions(a: string, b: string): number {
  if (a === b) return 0;
  if (a === 'Unknown version') return -1;
  if (b === 'Unknown version') return 1;
  const left = a.split(/[.\-_ ]/), right = b.split(/[.\-_ ]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '', y = right[i] ?? '';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN, ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) { if (nx !== ny) return nx - ny; continue; }
    const text = x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    if (text !== 0) return text;
  }
  return 0;
}

/** Case-insensitive match on name or publisher; every word must match. */
export function filterSoftware(groups: SoftwareGroup[], query: string): SoftwareGroup[] {
  const words = clean(query).toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return groups;
  return groups.filter(group => {
    const text = (group.name + ' ' + group.publisher).toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** Active computers that do NOT have this program (by inventory). Computers without any software inventory are excluded. */
export function missingFrom(group: SoftwareGroup, endpoints: FleetEndpoint[]): FleetEndpoint[] {
  const have = new Set(group.endpointIds);
  return endpoints.filter(endpoint => !endpoint.revoked && (endpoint.inventory?.software?.length ?? 0) > 0 && !have.has(endpoint.id));
}

const csvCell = (value: string) => /[",\r\n]/.test(value) || /^[=+\-@\t]/.test(value) ? '"' + (/^[=+\-@\t]/.test(value) ? "'" : '') + value.replace(/"/g, '""') + '"' : value;

/** CSV of every installed program per computer. Cells starting with formula characters are neutralised. */
export function softwareCsv(endpoints: FleetEndpoint[], onlyKeys?: Set<string>): string {
  const rows = [['Computer', 'Program', 'Version', 'Publisher', 'Install date']];
  for (const endpoint of endpoints) {
    if (endpoint.revoked) continue;
    for (const item of endpoint.inventory?.software ?? []) {
      if (onlyKeys && !onlyKeys.has(softwareKey(item.name))) continue;
      rows.push([endpoint.displayName || endpoint.hostname, clean(item.name), clean(item.version), clean(item.publisher), clean(item.installDate)]);
    }
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
