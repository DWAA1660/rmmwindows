import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Activity, Bell, Download, ListFilter, Network, Radar, RefreshCw, Router } from 'lucide-react';
import { FirewallAlerts, FirewallDetailFilters, detailFilters } from './FirewallAlerts';
import { FirewallOverview } from './FirewallOverview';
import { FirewallDevices } from './FirewallDevices';
import {
  actions, alertSummary, filterLabels, firewallError as errorText, formatFirewallBytes,
  formatFirewallTime as formatTime, ranges,
  type AlertInbox, type FirewallRequest, type FirewallRange, type FirewallSource as Source, type TrafficFilters,
} from './firewallTypes';
import './Firewall.css';

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
  application: string | null; host: string | null; sentBytes: number | null; receivedBytes: number | null; messageId: string | null;
};
type Page = { events: TrafficEvent[]; nextBefore: number | null };
const receiverLabel: Record<Status['receiver'], string> = {
  starting: 'Receiver starting', listening: 'Receiver listening', disabled: 'Receiver disabled', error: 'Receiver failed to start',
};
const newSource = { address: '', name: '', enabled: true, lastReceivedAt: null, hasRelayKey: false };
const tabs = [
  { key: 'overview', label: 'Overview', icon: Activity },
  { key: 'traffic', label: 'Traffic logs', icon: ListFilter },
  { key: 'devices', label: 'Observed devices', icon: Network },
  { key: 'alerts', label: 'Alerts', icon: Bell },
  { key: 'sources', label: 'Fireboxes', icon: Router },
] as const;

function addressWithPort(ip: string | null, port: number | null) {
  if (!ip) return '—';
  if (port === null) return ip;
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}

