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

/** Agents before 0.1.13 cannot zip folders, upload or extract; tell the operator how to fix it. */
export function downloadErrorText(error: string, isFolder: boolean): string {
  if (isFolder && /folders cannot be downloaded/i.test(error))
    return 'This computer runs an older agent that cannot zip folders. Update its agent (0.1.13 or newer) and try again.';
  return agentErrorText(error);
}

export function agentErrorText(error: string): string {
  return /unsupported file action/i.test(error)
    ? 'This computer runs an older agent that cannot do this yet. Update its agent (0.1.13 or newer) and try again.'
    : error;
}

/** Largest single upload the server accepts (matches the server's per-file cap). */
export const MAX_UPLOAD_BYTES = 1024 ** 3;

export const isZip = (name: string) => /\.zip$/i.test(name);

/** Default "Extract to" folder: next to the zip, named after it ("C:\a\b.zip" -> "C:\a\b"). */
export function extractDestination(zipPath: string): string {
  const folder = parentPath(zipPath);
  const name = zipPath.slice(zipPath.lastIndexOf('\\') + 1).replace(/\.zip$/i, '').replace(/[. ]+$/, '') || 'extracted';
  return joinPath(folder, name);
}

/** Names the server/agent would refuse, checked before spending time on an upload. */
export function uploadNameProblem(name: string): string | null {
  if (!name || name.length > 255) return 'Names must be 1 to 255 characters.';
  if (/[\u0000-\u001f\\/:*?"<>|]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i.test(name.split('.')[0].trimEnd()))
    return 'Windows does not allow this file name.';
  return null;
}

/** Items a folder zip left out (in use, links, agent data), including an explicit line when the list was cut short. */
export function leftOutItems(result: DownloadResult): { path: string; ok: false; error: string }[] {
  const listed = (result.skipped || []).map(item => ({ path: item.path, ok: false as const, error: item.error }));
  const unlisted = (result.skippedCount ?? listed.length) - listed.length;
  if (result.skippedListTruncated && unlisted > 0)
    listed.push({ path: `${result.name ?? 'zip'}: ${unlisted.toLocaleString('en-US')} more`, ok: false, error: 'Not listed here; open the job output for the full result.' });
  return listed;
}
