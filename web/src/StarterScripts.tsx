import { useState } from 'react';
import { Check, Eye, Play, Plus, ShieldAlert, ShieldCheck } from 'lucide-react';
import { scriptTemplates, type ScriptTemplate } from './scriptTemplates';

/** Catalog of ready-made scripts: preview, add to the library, or run immediately. */
export function StarterScripts({ existingNames, canEdit, onAdd, onRun }: {
  existingNames: string[]; canEdit: boolean;
  onAdd: (template: ScriptTemplate) => Promise<void>; onRun: (template: ScriptTemplate) => void;
}) {
  const categories = ['All', ...new Set(scriptTemplates.map(template => template.category))];
  const [category, setCategory] = useState('All');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const have = new Set(existingNames.map(name => name.trim().toLowerCase()));
  const shown = scriptTemplates.filter(template => category === 'All' || template.category === category);
  return (
    <div className="starter-scripts">
      <div className="starter-categories" role="tablist" aria-label="Script categories">
        {categories.map(name => (
          <button key={name} type="button" role="tab" aria-selected={category === name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>{name}</button>
        ))}
      </div>
      <div className="starter-grid">
        {shown.map(template => {
          const inLibrary = have.has(template.name.toLowerCase()) || added.has(template.id);
          return (
            <article key={template.id} className="starter-card">
              <header>
                <span className="starter-category">{template.category}</span>
                <span className={`starter-effect ${template.changes ? 'changes' : ''}`}>
                  {template.changes ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}{template.changes ? 'Makes changes' : 'Read-only'}
                </span>
              </header>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              {preview === template.id && <pre className="starter-preview">{template.body}</pre>}
              <footer>
                <button type="button" className="text-button" onClick={() => setPreview(preview === template.id ? null : template.id)}><Eye size={13} /> {preview === template.id ? 'Hide code' : 'Preview'}</button>
                <span className="starter-actions">
                  {canEdit && (
                    <button type="button" className="button small secondary" disabled={inLibrary || busy === template.id}
                      onClick={async () => { setBusy(template.id); try { await onAdd(template); setAdded(previous => new Set(previous).add(template.id)); } finally { setBusy(null); } }}>
                      {inLibrary ? <><Check size={13} /> In library</> : <><Plus size={13} /> Add to library</>}
                    </button>
                  )}
                  {canEdit && <button type="button" className="button small primary" onClick={() => onRun(template)}><Play size={13} /> Run…</button>}
                </span>
              </footer>
            </article>
          );
        })}
      </div>
    </div>
  );
}
