import { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, HardDrive, Network, ShieldAlert } from 'lucide-react';
import {
  firewallError, formatFirewallBytes, formatFirewallTime, ranges,
  type FirewallRange, type FirewallRequest, type FirewallSource, type TrafficFilters,
} from './firewallTypes';

type TrafficCounts = { total: number; allowed: number; denied: number; unparsed: number };
type LeaderRow = { value: string | number; count: number; denied: number; bytes: number };
const leaders = [
  { key: 'sources', heading: 'Top source IPs', filter: 'srcIp' },
  { key: 'destinations', heading: 'Top destination IPs', filter: 'dstIp' },
  { key: 'ports', heading: 'Top destination ports', filter: 'dstPort' },
  { key: 'policies', heading: 'Top policies', filter: 'policy' },
  { key: 'applications', heading: 'Top applications', filter: 'application' },
  { key: 'hosts', heading: 'Top hostnames', filter: 'host' },
] as const;
type Overview = {
  from: string; to: string; bucketMinutes: number;
  totals: TrafficCounts & { bytes: number; measured: number; uniqueSources: number; uniqueDestinations: number };
  buckets: (TrafficCounts & { start: string })[];
  top: Record<typeof leaders[number]['key'], LeaderRow[]>;
};
const number = (value: number) => value.toLocaleString();
const shortTime = (start: string, isWeek: boolean) => new Date(start).toLocaleString(undefined,
  isWeek ? { weekday: 'short', hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });

