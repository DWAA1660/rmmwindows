import { useEffect, useState, type FormEvent } from 'react';
import { Bell, Check, Plus } from 'lucide-react';
import {
  actions, alertSummary, filterLabels, firewallError, formatFirewallTime,
  type AlertDraft, type AlertInbox, type AlertRule, type FirewallRequest, type FirewallSource, type TrafficFilters,
} from './firewallTypes';

export const detailFilters = ['srcIp', 'dstIp', 'dstPort', 'protocol', 'policy', 'application', 'host', 'messageId'] as const;

export function FirewallDetailFilters({ value, onChange }: { value: TrafficFilters; onChange: (value: TrafficFilters) => void }) {
  return <div className="firewall-filter-fields">
    {detailFilters.map(field => <label key={field}>{filterLabels[field]}
      <input value={value[field] ?? ''} inputMode={field === 'dstPort' ? 'numeric' : undefined}
        maxLength={field === 'dstPort' ? 5 : 253}
        onChange={event => onChange({ ...value, [field]: event.target.value })} />
    </label>)}
  </div>;
}

const templates: { label: string; draft: AlertDraft }[] = [
  { label: 'Denied traffic burst', draft: { name: 'Denied traffic burst', kind: 'traffic', threshold: 50, windowMinutes: 5, cooldownMinutes: 30, enabled: true, filters: { action: 'deny' } } },
  { label: 'Firebox stops reporting', draft: { name: 'Firebox stops reporting', kind: 'silence', threshold: 15, windowMinutes: 15, cooldownMinutes: 60, enabled: true, filters: {} } },
  { label: 'Unparsed traffic spike', draft: { name: 'Unparsed traffic spike', kind: 'traffic', threshold: 20, windowMinutes: 5, cooldownMinutes: 60, enabled: true, filters: { action: 'unparsed' } } },
  { label: 'Custom traffic rule', draft: { name: '', kind: 'traffic', threshold: 10, windowMinutes: 5, cooldownMinutes: 30, enabled: true, filters: {} } },
];

function filterSummary(filters: TrafficFilters, sources: FirewallSource[]) {
  return Object.entries(filters).filter(([, value]) => value !== '').map(([field, value]) => {
    if (field === 'sender') return sources.find(source => source.address === value)?.name ?? value;
    if (field === 'action') return actions[value as keyof typeof actions];
    return `${filterLabels[field as keyof TrafficFilters]} ${value}`;
  }).join(' · ');
}

