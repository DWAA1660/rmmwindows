// Plans a bulk "Update agent" request (pure; tested in web/test/bulk-agent-update.test.mjs).
// The server is authoritative: it skips computers with a pending update or a revoked credential
// and reports why. This preview only explains the choice before anything is queued.
import { olderVersion } from './fleetHealthModel.ts';

export type UpdateCandidate = {
  id: string;
  hostname: string;
  displayName?: string;
  online: boolean;
  revoked?: boolean;
  inventory?: { agentVersion?: string };
};
export type UpdateJob = { endpointId: string; kind: string; status: string; payload?: Record<string, unknown> };
export type PlannedComputer = { id: string; name: string; version: string; online: boolean };
export type UpdatePlan = {
  /** Agent older than the published one (or unknown version). */
  outdated: PlannedComputer[];
  /** Already on the published version (or newer); only reinstalled when asked. */
  current: PlannedComputer[];
  /** An update job is already queued, dispatched or running; always skipped. */
  pending: PlannedComputer[];
  /** Revoked computers cannot run jobs; always skipped. */
  revoked: PlannedComputer[];
};

const ACTIVE = new Set(['queued', 'dispatched', 'running']);
/** The fixed server-written update job runs the public bootstrap. */
export const isAgentUpdateJob = (job: UpdateJob) =>
  job.kind === 'powershell' && typeof job.payload?.script === 'string' && /\/install\.ps1'/.test(job.payload.script as string);

export function planAgentUpdate(endpoints: UpdateCandidate[], published: string | undefined, jobs: UpdateJob[]): UpdatePlan {
  const pendingIds = new Set(jobs.filter(job => ACTIVE.has(job.status) && isAgentUpdateJob(job)).map(job => job.endpointId));
  const plan: UpdatePlan = { outdated: [], current: [], pending: [], revoked: [] };
  for (const endpoint of endpoints) {
    const version = endpoint.inventory?.agentVersion || 'unknown';
    const row = { id: endpoint.id, name: endpoint.displayName || endpoint.hostname, version, online: endpoint.online };
    if (endpoint.revoked) plan.revoked.push(row);
    else if (pendingIds.has(endpoint.id)) plan.pending.push(row);
    else if (!published || olderVersion(endpoint.inventory?.agentVersion, published)) plan.outdated.push(row);
    else plan.current.push(row);
  }
  for (const list of Object.values(plan)) list.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}

/** IDs to send: outdated computers, plus current ones when reinstalling, minus offline ones when excluded. */
export function chosenIds(plan: UpdatePlan, options: { reinstallCurrent: boolean; includeOffline: boolean }): string[] {
  return [...plan.outdated, ...(options.reinstallCurrent ? plan.current : [])]
    .filter(row => options.includeOffline || row.online)
    .map(row => row.id);
}
