import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, CircleStop, Download, Loader2, Play, RefreshCw, ShieldCheck, Terminal, TriangleAlert, X } from 'lucide-react';
import { progressOutput } from './progress';
import './TerminalConsole.css';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type Endpoint = { id: string; hostname: string; displayName?: string; online?: boolean };
type Chunk = { sequence: number; stream: string; text: string };
type Job = { id: string; status: string; payload: { script?: string }; createdAt: string; exitCode?: number | null; summary?: string | null };
type Session = { id: string; status: 'open' | 'closed'; workingDirectory: string | null; expiresAt: string; createdAt: string; reason?: string | null; jobs?: Job[] };
type PendingCommand = { command: string; timeoutSeconds: number; idempotencyKey: string };
type Page = { chunks: Chunk[]; nextCursor: number; hasMore: boolean };
type Props = { endpoint: Endpoint; request: Request; onClose: () => void; onError: (error: unknown) => void };
const active = (status: string) => ['queued', 'dispatched', 'running'].includes(status);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const endingReason = (reason?: string | null) => ({
  session_expired: 'The two-hour terminal session ended.', server_restarted: 'The server restarted and ended this terminal.',
  server_shutdown: 'The server stopped and ended this terminal.', agent_restarted: 'The Windows agent restarted. Open a new terminal for a fresh process.',
  agent_closed: 'The PowerShell process ended. Open a new terminal for a fresh process.',
  operator_session_revoked: 'The original operator login is no longer valid.', endpoint_revoked: 'This endpoint was revoked.',
  operator_closed: 'This terminal was ended by its operator.'
}[reason || ''] || 'This terminal has ended. Its command output remains available below.');

/** One modal owns one Windows runspace. A new endpoint always gets a new lifecycle. */
export function TerminalConsole(props: Props) {
  return <EndpointTerminal key={props.endpoint.id} {...props} />;
}