export function FirewallAlerts({ inbox, loadError, sources, request, canManage, browserAlerts, onBrowserAlerts, onRefresh, onTraffic }: {
  inbox: AlertInbox | null; loadError: string; sources: FirewallSource[]; request: FirewallRequest; canManage: boolean;
  browserAlerts: boolean; onBrowserAlerts: () => void; onRefresh: () => void; onTraffic: (filters: TrafficFilters) => void;
}) {
  const [draft, setDraft] = useState<AlertDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [cursors, setCursors] = useState<number[]>([]);
  const [older, setOlder] = useState<AlertInbox | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshHistory, setRefreshHistory] = useState(0);
  const before = cursors.at(-1);

  useEffect(() => {
    if (!before) { setOlder(null); setLoading(false); return; }
    let active = true;
    setLoading(true);
    request<AlertInbox>(`/firewall/alerts?before=${before}`).then(data => {
      if (active) { setOlder(data); setError(''); }
    }).catch(err => { if (active) setError(firewallError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [before, refreshHistory, request]);

  function edit(next: AlertDraft, id?: string) {
    const filters = Object.fromEntries(Object.entries(next.filters).map(([field, value]) => [field, String(value)]));
    setDraft({ ...next, filters });
    setEditingId(id ?? null);
    setError('');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError('');
    try {
      const filters = Object.fromEntries(Object.entries(draft.filters).filter(([, value]) => value?.trim()));
      await request<AlertRule>(editingId ? `/firewall/alert-rules/${editingId}` : '/firewall/alert-rules',
        editingId ? 'PUT' : 'POST', { ...draft, filters });
      setDraft(null);
      onRefresh();
    } catch (err) { setError(firewallError(err)); }
    finally { setBusy(false); }
  }

  async function acknowledge(id: number) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(`/firewall/alerts/${id}/acknowledge`, 'POST', {});
      onRefresh();
      setRefreshHistory(value => value + 1);
    } catch (err) { setError(firewallError(err)); }
    finally { setBusy(false); }
  }

  const page = before ? older : inbox;
  const visible = page?.alerts.filter(alert => showAcknowledged || !alert.acknowledgedAt) ?? [];
  return <>
    <section className="panel">
      <div className="panel-heading">
        <div><h2>Alert inbox</h2><p>{inbox ? `${inbox.open.toLocaleString()} open across the workspace` : 'Loading alerts'}</p></div>
        <div className="firewall-actions">
          {typeof Notification !== 'undefined' && <button type="button" className="button secondary small"
            aria-pressed={browserAlerts} onClick={onBrowserAlerts}><Bell size={15} />
            {browserAlerts ? 'Turn off desktop notices' : 'Enable desktop notices'}
          </button>}
          <label className="firewall-check"><input type="checkbox" checked={showAcknowledged}
            onChange={event => setShowAcknowledged(event.target.checked)} /> Include acknowledged</label>
        </div>
      </div>
      {loadError && <p role="alert" className="firewall-message firewall-error">{loadError}</p>}
      {error && !draft && <p role="alert" className="firewall-message firewall-error">{error}</p>}
      {typeof Notification !== 'undefined' && <p className="firewall-message muted">Desktop notices require browser permission and this Firewall page to remain open.</p>}
      {visible.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">Alert</th><th scope="col">Triggered</th><th scope="col">Evidence</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody>{visible.map(alert => <tr key={alert.id}>
          <td><strong>{alert.ruleName}</strong><div className="muted">{filterSummary(alert.filters, sources)}</div></td>
          <td>{formatFirewallTime(alert.firedAt)}</td><td>{alertSummary(alert)}</td>
          <td>{alert.acknowledgedAt ? `Acknowledged by ${alert.acknowledgedBy}` : 'Open'}</td>
          <td><div className="firewall-actions">
            <button type="button" className="button secondary small" onClick={() => onTraffic(alert.filters)}>View traffic</button>
            {!alert.acknowledgedAt && <button type="button" className="button secondary small" disabled={busy} onClick={() => void acknowledge(alert.id)}>
              <Check size={14} /> Acknowledge
            </button>}
          </div></td>
        </tr>)}</tbody>
      </table></div> : page && <p className="firewall-message muted">{showAcknowledged ? 'No alerts on this page.' : 'No open alerts on this page.'}</p>}
      {(before || page?.nextBefore) && <div className="firewall-actions firewall-paging">
        <button type="button" className="button secondary small" disabled={!before || loading}
          onClick={() => setCursors(values => values.slice(0, -1))}>Newer alerts</button>
        <button type="button" className="button secondary small" disabled={!page?.nextBefore || loading}
          onClick={() => { const next = page?.nextBefore; if (next) setCursors(values => [...values, next]); }}>Older alerts</button>
      </div>}
    </section>
    <section className="panel">
      <div className="panel-heading"><div><h2>Alert rules</h2><p>Set thresholds on logged events or detect when a Firebox stops sending.</p></div></div>
      {canManage && <div className="firewall-message firewall-actions">
        {templates.map(template => <button type="button" key={template.label} className="button secondary small"
          disabled={busy} onClick={() => edit(template.draft)}><Plus size={13} /> {template.label}</button>)}
      </div>}
      {draft && <form className="firewall-rule-form" onSubmit={save}>
        <h3>{editingId ? 'Edit alert rule' : 'New alert rule'}</h3>
        <div className="firewall-filter-fields">
          <label>Rule name<input required maxLength={100} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label>Condition<select value={draft.kind} onChange={e => {
            const kind = e.target.value as AlertDraft['kind'];
            setDraft({ ...draft, kind, filters: kind === 'silence' ? { sender: draft.filters.sender } : draft.filters });
          }}><option value="traffic">Traffic threshold</option><option value="silence">No traffic received</option></select></label>
          <label>Firebox<select required={draft.kind === 'silence'} value={draft.filters.sender ?? ''} onChange={e => setDraft({ ...draft, filters: { ...draft.filters, sender: e.target.value } })}>
            <option value="">{draft.kind === 'silence' ? 'Select Firebox' : 'All Fireboxes'}</option>
            {sources.map(source => <option key={source.address} value={source.address}>{source.name}</option>)}
          </select></label>
          {draft.kind === 'traffic' && <>
            <label>Action<select value={draft.filters.action ?? ''} onChange={e => setDraft({ ...draft, filters: { ...draft.filters, action: e.target.value as TrafficFilters['action'] } })}>
              <option value="">All actions</option>
              {Object.entries(actions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
            <label>Event threshold<input type="number" required min={1} max={50_000} value={draft.threshold || ''} onChange={e => setDraft({ ...draft, threshold: Number(e.target.value) })} /></label>
          </>}
          <label>{draft.kind === 'silence' ? 'No traffic for (minutes)' : 'Window (minutes)'}<input type="number" required min={1} max={1440} value={draft.windowMinutes || ''} onChange={e => setDraft({ ...draft, windowMinutes: Number(e.target.value) })} /></label>
          <label>Cooldown (minutes)<input type="number" required min={1} max={1440} value={draft.cooldownMinutes || ''} onChange={e => setDraft({ ...draft, cooldownMinutes: Number(e.target.value) })} /></label>
        </div>
        {draft.kind === 'traffic' && <details><summary>Optional traffic filters</summary>
          <FirewallDetailFilters value={draft.filters} onChange={filters => setDraft({ ...draft, filters })} />
        </details>}
        <label className="firewall-check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> Enable rule</label>
        {error && <p role="alert" className="firewall-error">{error}</p>}
        <div className="firewall-actions">
          <button className="button primary small" disabled={busy}>Save rule</button>
          <button type="button" className="button secondary small" disabled={busy} onClick={() => { setDraft(null); setError(''); }}>Cancel</button>
        </div>
      </form>}
      {inbox?.rules.length ? <div className="table-scroll"><table>
        <thead><tr><th scope="col">Rule</th><th scope="col">Condition</th><th scope="col">Cooldown</th><th scope="col">State</th><th scope="col">Last triggered</th>{canManage && <th scope="col">Manage</th>}</tr></thead>
        <tbody>{inbox.rules.map(rule => <tr key={rule.id}>
          <td><strong>{rule.name}</strong><div className="muted">{filterSummary(rule.filters, sources)}</div></td>
          <td>{rule.kind === 'silence' ? `No traffic for ${rule.windowMinutes} min` : `${rule.threshold.toLocaleString()} events in ${rule.windowMinutes} min`}</td>
          <td>{rule.cooldownMinutes} min</td><td>{rule.enabled ? 'Enabled' : 'Paused'}</td>
          <td>{rule.lastNotifiedAt ? formatFirewallTime(rule.lastNotifiedAt) : '—'}</td>
          {canManage && <td><button type="button" className="button secondary small" disabled={busy} aria-label={`Edit rule ${rule.name}`}
            onClick={() => edit(rule, rule.id)}>Edit</button></td>}
        </tr>)}</tbody>
      </table></div> : inbox && <p className="firewall-message muted">No rules configured.</p>}
    </section>
  </>;
}
