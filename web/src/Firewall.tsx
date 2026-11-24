import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import './Firewall.css';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Source = { address: string; name: string; enabled: boolean; lastReceivedAt: string | null; hasRelayKey: boolean };
type Status = {
  receiver: 'starting' | 'listening' | 'disabled' | 'error';
  relayEnabled: boolean;
  sources: Source[];
  rejected: number;
  dropped: number;
  lastStorageError: string | null;
  retentionDays: number;
  maxEvents: number;
};
type TrafficEvent = {
  id: number; sender: string; receivedAt: string; raw: string;
  action: 'allow' | 'deny' | null; srcIp: string | null; dstIp: string | null;
  srcPort: number | null; dstPort: number | null; protocol: string | null; policy: string | null;
};
type Page = { events: TrafficEvent[]; nextBefore: number | null };
const receiverLabel: Record<Status['receiver'], string> = {
  starting: 'Receiver starting', listening: 'Receiver listening', disabled: 'Receiver disabled', error: 'Receiver failed to start',
};
const newSource = { address: '', name: '', enabled: true, lastReceivedAt: null, hasRelayKey: false };
const formatTime = (value: string) => new Date(value).toLocaleString();
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Firewall request failed.';

function addressWithPort(ip: string | null, port: number | null) {
  if (!ip) return '—';
  if (port === null) return ip;
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}