export function FirewallOverview({ request, sources, range, sender, refresh, onSender, onTraffic }: {
  request: FirewallRequest; sources: FirewallSource[]; range: FirewallRange; sender: string; refresh: number;
  onSender: (address: string) => void; onTraffic: (filters?: TrafficFilters) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [selectedBucket, setSelectedBucket] = useState<number | null>(null);
  useEffect(() => {
    setOverview(null);
    setSelectedBucket(null);
  }, [range, sender]);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ hours: range });
    if (sender) params.set('sender', sender);
    request<Overview>(`/firewall/overview?${params}`).then(result => {
      if (active) { setOverview(result); setError(''); }
    }).catch(err => { if (active) setError(firewallError(err)); });
    return () => { active = false; };
  }, [request, range, sender, refresh]);

  const totals = overview?.totals;
  const alerts = totals && totals.total ? Math.round(totals.denied * 100 / totals.total) : 0;
  const peak = Math.max(1, ...(overview?.buckets.map(bucket => bucket.total) ?? []));
  const focused = selectedBucket === null ? undefined : overview?.buckets[selectedBucket];
  const cards = [
    { label: 'Traffic events', value: totals && number(totals.total), detail: totals && `${number(totals.allowed)} allowed · ${number(totals.denied)} denied`, icon: Activity, action: undefined },
    { label: 'Denied', value: totals && number(totals.denied), detail: totals && `${alerts}% of logged events`, icon: ShieldAlert, action: { action: 'deny' } as const },
    { label: 'Unique source IPs', value: totals && number(totals.uniqueSources), detail: totals && `${number(totals.uniqueDestinations)} distinct destination IPs`, icon: Network, action: undefined },
    { label: 'Reported bytes', value: totals && formatFirewallBytes(totals.bytes), detail: totals && `${number(totals.measured)} events reported byte counts`, icon: HardDrive, action: undefined },
  ];

  return <div className="firewall-overview">
    <div className="firewall-hero">
      <div>
        <h2>Traffic overview</h2>
        <p>{ranges[range]}{overview && ` · Updated ${shortTime(overview.to, false)}`}</p>
      </div>
      <label>Firebox<select value={sender} onChange={event => onSender(event.target.value)}>
        <option value="">All Fireboxes</option>
        {sources.map(source => <option key={source.address} value={source.address}>{source.name}</option>)}
      </select></label>
    </div>
    {error && <p className="firewall-message firewall-error" role="alert">{error}</p>}
    <div className="firewall-metrics">
      {cards.map(card => {
        const Icon = card.icon;
        return <article className="panel firewall-metric" key={card.label}>
          <div className="firewall-metric-label"><Icon size={17} aria-hidden="true" /><h3>{card.label}</h3></div>
          <strong>{card.value ?? '—'}</strong>
          <span>{card.detail ?? 'Waiting for data'}</span>
          {card.action && <button className="button secondary small" type="button" onClick={() => onTraffic(card.action)}>
            Review denials <ArrowUpRight size={14} />
          </button>}
        </article>;
      })}
    </div>
    <section className="panel firewall-trends">
      <div className="panel-heading">
        <div><h2>Traffic over time</h2><p>{overview ? `Events per ${overview.bucketMinutes} min · Peak ${number(overview.totals.total ? peak : 0)}` : 'Loading event counts'}</p></div>
        <button type="button" className="button secondary small" onClick={() => onTraffic({ action: 'unparsed' })}>
          Unparsed{totals ? ` · ${number(totals.unparsed)}` : ''}
        </button>
      </div>
      {overview && <div className="firewall-chart">
        <div className="firewall-chart-legend">
          <span className="firewall-allow">Allowed</span><span className="firewall-deny">Denied</span>
          <span className="firewall-unknown">Unparsed</span>
        </div>
        <div className="firewall-bars" role="group" aria-label="Traffic by time interval">
          {overview.buckets.map((bucket, i) => <button key={i} type="button"
            title={`${formatFirewallTime(bucket.start)} · ${number(bucket.total)} events`}
            aria-label={`${formatFirewallTime(bucket.start)}, ${number(bucket.allowed)} allowed, ${number(bucket.denied)} denied, ${number(bucket.unparsed)} unparsed`}
            aria-pressed={selectedBucket === i} onClick={() => setSelectedBucket(i)}>
            <span style={{ height: `${bucket.allowed * 100 / peak}%` }} className="firewall-allow" />
            <span style={{ height: `${bucket.denied * 100 / peak}%` }} className="firewall-deny" />
            <span style={{ height: `${bucket.unparsed * 100 / peak}%` }} className="firewall-unknown" />
          </button>)}
        </div>
        <div className="firewall-chart-axis">
          {[0, 1, 2, 3].map(i => <span key={i}>{shortTime(
            i === 3 ? overview.to : overview.buckets[Math.floor(i * overview.buckets.length / 3)].start, range === '168')}</span>)}
        </div>
        <p className="firewall-chart-detail" aria-live="polite">{focused ?
          `${formatFirewallTime(focused.start)} · ${number(focused.allowed)} allowed, ${number(focused.denied)} denied, ${number(focused.unparsed)} unparsed` :
          overview.totals.total ? 'Select an interval to inspect its counts.' : 'No retained traffic events in this range.'}</p>
      </div>}
    </section>
    {overview && <div className="firewall-leaders">
      {leaders.map(({ key, heading, filter }) => {
        const rows = overview.top[key];
        const max = rows[0]?.count || 1;
        return <section className="panel firewall-ranking" key={key}>
          <div className="panel-heading"><h2>{heading}</h2></div>
          {rows.length ? <ol>{rows.map(row => <li key={row.value}>
            <button type="button" onClick={() => onTraffic({ [filter]: String(row.value) })}
              title={`${row.value} · ${number(row.denied)} denied · ${formatFirewallBytes(row.bytes)} reported`}>
              <span className="firewall-rank-label">{row.value}</span><strong>{number(row.count)}</strong><ArrowUpRight size={13} />
              <span className="firewall-rank-bar" style={{ width: `${row.count * 100 / max}%` }} />
            </button>
          </li>)}</ol> : <p className="firewall-message muted">No reported values in this range.</p>}
        </section>;
      })}
    </div>}
  </div>;
}
