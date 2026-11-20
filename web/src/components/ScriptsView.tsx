import { Code2, Play, Plus, Search, ShieldCheck, X } from 'lucide-react';
import type { Script } from '../types';
import { formatRelativeTime } from '../uiUtils';
import { EmptyState } from './UiPrimitives';

export function ScriptsView({
  scripts,
  search,
  canEdit,
  onSearchChange,
  onCreate,
  onEdit,
  onRun,
}: {
  scripts: Script[];
  search: string;
  canEdit: boolean;
  onSearchChange: (q: string) => void;
  onCreate: () => void;
  onEdit: (script: Script) => void;
  onRun: (script: Script) => void;
}) {
  const shown = scripts.filter((s) =>
    `${s.name} ${s.description}`.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="view-stack">
      <div className="section-toolbar">
        <div className="search-field">
          <Search size={15} />
          <input
            aria-label="Search scripts"
            placeholder="Search saved PowerShell scripts…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => onSearchChange('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <span className="muted tabular">{shown.length} of {scripts.length} saved scripts</span>
      </div>

      {shown.length ? (
        <div className="script-grid">
          {shown.map((script) => (
            <article className="panel script-card" key={script.id}>
              <div className="script-top">
                <span className="script-title-wrap">
                  <span className="script-icon">
                    <Code2 size={16} />
                  </span>
                  <h2>{script.name}</h2>
                </span>
                <span className="tag-badge">PowerShell</span>
              </div>
              <p className="script-desc">{script.description || 'No description provided.'}</p>
              <pre className="script-snippet">
                {script.body.split('\n').slice(0, 4).join('\n')}
              </pre>
              <div className="script-card-footer">
                <span className="muted tabular">Updated {formatRelativeTime(script.updatedAt)}</span>
                <div className="script-card-actions">
                  {canEdit && (
                    <button
                      type="button"
                      className="button secondary small"
                      onClick={() => onEdit(script)}
                    >
                      Edit
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="button primary small"
                      onClick={() => onRun(script)}
                    >
                      <Play size={13} /> Run
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="panel">
          <EmptyState
            icon={Code2}
            title={scripts.length ? 'No scripts match your search' : 'Build your script library'}
            description={
              scripts.length
                ? 'Try a different keyword or clear the search box.'
                : 'Save reusable PowerShell routines once, then run them across endpoints or put them on a schedule.'
            }
            action={
              !scripts.length && canEdit ? (
                <button type="button" className="button primary" onClick={onCreate}>
                  <Plus size={15} /> Create a script
                </button>
              ) : undefined
            }
          />
        </section>
      )}

      <div className="info-note">
        <ShieldCheck size={16} />
        <p>
          Scripts run as LocalSystem in a fresh PowerShell process. Every execution creates a
          separate audited job with complete output retention.
        </p>
      </div>
    </div>
  );
}
