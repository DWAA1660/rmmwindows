// Pure helpers for the remote file explorer (unit tested in web/test/file-explorer.test.mjs).

/** Joins a Windows folder and a child name ("C:\" + "x" -> "C:\x"; "C:\a" + "x" -> "C:\a\x"). */
export function joinPath(folder: string, name: string): string {
  return folder.endsWith('\\') ? folder + name : `${folder}\\${name}`;
}

/** Parent of a Windows path; a drive root's parent is "" (This PC). */
export function parentPath(path: string): string {
  if (!path || /^[a-z]:\\?$/i.test(path)) return '';
  const trimmed = path.replace(/\\+$/, '');
  const index = trimmed.lastIndexOf('\\');
  if (index < 0) return '';
  const parent = trimmed.slice(0, index);
  return /^[a-z]:$/i.test(parent) ? parent + '\\' : parent;
}

/** Breadcrumb trail: This PC, the drive, then each folder. */
export function crumbs(path: string): { label: string; path: string }[] {
  const trail = [{ label: 'This PC', path: '' }];
  if (!path) return trail;
  const parts = path.replace(/\\+$/, '').split('\\').filter(Boolean);
  let current = '';
  for (const [index, part] of parts.entries()) {
    current = index === 0 ? `${part}\\` : joinPath(current, part);
    trail.push({ label: part, path: current });
  }
  return trail;
}

export function typeLabel(entry: { type: string; name: string; reparse?: boolean }): string {
  if (entry.reparse) return entry.type === 'directory' ? 'Folder link' : 'File link';
  if (entry.type === 'directory') return 'Folder';
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 && dot < entry.name.length - 1 ? `${entry.name.slice(dot + 1).toUpperCase()} file` : 'File';
}

export function formatBytes(value?: number | null): string {
  if (value == null || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024, unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
