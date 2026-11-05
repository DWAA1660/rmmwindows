import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';

type PickerEndpoint = { id: string; hostname: string; displayName?: string; online: boolean; tags?: string[]; groupId?:string;groupName?:string };

/** Checkbox list for choosing one or many computers for a job. */
export function EndpointPicker({ endpoints, value, onChange }: {
  endpoints: PickerEndpoint[]; value: string[]; onChange: (ids: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const name = (ep: PickerEndpoint) => ep.displayName || ep.hostname;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return endpoints
      .filter(ep => !needle || name(ep).toLowerCase().includes(needle) || ep.hostname.toLowerCase().includes(needle) || ep.tags?.some(tag => tag.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.online) - Number(a.online) || name(a).localeCompare(name(b)));
  }, [endpoints, query]);
  const chosen = new Set(value);
  const toggle = (id: string) => onChange(chosen.has(id) ? value.filter(v => v !== id) : [...value, id]);
  const online = endpoints.filter(ep => ep.online).map(ep => ep.id);
  const groups = [...new Map(endpoints.map(ep=>[ep.groupId||'new-endpoints',ep.groupName||'New endpoints'])).entries()];
  return (
    <div className="endpoint-picker">
      <div className="picker-groups"><span>Select whole groups:</span>{groups.map(([id,name])=>{const ids=endpoints.filter(ep=>(ep.groupId||'new-endpoints')===id).map(ep=>ep.id);return <button type="button" className="button small secondary" key={id} onClick={()=>onChange([...new Set([...value,...ids])])}>{name} ({ids.length})</button>;})}</div>
      <div className="endpoint-picker-bar">
        <label className="endpoint-picker-search"><Search size={14} /><input aria-label="Filter computers" placeholder="Filter by name or tag" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button type="button" className="button small secondary" onClick={() => onChange([...new Set([...value, ...online])])} disabled={!online.length}>Select all online ({online.length})</button>
        <button type="button" className="button small secondary" onClick={() => onChange([...new Set([...value, ...visible.map(ep => ep.id)])])} disabled={!visible.length}>Select shown</button>
        <button type="button" className="button small secondary" onClick={() => onChange([])} disabled={!value.length}>Clear</button>
      </div>
      <div className="endpoint-picker-list" role="group" aria-label="Computers">
        {visible.map(ep => (
          <label key={ep.id} className={chosen.has(ep.id) ? 'chosen' : ''}>
            <input type="checkbox" checked={chosen.has(ep.id)} onChange={() => toggle(ep.id)} />
            <span className={`live-dot ${ep.online ? '' : 'offline'}`} aria-hidden="true" />
            <strong>{name(ep)}</strong>
            <small>{ep.online ? 'Online' : 'Offline · runs when it reconnects'}</small>
          </label>
        ))}
        {!visible.length && <p className="muted">No computers match.</p>}
      </div>
      <small className="muted">{value.length} selected. Each computer gets its own job; every job runs at most once.</small>
    </div>
  );
}
