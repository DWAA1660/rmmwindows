import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  ArrowUp, Calculator, ChevronRight, ClipboardPaste, Copy, Download, Eye, EyeOff, File, FileArchive, Folder, FolderPlus,
  HardDrive, Link2, Loader2, Monitor, PackageOpen, Pencil, RefreshCw, Scissors, Trash2, TriangleAlert, Upload, X,
} from 'lucide-react';
import {
  joinPath, parentPath, crumbs, typeLabel, formatBytes, downloadErrorText, leftOutItems, agentErrorText, isZip, extractDestination,
  uploadNameProblem, MAX_UPLOAD_BYTES, type DownloadResult,
} from './fileExplorerModel';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type JobInfo = { id: string; status: string; summary?: string | null };
type Chunk = { sequence: number; stream: string; text: string };
export type FileEntry = {
  name: string; path: string; type: 'file' | 'directory'; size: number | null; lastWriteTimeUtc: string;
  hidden?: boolean; system?: boolean; readonly?: boolean; reparse?: boolean;
};
type Drive = { name: string; label?: string | null; type: string; format?: string | null; ready: boolean; totalBytes?: number | null; freeBytes?: number | null };
type Listing = { path: string; entries: FileEntry[]; drives: Drive[]; truncated: boolean; loadedAt: number };
type ItemResult = { path: string; ok: boolean; error?: string | null; target?: string | null; note?: string | null };
type Outcome = { action: string; ok: boolean; error?: string; succeeded?: number; failed?: number; results?: ItemResult[] };
type SortKey = 'name' | 'size' | 'modified' | 'type';
type Activity = { label: string; jobId?: string; status?: string; since: number; progress?: number; cancel?: () => void };
/** A finished upload on the server, ready to be saved on the computer. */
type StoredUpload = { uploadId: string; name: string };

const TERMINAL = ['succeeded', 'failed', 'interrupted', 'cancelled'];
const POLL_MS = 350;
const RENDER_STEP = 1500;
const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

/**
 * Queues one at-most-once job and waits for its JSON result. Polls quickly; with the agent's
 * long-poll claim a job normally starts within moments of being queued.
 */
async function runJob<T>(request: Request, endpointId: string, kind: string, payload: Record<string, unknown>, timeoutSeconds: number,
  onUpdate?: (job: JobInfo) => void): Promise<{ job: JobInfo; result: T | null }> {
  const created = await request<{ jobs: JobInfo[] }>('/jobs', 'POST', { endpointIds: [endpointId], kind, payload, timeoutSeconds, idempotencyKey: crypto.randomUUID() });
  let job = created.jobs[0];
  onUpdate?.(job);
  while (!TERMINAL.includes(job.status)) {
    await sleep(POLL_MS);
    job = await request<JobInfo>(`/jobs/${job.id}`);
    onUpdate?.(job);
  }
  if (job.status === 'cancelled') throw new Error('The request was cancelled before the computer picked it up.');
  // Output is uploaded before the completion, so everything is on the server by now.
  let after = -1, more = true, text = '';
  while (more) {
    const page = await request<{ chunks: Chunk[]; nextCursor: number; hasMore: boolean }>(`/jobs/${job.id}/output?after=${after}&limit=1000`);
    text += page.chunks.filter(chunk => chunk.stream === 'stdout').map(chunk => chunk.text).join('');
    after = page.nextCursor; more = page.hasMore;
  }
  try { return { job, result: text.trim() ? JSON.parse(text) as T : null }; }
  catch { return { job, result: null }; }
}

const failureText = (job: JobInfo, fallback: string) =>
  job.status === 'interrupted' ? `The computer could not finish this request: ${job.summary || 'interrupted'}. It will not be retried automatically.` : job.summary || fallback;

