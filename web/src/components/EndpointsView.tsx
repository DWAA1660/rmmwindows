import { CheckSquare, Monitor, Plus, Search, X } from 'lucide-react';
import type { Endpoint, RequestFn } from '../types';
import { EndpointGroups, type EndpointGroup } from '../EndpointGroups';
import { BulkActions } from '../BulkActions';
import { EndpointTable } from './EndpointTable';
import { EmptyState } from './UiPrimitives';
import { usedDiskPercent } from '../uiUtils';

export function EndpointsView({
  groups,
  groupFilter,
  onChangeGroup,
  activeEndpoints,
  groupScopeEndpoints,
  filteredEndpoints,
  statusFilter,
  onChangeStatusFilter,
  search,
  onChangeSearch,
  selected,
  onChangeSelected,
  onToggleSelected,
  canAct,
  busy,
  request,
  refresh,
  onError,
  onNotify,
  onOpenDetail,
  onOpenCommand,
  onQueueJobs,
  onBulkUpdateAgent,
  onAddEndpoint,
  onResetFilters,
}: {
  groups: EndpointGroup[];
  groupFilter: string;
  onChangeGroup: (id: string) => void;
  activeEndpoints: Endpoint[];
  groupScopeEndpoints: Endpoint[];
  filteredEndpoints: Endpoint[];
  statusFilter: string;
  onChangeStatusFilter: (status: string) => void;
  search: string;
  onChangeSearch: (q: string) => void;
  selected: string[];
  onChangeSelected: (ids: string[]) => void;
  onToggleSelected: (id: string) => void;
  canAct: boolean;
  busy: boolean;
  request: RequestFn;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
  onNotify: (msg: string) => void;
  onOpenDetail: (ep: Endpoint) => void;
  onOpenCommand: (kind: string, ids?: string[]) => void;
  onQueueJobs: (ids: string[], kind: string, payload: Record<string, unknown>) => Promise<void>;
  onBulkUpdateAgent: (ids: string[]) => void;
  onAddEndpoint: () => void;
  onResetFilters: () => void;
}) {
  const allVisibleSelected =
    filteredEndpoints.length > 0 && filteredEndpoints.every((e) => selected.includes(e.id));

  const filterTabs: [string, string, number][] = [
    ['all', 'All', groupScopeEndpoints.length],
    ['online', 'Online', groupScopeEndpoints.filter((ep) => ep.online).length],
    ['offline', 'Offline', groupScopeEndpoints.filter((ep) => !ep.online).length],
    [
      'attention',
      'Low disk',
      groupScopeEndpoints.filter((ep) =>
        ep.inventory?.disks?.some((d) => usedDiskPercent(d) >= 85),
      ).length,
    ],
    [
      'reboot',
      'Reboot pending',
      groupScopeEndpoints.filter((ep) => ep.inventory?.pendingReboot === true).length,
    ],
  ];

  return (
    <section className="panel endpoints-workspace">
      <EndpointGroups
        groups={groups}
        current={groupFilter}
        onChange={(id) => {
          onChangeGroup(id);
          onChangeSelected([]);
        }}
        members={activeEndpoints}
        onSelect={onChangeSelected}
        request={request}
        refresh={refresh}
        onError={onError}
        readOnly={!canAct}
        onAdd={onAddEndpoint}
      />

      <div className="table-toolbar">
        <div className="tabs status-tabs" role="group" aria-label="Filter by status">
          {filterTabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              aria-pressed={statusFilter === key}
              onClick={() => onChangeStatusFilter(key)}
              className={statusFilter === key ? 'active' : ''}
            >
              {label}
              <span className="tab-count tabular">{count}</span>
            </button>
          ))}
        </div>

        <div className="toolbar-right">
          {selected.length === 0 && groupScopeEndpoints.length > 0 && (
            <button
              type="button"
              className="button secondary small"
              onClick={() => onChangeSelected(groupScopeEndpoints.map((ep) => ep.id))}
            >
              <CheckSquare size={14} />
              Select {groupFilter === 'all' ? 'all' : 'group'} ({groupScopeEndpoints.length})
            </button>
          )}
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="Search endpoints"
              placeholder="Search name, IP, user, OU…"
              value={search}
              onChange={(e) => onChangeSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onChangeSearch('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {selected.length > 0 && (
        <BulkActions
          selected={selected}
          canAct={canAct}
          busy={busy}
          groups={groups}
          scope={{
            label: groupFilter === 'all' ? 'all endpoints' : 'entire group',
            ids: groupScopeEndpoints.map((ep) => ep.id),
          }}
          onSelect={onChangeSelected}
          onRun={(kind) =>
            kind === 'inventory'
              ? void onQueueJobs(selected, 'inventory', {})
              : onOpenCommand(kind, selected)
          }
          onUpdateAgent={() => onBulkUpdateAgent(selected)}
          onMove={async (groupId) => {
            await request(`/groups/${groupId}/members`, 'POST', { endpointIds: selected });
            const groupName = groups.find((g) => g.id === groupId)?.name || 'the group';
            onNotify(`${selected.length} computer${selected.length === 1 ? '' : 's'} moved to ${groupName}.`);
            onChangeSelected([]);
            await refresh();
          }}
        />
      )}

      {filteredEndpoints.length ? (
        <EndpointTable
          endpoints={filteredEndpoints}
          selected={selected}
          onToggleSelect={onToggleSelected}
          onToggleSelectAll={() =>
            onChangeSelected(
              allVisibleSelected
                ? selected.filter((id) => !filteredEndpoints.some((e) => e.id === id))
                : [...new Set([...selected, ...filteredEndpoints.map((e) => e.id)])],
            )
          }
          onOpenDetail={onOpenDetail}
        />
      ) : (
        <EmptyState
          icon={Monitor}
          title={activeEndpoints.length ? 'No matching endpoints' : 'No endpoints connected yet'}
          description={
            activeEndpoints.length
              ? 'No computers matched the active group, status, or search filter.'
              : 'Create an enrollment token or run the agent installer on a Windows computer.'
          }
          action={
            activeEndpoints.length ? (
              <button type="button" className="button secondary" onClick={onResetFilters}>
                Reset filters
              </button>
            ) : (
              <button type="button" className="button primary" onClick={onAddEndpoint}>
                <Plus size={15} /> Connect endpoint
              </button>
            )
          }
        />
      )}

      <div className="panel-bottom">
        <span className="tabular">
          Showing {filteredEndpoints.length} of {groupScopeEndpoints.length} endpoint
          {groupScopeEndpoints.length === 1 ? '' : 's'}
        </span>
        <span>Outbound HTTPS · At-most-once execution</span>
      </div>
    </section>
  );
}