function EndpointTerminal({ endpoint, request, onClose, onError }: Props) {
  const headingId = useId(), descriptionId = useId();
  const [session, setSession] = useState<Session | null>(null), [jobs, setJobs] = useState<Job[]>([]);
  const [output, setOutput] = useState<Record<string, Chunk[]>>({}), [more, setMore] = useState<Record<string, boolean>>({});
  const [creating, setCreating] = useState(true), [createError, setCreateError] = useState('');
  const [pollError, setPollError] = useState(''), [sendError, setSendError] = useState(''), [endError, setEndError] = useState('');
  const [command, setCommand] = useState(''), [timeoutSeconds, setTimeoutSeconds] = useState(900);
  const [submitting, setSubmitting] = useState(false), [uncertain, setUncertain] = useState<PendingCommand | null>(null), [ending, setEnding] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true), [expanded, setExpanded] = useState<Set<string>>(new Set()), [now, setNow] = useState(Date.now());
  const api = useRef(request), report = useRef(onError), leave = useRef(onClose);
  api.current = request; report.current = onError; leave.current = onClose;
  const mounted = useRef(false), sessionRef = useRef<Session | null>(null), jobsRef = useRef<Job[]>([]);
  const creation = useRef<Promise<Session> | null>(null), openKey = useRef(crypto.randomUUID());
  const pendingRequest = useRef<PendingCommand | null>(null);
  const polling = useRef(false), sending = useRef(false), endingRef = useRef(false), userEnded = useRef(false);
  const chunks = useRef<Record<string, Chunk[]>>({}), cursors = useRef<Record<string, number>>({});
  const remaining = useRef<Record<string, boolean>>({}), readAt = useRef<Record<string, number>>({}), readStatus = useRef<Record<string, string>>({});
  const closeSent = useRef(new Set<string>()), lastPollError = useRef('');
  const dialog = useRef<HTMLDivElement>(null), timeline = useRef<HTMLDivElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const history = useRef<string[]>([]), historyPosition = useRef<number | null>(null), historyDraft = useRef(''), knownCommands = useRef(new Set<string>());

  const acceptJobs = (values: Job[]) => {
    const merged = new Map(jobsRef.current.map(job => [job.id, job]));
    for (const job of values) merged.set(job.id, job);
    jobsRef.current = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (mounted.current) setJobs(jobsRef.current);
  };
  const closeBestEffort = (id: string) => {
    if (closeSent.current.has(id)) return;
    closeSent.current.add(id);
    void api.current(`/terminals/${id}/close`, 'POST', {}).catch(() => { /* Fixed server expiry remains authoritative if navigation interrupts this request. */ });
  };
  const poll = async () => {
    const current = sessionRef.current;
    if (!current || polling.current || !mounted.current) return;
    polling.current = true;
    try {
      const snapshot = await api.current<Session>(`/terminals/${current.id}`);
      if (!mounted.current) return;
      sessionRef.current = snapshot; setSession(snapshot); acceptJobs(snapshot.jobs || []); setNow(Date.now());
      // Every accepted chunk stays in memory. Each poll reads at most ten pages;
      // a large backlog resumes from its cursor next tick, never from a tail.
      // A job read while running is read again as soon as its status changes, so its final output
      // appears in the same poll that reports completion (never a false "No output").
      const queue = [...jobsRef.current].reverse().filter(job => active(job.status) || remaining.current[job.id] || readStatus.current[job.id] !== job.status || !readAt.current[job.id] || Date.now() - readAt.current[job.id] >= 10000);
      for (let pages = 0; queue.length && pages < 10 && mounted.current; pages++) {
        const job = queue.shift()!; const after = cursors.current[job.id] ?? -1;
        const page = await api.current<Page>(`/jobs/${job.id}/output?after=${after}&limit=200`);
        if (!mounted.current) return;
        const accepted = page.chunks.filter(chunk => chunk.sequence > after);
        if (accepted.length) {
          chunks.current[job.id] = [...(chunks.current[job.id] || []), ...accepted];
          cursors.current[job.id] = accepted.at(-1)!.sequence;
        }
        if (page.hasMore && (!accepted.length || page.nextCursor <= after)) throw new Error('The server returned an output page without advancing. Complete output remains available through Download.');
        remaining.current[job.id] = page.hasMore; readAt.current[job.id] = Date.now(); readStatus.current[job.id] = job.status;
        if (page.hasMore) queue.push(job);
      }
      setOutput({ ...chunks.current }); setMore({ ...remaining.current });
      setPollError(''); lastPollError.current = '';
    } catch (error) {
      if (mounted.current) {
        // Preserve earlier pages even when a later page fails. Read-only polling
        // may retry; command creation and execution never retry automatically.
        setOutput({ ...chunks.current }); setMore({ ...remaining.current });
        const text = message(error); setPollError(text);
        if (lastPollError.current !== text) { lastPollError.current = text; report.current(error); }
      }
    } finally { polling.current = false; }
  };
  const openSession = async () => {
    setCreating(true); setCreateError('');
    try {
      // React StrictMode may replay the effect. Sharing the first promise keeps
      // mount to one POST; an explicit retry retains this idempotency key.
      if (!creation.current) creation.current = api.current<Session>('/terminals', 'POST', { endpointId: endpoint.id, idempotencyKey: openKey.current });
      const opened = await creation.current;
      if (!mounted.current || userEnded.current) { closeBestEffort(opened.id); return; }
      sessionRef.current = opened; setSession(opened); void poll();
    } catch (error) {
      creation.current = null;
      if (mounted.current) { setCreateError(message(error)); report.current(error); }
    } finally { if (mounted.current) setCreating(false); }
  };
  const endSession = async () => {
    if (endingRef.current) return;
    const current = sessionRef.current;
    if (!current) {
      userEnded.current = true;
      if (creation.current) void creation.current.then(created => closeBestEffort(created.id)).catch(() => {});
      leave.current(); return;
    }
    if (current.status === 'closed') { userEnded.current = true; leave.current(); return; }
    endingRef.current = true; setEnding(true); setEndError('');
    try {
      const ended = await api.current<Session>(`/terminals/${current.id}/close`, 'POST', {});
      sessionRef.current = ended; userEnded.current = true; closeSent.current.add(current.id);
      if (mounted.current) { setSession(ended); leave.current(); }
    } catch (error) {
      if (mounted.current) { setEndError(`Could not confirm the terminal ended: ${message(error)}`); report.current(error); }
    } finally { endingRef.current = false; if (mounted.current) setEnding(false); }
  };

  useEffect(() => {
    mounted.current = true; const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus(); void openSession();
    const timer = window.setInterval(() => { setNow(Date.now()); void poll(); }, 1000);
    const pagehide = () => { if (sessionRef.current) closeBestEffort(sessionRef.current.id); };
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); void endSession(); return; }
      if (event.key !== 'Tab') return;
      const candidates = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),select:not(:disabled),input:not(:disabled),a[href],summary,[tabindex="0"]') || []).filter(element => element.getClientRects().length > 0);
      const first = candidates[0], last = candidates.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('pagehide', pagehide); document.addEventListener('keydown', keys);
    return () => {
      mounted.current = false; window.clearInterval(timer);
      window.removeEventListener('pagehide', pagehide); document.removeEventListener('keydown', keys); previous?.focus();
      // Defer so StrictMode's immediate effect replay does not end the session.
      queueMicrotask(() => {
        if (mounted.current || userEnded.current) return;
        if (sessionRef.current) closeBestEffort(sessionRef.current.id);
        else if (creation.current) void creation.current.then(created => closeBestEffort(created.id)).catch(() => {});
      });
    };
  }, []);
  useEffect(() => { if (autoFollow && timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight; }, [jobs, output, expanded, autoFollow]);
  useEffect(() => { if (session?.status === 'open' && !submitting && !uncertain) editor.current?.focus(); }, [session?.id, submitting, uncertain]);

  const send = async (retry?: PendingCommand) => {
    const current = sessionRef.current;
    if (!current || sending.current || endingRef.current) return;
    if (!retry && (pendingRequest.current || current.status !== 'open' || Date.parse(current.expiresAt) <= Date.now() || jobsRef.current.some(job => active(job.status)) || endpoint.online === false || !command.trim())) return;
    const pending = retry || { command, timeoutSeconds, idempotencyKey: crypto.randomUUID() };
    pendingRequest.current = pending;
    sending.current = true; setSubmitting(true); setSendError('');
    try {
      const job = await api.current<Job>(`/terminals/${current.id}/commands`, 'POST', pending);
      pendingRequest.current = null;
      acceptJobs([job]);
      if (!knownCommands.current.has(job.id)) { knownCommands.current.add(job.id); history.current.push(pending.command); }
      if (mounted.current) {
        setCommand(''); setUncertain(null); setExpanded(new Set([job.id])); historyPosition.current = null;
        void poll();
      }
    } catch (error) {
      // No status inference or automatic resubmission: only the user's explicit
      // retry sends this exact script/timeout/key again to the idempotent API.
      if (mounted.current) { setUncertain(pending); setSendError(message(error)); report.current(error); }
    } finally { sending.current = false; if (mounted.current) setSubmitting(false); }
  };
  const editorKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); return; }
    if (uncertain || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.currentTarget;
    if (target.selectionStart !== target.selectionEnd) return;
    const firstLine = !target.value.slice(0, target.selectionStart).includes('\n');
    const lastLine = !target.value.slice(target.selectionEnd).includes('\n');
    if (event.key === 'ArrowUp' && firstLine && history.current.length) {
      event.preventDefault();
      if (historyPosition.current === null) { historyDraft.current = command; historyPosition.current = history.current.length; }
      historyPosition.current = Math.max(0, historyPosition.current - 1); setCommand(history.current[historyPosition.current]);
    } else if (event.key === 'ArrowDown' && lastLine && historyPosition.current !== null) {
      event.preventDefault(); historyPosition.current++;
      if (historyPosition.current >= history.current.length) { historyPosition.current = null; setCommand(historyDraft.current); }
      else setCommand(history.current[historyPosition.current]);
    }
  };
  const inFlight = jobs.find(job => active(job.status));
  const expired = !!session && Date.parse(session.expiresAt) <= now;
  const ended = session?.status === 'closed' || expired;
  const disabled = !session || ended || submitting || !!uncertain || !!inFlight || ending || endpoint.online === false;
  const minutesLeft = session ? Math.max(0, Math.ceil((Date.parse(session.expiresAt) - now) / 60000)) : 0;
  const name = endpoint.displayName || endpoint.hostname;

  return <div className="terminal-backdrop">
    <div className="terminal-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} tabIndex={-1} ref={dialog}>
      <header className="terminal-heading">
        <div className="terminal-heading-icon"><Terminal size={22} /></div>
        <div className="terminal-title"><h2 id={headingId}>PowerShell <span>/ {name}</span></h2><p>{endpoint.hostname} <span>·</span> Windows endpoint <span>·</span> Agent service context</p></div>
        <button type="button" className="terminal-icon-button" aria-label={ended || !session ? 'Close terminal window' : 'End terminal session and close window'} title={ended || !session ? 'Close window' : 'End session and close'} disabled={ending} onClick={() => void endSession()}><X size={20} /></button>
      </header>
      <div className="terminal-toolbar">
        <span className={`terminal-state ${ended ? 'is-ended' : inFlight ? 'is-busy' : ''}`} role="status"><i />{creating ? 'Opening terminal' : ended ? 'Session ended' : endpoint.online === false ? 'Endpoint offline' : inFlight ? inFlight.status === 'running' ? 'Running command' : 'Waiting for endpoint' : session ? 'Ready' : 'Not connected'}</span>
        <span className="terminal-session-clock">{session && !ended ? `${minutesLeft} min remaining` : 'Persistent Windows PowerShell'}</span>
        <label className="terminal-follow"><input type="checkbox" checked={autoFollow} onChange={event => setAutoFollow(event.target.checked)} />Follow output</label>
        <button type="button" className="terminal-light-button" onClick={() => void poll()} disabled={!session || ending} title="Refresh command status and output"><RefreshCw size={13} />Refresh</button>
        <button type="button" className="terminal-end-button" onClick={() => void endSession()} disabled={ending}><CircleStop size={14} />{ending ? 'Ending…' : ended || !session ? 'Close window' : 'End session'}</button>
      </div>
      <div className="terminal-info" id={descriptionId}><ShieldCheck size={15} /><p>Variables, functions and the current folder stay in the same PowerShell process. Use commands that finish without prompts. Ending the session stops its process at the next agent check, within about 10 seconds.</p></div>
      {(createError || pollError || endError) && <div className="terminal-error" role="alert"><TriangleAlert size={16} /><div>{endError || createError || `Viewing is temporarily interrupted: ${pollError}`}<small>{createError ? 'Persistent terminals need agent 0.1.7 or later.' : 'Command execution is never retried automatically.'}</small></div>{createError && <button type="button" className="terminal-light-button" disabled={creating} onClick={() => void openSession()}>Retry opening</button>}</div>}
      {endpoint.online === false && !ended && <div className="terminal-notice">The endpoint is offline. Commands stay in the editor until you send them after it reconnects.</div>}
      {ended && <div className="terminal-notice">{expired && session?.status !== 'closed' ? 'The two-hour terminal session ended.' : endingReason(session?.reason)} A new terminal starts a fresh PowerShell process.</div>}
      <div className="terminal-timeline" ref={timeline} aria-label="PowerShell command history">
        {!jobs.length && <div className="terminal-empty"><Terminal size={32} /><h3>{creating ? 'Opening PowerShell' : session ? 'Your endpoint terminal is ready' : 'Endpoint PowerShell'}</h3><p>{creating ? 'Preparing a session for this Windows endpoint…' : 'Run a command below. Its full response and exit status will appear here.'}</p><code>PS {session?.workingDirectory || '…'}&gt;</code></div>}
        {jobs.map((job, index) => <CommandResult key={job.id} job={job} index={index + 1} chunks={output[job.id] || []} hasMore={!!more[job.id]} expanded={expanded.has(job.id)} onToggle={() => setExpanded(previous => { const next = new Set(previous); if (next.has(job.id)) next.delete(job.id); else next.add(job.id); return next; })} />)}
      </div>
      <div className="terminal-composer">
        {uncertain && <div className="terminal-uncertain" role="alert"><TriangleAlert size={16} /><div><strong>Command delivery needs checking</strong><p>{sendError} The request may already be queued or running. An explicit retry uses the same request ID; if it never reached the server, it queues this command once.</p></div><button type="button" className="terminal-light-button" disabled={submitting || ending} onClick={() => void send(uncertain)}>{submitting ? <Loader2 size={14} className="terminal-spin" /> : <RefreshCw size={14} />}Retry same request</button></div>}
        <label htmlFor={`${headingId}-command`} className="terminal-prompt"><span>PS</span><code>{session?.workingDirectory || endpoint.hostname}&gt;</code></label>
        <div className="terminal-input-row"><textarea id={`${headingId}-command`} ref={editor} rows={3} maxLength={262144} value={command} onChange={event => { setCommand(event.target.value); historyPosition.current = null; }} onKeyDown={editorKeys} readOnly={!!uncertain} disabled={!session || ended || submitting || ending} placeholder={inFlight ? 'Waiting for the current command to finish…' : 'Get-Location'} aria-label="PowerShell command" spellCheck={false} autoCapitalize="off" autoCorrect="off" /><button type="button" className="terminal-run-button" disabled={disabled || !command.trim()} onClick={() => void send()}>{submitting ? <Loader2 size={16} className="terminal-spin" /> : <Play size={15} />}{submitting ? 'Sending' : 'Run command'}</button></div>
        <div className="terminal-composer-footer"><span><kbd>Enter</kbd> run <span>·</span> <kbd>Shift Enter</kbd> new line <span>·</span> <kbd>↑ ↓</kbd> history</span><label>Command timeout<select value={timeoutSeconds} onChange={event => setTimeoutSeconds(Number(event.target.value))} disabled={submitting || !!uncertain || ending}><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes</option><option value={3600}>60 minutes</option></select></label></div>
      </div>
    </div>
  </div>;
}

