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

/** What the agent reports for a finished `download` job (folders arrive as one zip, agent 0.1.13+). */
export type DownloadResult = {
  ok: boolean; error?: string; name?: string; size?: number; archive?: boolean; files?: number; folders?: number;
  skippedCount?: number; skipped?: { path: string; error: string }[]; skippedListTruncated?: boolean;
};

/** Agents before 0.1.13 refuse folders with this text; tell the operator how to fix it. */
export function downloadErrorText(error: string, isFolder: boolean): string {
  return isFolder && /folders cannot be downloaded/i.test(error)
    ? 'This computer runs an older agent that cannot zip folders. Update its agent (0.1.13 or newer) and try again.'
    : error;
}

/** Items a folder zip left out (in use, links, agent data), including an explicit line when the list was cut short. */
export function leftOutItems(result: DownloadResult): { path: string; ok: false; error: string }[] {
  const listed = (result.skipped || []).map(item => ({ path: item.path, ok: false as const, error: item.error }));
  const unlisted = (result.skippedCount ?? listed.length) - listed.length;
  if (result.skippedListTruncated && unlisted > 0)
    listed.push({ path: `${result.name ?? 'zip'}: ${unlisted.toLocaleString('en-US')} more`, ok: false, error: 'Not listed here; open the job output for the full result.' });
  return listed;
}