export function Firewall({ request, canManage, onOpenScanner }: { request: FirewallRequest; canManage: boolean; onOpenScanner: () => void }) {
  const [tab, setTab] = useState<typeof tabs[number]['key']>('overview');
  const [range, setRange] = useState<FirewallRange>('24');
  const [live, setLive] = useState(true);
  const [inbox, setInbox] = useState<AlertInbox | null>(null);
  const [alertError, setAlertError] = useState('');
  const [browserAlerts, setBrowserAlerts] = useState(false);
  const [browserMessage, setBrowserMessage] = useState('');
  const latestAlert = useRef<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [sourceError, setSourceError] = useState('');
  const [eventError, setEventError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [sender, setSender] = useState('');
  const [filters, setFilters] = useState<TrafficFilters>({});
  const [draftFilters, setDraftFilters] = useState<TrafficFilters>({});
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [searchRaw, setSearchRaw] = useState(false);
  const [queryRaw, setQueryRaw] = useState(false);
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
  const params = new URLSearchParams({ hours: range });
  if (sender) params.set('sender', sender);
  for (const [field, value] of Object.entries(filters)) {
    if (value) params.set(field, String(value));
  }
  if (query) params.set('query', query);
  if (queryRaw) params.set('searchRaw', 'true');
  const csvQuery = params.toString();
  if (before) params.set('before', String(before));
  const eventQuery = params.toString();

  useEffect(() => {
    if (!live || tab === 'alerts' || (tab === 'traffic' && before !== undefined)) return;
    const timer = window.setInterval(() => setRefresh(value => value + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [live, before, tab]);

  useEffect(() => {
    let cancelled = false;
    request<Status>('/firewall').then(next => {
      if (!cancelled) { setStatus(next); setSourceError(''); }
    }).catch(err => { if (!cancelled) setSourceError(errorText(err)); });
    return () => { cancelled = true; };
  }, [request, refresh]);

  useEffect(() => { setPage(null); }, [eventQuery]);
  useEffect(() => {
    if (tab !== 'traffic') return;
    let cancelled = false;
    setLoading(true);
    request<Page>(`/firewall/events?${eventQuery}`)
      .then(next => { if (!cancelled) { setPage(next); setEventError(''); } })
      .catch(err => { if (!cancelled) setEventError(errorText(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [request, eventQuery, refresh, tab]);

  useEffect(() => {
    let active = true;
    let pending = false;
    async function readAlerts() {
      if (pending) return;
      pending = true;
      try {
        const next = await request<AlertInbox>('/firewall/alerts');
        if (!active) return;
        const previous = latestAlert.current;
        latestAlert.current = Math.max(previous ?? 0, next.alerts[0]?.id ?? 0);
        setInbox(next);
        setAlertError('');
        if (previous !== null && browserAlerts && Notification.permission === 'granted') {
          for (const alert of next.alerts.filter(item => item.id > previous && !item.acknowledgedAt).slice(0, 3)) {
            try {
              const notice = new Notification('Library RMM firewall alert', { body: alertSummary(alert), tag: `firewall-alert-${alert.id}` });
              notice.onclick = () => { window.focus(); setTab('alerts'); notice.close(); };
            } catch {
              setBrowserAlerts(false);
              setBrowserMessage('Desktop notices are unavailable in this browser.');
              break;
            }
          }
        }
      } catch (err) { if (active) setAlertError(errorText(err)); }
      finally { pending = false; }
    }
    void readAlerts();
    const timer = window.setInterval(readAlerts, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, refresh, browserAlerts]);

  async function toggleBrowserAlerts() {
    if (browserAlerts) { setBrowserAlerts(false); setBrowserMessage(''); return; }
    try {
      const permission = await Notification.requestPermission();
      setBrowserAlerts(permission === 'granted');
      setBrowserMessage(permission === 'granted' ? 'Desktop notices enabled for this Firewall page.' : 'Desktop notices were blocked by your browser.');
    } catch {
      setBrowserMessage('Desktop notices are unavailable in this browser.');
    }
  }

  function drill(next: TrafficFilters = {}) {
    const { sender: address, ...choices } = next;
    setSender(address ?? '');
    setDraftFilters(choices);
    setFilters(choices);
    setSearch('');
    setQuery('');
    setSearchRaw(false);
    setQueryRaw(false);
    setCursors([]);
    setTab('traffic');
  }

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
    <div className="firewall-toolbar">
      <nav className="firewall-tabs" aria-label="Firewall views">
        {tabs.map(({ key, label, icon: Icon }) => <button key={key} type="button" aria-current={tab === key ? 'page' : undefined}
          onClick={() => { setTab(key); if (key !== 'sources') { setRelayKey(''); setRelaySource(null); } }}>
          <Icon size={16} /> {label}{key === 'alerts' && Boolean(inbox?.open) && <span>{inbox?.open}</span>}
        </button>)}
      </nav>
      <div className="firewall-actions">
        <label className="firewall-check"><input type="checkbox" checked={live} onChange={e => setLive(e.target.checked)} /> Auto-refresh</label>
        {(tab === 'overview' || tab === 'traffic' || tab === 'devices') && <select aria-label="Time range" value={range} onChange={e => {
          setCursors([]); setRange(e.target.value as FirewallRange);
        }}>{Object.entries(ranges).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}
        <button type="button" className="button secondary small" onClick={() => { setCursors([]); setRefresh(value => value + 1); }}>
          <RefreshCw size={15} /> Refresh
        </button>
        <button type="button" className="button secondary small" onClick={onOpenScanner}><Radar size={15} /> Network scanner</button>
      </div>
    </div>
    {tab === 'overview' && <>
      {sourceError && <p role="alert" className="firewall-message firewall-error">{sourceError}</p>}
      {status && <section className="panel firewall-source-strip" aria-label="Firebox status">
        {status.sources.length ? status.sources.map(source => {
          const minutes = source.lastReceivedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(source.lastReceivedAt)) / 60_000)) : null;
          const label = !source.enabled ? 'Paused' : minutes === null ? 'No logs received' : minutes < 1 ? 'Log received just now' : `Last log ${minutes.toLocaleString()} min ago`;
          return <button type="button" key={source.address} onClick={() => setSender(source.address === sender ? '' : source.address)}
            aria-pressed={source.address === sender} title={source.lastReceivedAt ? formatTime(source.lastReceivedAt) : undefined}>
            <span className={source.enabled && minutes !== null && minutes < 15 ? 'firewall-dot recent' : 'firewall-dot'} />
            <strong>{source.name}</strong><span>{label}</span>
          </button>;
        }) : <button type="button" onClick={() => setTab('sources')}><Router size={15} /> Set up a Firebox</button>}
        <button type="button" onClick={() => setTab('sources')}>Collection status</button>
      </section>}
      <FirewallOverview request={request} sources={status?.sources ?? []} sender={sender} range={range} refresh={refresh}
        onSender={setSender} onTraffic={next => drill({ ...next, sender })} />
    </>}
    {tab === 'devices' && <FirewallDevices request={request} range={range} sender={sender} onSender={setSender}
      sources={status?.sources ?? []} refresh={refresh} onTraffic={next => drill({ ...next, sender })} />}
    {tab === 'alerts' && <>
      {browserMessage && <p role="status" className="firewall-message muted">{browserMessage}</p>}
      <FirewallAlerts inbox={inbox} loadError={alertError} sources={status?.sources ?? []} request={request}
        canManage={canManage} browserAlerts={browserAlerts} onBrowserAlerts={() => void toggleBrowserAlerts()}
        onRefresh={() => setRefresh(value => value + 1)} onTraffic={drill} />
    </>}
    {tab === 'sources' && <section className="panel">
      <div className="panel-heading">
        <div><h2>Fireboxes</h2><p aria-live="polite">{status ? [status.relayEnabled && 'HTTPS relay enabled',
          (!status.relayEnabled || status.receiver !== 'disabled') && receiverLabel[status.receiver]].filter(Boolean).join(' · ') : 'Syslog receiver status'}</p></div>
        <div className="firewall-actions">
          {canManage && status?.relayEnabled && <a className="button secondary small" href="/api/firewall/relay-installer">Windows relay installer</a>}
          {canManage && <button type="button" className="button primary small" disabled={saving} onClick={() => edit()}>Add Firebox</button>}
        </div>
      </div>
      {sourceError && <p role="alert" className="firewall-message firewall-error">{sourceError}</p>}
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
    </section>}
    {tab === 'traffic' && <section className="panel" aria-busy={loading && !page}>
      <div className="panel-heading"><div><h2>Traffic logs</h2>
        {status && <p>Up to {status.maxEvents.toLocaleString()} events from the last {status.retentionDays} days.</p>}
      </div><a className="button secondary small" href={`/api/firewall/events.csv?${csvQuery}`} title="Export up to 5,000 matching events">
        <Download size={15} /> Export CSV
      </a></div>
      {eventError && <p role="alert" className="firewall-message firewall-error">{eventError}</p>}
      <form className="firewall-form" onSubmit={e => {
        e.preventDefault(); setCursors([]); setQuery(search.trim()); setQueryRaw(searchRaw); setFilters(draftFilters);
      }}>
        <label>Firebox<select value={sender} onChange={e => { setCursors([]); setSender(e.target.value); }}>
          <option value="">All Fireboxes</option>
          {status?.sources.map(source => <option key={source.address} value={source.address}>{source.name} ({source.address})</option>)}
        </select></label>
        <label>Action<select value={draftFilters.action ?? ''} onChange={e => {
          const action = e.target.value as TrafficFilters['action'];
          setCursors([]); setDraftFilters({ ...draftFilters, action }); setFilters({ ...filters, action });
        }}>
          <option value="">All actions</option>{Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Search traffic<input type="search" maxLength={100} value={search} onChange={e => setSearch(e.target.value)}
          placeholder="IP, hostname, or policy" /></label>
        <button className="button secondary small">Search</button>
        <button type="button" className="button secondary small" onClick={() => drill()}>Clear filters</button>
        <details className="firewall-advanced" open={detailFilters.some(field => Boolean(filters[field])) || undefined}>
          <summary>Advanced filters</summary>
          <FirewallDetailFilters value={draftFilters} onChange={setDraftFilters} />
          <label className="firewall-check"><input type="checkbox" checked={searchRaw}
            onChange={e => setSearchRaw(e.target.checked)} /> Include raw logs in search (3 or more characters)</label>
          <button className="button secondary small">Apply filters</button>
        </details>
      </form>
      {detailFilters.some(field => Boolean(filters[field])) && <div className="firewall-chips">
        {detailFilters.filter(field => filters[field]).map(field => <span key={field}>{filterLabels[field]} {filters[field]}</span>)}
      </div>}
      {loading && !page ? <p className="firewall-message muted" role="status">Loading traffic logs…</p> :
        page && (page.events.length ? <div className="table-scroll"><table>
          <thead><tr><th scope="col">Received</th><th scope="col">Firebox</th><th scope="col">Action</th><th scope="col">Source</th><th scope="col">Destination</th><th scope="col">Protocol</th><th scope="col">Policy / app</th><th scope="col">Reported bytes</th><th scope="col">Syslog</th></tr></thead>
          <tbody>{page.events.map(row => <tr key={row.id}>
            <td>{formatTime(row.receivedAt)}</td>
            <td>{status?.sources.find(source => source.address === row.sender)?.name ?? row.sender}</td>
            <td><span className={`firewall-action ${row.action ?? ''}`}>{row.action === 'allow' ? 'Allowed' : row.action === 'deny' ? 'Denied' : 'Unparsed'}</span></td>
            <td><code>{addressWithPort(row.srcIp, row.srcPort)}</code></td><td><code>{addressWithPort(row.dstIp, row.dstPort)}</code></td>
            <td>{row.protocol ?? '—'}</td><td>{row.policy ?? '—'}{(row.host || row.application) && <div className="firewall-log-meta">{row.host ?? row.application}</div>}</td>
            <td>{row.sentBytes == null && row.receivedBytes == null ? '—' : formatFirewallBytes((row.sentBytes ?? 0) + (row.receivedBytes ?? 0))}</td>
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
    </section>}
  </div>;
}
