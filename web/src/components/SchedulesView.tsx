import { CalendarClock, Pause, Play, Plus, Trash2 } from 'lucide-react';
import type { Endpoint, Schedule, Script } from '../types';
import { formatTimestamp } from '../uiUtils';
import { EmptyState, StatusBadge } from './UiPrimitives';

export function SchedulesView({
  schedules,
  scripts,
  activeEndpoints,
  canEdit,
  onCreate,
  onToggle,
  onDelete,
}: {
  schedules: Schedule[];
  scripts: Script[];
  activeEndpoints: Endpoint[];
  canEdit: boolean;
  onCreate: () => void;
  onToggle: (s: Schedule) => Promise<void>;
  onDelete: (s: Schedule) => void;
}) {
  return (
    <div className="view-stack">
      <div className="info-note">
        <CalendarClock size={16} />
        <p>
          Each occurrence dispatches a single at-most-once job per endpoint. Missed intervals after
          server downtime are skipped cleanly — never replayed.
        </p>
      </div>

      <section className="panel">
        {schedules.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Schedule</th>
                  <th>Script</th>
                  <th>Targets</th>
                  <th>Interval</th>
                  <th>Next run</th>
                  <th>Status</th>
                  <th className="col-action" />
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                    </td>
                    <td>
                      {scripts.find((script) => script.id === s.scriptId)?.name || 'Deleted script'}
                    </td>
                    <td className="tabular">{s.endpointIds.length} endpoints</td>
                    <td className="tabular">Every {s.intervalMinutes} min</td>
                    <td className="tabular nowrap">{formatTimestamp(s.nextRunAt)}</td>
                    <td>
                      <StatusBadge status={s.enabled ? 'enabled' : 'paused'} />
                    </td>
                    <td className="col-action">
                      {canEdit && (
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-button"
                            title={s.enabled ? 'Pause schedule' : 'Enable schedule'}
                            aria-label={s.enabled ? `Pause ${s.name}` : `Enable ${s.name}`}
                            onClick={() => void onToggle(s)}
                          >
                            {s.enabled ? <Pause size={15} /> : <Play size={15} />}
                          </button>
                          <button
                            type="button"
                            className="icon-button danger-text"
                            title="Delete schedule"
                            aria-label={`Delete schedule ${s.name}`}
                            onClick={() => onDelete(s)}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="Keep routine checks on schedule"
            description={
              !scripts.length || !activeEndpoints.length
                ? 'Enroll an endpoint and save at least one PowerShell script before scheduling recurring jobs.'
                : 'Select a saved script, pick target endpoints, and define an interval.'
            }
            action={
              canEdit ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={!scripts.length || !activeEndpoints.length}
                  onClick={onCreate}
                >
                  <Plus size={15} /> Create schedule
                </button>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
