import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  Database,
  FolderSearch,
  HardDrive,
  Monitor,
  Pencil,
  Power,
  RefreshCw,
  Search,
  ShieldOff,
  Terminal,
  X,
} from 'lucide-react';
import type { Endpoint, Job, RequestFn, User } from '../types';
import {
  canStartRemoteSupport,
  endpointDisplayName,
  formatBytes,
  formatRelativeTime,
  formatTimestamp,
  usedDiskPercent,
} from '../uiUtils';
import { openRemoteSupport } from '../RemoteSupport';
import { AgentUpdateDetails } from '../AgentUpdateHealth';
import { EndpointDirectory } from '../EndpointDirectory';
import { DetailValue, EmptyState, StatusBadge } from './UiPrimitives';
import type { ConfirmDialogState } from './ConfirmDialog';

type InspectorTab = 'overview' | 'directory' | 'updates' | 'software';

export function EndpointInspector({
  endpoint,
  user,
  busy,
  request,
  refresh,
  onClose,
  onNotify,
  onError,
  onConfirm,
  onOpenTerminal,
  onOpenFiles,
  onRunPowerShell,
  onQueueInventory,
  onOpenReboot,
  onOpenJob,
}: {
  endpoint: Endpoint;
  user: User;
  busy: boolean;
  request: RequestFn;
  refresh: () => Promise<void>;
  onClose: () => void;
  onNotify: (msg: string) => void;
  onError: (err: unknown) => void;
  onConfirm: (dialog: ConfirmDialogState) => void;
  onOpenTerminal: (ep: Endpoint) => void;
  onOpenFiles: (ep: Endpoint) => void;
  onRunPowerShell: (ep: Endpoint) => void;
  onQueueInventory: (ids: string[]) => Promise<void>;
  onOpenReboot: (ep: Endpoint) => void;
  onOpenJob: (job: Job) => void;
}) {
  const [tab, setTab] = useState<InspectorTab>('overview');
  const [softwareSearch, setSoftwareSearch] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(endpoint.displayName || endpoint.hostname);
  const [renameBusy, setRenameBusy] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<string | undefined>();
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraftName(endpoint.displayName || endpoint.hostname);
    setRenaming(false);
  }, [endpoint.id, endpoint.displayName, endpoint.hostname]);

  useEffect(() => {
    request<{ version: string }>('/agent-download')
      .then((res) => setPublishedVersion(res.version))
      .catch(() => {});
  }, [request, endpoint.id]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !renaming) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose, renaming]);

  const canAct = user.role !== 'viewer';
  const softwareList = endpoint.inventory?.software || [];
  const filteredSoftware = softwareList.filter((s) =>
    `${s.name} ${s.publisher || ''}`.toLowerCase().includes(softwareSearch.toLowerCase()),
  );

  const submitRename = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed || renameBusy) return;
    setRenameBusy(true);
    try {
      await request(`/endpoints/${endpoint.id}`, 'PATCH', { displayName: trimmed });
      setRenaming(false);
      await refresh();
      onNotify('Endpoint name updated.');
    } catch (err) {
      onError(err);
    } finally {
      setRenameBusy(false);
    }
  };

  const triggerAgentUpdate = async () => {
    const published = await request<{ version: string }>('/agent-download').catch(() => null);
    const current = endpoint.inventory?.agentVersion || 'unknown';
    const target = published ? `v${published.version}` : 'the latest published version';
    const isSame = published?.version && current === published.version;
    onConfirm({
      title: isSame
        ? `Reinstall agent on ${endpointDisplayName(endpoint)}?`
        : `Update agent on ${endpointDisplayName(endpoint)}?`,
      description: isSame
        ? `${endpointDisplayName(endpoint)} already reports agent v${current}. Queue a clean reinstall of ${target}?`
        : `Update agent from v${current} to ${target}. Each update job runs at most once.`,
      details: [
        'The Windows agent restarts ~20 seconds after running and reconnects within a minute.',
        'Any open terminal or remote support session on this endpoint will close.',
        ...(!endpoint.online
          ? ['This endpoint is currently offline; the update runs when it reconnects.']
          : []),
      ],
      confirmLabel: isSame ? 'Reinstall agent' : `Update to ${target}`,
      tone: 'primary',
      onConfirm: async () => {
        const result = await request<{ job: Job; duplicate: boolean }>(
          `/endpoints/${endpoint.id}/update-agent`,
          'POST',
          { idempotencyKey: crypto.randomUUID() },
        );
        onNotify(`Agent update queued for ${endpointDisplayName(endpoint)}. It runs once.`);
        await refresh();
        onOpenJob(result.job);
      },
    });
  };

  const triggerRevoke = () => {
    onConfirm({
      title: `Revoke ${endpointDisplayName(endpoint)}?`,
      description:
        'Revoking removes this computer’s credentials immediately. It must be re-enrolled before it can reconnect, and any queued jobs will be cancelled.',
      confirmLabel: 'Revoke endpoint',
      tone: 'danger',
      onConfirm: async () => {
        await request(`/endpoints/${endpoint.id}/revoke`, 'POST', {});
        onClose();
        await refresh();
        onNotify('Endpoint credentials revoked.');
      },
    });
  };

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside
        className="inspector-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Inspect ${endpointDisplayName(endpoint)}`}
        tabIndex={-1}
        ref={drawerRef}
      >
        <header className="inspector-header">
          <div className="inspector-title-wrap">
            {renaming ? (
              <form className="inline-rename-form" onSubmit={(e) => void submitRename(e)}>
                <input
                  autoFocus
                  aria-label="Endpoint display name"
                  maxLength={120}
                  value={draftName}
                  disabled={renameBusy}
                  onChange={(e) => setDraftName(e.target.value)}
                />
                <button
                  type="submit"
                  className="button primary small"
                  disabled={renameBusy || !draftName.trim()}
                >
                  <Check size={14} /> Save
                </button>
                <button
                  type="button"
                  className="button secondary small"
                  disabled={renameBusy}
                  onClick={() => {
                    setRenaming(false);
                    setDraftName(endpoint.displayName || endpoint.hostname);
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="inspector-title-row">
                <h2>{endpointDisplayName(endpoint)}</h2>
                {canAct && !endpoint.revoked && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Rename endpoint"
                    title="Rename endpoint"
                    onClick={() => setRenaming(true)}
                  >
                    <Pencil size={14} />
                  </button>
                )}
              </div>
            )}
            <div className="inspector-meta-row">
              <StatusBadge
                status={
                  endpoint.revoked ? 'revoked' : endpoint.online ? 'online' : 'offline'
                }
              />
              <span className="inspector-meta-sep">·</span>
              <span className="mono tabular">{endpoint.hostname}</span>
              <span className="inspector-meta-sep">·</span>
              <span>{endpoint.groupName || 'New endpoints'}</span>
              <span className="inspector-meta-sep">·</span>
              <span className="tabular">Last seen {formatRelativeTime(endpoint.lastSeen)}</span>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close inspector"
          >
            <X size={18} />
          </button>
        </header>

        <div className="inspector-actions">
          <div className="inspector-action-row">
            {canAct && (
              <button
                type="button"
                className="button primary small"
                disabled={endpoint.revoked || !endpoint.online}
                onClick={() => {
                  if (!canStartRemoteSupport(endpoint.inventory?.agentVersion)) {
                    onError(
                      new Error(
                        'Remote support needs agent 0.1.6 or newer. Update the agent or restart the service when idle.',
                      ),
                    );
                    return;
                  }
                  openRemoteSupport(endpoint.id);
                }}
              >
                <Monitor size={14} /> Remote support
              </button>
            )}
            <button
              type="button"
              className="button primary small"
              disabled={endpoint.revoked}
              onClick={() => onOpenTerminal(endpoint)}
            >
              <Terminal size={14} /> Terminal
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={endpoint.revoked}
              onClick={() => onOpenFiles(endpoint)}
            >
              <FolderSearch size={14} /> Browse files
            </button>
            {canAct && (
              <button
                type="button"
                className="button secondary small"
                disabled={endpoint.revoked}
                onClick={() => onRunPowerShell(endpoint)}
              >
                <Terminal size={14} /> Run PowerShell
              </button>
            )}
            <button
              type="button"
              className="button secondary small"
              disabled={endpoint.revoked}
              onClick={() => void onQueueInventory([endpoint.id])}
            >
              <RefreshCw size={14} /> Refresh inventory
            </button>
            {canAct && (
              <button
                type="button"
                className="button secondary small"
                disabled={endpoint.revoked || busy}
                onClick={() => void triggerAgentUpdate()}
              >
                <ArrowDownToLine size={14} /> Update agent
              </button>
            )}
            {canAct && (
              <button
                type="button"
                className="button secondary small danger-outline"
                disabled={endpoint.revoked}
                onClick={() => onOpenReboot(endpoint)}
              >
                <Power size={14} /> Reboot
              </button>
            )}
          </div>
        </div>

        <nav className="inspector-tabs" role="tablist" aria-label="Endpoint details">
          {(
            [
              ['overview', 'Overview & storage'],
              ['directory', 'Directory & network'],
              ['updates', 'Agent updates'],
              ['software', `Software (${softwareList.length})`],
            ] as [InspectorTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={tab === key ? 'active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="inspector-body">
          {tab === 'overview' && (
            <div className="inspector-section-stack">
              <section className="inspector-block">
                <h3>System telemetry</h3>
                <div className="kv-grid">
                  <DetailValue label="Operating system" value={endpoint.inventory?.osName} />
                  <DetailValue label="OS version" value={endpoint.inventory?.osVersion} mono />
                  <DetailValue
                    label="IPv4 addresses"
                    value={endpoint.inventory?.ipv4?.join(', ')}
                    mono
                  />
                  <DetailValue
                    label="Directory"
                    value={
                      endpoint.inventory?.domainJoined
                        ? endpoint.inventory.domain
                        : 'Workgroup'
                    }
                  />
                  <DetailValue
                    label="Logged-on user"
                    value={endpoint.inventory?.loggedOnUser || 'No interactive user'}
                  />
                  <DetailValue
                    label="Last boot"
                    value={formatTimestamp(endpoint.inventory?.bootTime)}
                  />
                  <DetailValue
                    label="CPU load"
                    value={
                      endpoint.inventory?.cpuPercent != null
                        ? `${endpoint.inventory.cpuPercent.toFixed(1)}%`
                        : undefined
                    }
                  />
                  <DetailValue
                    label="Memory used"
                    value={
                      endpoint.inventory?.memoryTotalBytes
                        ? `${formatBytes(endpoint.inventory.memoryUsedBytes)} / ${formatBytes(
                            endpoint.inventory.memoryTotalBytes,
                          )}`
                        : undefined
                    }
                  />
                  <DetailValue
                    label="Agent version"
                    value={endpoint.inventory?.agentVersion}
                    mono
                  />
                  <DetailValue
                    label="Architecture"
                    value={endpoint.inventory?.architecture}
                  />
                </div>
              </section>

              <section className="inspector-block">
                <h3>Disks &amp; storage</h3>
                {endpoint.inventory?.disks?.length ? (
                  <div className="disk-cards">
                    {endpoint.inventory.disks.map((disk) => {
                      const pct = usedDiskPercent(disk);
                      return (
                        <div className="disk-card" key={disk.name}>
                          <div className="disk-card-head">
                            <span className="disk-icon">
                              <HardDrive size={16} />
                            </span>
                            <div>
                              <strong>
                                {disk.name} {disk.label ? `· ${disk.label}` : ''}
                              </strong>
                              <small className="tabular">
                                {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                              </small>
                            </div>
                            <b className={`tabular ${pct >= 85 ? 'text-amber' : ''}`}>
                              {Math.round(pct)}%
                            </b>
                          </div>
                          <div className="progress-track">
                            <span
                              className={pct >= 85 ? 'warning' : ''}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted">No disk inventory received yet.</p>
                )}
              </section>

              {canAct && (
                <section className="inspector-danger-row">
                  <div>
                    <strong>Revoke endpoint credentials</strong>
                    <p>Immediately disconnects this endpoint and invalidates its token.</p>
                  </div>
                  <button
                    type="button"
                    className="button secondary small danger-outline"
                    disabled={endpoint.revoked}
                    onClick={triggerRevoke}
                  >
                    <ShieldOff size={14} /> Revoke endpoint
                  </button>
                </section>
              )}
            </div>
          )}

          {tab === 'directory' && <EndpointDirectory inventory={endpoint.inventory} />}

          {tab === 'updates' && (
            <AgentUpdateDetails
              status={endpoint.updateStatus}
              agentVersion={endpoint.inventory?.agentVersion}
              online={endpoint.online}
              latestVersion={publishedVersion}
            />
          )}

          {tab === 'software' && (
            <div className="inspector-software">
              <div className="search-field">
                <Search size={15} />
                <input
                  aria-label="Search installed software"
                  placeholder="Filter programs or publishers…"
                  value={softwareSearch}
                  onChange={(e) => setSoftwareSearch(e.target.value)}
                />
                {softwareSearch && (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setSoftwareSearch('')}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              {filteredSoftware.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Software</th>
                        <th>Version</th>
                        <th>Publisher</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSoftware.map((s, i) => (
                        <tr key={`${s.name}-${i}`}>
                          <td>
                            <strong>{s.name}</strong>
                          </td>
                          <td className="mono tabular">{s.version || '—'}</td>
                          <td>{s.publisher || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState
                  icon={Database}
                  title={softwareList.length ? 'No matching programs' : 'No software inventory yet'}
                  description={
                    softwareList.length
                      ? `No installed application matched “${softwareSearch}”.`
                      : 'Refresh inventory to collect installed software.'
                  }
                />
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
