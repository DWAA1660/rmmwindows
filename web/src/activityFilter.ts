// Activity list filtering (pure; tested in web/test/activity-filter.test.mjs).
export type ActivityJob = { kind: string; status: string; summary?: string | null; endpointName?: string | null; payload?: Record<string, unknown> | null };
export type ActivityFilter = { status: string; kind: string; query: string; showBrowsing: boolean };

const activeStatuses = new Set(['queued', 'dispatched', 'running']);

/** Folder listings made by clicking around the file explorer: useful in the audit trail, noise here. */
export const isBrowsingJob = (job: ActivityJob) => job.kind === 'files' && job.payload?.action === 'list';

export function jobKindGroup(job: ActivityJob): string {
  if (job.kind === 'powershell') return 'powershell';
  if (job.kind === 'terminal') return 'terminal';
  if (job.kind === 'files' || job.kind === 'storage') return 'files';
  if (job.kind === 'reboot') return 'reboot';
  if (job.kind === 'inventory') return 'inventory';
  return 'other';
}

export function filterActivity<T extends ActivityJob>(jobs: T[], filter: ActivityFilter, endpointName: (job: T) => string = job => job.endpointName ?? ''): T[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return jobs.filter(job => {
    if (!filter.showBrowsing && isBrowsingJob(job)) return false;
    if (filter.status === 'active' ? !activeStatuses.has(job.status) : filter.status !== 'all' && job.status !== filter.status) return false;
    if (filter.kind !== 'all' && jobKindGroup(job) !== filter.kind) return false;
    if (!words.length) return true;
    const payload = job.payload ?? {};
    const text = [endpointName(job), job.kind, job.status, job.summary ?? '', typeof payload.script === 'string' ? payload.script : '',
      typeof payload.path === 'string' ? payload.path : '', typeof payload.action === 'string' ? payload.action : ''].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}
