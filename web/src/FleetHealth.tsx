import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, HardDrive, Power, RefreshCw, ArrowUpCircle, Clock, WifiOff } from 'lucide-react';
import { fleetHealth, type HealthEndpoint, type HealthIssue } from './fleetHealthModel';
import './FleetHealth.css';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const icons = { offline: WifiOff, disk: HardDrive, reboot: Power, agent: ArrowUpCircle, uptime: Clock };

/** Overview panel: everything that needs attention across the fleet, each with a next step. */
export function FleetHealth({ endpoints, request, canAct, onOpenEndpoint, onReboot, onRefreshInventory, onCleanDisk }: {
  endpoints: HealthEndpoint[]; request: Request; canAct: boolean;
  onOpenEndpoint: (id: string) => void; onReboot: (ids: string[]) => void; onRefreshInventory: (ids: string[]) => void; onCleanDisk: (ids: string[]) => void;
}) {
  const [latest, setLatest] = useState<string | undefined>();
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { request<{ version: string }>('/agent-download').then(value => setLatest(value.version)).catch(() => setLatest(undefined)); }, [request]);
  const issues = useMemo(() => fleetHealth(endpoints, latest), [endpoints, latest]);
  const problems = issues.filter(issue => issue.endpoints.length);
  const action = (issue: HealthIssue) => {
    const ids = issue.endpoints.map(endpoint => endpoint.id);
    if (!canAct) return null;
    if (issue.key === 'reboot' || issue.key === 'uptime')
      return <button type="button" className="button small secondary" onClick={() => onReboot(ids)}><Power size={13} /> Restart these…</button>;
    if (issue.key === 'disk') return <button type="button" className="button small secondary" onClick={() => onCleanDisk(ids)}><HardDrive size={13} /> Clean temp files…</button>;
    if (issue.key === 'offline') return <button type="button" className="button small secondary" onClick={() => onRefreshInventory(ids)}><RefreshCw size={13} /> Queue inventory refresh</button>;
    return null;
  };
  return (
    <section className="panel fleet-health">
      <div className="panel-heading">
        <div>
          <h2>Fleet health</h2>
          <p>{problems.length ? `${problems.reduce((sum, issue) => sum + issue.endpoints.length, 0)} item(s) need attention` : 'Everything looks healthy.'}{latest ? ` · Latest agent ${latest}` : ''}</p>
        </div>
      </div>
      {!problems.length ? (
        <div className="health-ok"><CheckCircle2 size={20} /><p>No offline computers, low disks, pending restarts, outdated agents or long uptimes.</p></div>
      ) : (
        <div className="health-list">
          {problems.map(issue => {
            const Icon = icons[issue.key];
            const expanded = open === issue.key;
            return (
              <div key={issue.key} className={`health-item health-${issue.key}`}>
                <button type="button" className="health-summary" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : issue.key)}>
                  <span className="health-icon"><Icon size={16} /></span>
                  <span className="health-title"><strong>{issue.title}</strong><small>{issue.endpoints.slice(0, 3).map(endpoint => endpoint.name).join(', ')}{issue.endpoints.length > 3 ? ` and ${issue.endpoints.length - 3} more` : ''}</small></span>
                  <span className="health-count">{issue.endpoints.length}</span>
                </button>
                {expanded && (
                  <div className="health-detail">
                    <p>{issue.advice}</p>
                    <ul>
                      {issue.endpoints.map(endpoint => (
                        <li key={endpoint.id}><button type="button" className="text-button" onClick={() => onOpenEndpoint(endpoint.id)}>{endpoint.name}</button><span>{endpoint.detail}</span></li>
                      ))}
                    </ul>
                    {action(issue)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
