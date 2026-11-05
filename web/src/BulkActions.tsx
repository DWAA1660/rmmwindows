import { useEffect, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, FolderInput, Power, RefreshCw, Terminal, X } from 'lucide-react';

type GroupOption = { id: string; name: string; isDefault?: boolean };
export const MAX_JOB_TARGETS = 250;

/**
 * One action bar for the computers selected in an endpoint table. It keeps its height whether
 * or not anything is selected, so the table never jumps under the pointer.
 */
export function BulkActions({ selected, canAct, busy, groups, scope, onSelect, onRun, onUpdateAgent, onMove }: {
  selected: string[];
  canAct: boolean;
  busy: boolean;
  /** Destination groups for "Move to"; omit to hide moving (e.g. on the overview). */
  groups?: GroupOption[];
  /** The computers in the current group view, for "Select entire group". */
  scope?: { label: string; ids: string[] };
  onSelect: (ids: string[]) => void;
  onRun: (kind: 'powershell' | 'inventory' | 'reboot') => void;
  onUpdateAgent: () => void;
  onMove?: (groupId: string) => Promise<void>;
}) {
  const [destination, setDestination] = useState('');
  useEffect(() => {
    if (groups?.length && !groups.some(group => group.id === destination))
      setDestination((groups.find(group => group.isDefault) || groups[0]).id);
  }, [groups, destination]);
  const count = selected.length;
  const tooMany = count > MAX_JOB_TARGETS;

  if (!count)
    return (
      <div className="bulk-bar idle" role="toolbar" aria-label="Actions for selected computers">
        <span className="bulk-hint">
          Tick computers to act on them together{canAct ? ': PowerShell, inventory, agent update, reboot or move.' : '.'}
        </span>
        {scope && (
          <button className="button small secondary" disabled={!scope.ids.length} onClick={() => onSelect(scope.ids)}>
            <CheckCircle2 size={14} />
            Select {scope.label} ({scope.ids.length})
          </button>
        )}
      </div>
    );

  return (
    <div className="bulk-bar active" role="toolbar" aria-label="Actions for selected computers">
      <span className="bulk-count">
        <CheckCircle2 size={17} />
        <strong>{count}</strong> selected
        <button className="bulk-clear" aria-label="Clear selection" title="Clear selection" onClick={() => onSelect([])}>
          <X size={15} />
        </button>
      </span>
      {canAct ? (
        <>
          <div className="bulk-actions" role="group" aria-label="Run on selected computers">
            <button className="button small primary" disabled={busy || tooMany} onClick={() => onRun('powershell')}>
              <Terminal size={14} /> Run PowerShell
            </button>
            <button className="button small secondary" disabled={busy || tooMany} onClick={() => onRun('inventory')}>
              <RefreshCw size={14} /> Refresh inventory
            </button>
            <button className="button small secondary" disabled={busy || tooMany} onClick={onUpdateAgent}>
              <ArrowDownToLine size={14} /> Update agent
            </button>
            <button className="button small secondary danger-outline" disabled={busy || tooMany} onClick={() => onRun('reboot')}>
              <Power size={14} /> Reboot
            </button>
          </div>
          {groups && onMove && (
            <form
              className="bulk-move"
              aria-label="Move selected computers"
              onSubmit={event => {
                event.preventDefault();
                if (destination) void onMove(destination);
              }}
            >
              <FolderInput size={15} aria-hidden="true" />
              <label>
                Move to
                <select aria-label="Destination group" value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}>
                  {groups.map(group => (
                    <option key={group.id} value={group.id}>{group.name}</option>
                  ))}
                </select>
              </label>
              <button className="button small secondary" disabled={busy || !destination}>Move</button>
            </form>
          )}
          {tooMany && <span className="bulk-note">Commands go to at most {MAX_JOB_TARGETS} computers at a time.</span>}
        </>
      ) : (
        <span className="bulk-note">Read-only account: you can view these computers but not run actions.</span>
      )}
    </div>
  );
}
