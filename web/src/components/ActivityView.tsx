import { ChevronRight, Search, ShieldCheck, Terminal, X } from 'lucide-react';
import type { Endpoint, Job, RunSummary } from '../types';
import { endpointDisplayName, formatTimestamp, titleCaseAction } from '../uiUtils';
import { EmptyState, StatusBadge } from './UiPrimitives';

export function ActivityView({
  runs,
  jobs,
  visibleJobs,
  browsingCount,
  endpoints,
  statusFilter,
  kindFilter,
  search,
  showBrowsing,
  onChangeStatusFilter,
  onChangeKindFilter,
  onChangeSearch,
  onToggleShowBrowsing,
  onOpenRun,
  onOpenJob,
}: {
  runs: RunSummary[];
  jobs: Job[];
  visibleJobs: Job[];
  browsingCount: number;
  endpoints: Endpoint[];
  statusFilter: string;
  kindFilter: string;
  search: string;
  showBrowsing: boolean;
  onChangeStatusFilter: (status: string) => void;
  onChangeKindFilter: (kind: string) => void;
  onChangeSearch: (q: string) => void;
  onToggleShowBrowsing: (show: boolean) => void;
  onOpenRun: (runId: string) => void;
  onOpenJob: (job: Job) => void;
}) {
  return (
    <div className="view-stack">
      {runs.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent batch runs</h2>
              <p>Compare multi-computer results and full output side by side.</p>
            </div>
          </div>
          <div className="recent-runs">
            {runs.slice(0, 16).map((run) => (
              <button
                type="button"
                key={run.id}
                className="run-link"
                onClick={() => onOpenRun(run.id)}
              >
                <strong>{run.name}</strong>
                <span className="tabular">
                  {run.endpointCount} computer{run.endpointCount === 1 ? '' : 's'} ·{' '}
                  {formatTimestamp(run.createdAt)}
                </span>
                <small>
                  {Object.entries(run.counts)
                    .map(([status, count]) => `${count} ${status}`)
                    .join(' · ')}
                </small>
                <span className="run-open">View results →</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>All jobs</h2>
            <p>Every command dispatched to an endpoint with complete retained output.</p>
          </div>
          <span className="muted tabular">
            {visibleJobs.length} of {jobs.length} jobs
          </span>
        </div>

        <div className="table-toolbar">
          <div className="tabs">
            {(
              [
                ['all', 'All jobs'],
                ['active', 'In progress'],
                ['succeeded', 'Completed'],
                ['failed', 'Failed'],
              ] as [string, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={statusFilter === key ? 'active' : ''}
                onClick={() => onChangeStatusFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="activity-tools">
            <div className="search-field">
              <Search size={15} />
              <input
                aria-label="Search activity"
                placeholder="Computer, command or result…"
                value={search}
                onChange={(e) => onChangeSearch(e.target.value)}
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => onChangeSearch('')}>
                  <X size={14} />
                </button>
              )}
            </div>
            <select
              aria-label="Job type"
              value={kindFilter}
              onChange={(e) => onChangeKindFilter(e.target.value)}
            >
              <option value="all">All types</option>
              <option value="powershell">PowerShell</option>
              <option value="terminal">Terminal</option>
              <option value="files">Files</option>
              <option value="reboot">Reboot</option>
              <option value="inventory">Inventory</option>
              <option value="other">Other</option>
            </select>
            <label className="activity-browsing">
              <input
                type="checkbox"
                checked={showBrowsing}
                onChange={(e) => onToggleShowBrowsing(e.target.checked)}
              />
              Show file browsing ({browsingCount})
            </label>
          </div>
        </div>

        {visibleJobs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Summary</th>
                  <th className="col-action" />
                </tr>
              </thead>
              <tbody>
                {visibleJobs.map((job) => (
                  <tr
                    key={job.id}
                    className="clickable-row"
                    onClick={() => onOpenJob(job)}
                  >
                    <td>
                      <button
                        type="button"
                        className="table-text-link"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenJob(job);
                        }}
                      >
                        <Terminal size={15} />
                        {titleCaseAction(job.kind)}
                      </button>
                    </td>
                    <td>
                      {endpointDisplayName(endpoints.find((ep) => ep.id === job.endpointId))}
                    </td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="nowrap muted tabular">{formatTimestamp(job.createdAt)}</td>
                    <td className="summary-cell" title={job.summary}>
                      {job.summary || 'Awaiting endpoint'}
                    </td>
                    <td className="col-action">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label="View full job output"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenJob(job);
                        }}
                      >
                        <ChevronRight size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Terminal}
            title="No jobs match this filter"
            description="Run PowerShell, refresh inventory, or queue actions from Endpoints to view live and completed output here."
          />
        )}

        <div className="panel-bottom">
          <span>
            <ShieldCheck size={14} /> At-most-once execution
          </span>
          <span>Complete output retained &amp; downloadable for every job</span>
        </div>
      </section>
    </div>
  );
}
