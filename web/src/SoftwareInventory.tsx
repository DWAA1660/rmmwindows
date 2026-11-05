import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Package, Search } from 'lucide-react';
import { filterSoftware, groupSoftware, missingFrom, softwareCsv, type FleetEndpoint, type SoftwareGroup } from './softwareModel';
import './SoftwareInventory.css';

/** Fleet-wide installed software: which computers have a program, which versions, and which lack it. */
export function SoftwareInventory({ endpoints, onOpenEndpoint }: { endpoints: FleetEndpoint[]; onOpenEndpoint: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showMissing, setShowMissing] = useState(false);
  const groups = useMemo(() => groupSoftware(endpoints), [endpoints]);
  const visible = useMemo(() => filterSoftware(groups, query), [groups, query]);
  const byId = useMemo(() => new Map(endpoints.map(endpoint => [endpoint.id, endpoint])), [endpoints]);
  const reporting = endpoints.filter(endpoint => !endpoint.revoked && (endpoint.inventory?.software?.length ?? 0) > 0).length;
  const name = (id: string) => { const endpoint = byId.get(id); return endpoint ? endpoint.displayName || endpoint.hostname : 'Unknown computer'; };
  const download = (onlyVisible: boolean) => {
    const keys = onlyVisible && query.trim() ? new Set(visible.map(group => group.key)) : undefined;
    const blob = new Blob(['﻿' + softwareCsv(endpoints, keys)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `software-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const computerChip = (id: string) => (
    <button key={id} type="button" className="software-computer" onClick={() => onOpenEndpoint(id)}>
      <span className={`live-dot ${byId.get(id)?.online ? '' : 'offline'}`} aria-hidden="true" />{name(id)}
    </button>
  );
  const detail = (group: SoftwareGroup) => {
    const missing = missingFrom(group, endpoints);
    return (
      <div className="software-detail">
        {group.versions.map(version => (
          <div key={version.version} className="software-version">
            <div className="software-version-head"><strong>{version.version}</strong><span>{version.endpointIds.length} computer{version.endpointIds.length === 1 ? '' : 's'}</span></div>
            <div className="software-computers">{version.endpointIds.map(computerChip)}</div>
          </div>
        ))}
        <button type="button" className="text-button" onClick={() => setShowMissing(value => !value)}>
          {showMissing ? 'Hide' : 'Show'} computers without it ({missing.length})
        </button>
        {showMissing && <div className="software-computers missing">{missing.length ? missing.map(endpoint => computerChip(endpoint.id)) : <span className="muted">Every reporting computer has it.</span>}</div>}
      </div>
    );
  };
  return (
    <section className="panel software-inventory">
      <div className="panel-heading">
        <div>
          <h2>Installed software</h2>
          <p>{groups.length} programs across {reporting} reporting computer{reporting === 1 ? '' : 's'}. Updated with each inventory (every few minutes).</p>
        </div>
        <div className="software-actions">
          <button type="button" className="button secondary small" onClick={() => download(true)} disabled={!groups.length}><Download size={14} /> {query.trim() ? 'Export matches (CSV)' : 'Export all (CSV)'}</button>
        </div>
      </div>
      <label className="software-search"><Search size={15} /><input aria-label="Search installed software" placeholder="Search programs or publishers, e.g. chrome, adobe reader" value={query} onChange={event => { setQuery(event.target.value); setOpen(null); }} autoFocus /></label>
      {!groups.length ? (
        <div className="software-empty"><Package size={22} /><p>No software inventory yet. It appears after computers send their first inventory.</p></div>
      ) : !visible.length ? (
        <div className="software-empty"><Search size={22} /><p>No installed program matches “{query}”.</p></div>
      ) : (
        <div className="table-scroll">
          <table className="software-table">
            <thead><tr><th /><th>PROGRAM</th><th>PUBLISHER</th><th>COMPUTERS</th><th>VERSIONS</th></tr></thead>
            <tbody>
              {visible.slice(0, 500).flatMap(group => {
                const expanded = open === group.key;
                const rows = [
                  <tr key={group.key} className={expanded ? 'expanded' : ''} onClick={() => { setOpen(expanded ? null : group.key); setShowMissing(false); }}>
                    <td className="software-toggle">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
                    <td><button type="button" className="software-name" aria-expanded={expanded}>{group.name}</button></td>
                    <td>{group.publisher || '—'}</td>
                    <td><strong>{group.endpointIds.length}</strong> / {reporting}</td>
                    <td>{group.versions.length === 1 ? group.versions[0].version : `${group.versions.length} versions (newest ${group.versions[0].version})`}</td>
                  </tr>
                ];
                if (expanded) rows.push(<tr key={group.key + '-detail'} className="software-detail-row"><td colSpan={5}>{detail(group)}</td></tr>);
                return rows;
              })}
            </tbody>
          </table>
          {visible.length > 500 && <p className="muted software-more">Showing the 500 most installed of {visible.length} matches. Refine the search to see others.</p>}
        </div>
      )}
    </section>
  );
}
