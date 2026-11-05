import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, Loader2, MinusCircle, ShieldCheck } from 'lucide-react';
import { chosenIds, planAgentUpdate, type PlannedComputer, type UpdateCandidate, type UpdateJob } from './bulkAgentUpdateModel';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type QueuedJob = { id: string; endpointId: string; kind: string; status: string; createdAt: string };
export type BulkUpdateResult = { endpointId: string; endpointName: string | null; status: 'queued' | 'skipped'; reason?: string; job?: QueuedJob };

/**
 * Confirm, then queue the fixed server-written agent update on many computers with one request
 * (POST /api/endpoints/update-agent). Each job runs at most once; nothing is retried here.
 */
export function BulkAgentUpdate({ endpoints, jobs, request, onQueued, onOpenResults, onClose }: {
  endpoints: UpdateCandidate[];
  jobs: UpdateJob[];
  request: Request;
  onQueued: () => void;
  onOpenResults: (jobs: QueuedJob[]) => void;
  onClose: () => void;
}) {
  const [published, setPublished] = useState<string | null | undefined>(undefined);
  const [reinstallCurrent, setReinstallCurrent] = useState(false);
  const [includeOffline, setIncludeOffline] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<BulkUpdateResult[] | null>(null);
  // Generated once per dialog, so an uncertain retry of the same click cannot queue twice.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    request<{ version: string }>('/agent-download').then(row => setPublished(row.version)).catch(() => setPublished(null));
  }, []);
  const plan = useMemo(() => planAgentUpdate(endpoints, published ?? undefined, jobs), [endpoints, published, jobs]);
  const ids = chosenIds(plan, { reinstallCurrent, includeOffline });
  const offlineEligible = [...plan.outdated, ...(reinstallCurrent ? plan.current : [])].filter(row => !row.online).length;
  const target = published ? `v${published}` : 'the latest published version';

  const submit = async () => {
    if (!ids.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await request<{ results: BulkUpdateResult[] }>('/endpoints/update-agent', 'POST', { endpointIds: ids, idempotencyKey });
      // Selected computers this dialog did not send are reported too, with the reason.
      const sent = new Set(ids);
      const notSent = (rows: PlannedComputer[], reason: (row: PlannedComputer) => string): BulkUpdateResult[] =>
        rows.filter(row => !sent.has(row.id)).map(row => ({ endpointId: row.id, endpointName: row.name, status: 'skipped', reason: reason(row) }));
      setResults([
        ...response.results,
        ...notSent(plan.outdated, () => 'Offline computers were excluded.'),
        ...notSent(plan.current, () => (reinstallCurrent ? 'Offline computers were excluded.' : `Already on ${target}; not reinstalled.`)),
        ...notSent(plan.pending, () => 'An agent update is already queued or running.'),
        ...notSent(plan.revoked, () => 'This endpoint is revoked.'),
      ]);
      onQueued();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  if (results) {
    const queued = results.filter(row => row.status === 'queued');
    const nameOf = (row: BulkUpdateResult) => row.endpointName || endpoints.find(ep => ep.id === row.endpointId)?.hostname || row.endpointId;
    return (
      <div className="bulk-update">
        <div className={`bulk-update-summary ${queued.length ? 'ok' : 'warn'}`} role="status">
          <CheckCircle2 size={18} />
          <span>
            <strong>{queued.length} of {results.length}</strong> computer{results.length === 1 ? '' : 's'} queued for an agent update. Each update runs once; skipped computers were not changed.
          </span>
        </div>
        <ul className="bulk-update-results" aria-label="Per-computer results">
          {results.map(row => (
            <li key={row.endpointId} className={row.status}>
              {row.status === 'queued' ? <CheckCircle2 size={16} /> : <MinusCircle size={16} />}
              <strong>{nameOf(row)}</strong>
              <span>{row.status === 'queued' ? 'Queued' : `Skipped · ${row.reason}`}</span>
            </li>
          ))}
        </ul>
        <div className="modal-footer">
          <span><ShieldCheck size={14} /> Failed or interrupted updates are never retried automatically.</span>
          <div>
            <button type="button" className="button secondary" onClick={onClose}>Done</button>
            {!!queued.length && (
              <button type="button" className="button primary" onClick={() => onOpenResults(queued.map(row => row.job!))}>
                Watch live results
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bulk-update">
      {published === undefined ? (
        <p className="muted"><Loader2 size={14} className="spin" /> Checking the published agent version…</p>
      ) : (
        <p className="bulk-update-lead">
          Install agent <strong>{target}</strong> on <strong>{ids.length}</strong> of {endpoints.length} selected computer{endpoints.length === 1 ? '' : 's'}.
          {published === null && ' The published version could not be read, so every computer is offered.'}
        </p>
      )}
      <div className="bulk-update-groups">
        <Group title="Will update" tone="go" rows={plan.outdated.filter(row => includeOffline || row.online)} target={published} />
        {!!plan.current.length && (
          <Group title={`Already on ${target}`} tone="muted" rows={plan.current} note={reinstallCurrent ? 'Will be reinstalled' : 'Skipped'} />
        )}
        {!!plan.pending.length && <Group title="Update already pending" tone="muted" rows={plan.pending} note="Skipped" />}
        {!!plan.revoked.length && <Group title="Revoked" tone="muted" rows={plan.revoked} note="Skipped" />}
      </div>
      <div className="bulk-update-options">
        {!!plan.current.length && (
          <label>
            <input type="checkbox" checked={reinstallCurrent} onChange={event => setReinstallCurrent(event.target.checked)} />
            Also reinstall on {plan.current.length} computer{plan.current.length === 1 ? '' : 's'} already on {target}
          </label>
        )}
        {!!offlineEligible && (
          <label>
            <input type="checkbox" checked={includeOffline} onChange={event => setIncludeOffline(event.target.checked)} />
            Include {offlineEligible} offline computer{offlineEligible === 1 ? '' : 's'}; each update runs when that computer reconnects
          </label>
        )}
      </div>
      <div className="info-note compact">
        <ArrowDownToLine size={16} />
        <p>
          Each computer gets one fixed, server-written update job. Its agent restarts about 20 seconds after the job runs and
          reconnects within a minute; an open terminal or remote support session on it will end.
        </p>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-footer">
        <span><ShieldCheck size={14} /> One job per computer. No automatic retry.</span>
        <div>
          <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="button primary" disabled={busy || published === undefined || !ids.length} onClick={() => void submit()}>
            {busy ? <Loader2 size={15} className="spin" /> : <ArrowDownToLine size={15} />}
            {ids.length ? `Update ${ids.length} computer${ids.length === 1 ? '' : 's'}` : 'Nothing to update'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Group({ title, rows, tone, note, target }: { title: string; rows: PlannedComputer[]; tone: 'go' | 'muted'; note?: string; target?: string | null }) {
  return (
    <section className={`bulk-update-group ${tone}`}>
      <h3>{title} <span className="count-chip">{rows.length}</span>{note && <small>{note}</small>}</h3>
      {rows.length ? (
        <ul>
          {rows.map(row => (
            <li key={row.id}>
              <span className={`status-dot ${row.online ? 'green' : 'gray'}`} title={row.online ? 'Online' : 'Offline'} />
              <strong>{row.name}</strong>
              <span className="mono">{row.version === 'unknown' ? 'unknown version' : `v${row.version}`}{tone === 'go' && target ? ` → v${target}` : ''}</span>
              {!row.online && <small>offline</small>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
    </section>
  );
}
