import { useState } from 'react';
import { Check, Monitor, Trash2, X } from 'lucide-react';

export type JoinRequest = {
  id: string; deviceId: string; hostname: string; remoteIp?: string | null; status: 'pending' | 'approved' | 'denied';
  details: { osName?: string; osVersion?: string; domain?: string; agentVersion?: string };
  endpointId?: string | null; createdAt: string; lastPollAt: string; decidedBy?: string | null; decidedAt?: string | null;
};
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

const ago = (iso?: string | null) => {
  if (!iso) return '—';
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};

/** Computers that installed the agent without a token and are asking to join. */
export function JoinRequests({ requests, request, canDecide, onChanged }: {
  requests: JoinRequest[]; request: Request; canDecide: boolean; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const pending = requests.filter(row => row.status === 'pending');
  const decided = requests.filter(row => row.status !== 'pending');
  const act = async (row: JoinRequest, action: 'approve' | 'deny' | 'remove') => {
    if (action === 'approve' && !window.confirm(`Approve ${row.hostname}${row.remoteIp ? ` (${row.remoteIp})` : ''}? It will be able to receive administrative jobs from this console.`)) return;
    setBusy(row.id); setError('');
    try {
      if (action === 'remove') await request(`/join-requests/${row.id}`, 'DELETE');
      else await request(`/join-requests/${row.id}/${action}`, 'POST', {});
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  };
  const machine = (row: JoinRequest) => (
    <div className="join-machine">
      <strong>{row.hostname}</strong>
      <small>{[row.details?.osName, row.details?.domain && `Domain ${row.details.domain}`, row.details?.agentVersion && `Agent ${row.details.agentVersion}`].filter(Boolean).join(' · ') || '—'}</small>
    </div>
  );
  return (
    <section className="panel join-requests">
      <div className="panel-heading">
        <div>
          <h2>Waiting for approval {pending.length > 0 && <span className="nav-count join-count">{pending.length}</span>}</h2>
          <p>Computers that ran the install command appear here. Approve only computers you recognize.</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {pending.length ? (
        <div className="table-scroll">
          <table>
            <thead><tr><th>COMPUTER</th><th>IP ADDRESS</th><th>REQUESTED</th><th>LAST CHECKED IN</th><th /></tr></thead>
            <tbody>
              {pending.map(row => (
                <tr key={row.id}>
                  <td>{machine(row)}</td>
                  <td>{row.remoteIp || '—'}</td>
                  <td>{ago(row.createdAt)}</td>
                  <td>{ago(row.lastPollAt)}</td>
                  <td className="join-actions">
                    {canDecide ? <>
                      <button className="button small" disabled={busy === row.id} onClick={() => void act(row, 'approve')}><Check size={14} /> Approve</button>
                      <button className="button small secondary" disabled={busy === row.id} onClick={() => void act(row, 'deny')}><X size={14} /> Deny</button>
                    </> : <small className="muted">Operator or administrator required</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="join-empty"><Monitor size={20} /><p>No computers are waiting. New installs show up here within a few seconds.</p></div>
      )}
      {decided.length > 0 && (
        <details className="join-history">
          <summary>Recent decisions ({decided.length})</summary>
          <div className="table-scroll">
            <table>
              <thead><tr><th>COMPUTER</th><th>DECISION</th><th>BY</th><th>WHEN</th><th /></tr></thead>
              <tbody>
                {decided.map(row => (
                  <tr key={row.id}>
                    <td>{machine(row)}</td>
                    <td><span className={`status ${row.status === 'approved' ? 'status-succeeded' : 'status-failed'}`}><span />{row.status === 'approved' ? (row.endpointId ? 'Joined' : 'Approved · waiting for agent') : 'Denied'}</span></td>
                    <td>{row.decidedBy || '—'}</td>
                    <td>{ago(row.decidedAt)}</td>
                    <td className="join-actions">
                      {canDecide && row.status === 'denied' && <>
                        <button className="button small secondary" disabled={busy === row.id} onClick={() => void act(row, 'approve')}><Check size={14} /> Approve</button>
                        <button className="button small secondary" disabled={busy === row.id} title="Forget this request so the computer can ask again" onClick={() => void act(row, 'remove')}><Trash2 size={14} /> Remove</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
