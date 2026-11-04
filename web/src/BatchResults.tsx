import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { progressOutput } from './progress';

type BatchJob = { id: string; endpointId: string; kind: string; status: string; summary?: string; exitCode?: number | null };
type Chunk = { sequence: number; stream: string; text: string };
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const finished = (status: string) => ['succeeded', 'failed', 'interrupted', 'cancelled'].includes(status);
const TAIL_CHARS = 6000;

/**
 * Live results board for one command sent to many computers: one card per job with its
 * status and the most recent output. Full output stays available per job (nothing is
 * truncated on the server; the card only shows the latest text).
 */
export function BatchResults({ jobs, nameOf, request, onOpen }: {
  jobs: BatchJob[]; nameOf: (endpointId: string) => string; request: Request; onOpen: (job: BatchJob) => void;
}) {
  const [state, setState] = useState<Record<string, { job: BatchJob; tail: string; percent: number | null }>>(
    () => Object.fromEntries(jobs.map(job => [job.id, { job, tail: '', percent: null }])));
  const cursors = useRef<Record<string, number>>({});
  const recent = useRef<Record<string, Chunk[]>>({});
  const done = useRef<Set<string>>(new Set());
  useEffect(() => {
    let stopped = false, polling = false;
    const pollJob = async (id: string) => {
      const job = await request<BatchJob>(`/jobs/${id}`);
      let more = true;
      while (more && !stopped) {
        const page = await request<{ chunks: Chunk[]; nextCursor: number; hasMore: boolean }>(`/jobs/${id}/output?after=${cursors.current[id] ?? -1}&limit=200`);
        const kept = [...(recent.current[id] || []), ...page.chunks];
        // Keep only enough recent chunks for the card; the full output is one click away.
        let size = 0, start = kept.length;
        while (start > 0 && size < TAIL_CHARS * 2) size += kept[--start].text.length;
        recent.current[id] = kept.slice(start);
        if (page.chunks.length) cursors.current[id] = page.nextCursor;
        more = page.hasMore;
      }
      // Output is complete once the job finished and everything after that was read.
      if (finished(job.status)) done.current.add(id);
      const view = progressOutput(recent.current[id] || []);
      const text = view.display.map(chunk => chunk.text).join('');
      setState(previous => ({ ...previous, [id]: { job, tail: text.slice(-TAIL_CHARS), percent: view.percent } }));
    };
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        await Promise.all(jobs.filter(job => !done.current.has(job.id)).map(job => pollJob(job.id).catch(() => { /* retried next tick */ })));
      } finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => {
      if (jobs.every(job => done.current.has(job.id))) { window.clearInterval(timer); return; }
      void poll();
    }, 1200);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [jobs, request]);
  const entries = jobs.map(job => state[job.id]).filter(Boolean);
  const counts = entries.reduce<Record<string, number>>((all, entry) => ({ ...all, [entry.job.status]: (all[entry.job.status] || 0) + 1 }), {});
  return (
    <div className="batch-results">
      <div className="batch-summary">
        {Object.entries(counts).map(([status, count]) => <span key={status} className={`status status-${status}`}><span />{count} {status}</span>)}
      </div>
      <div className="batch-grid">
        {entries.map(({ job, tail, percent }) => (
          <section key={job.id} className="batch-card">
            <header>
              <strong>{nameOf(job.endpointId)}</strong>
              <span className={`status status-${job.status}`}><span />{job.status}{job.exitCode !== undefined && job.exitCode !== null && finished(job.status) ? ` · exit ${job.exitCode}` : ''}</span>
            </header>
            {percent !== null && !finished(job.status) && <progress max={100} value={percent} aria-label={`${nameOf(job.endpointId)} progress`} />}
            <BatchTail text={tail} />
            <footer>
              <small>{job.summary || (finished(job.status) ? '' : 'Waiting for output…')}</small>
              <button type="button" className="button small secondary" onClick={() => onOpen(job)}><ExternalLink size={13} /> Full output</button>
            </footer>
          </section>
        ))}
      </div>
    </div>
  );
}

function BatchTail({ text }: { text: string }) {
  const element = useRef<HTMLPreElement>(null);
  useEffect(() => { if (element.current) element.current.scrollTop = element.current.scrollHeight; }, [text]);
  return <pre ref={element} className="batch-output" tabIndex={0}>{text || ' '}</pre>;
}
