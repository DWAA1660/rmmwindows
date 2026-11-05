import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Monitor, Search, Sparkles, Zap } from 'lucide-react';
import { rankPalette, type PaletteItem } from './commandPaletteModel';
import './CommandPalette.css';

/** Ctrl+K / Cmd+K quick search for computers, pages and actions. */
export function CommandPalette({ items, onSelect }: { items: PaletteItem[]; onSelect: (item: PaletteItem) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<HTMLElement | null>(null);
  const results = useMemo(() => rankPalette(items, query), [items, query]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(value => { if (!value) previous.current = document.activeElement as HTMLElement; return !value; });
        setQuery(''); setIndex(0);
      }
    };
    window.addEventListener('keydown', handler);
    const opener = () => { previous.current = document.activeElement as HTMLElement; setOpen(true); setQuery(''); setIndex(0); };
    window.addEventListener('open-command-palette', opener);
    return () => { window.removeEventListener('keydown', handler); window.removeEventListener('open-command-palette', opener); };
  }, []);
  useEffect(() => { if (open) setTimeout(() => input.current?.focus(), 0); else previous.current?.focus?.(); }, [open]);
  useEffect(() => { setIndex(0); }, [query]);
  if (!open) return null;
  const choose = (item: PaletteItem | undefined) => { if (!item) return; setOpen(false); onSelect(item); };
  const icon = (item: PaletteItem) => item.kind === 'computer' ? <Monitor size={15} /> : item.kind === 'action' ? <Zap size={15} /> : <Sparkles size={15} />;
  return (
    <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Quick search">
        <label className="palette-search">
          <Search size={17} />
          <input ref={input} value={query} placeholder="Jump to a computer, page or action…" aria-label="Quick search" aria-controls="palette-results"
            aria-activedescendant={results[index] ? `palette-${results[index].id}` : undefined}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
              else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(results.length - 1, value + 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, value - 1)); }
              else if (event.key === 'Enter') { event.preventDefault(); choose(results[index]); }
            }} />
          <kbd>Esc</kbd>
        </label>
        <ul id="palette-results" className="palette-results" role="listbox">
          {results.map((item, position) => (
            <li key={item.id} id={`palette-${item.id}`} role="option" aria-selected={position === index}
              className={position === index ? 'active' : ''} onMouseEnter={() => setIndex(position)} onMouseDown={event => { event.preventDefault(); choose(item); }}>
              <span className={`palette-icon ${item.kind}`}>{icon(item)}</span>
              <span className="palette-text"><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</span>
              <span className="palette-kind">{item.kind === 'computer' ? 'Computer' : item.kind === 'action' ? 'Action' : 'Page'}</span>
              {position === index && <CornerDownLeft size={13} className="palette-enter" />}
            </li>
          ))}
          {!results.length && <li className="palette-empty">No computers, pages or actions match “{query}”.</li>}
        </ul>
        <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd> toggle</span></footer>
      </div>
    </div>
  );
}
