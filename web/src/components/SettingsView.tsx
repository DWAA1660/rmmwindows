import { ArrowRight, CheckCircle2, RefreshCw, Server, ShieldCheck, Users } from 'lucide-react';
import type { RequestFn, User } from '../types';
import { formatTimestamp } from '../uiUtils';
import { AccountSettings } from '../AccountSettings';
import { SupportSettings } from '../SupportSettings';
import { StatusBadge } from './UiPrimitives';
import type { ConfirmDialogState } from './ConfirmDialog';

export function SettingsView({
  user,
  settings,
  updateStatus,
  busy,
  request,
  onProfile,
  onUpdateStatusChange,
  onError,
  onNotify,
  onConfirm,
}: {
  user: User;
  settings: Record<string, unknown>;
  updateStatus: Record<string, unknown> | null;
  busy: boolean;
  request: RequestFn;
  onProfile: (user: User) => void;
  onUpdateStatusChange: (status: Record<string, unknown> | null) => void;
  onError: (err: unknown) => void;
  onNotify: (msg: string) => void;
  onConfirm: (dialog: ConfirmDialogState) => void;
}) {
  const triggerAppUpdate = () => {
    onConfirm({
      title: 'Pull latest & restart console?',
      description:
        'This pulls the configured GitHub repository, rebuilds the container, and restarts the web app. The console will disconnect briefly; database state and job history are preserved, and dispatched endpoint jobs are never replayed.',
      confirmLabel: 'Pull & restart app',
      tone: 'primary',
      onConfirm: async () => {
        const result = await request<Record<string, unknown>>('/settings/update', 'POST', {});
        onUpdateStatusChange(result);
        onNotify(
          'Update requested. This console may disconnect briefly while the app restarts.',
        );
      },
    });
  };

  return (
    <div className="view-stack">
      <AccountSettings user={user} request={request} onProfile={onProfile} />

      {user.role === 'admin' && <SupportSettings request={request} onError={onError} />}

      <div className="settings-grid">
        <section className="panel settings-card">
          <div className="settings-card-heading">
            <span className="settings-icon">
              <Server size={18} />
            </span>
            <div>
              <h2>Application updates</h2>
              <p>Controlled container updates from the configured repository.</p>
            </div>
          </div>

          <div className="key-values">
            <div>
              <span>Installed version</span>
              <strong className="mono tabular">{String(settings.version || '0.1.0')}</strong>
            </div>
            <div>
              <span>Update service</span>
              <strong>
                {settings.updateEnabled || settings.updatesEnabled ? 'Connected' : 'Not configured'}
              </strong>
            </div>
            {!!settings.updateImage && (
              <div>
                <span>Container image</span>
                <code className="mono">{String(settings.updateImage)}</code>
              </div>
            )}
            <div>
              <span>Current host</span>
              <strong className="mono">{window.location.host}</strong>
            </div>
          </div>

          <div className="info-note compact">
            <ShieldCheck size={16} />
            <p>
              Database state, endpoint enrollments, and job history remain in persistent storage
              across updates.
            </p>
          </div>

          {updateStatus && (
            <div className="update-status">
              <div className="update-status-head">
                <strong>Update status</strong>
                <StatusBadge status={String(updateStatus.status || 'idle')} />
              </div>
              <p>{String(updateStatus.message || 'The update service is ready.')}</p>
              {!!updateStatus.activeCommit && (
                <small className="mono">
                  Active commit {String(updateStatus.activeCommit).slice(0, 12)}
                </small>
              )}
              {typeof updateStatus.automatic === 'boolean' && (
                <small>Automatic checks {updateStatus.automatic ? 'enabled' : 'disabled'}</small>
              )}
              {!!updateStatus.completedAt && (
                <small className="tabular">
                  Last completed {formatTimestamp(String(updateStatus.completedAt))}
                </small>
              )}
            </div>
          )}

          <div className="settings-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !(settings.updateEnabled || settings.updatesEnabled)}
              onClick={triggerAppUpdate}
            >
              <RefreshCw size={15} className={busy ? 'spin' : ''} />
              Pull latest &amp; restart app
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                request<Record<string, unknown>>('/settings/update')
                  .then(onUpdateStatusChange)
                  .catch(onError)
              }
            >
              Check update status <ArrowRight size={14} />
            </button>
          </div>
        </section>

        <div className="settings-side-stack">
          <section className="panel settings-card">
            <div className="settings-card-heading">
              <span className="settings-icon">
                <ShieldCheck size={18} />
              </span>
              <div>
                <h2>Execution safeguards</h2>
                <p>Built for restore-on-reboot library computers.</p>
              </div>
            </div>
            <ul className="check-list">
              <li>
                <CheckCircle2 size={16} />
                Server consumes every job at-most-once before dispatch
              </li>
              <li>
                <CheckCircle2 size={16} />
                No automatic replay after reboot, timeout, or snapshot rollback
              </li>
              <li>
                <CheckCircle2 size={16} />
                Every accepted output chunk is stored without truncation
              </li>
              <li>
                <CheckCircle2 size={16} />
                Administrative changes and sessions are audited
              </li>
            </ul>
            <p className="settings-footnote">
              If an endpoint loses connectivity mid-job, verify device state before queuing a
              replacement job.
            </p>
          </section>

          <section className="panel settings-card">
            <div className="settings-card-heading">
              <span className="settings-icon">
                <Users size={18} />
              </span>
              <div>
                <h2>Remote assistance</h2>
                <p>Interactive screen support on signed-in desktops.</p>
              </div>
            </div>
            <p className="settings-body-copy">
              Inspect any online endpoint running agent 0.1.6 or later and choose Remote support to
              view the desktop and share mouse/keyboard input. The persistent sharing indicator
              remains visible according to workspace policy, and{' '}
              <kbd>Ctrl+Alt+Shift+F12</kbd> ends sharing locally at any time.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
