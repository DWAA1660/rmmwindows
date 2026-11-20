import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, ShieldAlert, X } from 'lucide-react';

export type ConfirmDialogState = {
  title: string;
  description: string;
  details?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => Promise<void> | void;
};

export function ConfirmDialog({
  dialog,
  onClose,
}: {
  dialog: ConfirmDialogState | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setError('');
    setBusy(false);
    if (!dialog) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('.confirm-actions button.primary, .confirm-actions button.danger, .confirm-actions button')?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [dialog]);

  if (!dialog) return null;

  const isDanger = dialog.tone === 'danger';
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await dialog.onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="modal confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        ref={panelRef}
      >
        <div className="modal-heading">
          <div className="confirm-title-row">
            <span className={`confirm-icon ${isDanger ? 'danger' : 'primary'}`}>
              {isDanger ? <AlertTriangle size={18} /> : <ShieldAlert size={18} />}
            </span>
            <div>
              <h2 id="confirm-dialog-title">{dialog.title}</h2>
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            disabled={busy}
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <p className="confirm-description">{dialog.description}</p>

        {dialog.details && dialog.details.length > 0 && (
          <ul className="confirm-details">
            {dialog.details.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-footer confirm-actions">
          <span />
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              {dialog.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              className={`button ${isDanger ? 'danger' : 'primary'}`}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy && <Loader2 size={15} className="spin" />}
              {dialog.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
