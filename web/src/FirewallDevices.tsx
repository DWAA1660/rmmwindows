import { useEffect, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import {
  firewallError, formatFirewallBytes, formatFirewallTime,
  type FirewallRange, type FirewallRequest, type FirewallSource, type TrafficFilters,
} from './firewallTypes';

type Device = {
  ip: string; firstSeen: string; lastSeen: string; total: number; denied: number; bytes: number;
  destinations: number; endpointName: string | null;
};
type DeviceList = { devices: Device[]; hasMore: boolean };

export function FirewallDevices({ request, range, sender, onSender, sources, refresh, onTraffic }: {
  request: FirewallRequest; range: FirewallRange; sender: string; onSender: (value: string) => void;
  sources: FirewallSource[]; refresh: number; onTraffic: (filters: TrafficFilters) => void;
}) {
  const [scope, setScope] = useState('lan');
  const [sort, setSort] = useState('recent');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DeviceList | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { setResults(null); }, [range, sender, scope, sort, query]);
  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ hours: range, scope, sort, query });
    if (sender) params.set('sender', sender);
    request<DeviceList>(`/firewall/devices?${params}`).then(result => {
      if (active) { setResults(result); setError(''); }
    }).catch(err => { if (active) setError(firewallError(err)); });
    return () => { active = false; };
  }, [request, range, sender, scope, sort, query, refresh]);

  return <section className="panel">
    <div className="panel-heading"><div><h2>Observed devices</h2>
      <p>Source IPs seen in Firebox logs in this time range. Endpoint names come from matching RMM inventory.</p>
    </div></div>
    <form className="firewall-form" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); }}>
      <label>Firebox<select value={sender} onChange={event => onSender(event.target.value)}>
        <option value="">All Fireboxes</option>
        {sources.map(source => <option key={source.address} value={source.address}>{source.name}</option>)}
      </select></label>
      <label>Address scope<select value={scope} onChange={event => setScope(event.target.value)}>
        <option value="lan">Private IPv4 and IPv6 ULA</option><option value="all">All source addresses</option>
      </select></label>
      <label>Sort by<select value={sort} onChange={event => setSort(event.target.value)}>
        <option value="recent">Last seen</option><option value="events">Most events</option>
        <option value="denied">Most denied events</option><option value="bytes">Most reported bytes</option>
      </select></label>
      <label>IP or endpoint name<input type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></label>
      <button className="button secondary small">Search devices</button>
    </form>
    {error && <p className="firewall-message firewall-error" role="alert">{error}</p>}
    {!results && !error && <p className="firewall-message muted" role="status">Loading observed devices…</p>}
    {results && (results.devices.length ? <div className="table-scroll"><table>
      <thead><tr><th scope="col">Source</th><th scope="col">First seen</th><th scope="col">Last seen</th>
        <th scope="col">Destinations</th><th scope="col">Events</th><th scope="col">Denied</th><th scope="col">Reported bytes</th><th scope="col">Traffic</th></tr></thead>
      <tbody>{results.devices.map(device => <tr key={device.ip}>
        <td>{device.endpointName && <strong>{device.endpointName}</strong>}<div><code>{device.ip}</code></div></td>
        <td>{formatFirewallTime(device.firstSeen)}</td><td>{formatFirewallTime(device.lastSeen)}</td>
        <td>{device.destinations.toLocaleString()}</td><td>{device.total.toLocaleString()}</td>
        <td>{device.denied.toLocaleString()}</td><td>{formatFirewallBytes(device.bytes)}</td>
        <td><button type="button" className="button secondary small" aria-label={`View traffic for ${device.ip}`}
          onClick={() => onTraffic({ srcIp: device.ip })}>View logs <ArrowUpRight size={14} /></button></td>
      </tr>)}</tbody>
    </table></div> : <p className="firewall-message muted">No observed devices match these filters.</p>)}
    {results?.hasMore && <p className="firewall-message muted">Showing the first 100 results. Filter by Firebox, time range, or address to narrow the list.</p>}
  </section>;
}
