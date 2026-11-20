import { RefreshCw, ShieldCheck } from 'lucide-react';
import type { Audit } from '../types';
import { formatTimestamp } from '../uiUtils';
import { EmptyState } from './UiPrimitives';

export function AuditView({
  audit,
  onRefresh,
}: {
  audit: Audit[];
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Administrative events</h2>
          <p>Most recent 100 security and operational events recorded by the server.</p>
        </div>
        <button type="button" className="button secondary small" onClick={onRefresh}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {audit.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>Timestamp</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((event, i) => (
                <tr key={event.id || i}>
                  <td>
                    <strong className="mono">{event.action}</strong>
                  </td>
                  <td>{event.actor || 'System'}</td>
                  <td className="nowrap tabular">{formatTimestamp(event.createdAt)}</td>
                  <td>
                    <code className="audit-details">
                      {typeof event.details === 'string'
                        ? event.details
                        : JSON.stringify(event.details || event.targetId || '')}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={ShieldCheck}
          title="No audit events available"
          description="Sign-ins, approvals, script executions, and policy changes appear here automatically."
        />
      )}
    </section>
  );
}
