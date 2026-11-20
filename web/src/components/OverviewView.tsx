import { useMemo, useState } from 'react';
import {
  Activity,
  ArrowRight,
  HardDrive,
  Monitor,
  Plus,
  Power,
  Terminal,
  Wifi,
} from 'lucide-react';
import type { Endpoint, Job, RequestFn, View } from '../types';
import {
  endpointDisplayName,
  formatBytes,
  formatRelativeTime,
  getPrimaryDisk,
  isActiveJob,
  titleCaseAction,
  usedDiskPercent,
} from '../uiUtils';
import { FleetHealth } from '../FleetHealth';
import { AgentUpdateHealth } from '../AgentUpdateHealth';
import { fleetHealth } from '../fleetHealthModel';
import { scriptTemplates } from '../scriptTemplates';
import { EndpointTable } from './EndpointTable';
import { EmptyState, StatusBadge } from './UiPrimitives';

export function OverviewView({
  endpoints,
  jobs,
  canAct,
  request,
  onOpenEndpoints,
  onOpenEndpointDetail,
  onOpenJob,
  onChangeView,
  onOpenCommand,
  onQueueJobs,
}: {
  endpoints: Endpoint[];
  jobs: Job[];
  canAct: boolean;
  request: RequestFn;
  onOpenEndpoints: (statusFilter: string) => void;
  onOpenEndpointDetail: (ep: Endpoint) => void;
  onOpenJob: (job: Job) => void;
  onChangeView: (view: View) => void;
  onOpenCommand: (kind: string, ids: string[], script?: string, chooseEndpoints?: boolean) => void;
  onQueueJobs: (ids: string[], kind: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const [healthTab, setHealthTab] = useState<'health' | 'updates'>('health');

  const online = endpoints.filter((ep) => ep.online);
  const offlineCount = endpoints.length - online.length;
  const lowDisk = endpoints.filter((ep) =>
    ep.inventory?.disks?.some((d) => usedDiskPercent(d) >= 85),
  );
  const rebootPending = endpoints.filter((ep) => ep.inventory?.pendingReboot === true);
  const attentionCount = new Set([
    ...endpoints.filter((ep) => !ep.online).map((ep) => ep.id),
    ...lowDisk.map((ep) => ep.id),
    ...rebootPending.map((ep) => ep.id),
  ]).size;
  const activeJobs = jobs.filter(isActiveJob);

  const healthIssues = useMemo(
    () => fleetHealth(endpoints).filter((i) => i.endpoints.length > 0),
    [endpoints],
  );
  const healthIssueCount = healthIssues.reduce((sum, i) => sum + i.endpoints.length, 0);

  const storageTargets = useMemo(
    () =>
      endpoints
        .filter((ep) => getPrimaryDisk(ep))
        .sort((a, b) => usedDiskPercent(getPrimaryDisk(b)!) - usedDiskPercent(getPrimaryDisk(a)!))
        .slice(0, 5),
    [endpoints],
  );

  const snapshotEndpoints = useMemo(
    () =>
      [...endpoints]
        .sort(
          (a, b) =>
            Number(!b.online) - Number(!a.online) ||
            Number(Boolean(b.inventory?.pendingReboot)) - Number(Boolean(a.inventory?.pendingReboot)) ||
            endpointDisplayName(a).localeCompare(endpointDisplayName(b)),
        )
        .slice(0, 6),
    [endpoints],
  );

  return (
    <div className="overview-layout">
      <section className="kpi-strip" aria-label="Fleet summary">
        <button
          type="button"
          className="kpi-cell"
          onClick={() => onOpenEndpoints('all')}
        >
          <span className="kpi-label">
            <Monitor size={14} /> Total endpoints
          </span>
          <strong className="kpi-value tabular">{endpoints.length.toLocaleString()}</strong>
          <span className="kpi-meta">Active Windows fleet</span>
        </button>

        <button
          type="button"
          className="kpi-cell"
          onClick={() => onOpenEndpoints('online')}
        >
          <span className="kpi-label">
            <Wifi size={14} /> Online now
          </span>
          <strong className="kpi-value tabular tone-ok">{online.length.toLocaleString()}</strong>
          <span className="kpi-meta">
            {endpoints.length
              ? `${Math.round((online.length / endpoints.length) * 100)}% reachable`
              : 'Waiting for agents'}
          </span>
        </button>

        <button
          type="button"
          className="kpi-cell"
          onClick={() => onOpenEndpoints(offlineCount > 0 ? 'offline' : 'attention')}
        >
          <span className="kpi-label">
            <Activity size={14} /> Needs attention
          </span>
          <strong className={`kpi-value tabular ${attentionCount > 0 ? 'tone-warn' : ''}`}>
            {attentionCount.toLocaleString()}
          </strong>
          <span className="kpi-meta">
            {offlineCount} offline · {lowDisk.length} low disk · {rebootPending.length} reboot
          </span>
        </button>

        <button
          type="button"
          className="kpi-cell"
          onClick={() => onChangeView('activity')}
        >
          <span className="kpi-label">
            <Terminal size={14} /> Active jobs
          </span>
          <strong className="kpi-value tabular">{activeJobs.length.toLocaleString()}</strong>
          <span className="kpi-meta">{jobs.length.toLocaleString()} total recorded</span>
        </button>
      </section>

      <div className="overview-grid">
        <div className="overview-primary">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Operations &amp; health</h2>
                <p>Triage fleet alerts or inspect agent update rollouts.</p>
              </div>
              <div className="segmented-tabs" role="tablist" aria-label="Health view">
                <button
                  type="button"
                  role="tab"
                  aria-selected={healthTab === 'health'}
                  className={healthTab === 'health' ? 'active' : ''}
                  onClick={() => setHealthTab('health')}
                >
                  Fleet issues
                  <span className="tab-count tabular">{healthIssueCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={healthTab === 'updates'}
                  className={healthTab === 'updates' ? 'active' : ''}
                  onClick={() => setHealthTab('updates')}
                >
                  Agent updates
                </button>
              </div>
            </div>

            {healthTab === 'health' ? (
              <div className="panel-body-flush">
                <FleetHealth
                  endpoints={endpoints}
                  request={request}
                  canAct={canAct}
                  onOpenEndpoint={(id) => {
                    const ep = endpoints.find((item) => item.id === id);
                    if (ep) onOpenEndpointDetail(ep);
                  }}
                  onReboot={(ids) => onOpenCommand('reboot', ids)}
                  onRefreshInventory={(ids) => void onQueueJobs(ids, 'inventory', {})}
                  onCleanDisk={(ids) =>
                    onOpenCommand(
                      'powershell',
                      ids,
                      scriptTemplates.find((t) => t.id === 'clean-temp')?.body ?? '',
                      true,
                    )
                  }
                />
              </div>
            ) : (
              <div className="panel-body-flush">
                <AgentUpdateHealth
                  endpoints={endpoints}
                  request={request}
                  onOpenEndpoint={(id) => {
                    const ep = endpoints.find((item) => item.id === id);
                    if (ep) onOpenEndpointDetail(ep);
                  }}
                />
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Fleet snapshot</h2>
                <p>Prioritized endpoints needing review or quick access.</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => onChangeView('endpoints')}
              >
                View all endpoints ({endpoints.length})
                <ArrowRight size={14} />
              </button>
            </div>
            {snapshotEndpoints.length ? (
              <EndpointTable
                endpoints={snapshotEndpoints}
                selected={[]}
                onToggleSelect={() => {}}
                onToggleSelectAll={() => {}}
                onOpenDetail={onOpenEndpointDetail}
                compact
                selectable={false}
              />
            ) : (
              <EmptyState
                title="No endpoints enrolled"
                description="Install the Windows agent on a library workstation or server to start monitoring."
                action={
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => onChangeView('enrollment')}
                  >
                    <Plus size={15} /> Add first endpoint
                  </button>
                }
              />
            )}
          </section>
        </div>

        <aside className="overview-secondary">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Storage watch</h2>
                <p>Highest C: drive utilization</p>
              </div>
              <HardDrive size={16} className="muted-icon" />
            </div>
            {storageTargets.length ? (
              <div className="storage-list">
                {storageTargets.map((ep) => {
                  const disk = getPrimaryDisk(ep)!;
                  const pct = usedDiskPercent(disk);
                  return (
                    <button
                      type="button"
                      className="storage-item"
                      key={ep.id}
                      onClick={() => onOpenEndpointDetail(ep)}
                    >
                      <div className="storage-item-top">
                        <strong>{endpointDisplayName(ep)}</strong>
                        <span className={`tabular ${pct >= 85 ? 'text-amber' : ''}`}>
                          {Math.round(pct)}%
                        </span>
                      </div>
                      <div className="progress-track">
                        <span
                          className={pct >= 85 ? 'warning' : ''}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <small className="tabular">
                        {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                      </small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="quiet-empty">
                <HardDrive size={20} />
                <p>Disk usage appears once inventory is reported.</p>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Recent activity</h2>
                <p>Latest dispatched jobs</p>
              </div>
              <button
                type="button"
                className="text-button"
                onClick={() => onChangeView('activity')}
              >
                All activity <ArrowRight size={14} />
              </button>
            </div>
            {jobs.length ? (
              <div className="activity-list">
                {jobs.slice(0, 6).map((job) => (
                  <button
                    type="button"
                    key={job.id}
                    className="activity-row"
                    onClick={() => onOpenJob(job)}
                  >
                    <span className="activity-icon">
                      {job.kind === 'reboot' ? <Power size={15} /> : <Terminal size={15} />}
                    </span>
                    <div className="activity-meta">
                      <strong>{titleCaseAction(job.kind)}</strong>
                      <small>
                        {endpointDisplayName(endpoints.find((ep) => ep.id === job.endpointId))} ·{' '}
                        {formatRelativeTime(job.createdAt)}
                      </small>
                    </div>
                    <StatusBadge status={job.status} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="quiet-empty">
                <Activity size={20} />
                <p>No jobs dispatched yet.</p>
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