export function FileExplorer({ endpoint, request, canWrite }: {
  endpoint: { id: string; name: string; online: boolean }; request: Request; canWrite: boolean;
}) {
  const cache = useRef(new Map<string, Listing>());
  const navToken = useRef(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [navActivity, setNavActivity] = useState<Activity | null>(null);
  const [opActivity, setOpActivity] = useState<Activity | null>(null);
  const [pathInput, setPathInput] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'name', descending: false });
  const [showHidden, setShowHidden] = useState(false);
  const [clipboard, setClipboard] = useState<{ mode: 'copy' | 'cut'; paths: string[]; from: string } | null>(null);
  const [sizes, setSizes] = useState<Record<string, { bytes: number | null; partial: boolean }>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failures, setFailures] = useState<{ title: string; items: ItemResult[]; retry?: () => void; tone?: 'warning' } | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'delete' } | { kind: 'rename'; entry: FileEntry } | { kind: 'mkdir' } | { kind: 'extract'; entry: FileEntry }>(null);
  const [nameInput, setNameInput] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadCancelled = useRef(false);
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);
  const [now, setNow] = useState(Date.now());
  const busy = opActivity !== null;
  const currentPath = listing?.path ?? '';

  // Tick for "waiting for the computer" messages.
  useEffect(() => {
    if (!navActivity && !opActivity) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [navActivity, opActivity]);

  const listingRef = useRef<Listing | null>(null);
  const show = (next: Listing) => {
    if (listingRef.current?.path !== next.path) { setSelected(new Set()); setRenderLimit(RENDER_STEP); }
    listingRef.current = next;
    setListing(next);
    setPathInput(next.path);
  };

  /** Opens a folder ('' = This PC). Newest click wins; a cached listing shows instantly and refreshes. */
  const open = async (target: string, { keepMessages = false } = {}) => {
    if (!canWrite) return;
    const token = ++navToken.current;
    setLoadingPath(target);
    // A refresh after an action keeps that action's result message visible.
    if (!keepMessages) { setError(''); setNotice(''); setFailures(null); }
    const cached = cache.current.get(target);
    if (cached) show(cached);
    setNavActivity({ label: cached ? `Refreshing ${target || 'This PC'}` : `Opening ${target || 'This PC'}`, since: Date.now() });
    try {
      const { job, result } = await runJob<{ ok: boolean; error?: string; path: string; entries?: FileEntry[]; drives?: Drive[]; truncated?: boolean }>(
        request, endpoint.id, 'files', { action: 'list', path: target }, 120,
        update => { if (token === navToken.current) setNavActivity(activity => activity && { ...activity, jobId: update.id, status: update.status }); });
      if (!result?.ok) throw new Error(result?.error || failureText(job, 'The folder could not be listed.'));
      const fresh: Listing = { path: result.path ?? target, entries: result.entries || [], drives: result.drives || [], truncated: !!result.truncated, loadedAt: Date.now() };
      cache.current.set(target, fresh);
      if (token === navToken.current) show(fresh);
    } catch (e) {
      if (token === navToken.current) {
        setError((e as Error).message);
        setPathInput(listingRef.current?.path ?? '');
        // A folder that no longer exists should not keep reappearing from the cache.
        cache.current.delete(target);
      }
    } finally {
      if (token === navToken.current) { setLoadingPath(null); setNavActivity(null); }
    }
  };

  useEffect(() => { void open(''); /* This PC on first open */ }, [endpoint.id]);

  const entries = useMemo(() => {
    const list = (listing?.entries || []).filter(entry => showHidden || !(entry.hidden || entry.system));
    const sizeOf = (entry: FileEntry) => entry.type === 'directory' ? sizes[entry.path]?.bytes ?? -1 : entry.size ?? 0;
    const compare = (a: FileEntry, b: FileEntry) => {
      switch (sort.key) {
        case 'size': return sizeOf(a) - sizeOf(b);
        case 'modified': return Date.parse(a.lastWriteTimeUtc) - Date.parse(b.lastWriteTimeUtc);
        case 'type': return typeLabel(a).localeCompare(typeLabel(b)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        default: return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      }
    };
    return list.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1; // folders first, like Explorer
      const result = compare(a, b);
      return sort.descending ? -result : result;
    });
  }, [listing, showHidden, sort, sizes]);
  const hiddenCount = (listing?.entries || []).filter(entry => entry.hidden || entry.system).length;
  const selectedEntries = (listing?.entries || []).filter(entry => selected.has(entry.path));
  const allSelected = entries.length > 0 && entries.every(entry => selected.has(entry.path));
  const toggle = (path: string) => setSelected(previous => {
    const next = new Set(previous);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const sortBy = (key: SortKey) => setSort(previous => ({ key, descending: previous.key === key ? !previous.descending : key === 'size' || key === 'modified' }));

  /** Runs a mutating files job, reports per-item failures, and refreshes the folder. */
  const mutate = async (label: string, payload: Record<string, unknown>, after?: (outcome: Outcome) => void) => {
    setOpActivity({ label, since: Date.now() }); setError(''); setNotice(''); setFailures(null);
    try {
      const { job, result } = await runJob<Outcome>(request, endpoint.id, 'files', payload, 1800,
        update => setOpActivity(activity => activity && { ...activity, jobId: update.id, status: update.status }));
      if (!result) throw new Error(failureText(job, 'The computer did not report a result.'));
      if (result.error) throw new Error(agentErrorText(result.error));
      const failed = (result.results || []).filter(item => !item.ok);
      if (failed.length) setFailures({ title: `${result.succeeded ?? 0} succeeded, ${failed.length} failed`, items: failed });
      else setNotice(job.summary || 'Done.');
      after?.(result);
      return result;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setOpActivity(null);
      const folder = listingRef.current?.path;
      if (folder) { cache.current.delete(folder); void open(folder, { keepMessages: true }); }
    }
  };

  /** Downloads each selected item; the agent compresses folders into one .zip each before sending them. */
  const downloadSelected = async () => {
    const items = selectedEntries;
    setError(''); setNotice(''); setFailures(null);
    const problems: ItemResult[] = [];
    const leftOut: ItemResult[] = [];
    const saved: string[] = [];
    for (const [index, item] of items.entries()) {
      const isFolder = item.type === 'directory';
      const position = items.length > 1 ? ` (${index + 1} of ${items.length})` : '';
      setOpActivity({ label: isFolder ? `Compressing ${item.name} into a .zip and fetching it${position}` : `Fetching ${item.name}${position}`, since: Date.now() });
      try {
        const { job, result } = await runJob<DownloadResult>(request, endpoint.id, 'files', { action: 'download', path: item.path }, 3600,
          update => setOpActivity(activity => activity && { ...activity, jobId: update.id, status: update.status }));
        if (!result?.ok) throw new Error(downloadErrorText(result?.error || failureText(job, `${item.name} could not be fetched.`), isFolder));
        // The browser saves it from the attachment response; the page stays here.
        const name = result.name || (isFolder ? `${item.name}.zip` : item.name);
        const link = document.createElement('a');
        link.href = `/api/jobs/${job.id}/file`;
        link.download = name;
        document.body.appendChild(link); link.click(); link.remove();
        saved.push(name);
        if (result.archive) leftOut.push(...leftOutItems(result));
      } catch (e) { problems.push({ path: item.path, ok: false, error: (e as Error).message }); }
    }
    setOpActivity(null);
    const leftOutTitle = `${leftOut.length.toLocaleString()} item(s) could not be included in the zip`;
    if (problems.length) {
      setFailures({ title: [`${saved.length} downloaded`, `${problems.length} failed`, ...(leftOut.length ? [leftOutTitle] : [])].join(', '), items: [...problems, ...leftOut] });
      return;
    }
    setNotice(saved.length === 1 ? `${saved[0]} is downloading in your browser.` : `${saved.length} downloads started in your browser: ${saved.join(', ')}.`);
    // The download succeeded; what was left out (in use, links, agent data) is a warning, not a failure.
    if (leftOut.length) setFailures({ title: leftOutTitle, items: leftOut, tone: 'warning' });
  };

  /** Refreshes a folder's listing if it is still the one on screen; otherwise just forgets the cached copy. */
  const refreshIfShowing = (folder: string) => {
    cache.current.delete(folder);
    if (listingRef.current?.path === folder) void open(folder, { keepMessages: true });
  };

  /** Queues the at-most-once job that saves a finished upload on the computer. */
  const deliver = async (upload: StoredUpload, folder: string, overwrite: boolean, label: string) => {
    setOpActivity({ label, since: Date.now() });
    const { job, result } = await runJob<{ ok: boolean; error?: string; path?: string }>(request, endpoint.id, 'files',
      { action: 'upload', uploadId: upload.uploadId, destinationDirectory: folder, overwrite }, 3600,
      update => setOpActivity(activity => activity && { ...activity, jobId: update.id, status: update.status }));
    if (!result?.ok) throw new Error(agentErrorText(result?.error || failureText(job, `${upload.name} could not be saved.`)));
  };

  const reportUploads = (folder: string, saved: string[], problems: ItemResult[], conflicts: StoredUpload[]) => {
    setOpActivity(null);
    if (problems.length) {
      setFailures({ title: `${saved.length} uploaded, ${problems.length} not uploaded`, items: problems,
        retry: conflicts.length ? () => void replaceUploads(folder, conflicts) : undefined });
    } else setNotice(saved.length === 1 ? `${saved[0]} was uploaded to ${folder}.` : `${saved.length} files were uploaded to ${folder}.`);
    refreshIfShowing(folder);
  };

  /** Sends files from this browser to the computer: browser -> server (chunked) -> one job per file. */
  const uploadFiles = async (picked: File[], skipped: ItemResult[] = []) => {
    const folder = listingRef.current?.path;
    if (!folder || (!picked.length && !skipped.length)) return;
    setError(''); setNotice(''); setFailures(null);
    uploadCancelled.current = false;
    const problems: ItemResult[] = [...skipped];
    const conflicts: StoredUpload[] = [];
    const saved: string[] = [];
    for (const [index, file] of picked.entries()) {
      const target = joinPath(folder, file.name);
      if (uploadCancelled.current) { problems.push({ path: target, ok: false, error: 'Not uploaded: the upload was cancelled.' }); continue; }
      const position = picked.length > 1 ? ` (${index + 1} of ${picked.length})` : '';
      const nameProblem = uploadNameProblem(file.name);
      if (nameProblem) { problems.push({ path: target, ok: false, error: nameProblem }); continue; }
      if (file.size > MAX_UPLOAD_BYTES) { problems.push({ path: target, ok: false, error: `${formatBytes(file.size)} is larger than the 1 GiB upload limit.` }); continue; }
      let uploadId: string | null = null;
      try {
        setOpActivity({ label: `Uploading ${file.name} to the server${position}`, since: Date.now(), progress: 0, cancel: () => { uploadCancelled.current = true; } });
        const created = await request<{ id: string; chunkBytes: number }>('/uploads', 'POST', { name: file.name, sizeBytes: file.size });
        uploadId = created.id;
        for (let offset = 0, sequence = 0; offset < file.size; offset += created.chunkBytes, sequence++) {
          if (uploadCancelled.current) throw new Error('Not uploaded: the upload was cancelled.');
          await request(`/uploads/${created.id}/chunks/${sequence}`, 'PUT', file.slice(offset, offset + created.chunkBytes));
          const done = Math.min(file.size, offset + created.chunkBytes) / file.size;
          setOpActivity(activity => activity && { ...activity, progress: done });
        }
        await request(`/uploads/${created.id}/complete`, 'POST', {});
        if (uploadCancelled.current) throw new Error('Not uploaded: the upload was cancelled.');
        const stored = { uploadId: created.id, name: file.name };
        try {
          await deliver(stored, folder, false, `Saving ${file.name} on ${endpoint.name}${position}`);
          saved.push(file.name);
          uploadId = null; // delivered; the server frees its copy automatically
        } catch (e) {
          // Keep the server copy so "Replace existing items" can resend it without uploading again.
          if (/already exists/i.test((e as Error).message) && !/folder named/i.test((e as Error).message)) { conflicts.push(stored); uploadId = null; }
          throw e;
        }
      } catch (e) {
        problems.push({ path: target, ok: false, error: (e as Error).message });
      } finally {
        if (uploadId) void request(`/uploads/${uploadId}`, 'DELETE').catch(() => { /* expires on its own */ });
      }
    }
    reportUploads(folder, saved, problems, conflicts);
  };

  const replaceUploads = async (folder: string, conflicts: StoredUpload[]) => {
    setError(''); setNotice(''); setFailures(null);
    const problems: ItemResult[] = [];
    const saved: string[] = [];
    for (const [index, upload] of conflicts.entries()) {
      try {
        await deliver(upload, folder, true, `Replacing ${upload.name} on ${endpoint.name}${conflicts.length > 1 ? ` (${index + 1} of ${conflicts.length})` : ''}`);
        saved.push(upload.name);
      } catch (e) { problems.push({ path: joinPath(folder, upload.name), ok: false, error: (e as Error).message }); }
    }
    reportUploads(folder, saved, problems, []);
  };

  /** Files dropped from the computer's desktop. Folders cannot be sent directly; zip them first. */
  const dropFiles = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy || !listingRef.current?.path) return;
    const files: File[] = [];
    const skipped: ItemResult[] = [];
    for (const item of Array.from(event.dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      const file = item.getAsFile();
      if (entry?.isDirectory) skipped.push({ path: entry.name, ok: false, error: 'Folders cannot be uploaded directly. Zip the folder, upload the .zip, then choose Extract.' });
      else if (file) files.push(file);
    }
    void uploadFiles(files, skipped);
  };

  const paste = (overwrite = false, paths = clipboard?.paths || []) => {
    if (!clipboard || !listing?.path) return;
    const mode = clipboard.mode;
    void mutate(`${mode === 'cut' ? 'Moving' : 'Copying'} ${paths.length} item(s) to ${listing.path}`,
      { action: mode === 'cut' ? 'move' : 'copy', sources: paths, destinationDirectory: listing.path, overwrite },
      outcome => {
        const failed = (outcome.results || []).filter(item => !item.ok);
        if (mode === 'cut') setClipboard(failed.length ? { ...clipboard, paths: failed.map(item => item.path) } : null);
        // Offer a replace pass only for items that collided with existing names.
        const conflicts = failed.filter(item => /already exists/i.test(item.error || ''));
        if (conflicts.length && !overwrite)
          setFailures(previous => previous && { ...previous, retry: () => paste(true, conflicts.map(item => item.path)) });
        // Moved items no longer exist in the old folder.
        if (mode === 'cut') cache.current.delete(clipboard.from);
      });
  };

  const calculateSizes = async () => {
    if (!listing?.path) return;
    setOpActivity({ label: `Calculating folder sizes in ${listing.path} (this can take a while)`, since: Date.now() }); setError(''); setNotice('');
    try {
      const { job, result } = await runJob<{ entries?: { path: string; isDirectory: boolean; sizeBytes?: number | null; partial?: boolean }[]; partial?: boolean }>(
        request, endpoint.id, 'storage', { path: listing.path }, 900,
        update => setOpActivity(activity => activity && { ...activity, jobId: update.id, status: update.status }));
      if (!result?.entries) throw new Error(failureText(job, 'Folder sizes could not be calculated.'));
      setSizes(previous => ({ ...previous, ...Object.fromEntries(result.entries!.filter(entry => entry.isDirectory).map(entry => [entry.path, { bytes: entry.sizeBytes ?? null, partial: !!entry.partial }])) }));
      setSort({ key: 'size', descending: true });
      setNotice(result.partial ? 'Folder sizes calculated. Some folders could not be read completely (marked ≥).' : 'Folder sizes calculated.');
    } catch (e) { setError((e as Error).message); }
    finally { setOpActivity(null); }
  };

  const cancelQueued = async (activity: Activity | null) => {
    if (!activity?.jobId) return;
    try { await request(`/jobs/${activity.jobId}/cancel`, 'POST', {}); }
    catch (e) { setError((e as Error).message); }
  };

  const submitDialog = () => {
    if (!dialog || !listing) return;
    if (dialog.kind === 'delete') {
      const paths = selectedEntries.map(entry => entry.path);
      setDialog(null);
      void mutate(`Deleting ${paths.length} item(s)`, { action: 'delete', paths, recursive }, () => setSelected(new Set()));
    } else if (dialog.kind === 'extract') {
      const destination = nameInput.trim();
      if (!destination) return;
      const zip = dialog.entry;
      setDialog(null);
      const run = (overwrite: boolean) => void mutate(`Extracting ${zip.name} to ${destination}`,
        { action: 'extract', path: zip.path, destinationDirectory: destination, overwrite },
        outcome => {
          if (!overwrite && (outcome.results || []).some(item => /already exists/i.test(item.error || '')))
            setFailures(previous => previous && { ...previous, retry: () => run(true) });
        });
      run(replaceExisting);
    } else if (dialog.kind === 'rename') {
      const name = nameInput.trim();
      if (!name || name === dialog.entry.name) { setDialog(null); return; }
      setDialog(null);
      void mutate(`Renaming ${dialog.entry.name}`, { action: 'rename', path: dialog.entry.path, newName: name }, () => setSelected(new Set()));
    } else {
      const name = nameInput.trim();
      if (!name) return;
      setDialog(null);
      void mutate(`Creating ${name}`, { action: 'mkdir', path: joinPath(listing.path, name) });
    }
  };

  if (!canWrite) {
    return <div className="fx-empty"><TriangleAlert size={18} /> Browsing files runs jobs on the computer, so it requires an operator or administrator account.</div>;
  }

  const activity = opActivity || navActivity;
  const waitingSeconds = activity ? Math.floor((now - activity.since) / 1000) : 0;
  const atRoot = !listing || listing.path === '';
  const hasFolderSelected = selectedEntries.some(entry => entry.type === 'directory');
  const onlyFolders = hasFolderSelected && selectedEntries.every(entry => entry.type === 'directory');
  const selectedZip = selectedEntries.length === 1 && selectedEntries[0].type === 'file' && !selectedEntries[0].reparse && isZip(selectedEntries[0].name) ? selectedEntries[0] : null;
  const acceptsDrop = !atRoot && !busy && !!listing;

  return (
    <div className={`fx${dragging ? ' fx-dragging' : ''}`}
      onDragOver={event => { if (acceptsDrop && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={event => { if (acceptsDrop) dropFiles(event); else { event.preventDefault(); setDragging(false); } }}>
      {dragging && <div className="fx-drop" aria-hidden><Upload size={22} /> Drop files to upload them to {currentPath}</div>}
      <input ref={fileInput} type="file" multiple hidden onChange={event => { const picked = Array.from(event.target.files || []); event.target.value = ''; void uploadFiles(picked); }} />
      {!endpoint.online && (
        <div className="fx-banner"><TriangleAlert size={15} /> {endpoint.name} is offline. Requests wait in the queue until it reconnects (you can cancel them).</div>
      )}
      <div className="fx-nav">
        <button className="icon-button fx-icon" title="Up one level" aria-label="Up one level" disabled={atRoot} onClick={() => void open(parentPath(currentPath))}><ArrowUp size={16} /></button>
        <button className="icon-button fx-icon" title="Refresh" aria-label="Refresh" onClick={() => { cache.current.delete(currentPath); void open(currentPath); }}>
          <RefreshCw size={15} className={loadingPath === currentPath && navActivity ? 'spin' : ''} />
        </button>
        <nav className="fx-crumbs" aria-label="Folder path">
          {crumbs(currentPath).map((crumb, index, all) => (
            <span key={crumb.path || 'pc'} className="fx-crumb">
              {index > 0 && <ChevronRight size={12} aria-hidden />}
              <button className={index === all.length - 1 ? 'current' : ''} onClick={() => void open(crumb.path)}>
                {index === 0 && <Monitor size={13} aria-hidden />}{crumb.label}
                {loadingPath === crumb.path && navActivity && <Loader2 size={12} className="spin" aria-label="Loading" />}
              </button>
            </span>
          ))}
        </nav>
        <form className="fx-path" onSubmit={event => { event.preventDefault(); const value = pathInput.trim(); void open(/^[a-z]:$/i.test(value) ? value + '\\' : value); }}>
          <input aria-label="Folder path" value={pathInput} placeholder="C:\Users" onChange={event => setPathInput(event.target.value)} spellCheck={false} />
        </form>
      </div>

      {!atRoot && (
        <div className="fx-toolbar" role="toolbar" aria-label="File actions">
          <button className="button secondary small" disabled={busy || !selected.size}
            title={hasFolderSelected ? 'Download the selected items; each folder is compressed into its own .zip on the computer first (up to 1 GiB per download)' : 'Download the selected files'}
            onClick={() => void downloadSelected()}>
            {onlyFolders ? <FileArchive size={14} /> : <Download size={14} />} {onlyFolders ? 'Download as .zip' : 'Download'}
          </button>
          <button className="button secondary small" disabled={busy} title={`Upload files from this browser to ${currentPath} (up to 1 GiB each; you can also drag files here)`}
            onClick={() => fileInput.current?.click()}><Upload size={14} /> Upload</button>
          <button className="button secondary small" disabled={busy || !selectedZip} title={selectedZip ? `Extract ${selectedZip.name} on ${endpoint.name}` : 'Select one .zip file to extract it'}
            onClick={() => { if (!selectedZip) return; setNameInput(extractDestination(selectedZip.path)); setReplaceExisting(false); setDialog({ kind: 'extract', entry: selectedZip }); }}>
            <PackageOpen size={14} /> Extract
          </button>
          <button className="button secondary small" disabled={busy || !selected.size} onClick={() => { setClipboard({ mode: 'copy', paths: selectedEntries.map(entry => entry.path), from: currentPath }); setNotice(`${selected.size} item(s) copied. Open a folder and choose Paste.`); }}><Copy size={14} /> Copy</button>
          <button className="button secondary small" disabled={busy || !selected.size} onClick={() => { setClipboard({ mode: 'cut', paths: selectedEntries.map(entry => entry.path), from: currentPath }); setNotice(`${selected.size} item(s) cut. Open a folder and choose Paste to move them.`); }}><Scissors size={14} /> Cut</button>
          <button className="button secondary small" disabled={busy || !clipboard} title={clipboard ? `${clipboard.mode === 'cut' ? 'Move' : 'Copy'} ${clipboard.paths.length} item(s) here` : 'Copy or cut items first'} onClick={() => paste()}>
            <ClipboardPaste size={14} /> Paste{clipboard ? ` (${clipboard.paths.length})` : ''}
          </button>
          <button className="button secondary small" disabled={busy || selected.size !== 1} onClick={() => { const entry = selectedEntries[0]; setNameInput(entry.name); setDialog({ kind: 'rename', entry }); }}><Pencil size={14} /> Rename</button>
          <button className="button secondary small" disabled={busy} onClick={() => { setNameInput('New folder'); setDialog({ kind: 'mkdir' }); }}><FolderPlus size={14} /> New folder</button>
          <button className="button secondary small fx-danger" disabled={busy || !selected.size} onClick={() => { setRecursive(true); setDialog({ kind: 'delete' }); }}><Trash2 size={14} /> Delete</button>
          <span className="fx-toolbar-spacer" />
          <button className="button secondary small" disabled={busy} title="Recursive scan of every folder here (separate, slower job)" onClick={() => void calculateSizes()}><Calculator size={14} /> Calculate folder sizes</button>
          <button className="button secondary small" aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}>
            {showHidden ? <EyeOff size={14} /> : <Eye size={14} />} {showHidden ? 'Hide' : 'Show'} hidden{hiddenCount ? ` (${hiddenCount})` : ''}
          </button>
        </div>
      )}

      {clipboard && !atRoot && (
        <div className="fx-clipboard">
          <span>{clipboard.mode === 'cut' ? 'Cut' : 'Copied'}: {clipboard.paths.length === 1 ? clipboard.paths[0] : `${clipboard.paths.length} items from ${clipboard.from}`}</span>
          <button className="icon-button" aria-label="Clear clipboard" title="Clear clipboard" onClick={() => setClipboard(null)}><X size={14} /></button>
        </div>
      )}

      {activity && (
        <div className="fx-status" role="status">
          <Loader2 size={14} className="spin" />
          <span>{activity.label}{activity.progress !== undefined ? ` — ${Math.floor(activity.progress * 100)}%` : ''}…{activity.status === 'queued' && waitingSeconds >= 3 ? ` Waiting for ${endpoint.name} to pick it up (${waitingSeconds}s).` : ''}</span>
          {activity.progress !== undefined && <span className="progress-track fx-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(activity.progress * 100)}><span style={{ width: `${activity.progress * 100}%` }} /></span>}
          {activity.cancel && activity.progress !== undefined && <button className="text-button" onClick={activity.cancel}>Cancel</button>}
          {activity.status === 'queued' && waitingSeconds >= 3 && <button className="text-button" onClick={() => void cancelQueued(activity)}>Cancel</button>}
        </div>
      )}
      {error && <p className="form-error fx-message" role="alert">{error}</p>}
      {notice && !error && <p className="fx-notice fx-message">{notice}</p>}
      {failures && (
        <div className={`fx-failures${failures.tone === 'warning' ? ' fx-warning' : ''}`} role={failures.tone === 'warning' ? 'status' : 'alert'}>
          <strong>{failures.title}</strong>
          <ul>{failures.items.slice(0, 50).map(item => <li key={item.path}><code>{item.path}</code> — {item.error}</li>)}</ul>
          {failures.items.length > 50 && <p>…and {failures.items.length - 50} more. The job's full output lists every item.</p>}
          <div className="fx-failure-actions">
            {failures.retry && <button className="button secondary small" onClick={failures.retry}>Replace existing items</button>}
            <button className="button secondary small" onClick={() => setFailures(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {dialog && (
        <div className="fx-dialog" role="dialog" aria-modal="false" aria-label={dialog.kind === 'delete' ? 'Confirm delete' : dialog.kind === 'rename' ? 'Rename' : dialog.kind === 'extract' ? 'Extract zip' : 'New folder'}>
          {dialog.kind === 'extract' ? (
            <form onSubmit={event => { event.preventDefault(); submitDialog(); }}>
              <label>Extract {dialog.entry.name} on {endpoint.name} into this folder (created if it does not exist)
                <input autoFocus value={nameInput} maxLength={4096} onChange={event => setNameInput(event.target.value)} spellCheck={false} />
              </label>
              <label className="fx-check"><input type="checkbox" checked={replaceExisting} onChange={event => setReplaceExisting(event.target.checked)} /> Replace files that already exist there</label>
              <p className="muted fx-hint">Entries that would land outside this folder, pass through links or go into protected system folders are skipped and listed.</p>
              <div className="fx-dialog-actions">
                <button type="button" className="button secondary small" onClick={() => setDialog(null)}>Cancel</button>
                <button type="submit" className="button primary small" disabled={!nameInput.trim()}><PackageOpen size={14} /> Extract</button>
              </div>
            </form>
          ) : dialog.kind === 'delete' ? (
            <>
              <strong>Permanently delete {selectedEntries.length} item(s) from {endpoint.name}?</strong>
              <p>Files are removed from the disk, not moved to the Recycle Bin. This cannot be undone.</p>
              <ul className="fx-delete-list">
                {selectedEntries.slice(0, 100).map(entry => <li key={entry.path}>{entry.type === 'directory' ? <Folder size={13} /> : <File size={13} />} {entry.path}</li>)}
                {selectedEntries.length > 100 && <li>…and {selectedEntries.length - 100} more</li>}
              </ul>
              {hasFolderSelected && (
                <label className="fx-check"><input type="checkbox" checked={recursive} onChange={event => setRecursive(event.target.checked)} /> Delete folders including everything inside them (links inside are removed, never followed)</label>
              )}
              <div className="fx-dialog-actions">
                <button className="button secondary small" onClick={() => setDialog(null)}>Cancel</button>
                <button className="button danger small" onClick={submitDialog}><Trash2 size={14} /> Delete permanently</button>
              </div>
            </>
          ) : (
            <form onSubmit={event => { event.preventDefault(); submitDialog(); }}>
              <label>{dialog.kind === 'rename' ? `New name for ${dialog.entry.name}` : `New folder in ${currentPath}`}
                <input autoFocus value={nameInput} maxLength={255} onChange={event => setNameInput(event.target.value)} spellCheck={false} />
              </label>
              <div className="fx-dialog-actions">
                <button type="button" className="button secondary small" onClick={() => setDialog(null)}>Cancel</button>
                <button type="submit" className="button primary small" disabled={!nameInput.trim()}>{dialog.kind === 'rename' ? 'Rename' : 'Create folder'}</button>
              </div>
            </form>
          )}
        </div>
      )}

      {!listing ? (
        <div className="fx-empty"><Loader2 size={16} className="spin" /> Connecting to {endpoint.name}…</div>
      ) : atRoot ? (
        <div className="fx-drives">
          {listing.drives.map(drive => {
            const used = drive.totalBytes && drive.freeBytes != null ? Math.min(100, Math.max(0, ((drive.totalBytes - drive.freeBytes) / drive.totalBytes) * 100)) : null;
            return (
              <button key={drive.name} className="fx-drive" disabled={!drive.ready} onClick={() => void open(drive.name)}>
                <span className="fx-drive-icon">{loadingPath === drive.name && navActivity ? <Loader2 size={20} className="spin" /> : <HardDrive size={20} />}</span>
                <span className="fx-drive-text">
                  <strong>{drive.label ? `${drive.label} (${drive.name.replace(/\\$/, '')})` : drive.name.replace(/\\$/, '')}</strong>
                  <small>{drive.ready ? `${formatBytes(drive.freeBytes)} free of ${formatBytes(drive.totalBytes)} · ${drive.type}` : `${drive.type} · not ready`}</small>
                  {used !== null && <span className="progress-track"><span className={used >= 85 ? 'warning' : ''} style={{ width: `${used}%` }} /></span>}
                </span>
              </button>
            );
          })}
          {!listing.drives.length && <p className="muted">No drives reported.</p>}
        </div>
      ) : (
        <>
          <div className="table-scroll fx-table-wrap">
            <table className="fx-table">
              <thead>
                <tr>
                  <th className="fx-check-cell"><input type="checkbox" aria-label="Select all" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map(entry => entry.path)))} /></th>
                  {([['name', 'NAME'], ['size', 'SIZE'], ['modified', 'MODIFIED'], ['type', 'TYPE']] as [SortKey, string][]).map(([key, label]) => (
                    <th key={key} className={`fx-col-${key}`} aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
                      <button className="fx-sort" onClick={() => sortBy(key)}>{label}{sort.key === key ? (sort.descending ? ' ▼' : ' ▲') : ''}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.slice(0, renderLimit).map(entry => {
                  const isFolder = entry.type === 'directory';
                  const size = isFolder ? sizes[entry.path] : null;
                  const loading = loadingPath === entry.path && navActivity;
                  return (
                    <tr key={entry.path} className={`${selected.has(entry.path) ? 'fx-selected' : ''} ${isFolder ? 'fx-folder-row' : ''} ${entry.hidden || entry.system ? 'fx-hidden' : ''}`}
                      onClick={isFolder ? () => void open(entry.path) : undefined}>
                      <td className="fx-check-cell" onClick={event => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.path)} onChange={() => toggle(entry.path)} />
                      </td>
                      <td className="fx-col-name">
                        {isFolder ? (
                          <button className="fx-name fx-folder" onClick={event => { event.stopPropagation(); void open(entry.path); }}>
                            {loading ? <Loader2 size={15} className="spin" aria-label="Opening" /> : <Folder size={15} />}
                            <span>{entry.name}</span>
                            {entry.reparse && <Link2 size={12} aria-label="Link" />}
                          </button>
                        ) : (
                          <span className="fx-name"><File size={15} /><span>{entry.name}</span>{entry.reparse && <Link2 size={12} aria-label="Link" />}</span>
                        )}
                      </td>
                      <td className="fx-col-size">{isFolder ? (size ? `${size.partial ? '≥ ' : ''}${formatBytes(size.bytes)}` : '') : formatBytes(entry.size)}</td>
                      <td className="fx-col-modified">{entry.lastWriteTimeUtc ? new Date(entry.lastWriteTimeUtc).toLocaleString() : '—'}</td>
                      <td className="fx-col-type">{typeLabel(entry)}</td>
                    </tr>
                  );
                })}
                {!entries.length && (
                  <tr><td colSpan={5} className="fx-empty-row">{listing.entries.length ? `Only hidden or system items here (${hiddenCount}). Choose “Show hidden” to see them.` : 'This folder is empty.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {entries.length > renderLimit && (
            <button className="text-button fx-more" onClick={() => setRenderLimit(limit => limit + RENDER_STEP)}>Show {Math.min(RENDER_STEP, entries.length - renderLimit).toLocaleString()} more of {entries.length.toLocaleString()}</button>
          )}
          <div className="fx-footer">
            <span>{entries.length.toLocaleString()} item(s){selected.size ? ` · ${selected.size} selected` : ''}{!showHidden && hiddenCount ? ` · ${hiddenCount} hidden` : ''}</span>
            {listing.truncated && <span className="text-amber">Showing the first {listing.entries.length.toLocaleString()} entries; this folder has more. Use PowerShell for the rest.</span>}
            <span>Updated {new Date(listing.loadedAt).toLocaleTimeString()}</span>
          </div>
        </>
      )}
    </div>
  );
}
