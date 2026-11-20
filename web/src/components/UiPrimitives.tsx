import React from 'react';
import { BookOpen, Monitor } from 'lucide-react';
import { titleCaseAction } from '../uiUtils';

export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'brand-small' : ''}`}>
      <span className="brand-mark">
        <BookOpen size={20} strokeWidth={1.8} />
      </span>
      <div className="brand-text">
        <strong>Park County Library</strong>
        <span>Endpoint RMM</span>
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <i aria-hidden="true" />
      {titleCaseAction(status)}
    </span>
  );
}

export function EmptyState({
  icon: Icon = Monitor,
  title,
  description,
  action,
}: {
  icon?: typeof Monitor;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={24} strokeWidth={1.6} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function DetailValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
}) {
  return (
    <div className="kv-cell">
      <span>{label}</span>
      <strong className={mono ? 'mono' : ''}>{value || '—'}</strong>
    </div>
  );
}
