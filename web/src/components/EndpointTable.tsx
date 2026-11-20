import { ChevronRight, Monitor, ShieldCheck } from 'lucide-react';
import type { Endpoint } from '../types';
import { endpointDisplayName, formatBytes, formatRelativeTime, getPrimaryDisk, usedDiskPercent } from '../uiUtils';
import { StatusBadge } from './UiPrimitives';

export function EndpointTable({
  endpoints,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  onOpenDetail,
  compact = false,
  selectable = true,
}: {
  endpoints: Endpoint[];
  selected: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onOpenDetail: (ep: Endpoint) => void;
  compact?: boolean;
  selectable?: boolean;
}) {
  const allVisibleSelected =
    endpoints.length > 0 && endpoints.every((e) => selected.includes(e.id));

  return (
    <div className="table-scroll">
      <table className="endpoint-table">
        <thead>
          <tr>
            {selectable && (
              <th className="check-cell">
                <input
                  aria-label="Select all visible endpoints"
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={onToggleSelectAll}
                />
              </th>
            )}
            <th>Endpoint</th>
            <th>Status</th>
            <th>IPv4</th>
            {!compact && <th>Directory / Group</th>}
            <th>Disk (C:)</th>
            <th>Last seen</th>
            <th className="col-action" />
          </tr>
        </thead>
        <tbody>
          {endpoints.map((ep) => {
            const disk = getPrimaryDisk(ep);
            const pct = disk ? usedDiskPercent(disk) : 0;
            const isSelected = selected.includes(ep.id);
            return (
              <tr
                key={ep.id}
                className={`clickable-row ${isSelected ? 'selected-row' : ''}`}
                onClick={() => onOpenDetail(ep)}
              >
                {selectable && (
                  <td className="check-cell" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${endpointDisplayName(ep)}`}
                      checked={isSelected}
                      onChange={() => onToggleSelect(ep.id)}
                    />
                  </td>
                )}
                <td>
                  <div className="endpoint-cell">
                    <span className={`computer-icon ${ep.online ? 'online' : ''}`}>
                      <Monitor size={16} />
                    </span>
                    <div className="endpoint-cell-text">
                      <button
                        type="button"
                        className="endpoint-name-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDetail(ep);
                        }}
                      >
                        {endpointDisplayName(ep)}
                      </button>
                      <small>
                        {ep.inventory?.osName || 'Windows · Awaiting inventory'}
                        {ep.inventory?.loggedOnUser ? ` · ${ep.inventory.loggedOnUser}` : ''}
                      </small>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="status-cell">
                    <StatusBadge status={ep.online ? 'online' : 'offline'} />
                    {ep.inventory?.pendingReboot === true && (
                      <span
                        className="reboot-flag"
                        title={
                          (ep.inventory.pendingRebootReasons || []).join('\n') ||
                          'Windows reports a pending restart'
                        }
                      >
                        Reboot pending
                      </span>
                    )}
                  </div>
                </td>
                <td className="mono tabular">{ep.inventory?.ipv4?.[0] || '—'}</td>
                {!compact && (
                  <td>
                    <div className="dir-cell">
                      <span className="dir-group">{ep.groupName || 'New endpoints'}</span>
                      <small className="dir-domain">
                        {ep.inventory?.domainJoined ? (
                          <>
                            <ShieldCheck size={12} />
                            {ep.inventory.domain}
                          </>
                        ) : (
                          'Workgroup'
                        )}
                      </small>
                    </div>
                  </td>
                )}
                <td>
                  {disk ? (
                    <div className="table-disk">
                      <div className="table-disk-top tabular">
                        <span className={pct >= 85 ? 'text-amber' : ''}>{Math.round(pct)}%</span>
                        <small>{formatBytes(disk.freeBytes)} free</small>
                      </div>
                      <div className="progress-track">
                        <span
                          className={pct >= 85 ? 'warning' : ''}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="muted">Pending</span>
                  )}
                </td>
                <td className="muted nowrap tabular">{formatRelativeTime(ep.lastSeen)}</td>
                <td className="col-action">
                  <button
                    type="button"
                    className="icon-button"
                    title="Inspect endpoint"
                    aria-label={`Open ${endpointDisplayName(ep)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDetail(ep);
                    }}
                  >
                    <ChevronRight size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