function CommandResult({ job, index, chunks, hasMore, expanded, onToggle }: { job: Job; index: number; chunks: Chunk[]; hasMore: boolean; expanded: boolean; onToggle: () => void }) {
  const progress = useMemo(() => progressOutput(chunks), [chunks]);
  const outputId = useId();
  return <section className={`terminal-command terminal-command-${job.status}`}>
    <header className="terminal-command-heading"><button type="button" onClick={onToggle} aria-expanded={expanded} aria-controls={outputId} className="terminal-command-toggle">{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<span className="terminal-command-number">{String(index).padStart(2, '0')}</span><code>{job.payload?.script || 'PowerShell command'}</code></button><span className={`terminal-job-status status-${job.status}`}>{active(job.status) && <Loader2 size={11} className="terminal-spin" />}{job.status}{job.exitCode !== null && job.exitCode !== undefined ? ` · exit ${job.exitCode}` : ''}</span><a className="terminal-download" href={`/api/jobs/${encodeURIComponent(job.id)}/download`} title="Download every accepted output chunk" aria-label={`Download full output for command ${index}`}><Download size={13} /><span>Full output</span></a></header>
    {expanded && <div id={outputId} className="terminal-command-body">
      {progress.percent !== null && active(job.status) && <div className="terminal-command-progress"><progress max={100} value={progress.percent} aria-label={`Command ${index} progress`} /><span>{progress.percent}%</span></div>}
      <pre className="terminal-output" tabIndex={0} aria-label={`Command ${index} complete output`}>{progress.display.length ? progress.display.map(chunk => <span className={`terminal-stream-${chunk.stream}`} key={chunk.sequence}>{chunk.text}</span>) : <span className="terminal-output-placeholder">{active(job.status) ? job.status === 'queued' ? 'Waiting for this endpoint to accept the command…' : 'Waiting for command output…' : 'No output was emitted.'}</span>}</pre>
      {(job.summary || hasMore) && <footer className="terminal-command-footer"><span>{job.summary || `${chunks.length.toLocaleString()} output chunks received`}</span>{hasMore && <span><Loader2 size={12} className="terminal-spin" />Loading more output…</span>}</footer>}
    </div>}
  </section>;
}