export function Firewall({ request, canManage }: { request: Request; canManage: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [sender, setSender] = useState('');
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursors, setCursors] = useState<number[]>([]);
  const [editing, setEditing] = useState<Source | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [relaySource, setRelaySource] = useState<Source | null>(null);
  const [relayKey, setRelayKey] = useState('');
  const [relayMessage, setRelayMessage] = useState('');
  const [relayBusy, setRelayBusy] = useState(false);
  const before = cursors.at(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (sender) params.set('sender', sender);
    if (action) params.set('action', action);
    if (query) params.set('query', query);
    if (before) params.set('before', String(before));
    Promise.all([request<Status>('/firewall'), request<Page>(`/firewall/events?${params}`)])
      .then(([nextStatus, nextPage]) => {
        if (!cancelled) { setStatus(nextStatus); setPage(nextPage); }
      })
      .catch(err => { if (!cancelled) { setPage(null); setError(errorText(err)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request, sender, action, query, before, refresh]);

  function edit(source?: Source) {
    setEditing(source ?? newSource);
    setEditingExisting(Boolean(source));
    setSaveError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    const address = editing.address.trim();
    if (!editingExisting && status?.sources.some(source => source.address === address)) {
      setSaveError('This address is already registered. Edit the existing Firebox.');
      return;
    }
    setSaving(true);
    setSaveError('');
    try {
      await request(`/firewall/sources/${encodeURIComponent(address)}`, 'PUT', { name: editing.name, enabled: editing.enabled });
      setEditing(null);
      setRefresh(value => value + 1);
    } catch (err) {
      setSaveError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  async function changeRelayKey(revoke = false) {
    if (!relaySource || relayBusy) return;
    setRelayBusy(true);
    setRelayKey('');
    setRelayMessage('');
    try {
      const path = `/firewall/sources/${encodeURIComponent(relaySource.address)}/relay-key`;
      if (revoke) {
        await request(path, 'DELETE');
        setRelayMessage('Relay key revoked.');
      } else {
        const result = await request<{ key: string }>(path, 'POST', {});
        setRelayKey(result.key);
      }
      setRelaySource({ ...relaySource, hasRelayKey: !revoke });
      setRefresh(value => value + 1);
    } catch (err) {
      setRelayMessage(errorText(err));
    } finally {
      setRelayBusy(false);
    }
  }

  return <div className="firewall">
    <section className="panel">
      <div className="panel-heading">
        <div><h2>Fireboxes</h2><p aria-live="polite">{status ? [status.relayEnabled && 'HTTPS relay enabled',
          (!status.relayEnabled || status.receiver !== 'disabled') && receiverLabel[status.receiver]].filter(Boolean).join(' · ') : 'Syslog receiver status'}</p></div>
        <div className="firewall-actions">
          {canManage && status?.relayEnabled && <a className="button secondary small" href="/api/firewall/relay-installer">Windows relay installer</a>}
          <button type="button" className="button secondary small" disabled={loading} onClick={() => { setCursors([]); setRefresh(value => value + 1); }}>
            <RefreshCw size={15} /> Refresh
          </button>
          {canManage && <button type="button" className="button primary small" disabled={saving} onClick={() => edit()}>Add Firebox</button>}
        </div>
      </div>
      {error && <p role="alert" className="firewall-message">{error}</p>}
      {status?.receiver === 'disabled' && !status.relayEnabled && <p className="firewall-message muted">Enable the syslog receiver on the RMM host to start collecting traffic.</p>}
      {status?.receiver === 'error' && <p className="firewall-message" role="alert">Check the RMM server logs for the syslog bind error.</p>}
      {status && (status.rejected > 0 || status.dropped > 0 || status.lastStorageError) && <p className="firewall-message muted">
        Since restart, {status.rejected.toLocaleString()} datagrams rejected and {status.dropped.toLocaleString()} dropped by the collector.
        {status.lastStorageError && ` Last storage error ${formatTime(status.lastStorageError)}.`}
      </p>}
      {status?.sources.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">Firebox</th><th scope="col">Sender IPv4</th><th scope="col">Collection</th><th scope="col">Last log received</th>{canManage && <th scope="col">Manage</th>}</tr></thead>
        <tbody>{status.sources.map(source => <tr key={source.address}>
          <td>{source.name}</td><td><code>{source.address}</code></td><td>{source.enabled ? 'Enabled' : 'Paused'}</td>
          <td>{source.lastReceivedAt ? formatTime(source.lastReceivedAt) : 'No logs received'}</td>
          {canManage && <td><div className="firewall-actions">
            <button type="button" className="button secondary small" disabled={saving} aria-label={`Edit ${source.name}`} onClick={() => edit(source)}>Edit</button>
            {status.relayEnabled && <button type="button" className="button secondary small" disabled={relayBusy} aria-label={`Relay setup for ${source.name}`} onClick={() => {
              setRelaySource(source); setRelayKey(''); setRelayMessage('');
            }}>Relay setup</button>}
          </div></td>}
        </tr>)}</tbody>
      </table></div> : status && <p className="firewall-message muted">No Fireboxes registered. Add the sender IPv4 address seen by the RMM receiver.</p>}
      {editing && <form className="firewall-form" onSubmit={save}>
        <label>Firebox name<input required maxLength={100} value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /></label>
        <label>Sender IPv4<input required maxLength={15} disabled={editingExisting} value={editing.address} onChange={e => setEditing({ ...editing, address: e.target.value })} /></label>
        <label className="firewall-checkbox"><input type="checkbox" checked={editing.enabled} onChange={e => setEditing({ ...editing, enabled: e.target.checked })} /> Collect traffic</label>
        <div className="firewall-actions">
          <button className="button primary small" disabled={saving}>Save Firebox</button>
          <button type="button" className="button secondary small" disabled={saving} onClick={() => setEditing(null)}>Cancel</button>
        </div>
        {saveError && <p role="alert">{saveError}</p>}
      </form>}
      {relaySource && <div className="firewall-message firewall-relay">
        <h3>Relay setup for {relaySource.name}</h3>
        <p className="muted">Enter {relaySource.address} as the Firebox address when running the Windows relay installer.</p>
        {relaySource.hasRelayKey && !relayKey && <p>Replacing or revoking the key will disconnect any relay using it.</p>}
        {relayKey && <label>Relay key shown once<input readOnly value={relayKey} onFocus={event => event.currentTarget.select()} /></label>}
        {relayMessage && <p role="status">{relayMessage}</p>}
        <div className="firewall-actions">
          {!relayKey && <button type="button" className="button primary small" disabled={relayBusy} onClick={() => void changeRelayKey()}>
            {relaySource.hasRelayKey ? 'Replace relay key' : 'Generate relay key'}
          </button>}
          {relaySource.hasRelayKey && !relayKey && <button type="button" className="button secondary small" disabled={relayBusy} onClick={() => void changeRelayKey(true)}>Revoke relay key</button>}
          <button type="button" className="button secondary small" disabled={relayBusy} onClick={() => { setRelaySource(null); setRelayKey(''); }}>Done</button>
        </div>
      </div>}
    </section>
    <section className="panel" aria-busy={loading}>
      <div className="panel-heading"><div><h2>Traffic logs</h2>
        {status && <p>Up to {status.maxEvents.toLocaleString()} events from the last {status.retentionDays} days.</p>}
      </div></div>
      <form className="firewall-form" onSubmit={e => { e.preventDefault(); setCursors([]); setQuery(search.trim()); }}>
        <label>Firebox<select value={sender} onChange={e => { setCursors([]); setSender(e.target.value); }}>
          <option value="">All Fireboxes</option>
          {status?.sources.map(source => <option key={source.address} value={source.address}>{source.name} ({source.address})</option>)}
        </select></label>
        <label>Action<select value={action} onChange={e => { setCursors([]); setAction(e.target.value); }}>
          <option value="">All actions</option><option value="allow">Allowed</option><option value="deny">Denied</option><option value="unparsed">Unparsed</option>
        </select></label>
        <label>IP address or policy<input type="search" maxLength={100} value={search} onChange={e => setSearch(e.target.value)} /></label>
        <button className="button secondary small">Search</button>
      </form>
      {loading ? <p className="firewall-message muted" role="status">Loading traffic logs…</p> :
        page && (page.events.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">Received</th><th scope="col">Firebox</th><th scope="col">Action</th><th scope="col">Source</th><th scope="col">Destination</th><th scope="col">Protocol</th><th scope="col">Policy</th><th scope="col">Syslog</th></tr></thead>
          <tbody>{page.events.map(row => <tr key={row.id}>
            <td>{formatTime(row.receivedAt)}</td>
            <td>{status?.sources.find(source => source.address === row.sender)?.name ?? row.sender}</td>
            <td><span className={`firewall-action ${row.action ?? ''}`}>{row.action === 'allow' ? 'Allowed' : row.action === 'deny' ? 'Denied' : 'Unparsed'}</span></td>
            <td><code>{addressWithPort(row.srcIp, row.srcPort)}</code></td><td><code>{addressWithPort(row.dstIp, row.dstPort)}</code></td>
            <td>{row.protocol ?? '—'}</td><td>{row.policy ?? '—'}</td>
            <td><details className="firewall-raw"><summary>Raw log</summary><pre>{row.raw}</pre></details></td>
          </tr>)}</tbody>
        </table></div> : <p className="firewall-message muted">No traffic events match these filters.</p>)}
      {page && (Boolean(cursors.length) || page.nextBefore !== null) && <div className="firewall-actions firewall-paging">
        <button type="button" className="button secondary small" disabled={loading || !cursors.length} onClick={() => setCursors(values => values.slice(0, -1))}>Newer</button>
        <button type="button" className="button secondary small" disabled={loading || page.nextBefore === null} onClick={() => {
          const next = page.nextBefore;
          if (next !== null) setCursors(values => [...values, next]);
        }}>Older</button>
      </div>}
    </section>
  </div>;
}
