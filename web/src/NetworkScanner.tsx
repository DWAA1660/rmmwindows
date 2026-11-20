import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, BookmarkPlus, Cctv, ChevronDown, ChevronRight, CircleCheckBig, CircleDashed, CircleHelp, CircleX, Clock3, Cpu, Database,
  Download, EthernetPort, HardDrive, GitCompareArrows, Globe, Info, ListChecks, Loader2, Map as MapIcon, Monitor, Network, Pencil, Play, Plus, Printer,
  Radar, RotateCcw, Router, Search, Server, ShieldAlert, ShieldCheck, ShieldX, Table2, Target as TargetIcon, Trash2, X,
} from 'lucide-react';
import { EndpointPicker } from './EndpointPicker';
import {
  PORT_CATALOG, PORT_PROFILES, SPEEDS, DEVICE_LABELS, LIMITS, RISK_ORDER, addressCount, compareSources, describeTarget, deviceGuess, duration,
  estimateSeconds, findings, fleetSubnets, hostRisk, ipNumber, osGuess, parsePortsText, parseTarget, portInfo, portsText, scanCsv, splitTargets,
  subnetGrids, type DeviceKind, type Expectation, type Preset, type Risk, type Scan, type ScanHost, type ScanSource, type Speed, type Target,
} from './netscanModel';
import './NetworkScanner.css';
import type { ConfirmDialogState } from './components/ConfirmDialog';

type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
type ScanEndpoint = { id: string; hostname: string; displayName?: string; online: boolean; revoked?: boolean; tags?: string[]; groupId?: string; groupName?: string;
  inventory?: { ipv4?: string[]; networkAdapters?: { ipv4?: string[]; gateways?: string[] }[] } };
type Builder = { sources: string[]; targets: string[]; ports: number[]; expect: Expectation; speed: Speed; ping: boolean; resolveNames: boolean; onlyResponsive: boolean; name: string; testId: string | null };
const blankBuilder = (): Builder => ({ sources: [], targets: [], ports: PORT_PROFILES[0].ports, expect: 'discover', speed: 'normal', ping: true, resolveNames: true, onlyResponsive: false, name: '', testId: null });
const EXPECT_COPY: Record<Expectation, { label: string; short: string; hint: string; icon: typeof Radar }> = {
  discover: { label: 'Discover', short: 'Discover', hint: 'Find every device and open port the computer can reach.', icon: Radar },
  reachable: { label: 'Must be reachable', short: 'Must reach', hint: 'Pass only if every target answers on every port, e.g. everyone can print to 10.0.0.40:9100.', icon: ShieldCheck },
  blocked: { label: 'Must be blocked', short: 'Must block', hint: 'Pass only if no target answers on any port, e.g. patron PCs cannot reach staff file shares.', icon: ShieldX },
};
const DEVICE_ICONS: Record<DeviceKind, typeof Monitor> = { dc: Server, nas: HardDrive, printer: Printer, camera: Cctv, iot: Cpu, 'windows-server': Server, windows: Monitor, linux: Server, network: Router, web: Globe, database: Database, unknown: CircleHelp };
const RISK_LABEL: Record<Risk, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const PHASE_LABEL: Record<string, string> = { ping: 'Pinging', tcp: 'Probing ports', names: 'Looking up names' };
const ago = (value: string) => { const s = Math.max(0, (Date.now() - Date.parse(value)) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : new Date(value).toLocaleDateString(); };
const key = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

function Dialog({ title, subtitle, onClose, wide, children }: { title: string; subtitle?: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    (box.current?.querySelector<HTMLElement>('input:not([type=checkbox]),textarea') ?? box.current?.querySelector<HTMLElement>('.modal-footer .button.primary, button'))?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''} ns-dialog`} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={20} /></button></div>
        {children}
      </div>
    </div>
  );
}

function RiskBadge({ risk }: { risk: Risk }) { return <span className={`ns-risk ns-risk-${risk}`}>{RISK_LABEL[risk]}</span>; }
function PortChip({ port, onRemove, compact }: { port: number; onRemove?: () => void; compact?: boolean }) {
  const info = portInfo(port);
  return (
    <span className={`ns-port ns-port-${info.risk}`} title={`${port} · ${info.service} — ${info.note}`}>
      <strong>{port}</strong>{!compact && <span>{info.service}</span>}
      {onRemove && <button type="button" aria-label={`Remove port ${port}`} onClick={onRemove}><X size={11} /></button>}
    </span>
  );
}
function Verdict({ verdict, expect }: { verdict: Scan['verdict'] | 'pending' | null; expect: Expectation }) {
  if (expect === 'discover' || !verdict) return null;
  if (verdict === 'pass') return <span className="ns-verdict pass"><CircleCheckBig size={13} /> Passed</span>;
  if (verdict === 'fail') return <span className="ns-verdict fail"><CircleX size={13} /> Failed</span>;
  return <span className="ns-verdict pending"><CircleDashed size={13} /> Waiting</span>;
}

/** Network reachability scanner: what can each computer reach, on which ports, and does that match policy. */
export function NetworkScanner({ endpoints, canRun, request, notify, onConfirm }: { endpoints: ScanEndpoint[]; canRun: boolean; request: Request; notify: (message: string) => void; onConfirm?: (dialog: ConfirmDialogState) => void }) {
  const [builder, setBuilder] = useState<Builder>(blankBuilder);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [scans, setScans] = useState<Scan[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: 'sources' } | { kind: 'catalog' } | { kind: 'save'; what: 'targets' | 'ports' | 'test' } | { kind: 'run'; test: Preset }>(null);
  const active = useMemo(() => endpoints.filter(ep => !ep.revoked), [endpoints]);
  const byId = useMemo(() => new Map(endpoints.map(ep => [ep.id, ep])), [endpoints]);
  const name = (id: string) => { const ep = byId.get(id); return ep ? ep.displayName || ep.hostname : 'Removed computer'; };
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const loadPresets = () => request<Preset[]>('/netscan/presets').then(setPresets).catch(fail);
  const loadScans = () => request<Scan[]>('/netscans').then(setScans).catch(fail);
  useEffect(() => { void loadPresets(); void loadScans(); }, []);
  useEffect(() => {
    const running = scans.some(scan => scan.status !== 'finished');
    const timer = window.setInterval(() => void loadScans(), running ? 4000 : 15000);
    return () => window.clearInterval(timer);
  }, [scans]);

  const parsed = builder.targets.map(parseTarget);
  const validTargets = parsed.filter((t): t is Target => typeof t !== 'string');
  const addresses = addressCount(validTargets);
  const probes = addresses * builder.ports.length;
  const problems = [
    !builder.sources.length && 'Choose at least one computer to scan from.',
    !builder.targets.length && 'Add at least one target.',
    ...parsed.filter((t): t is string => typeof t === 'string'),
    addresses > LIMITS.addresses && `${addresses.toLocaleString()} addresses is over the ${LIMITS.addresses.toLocaleString()} limit.`,
    !builder.ports.length && !builder.ping && 'Choose ports or turn on ping.',
    !builder.ports.length && builder.expect !== 'discover' && 'A reachable/blocked test needs at least one port.',
    probes > LIMITS.probes && `${probes.toLocaleString()} probes is over the ${LIMITS.probes.toLocaleString()} limit. Narrow targets or ports.`,
  ].filter(Boolean) as string[];
  const estimate = estimateSeconds(addresses, builder.ports.length, builder.speed, builder.ping, builder.resolveNames);
  const update = (patch: Partial<Builder>) => setBuilder(current => ({ ...current, ...patch }));

  const scanBody = (b: Builder, sources = b.sources) => ({ endpointIds: sources, targets: b.targets, ports: b.ports, expect: b.expect, speed: b.speed, ping: b.ping,
    resolveNames: b.resolveNames, onlyResponsive: b.onlyResponsive, name: b.name.trim() || undefined, testId: b.testId ?? undefined, idempotencyKey: key() });
  const start = async (body: ReturnType<typeof scanBody>) => {
    setBusy(true); setError('');
    try {
      const scan = await request<Scan>('/netscans', 'POST', body);
      notify(`Scan queued on ${scan.sources.length} computer${scan.sources.length === 1 ? '' : 's'}. Each job runs once.`);
      setDialog(null); setOpenId(scan.id); void loadScans();
    } catch (err) { fail(err); } finally { setBusy(false); }
  };
  const loadTest = (test: Preset) => {
    setBuilder({ sources: (test.endpointIds ?? []).filter(id => byId.has(id)), targets: test.targets ?? [], ports: test.ports ?? [], expect: test.expect ?? 'discover',
      speed: test.speed ?? 'normal', ping: test.ping ?? true, resolveNames: test.resolveNames ?? true, onlyResponsive: test.onlyResponsive ?? false, name: test.name, testId: test.id });
    setOpenId(null); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const rerun = (scan: Scan) => {
    setBuilder({ sources: scan.sources.map(s => s.endpointId).filter(id => byId.has(id)), targets: scan.targets.map(t => t.input), ports: scan.ports, expect: scan.expect,
      speed: scan.speed, ping: scan.ping, resolveNames: scan.resolveNames, onlyResponsive: scan.onlyResponsive, name: scan.name, testId: scan.testId });
    setOpenId(null); window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const doRemovePreset = async (preset: Preset) => {
    try { await request(`/netscan/presets/${preset.id}`, 'DELETE'); notify(`Deleted “${preset.name}”.`); if (builder.testId === preset.id) update({ testId: null }); void loadPresets(); } catch (err) { fail(err); }
  };
  const removePreset = (preset: Preset) => {
    if (onConfirm) {
      onConfirm({
        title: `Delete “${preset.name}”?`,
        description: 'Past scan results using this saved preset or test will be kept.',
        confirmLabel: 'Delete preset',
        tone: 'danger',
        onConfirm: () => doRemovePreset(preset),
      });
      return;
    }
    void doRemovePreset(preset);
  };

  if (openId) return <ScanResults id={openId} request={request} endpoints={endpoints} canRun={canRun} onBack={() => { setOpenId(null); void loadScans(); }} onRerun={rerun} />;

  const tests = presets.filter(p => p.kind === 'test');
  const lastRun = (test: Preset) => scans.find(scan => scan.testId === test.id);
  return (
    <div className="ns-page">
      {error && <div className="error-banner" role="alert"><CircleX size={18} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
      <div className="ns-layout">
        {canRun ? (
          <section className="panel ns-builder" aria-label="Build a scan">
            <header className="ns-builder-head">
              <span className="ns-builder-icon"><Radar size={20} /></span>
              <div><h2>{builder.testId ? `Editing “${builder.name}”` : 'New scan'}</h2><p>See what a computer can reach, or prove a firewall rule works.</p></div>
              {(builder.testId || builder.targets.length > 0) && <button type="button" className="text-button" onClick={() => setBuilder(blankBuilder())}>Clear</button>}
            </header>

            <Step n={1} title="Scan from" hint="Each computer runs the scan itself, so results show what it can reach.">
              <div className="ns-sources">
                {builder.sources.map(id => (
                  <span key={id} className="ns-source-chip"><span className={`status-dot ${byId.get(id)?.online ? 'green' : 'gray'}`} />{name(id)}
                    <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => update({ sources: builder.sources.filter(s => s !== id) })}><X size={12} /></button></span>
                ))}
                <button type="button" className="ns-add" onClick={() => setDialog({ kind: 'sources' })}><Plus size={14} />{builder.sources.length ? 'Change computers' : 'Choose computers'}</button>
              </div>
            </Step>

            <Step n={2} title="Targets" hint="Whole subnet (10.0.0.0/24), range (10.0.0.10-50) or single IP. Paste several at once.">
              <TargetInput targets={builder.targets} onChange={targets => update({ targets })} />
              <TargetSuggestions presets={presets.filter(p => p.kind === 'targets')} endpoints={active} sources={builder.sources}
                onAdd={items => update({ targets: [...new Set([...builder.targets, ...items])] })} onSave={() => setDialog({ kind: 'save', what: 'targets' })}
                canSave={builder.targets.length > 0 && parsed.every(t => typeof t !== 'string')} onDelete={removePreset} />
            </Step>

            <Step n={3} title="Ports" hint={`${builder.ports.length} selected. Pick a profile, browse common ports, or type your own.`}>
              <PortPicker ports={builder.ports} onChange={ports => update({ ports })} presets={presets.filter(p => p.kind === 'ports')}
                onBrowse={() => setDialog({ kind: 'catalog' })} onSave={() => setDialog({ kind: 'save', what: 'ports' })} onDelete={removePreset} />
            </Step>

            <Step n={4} title="What should happen?" hint={EXPECT_COPY[builder.expect].hint}>
              <div className="ns-segmented ns-expect" role="radiogroup" aria-label="Test type">
                {(Object.keys(EXPECT_COPY) as Expectation[]).map(value => { const Icon = EXPECT_COPY[value].icon; return (
                  <button key={value} type="button" role="radio" aria-checked={builder.expect === value} className={builder.expect === value ? `active ${value}` : ''} onClick={() => update({ expect: value })}><Icon size={15} />{EXPECT_COPY[value].label}</button>
                ); })}
              </div>
              <details className="ns-options">
                <summary>Scan options · {SPEEDS[builder.speed].label}{builder.ping ? ', ping' : ''}{builder.resolveNames ? ', names' : ''}{builder.onlyResponsive ? ', responsive hosts only' : ''}</summary>
                <div className="ns-segmented" role="radiogroup" aria-label="Speed">
                  {(Object.keys(SPEEDS) as Speed[]).map(value => <button key={value} type="button" role="radio" aria-checked={builder.speed === value} className={builder.speed === value ? 'active' : ''} onClick={() => update({ speed: value })} title={SPEEDS[value].hint}><strong>{SPEEDS[value].label}</strong><small>{SPEEDS[value].hint}</small></button>)}
                </div>
                <label className="ns-toggle"><input type="checkbox" checked={builder.ping} onChange={e => update({ ping: e.target.checked, onlyResponsive: e.target.checked && builder.onlyResponsive })} /><span><strong>Ping each address</strong><small>Finds devices that answer ping and records response time and TTL.</small></span></label>
                <label className="ns-toggle"><input type="checkbox" checked={builder.onlyResponsive} disabled={!builder.ping} onChange={e => update({ onlyResponsive: e.target.checked })} /><span><strong>Only probe ports on hosts that answer</strong><small>Much faster on sparse subnets, but misses hosts whose firewall drops ping.</small></span></label>
                <label className="ns-toggle"><input type="checkbox" checked={builder.resolveNames} onChange={e => update({ resolveNames: e.target.checked })} /><span><strong>Look up names</strong><small>Reverse DNS for every device found.</small></span></label>
                <label className="ns-name">Scan name (optional)<input value={builder.name} maxLength={150} placeholder="e.g. Branch printer check" onChange={e => update({ name: e.target.value })} /></label>
              </details>
            </Step>

            <footer className="ns-run">
              <div className="ns-estimate">
                <span><strong>{addresses.toLocaleString()}</strong> address{addresses === 1 ? '' : 'es'}</span>
                <span><strong>{builder.ports.length}</strong> port{builder.ports.length === 1 ? '' : 's'}</span>
                <span><strong>{probes.toLocaleString()}</strong> probes</span>
                <span><Clock3 size={12} /> up to {duration(estimate)}</span>
              </div>
              {problems.length > 0 && builder.targets.length + builder.sources.length > 0 && <p className="ns-problem"><Info size={13} />{problems[0]}</p>}
              <div className="ns-run-actions">
                <button type="button" className="button secondary" disabled={!builder.targets.length || parsed.some(t => typeof t === 'string') || (!builder.ports.length && builder.expect !== 'discover')} onClick={() => setDialog({ kind: 'save', what: 'test' })}><BookmarkPlus size={15} />{builder.testId ? 'Update saved test' : 'Save as test'}</button>
                <button type="button" className="button primary" disabled={busy || problems.length > 0} onClick={() => start(scanBody(builder))}>{busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />}Run on {builder.sources.length || '…'} computer{builder.sources.length === 1 ? '' : 's'}</button>
              </div>
            </footer>
          </section>
        ) : (
          <section className="panel ns-readonly"><ShieldCheck size={20} /><p>Your account can view scan results. An operator or administrator can run new scans and save tests.</p></section>
        )}

        <div className="ns-side">
          <section className="panel ns-tests">
            <div className="panel-heading"><div><h2>Saved tests</h2><p>Re-run firewall and reachability checks on any computer in one click.</p></div><ListChecks size={18} /></div>
            {!tests.length ? (
              <div className="ns-empty"><TargetIcon size={20} /><p>Build a scan, choose <strong>Must be reachable</strong> or <strong>Must be blocked</strong>, then <strong>Save as test</strong>. For example: every computer can print to <code>10.0.0.40</code> on <code>9100</code>.</p></div>
            ) : (
              <ul className="ns-test-list">
                {tests.map(test => { const last = lastRun(test); const Icon = EXPECT_COPY[test.expect ?? 'discover'].icon; return (
                  <li key={test.id} className={`ns-test ns-test-${test.expect}`}>
                    <span className="ns-test-icon"><Icon size={16} /></span>
                    <div className="ns-test-body">
                      <strong>{test.name}</strong>
                      <span className="ns-test-meta">{EXPECT_COPY[test.expect ?? 'discover'].short} · {(test.targets ?? []).join(', ')} · {portsText(test.ports ?? []) || 'ping only'}</span>
                      <span className="ns-test-last">{last ? <><Verdict verdict={last.verdict} expect={last.expect} /><button type="button" className="text-button" onClick={() => setOpenId(last.id)}>Last run {ago(last.createdAt)}</button></> : 'Never run'}{(test.endpointIds?.length ?? 0) > 0 && <> · {test.endpointIds!.length} saved computer{test.endpointIds!.length === 1 ? '' : 's'}</>}</span>
                    </div>
                    {canRun && <div className="ns-test-actions">
                      <button type="button" className="button primary small" onClick={() => setDialog({ kind: 'run', test })}><Play size={13} />Run</button>
                      <button type="button" className="icon-button" title="Edit" aria-label={`Edit ${test.name}`} onClick={() => loadTest(test)}><Pencil size={14} /></button>
                      <button type="button" className="icon-button" title="Delete" aria-label={`Delete ${test.name}`} onClick={() => removePreset(test)}><Trash2 size={14} /></button>
                    </div>}
                  </li>
                ); })}
              </ul>
            )}
          </section>

          <section className="panel ns-history">
            <div className="panel-heading"><div><h2>Recent scans</h2><p>Results stay available; open one to see hosts, map and exposures.</p></div><Clock3 size={18} /></div>
            {!scans.length ? <div className="ns-empty"><Radar size={20} /><p>No scans yet.</p></div> : (
              <ul className="ns-history-list">
                {scans.map(scan => {
                  const done = scan.sources.filter(s => s.finished).length;
                  const pct = scan.sources.length ? Math.round(scan.sources.reduce((sum, s) => sum + (s.finished ? 1 : s.progress && s.progress.total ? Math.min(0.99, s.progress.done / s.progress.total) : 0), 0) / scan.sources.length * 100) : 0;
                  const up = Math.max(0, ...scan.sources.map(s => s.hostsUp));
                  return (
                    <li key={scan.id}><button type="button" onClick={() => setOpenId(scan.id)}>
                      <span className={`ns-history-state ${scan.status}`}>{scan.status === 'finished' ? <CircleCheckBig size={15} /> : <Loader2 size={15} className={scan.status === 'running' ? 'spin' : ''} />}</span>
                      <span className="ns-history-body">
                        <strong>{scan.name}</strong>
                        <small>{scan.sources.length === 1 ? scan.sources[0].endpointName : `${scan.sources.length} computers`} · {scan.ports.length} ports · {scan.createdBy} · {ago(scan.createdAt)}</small>
                        {scan.status !== 'finished' && <span className="ns-mini-progress"><span style={{ width: `${pct}%` }} /></span>}
                      </span>
                      <span className="ns-history-result">{scan.expect !== 'discover' ? <Verdict verdict={scan.verdict} expect={scan.expect} /> : scan.status === 'finished' || up ? <span className="ns-found">{up} host{up === 1 ? '' : 's'}</span> : <span className="ns-found muted">{done}/{scan.sources.length}</span>}</span>
                      <ChevronRight size={15} />
                    </button></li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>

      {dialog?.kind === 'sources' && (
        <Dialog title="Scan from which computers?" subtitle="Results show what each chosen computer can reach from where it sits on the network." onClose={() => setDialog(null)} wide>
          <EndpointPicker endpoints={active} value={builder.sources} onChange={sources => update({ sources })} />
          <div className="modal-footer"><span>Offline computers run the scan when they reconnect.</span><div><button className="button primary" onClick={() => setDialog(null)}>Done</button></div></div>
        </Dialog>
      )}
      {dialog?.kind === 'catalog' && <PortCatalog ports={builder.ports} onChange={ports => update({ ports })} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'save' && <SaveDialog what={dialog.what} builder={builder} existing={dialog.what === 'test' && builder.testId ? presets.find(p => p.id === builder.testId) ?? null : null}
        request={request} onClose={() => setDialog(null)} onSaved={(preset, message) => { notify(message); setDialog(null); void loadPresets(); if (preset.kind === 'test') update({ testId: preset.id, name: preset.name }); }} />}
      {dialog?.kind === 'run' && <RunTestDialog test={dialog.test} endpoints={active} busy={busy} onClose={() => setDialog(null)}
        onRun={sources => start({ endpointIds: sources, targets: dialog.test.targets ?? [], ports: dialog.test.ports ?? [], expect: dialog.test.expect ?? 'discover', speed: dialog.test.speed ?? 'normal',
          ping: dialog.test.ping ?? true, resolveNames: dialog.test.resolveNames ?? true, onlyResponsive: dialog.test.onlyResponsive ?? false, name: dialog.test.name, testId: dialog.test.id, idempotencyKey: key() })} />}
    </div>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint: string; children: ReactNode }) {
  return <div className="ns-step"><div className="ns-step-label"><span className="ns-step-n">{n}</span><div><h3>{title}</h3><p>{hint}</p></div></div><div className="ns-step-body">{children}</div></div>;
}

function TargetInput({ targets, onChange }: { targets: string[]; onChange: (targets: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const commit = (text = draft) => { const items = splitTargets(text); if (items.length) onChange([...new Set([...targets, ...items])]); setDraft(''); };
  const preview = draft.trim() ? parseTarget(draft) : null;
  return (
    <div className="ns-target-box">
      <div className="ns-target-chips">
        {targets.map(item => { const t = parseTarget(item); const invalid = typeof t === 'string'; return (
          <span key={item} className={`ns-target-chip ${invalid ? 'invalid' : (t as Target).kind}`} title={invalid ? t : describeTarget(t as Target)}>
            {invalid ? <CircleX size={12} /> : (t as Target).kind === 'subnet' ? <Network size={12} /> : (t as Target).kind === 'range' ? <EthernetPort size={12} /> : <TargetIcon size={12} />}
            <strong>{item}</strong><small>{invalid ? 'invalid' : (t as Target).kind === 'ip' ? 'IP' : `${(t as Target).count} IPs`}</small>
            <button type="button" aria-label={`Remove ${item}`} onClick={() => onChange(targets.filter(x => x !== item))}><X size={11} /></button>
          </span>
        ); })}
        <input aria-label="Add a target" value={draft} placeholder={targets.length ? 'Add another…' : '10.0.0.0/24, 10.0.0.10-50, 10.0.0.40'}
          onChange={e => { const v = e.target.value; if (/[,;\n]/.test(v)) commit(v); else setDraft(v); }}
          onPaste={e => { const text = e.clipboardData.getData('text'); if (/[\s,;]/.test(text.trim())) { e.preventDefault(); commit(draft + text); } }}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Tab' && draft.trim()) { e.preventDefault(); commit(); } else if (e.key === 'Backspace' && !draft && targets.length) onChange(targets.slice(0, -1)); }}
          onBlur={() => draft.trim() && commit()} />
      </div>
      {preview && <p className={`ns-target-preview ${typeof preview === 'string' ? 'bad' : ''}`}>{typeof preview === 'string' ? preview : `${describeTarget(preview)} — press Enter to add`}</p>}
    </div>
  );
}

function TargetSuggestions({ presets, endpoints, sources, onAdd, onSave, canSave, onDelete }: { presets: Preset[]; endpoints: ScanEndpoint[]; sources: string[]; onAdd: (items: string[]) => void; onSave: () => void; canSave: boolean; onDelete: (preset: Preset) => void }) {
  const subnets = useMemo(() => fleetSubnets(endpoints), [endpoints]);
  const sourceSet = new Set(sources);
  const ordered = [...subnets].sort((a, b) => Number(b.endpointIds.some(id => sourceSet.has(id))) - Number(a.endpointIds.some(id => sourceSet.has(id))));
  return (
    <div className="ns-suggest">
      {presets.length > 0 && <div className="ns-suggest-row"><span className="ns-suggest-label">Saved lists</span>
        {presets.map(p => <span key={p.id} className="ns-saved"><button type="button" className="ns-pill saved" title={(p.targets ?? []).join(', ')} onClick={() => onAdd(p.targets ?? [])}><Plus size={12} />{p.name}<small>{(p.targets ?? []).length}</small></button><button type="button" className="ns-saved-x" aria-label={`Delete ${p.name}`} onClick={() => onDelete(p)}><X size={11} /></button></span>)}
      </div>}
      {ordered.length > 0 && <div className="ns-suggest-row"><span className="ns-suggest-label">Fleet subnets</span>
        {ordered.slice(0, 10).map(s => <button key={s.cidr} type="button" className={`ns-pill ${s.endpointIds.some(id => sourceSet.has(id)) ? 'local' : ''}`} onClick={() => onAdd([s.cidr])}
          title={`${s.endpointIds.length} managed computer${s.endpointIds.length === 1 ? '' : 's'} on this /24${s.endpointIds.some(id => sourceSet.has(id)) ? ' — includes a chosen computer' : ''}`}><Plus size={12} />{s.cidr}<small>{s.endpointIds.length} PCs</small></button>)}
      </div>}
      <button type="button" className="text-button ns-save-link" disabled={!canSave} onClick={onSave}><BookmarkPlus size={13} />Save these targets as a list</button>
    </div>
  );
}

function PortPicker({ ports, onChange, presets, onBrowse, onSave, onDelete }: { ports: number[]; onChange: (ports: number[]) => void; presets: Preset[]; onBrowse: () => void; onSave: () => void; onDelete: (preset: Preset) => void }) {
  const [draft, setDraft] = useState(''); const [problem, setProblem] = useState('');
  const same = (list: number[]) => list.length === ports.length && list.every(port => ports.includes(port));
  const add = () => { const parsed = parsePortsText(draft); if (typeof parsed === 'string') { setProblem(parsed); return; } onChange([...new Set([...ports, ...parsed])].sort((a, b) => a - b)); setDraft(''); setProblem(''); };
  const sorted = [...ports].sort((a, b) => a - b);
  return (
    <div className="ns-ports">
      <div className="ns-profiles">
        {PORT_PROFILES.map(profile => <button key={profile.id} type="button" className={`ns-pill ${same(profile.ports) ? 'active' : ''}`} title={profile.description} onClick={() => onChange(profile.ports)}>{profile.label}</button>)}
        {presets.map(p => <span key={p.id} className="ns-saved"><button type="button" className={`ns-pill saved ${same(p.ports ?? []) ? 'active' : ''}`} title={portsText(p.ports ?? [])} onClick={() => onChange(p.ports ?? [])}>{p.name}<small>{(p.ports ?? []).length}</small></button><button type="button" className="ns-saved-x" aria-label={`Delete ${p.name}`} onClick={() => onDelete(p)}><X size={11} /></button></span>)}
      </div>
      <div className="ns-port-chips">
        {sorted.slice(0, 60).map(port => <PortChip key={port} port={port} onRemove={() => onChange(ports.filter(p => p !== port))} />)}
        {sorted.length > 60 && <span className="ns-more">+{sorted.length - 60} more ({portsText(sorted.slice(60)).slice(0, 60)}{portsText(sorted.slice(60)).length > 60 ? '…' : ''})</span>}
        {!sorted.length && <span className="muted ns-more">No ports — ping only.</span>}
      </div>
      <div className="ns-port-add">
        <input aria-label="Add ports" value={draft} placeholder="Add ports: 9100, 8000-8010" onChange={e => { setDraft(e.target.value); setProblem(''); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="button secondary small" disabled={!draft.trim()} onClick={add}><Plus size={13} />Add</button>
        <button type="button" className="button secondary small" onClick={onBrowse}><Table2 size={13} />Common ports</button>
        <button type="button" className="icon-button" title="Save this port list" aria-label="Save this port list" disabled={!ports.length} onClick={onSave}><BookmarkPlus size={15} /></button>
        {ports.length > 0 && <button type="button" className="icon-button" title="Clear ports" aria-label="Clear ports" onClick={() => onChange([])}><Trash2 size={14} /></button>}
      </div>
      {problem && <p className="ns-target-preview bad">{problem}</p>}
    </div>
  );
}

function PortCatalog({ ports, onChange, onClose }: { ports: number[]; onChange: (ports: number[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState(''); const [category, setCategory] = useState('All');
  const chosen = new Set(ports);
  const categories = ['All', ...new Set(PORT_CATALOG.map(item => item.category))];
  const needle = query.trim().toLowerCase();
  const visible = PORT_CATALOG.filter(item => (category === 'All' || item.category === category) && (!needle || String(item.port).startsWith(needle) || item.service.toLowerCase().includes(needle) || item.note.toLowerCase().includes(needle)));
  const toggle = (port: number) => onChange(chosen.has(port) ? ports.filter(p => p !== port) : [...ports, port].sort((a, b) => a - b));
  const allShown = visible.length > 0 && visible.every(item => chosen.has(item.port));
  return (
    <Dialog title="Common ports" subtitle={`${ports.length} selected. Risk shows how worrying it is when the port is reachable from a computer that should not need it.`} onClose={onClose} wide>
      <div className="ns-catalog-tools">
        <label className="ns-search"><Search size={14} /><input aria-label="Search ports" placeholder="Search port, service or advice (smb, 3389, camera…)" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <button type="button" className="button secondary small" disabled={!visible.length} onClick={() => onChange(allShown ? ports.filter(p => !visible.some(v => v.port === p)) : [...new Set([...ports, ...visible.map(v => v.port)])].sort((a, b) => a - b))}>{allShown ? 'Unselect shown' : `Select shown (${visible.length})`}</button>
      </div>
      <div className="ns-catalog-cats">{categories.map(c => <button key={c} type="button" className={`ns-pill ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>{c}</button>)}</div>
      <div className="ns-catalog">
        <table>
          <thead><tr><th /><th>PORT</th><th>SERVICE</th><th>RISK</th><th>WHAT TO DO IF IT IS OPEN</th></tr></thead>
          <tbody>
            {visible.map(item => (
              <tr key={item.port} className={chosen.has(item.port) ? 'chosen' : ''} onClick={() => toggle(item.port)}>
                <td><input type="checkbox" aria-label={`Port ${item.port} ${item.service}`} checked={chosen.has(item.port)} onChange={() => toggle(item.port)} onClick={e => e.stopPropagation()} /></td>
                <td><strong>{item.port}</strong></td><td>{item.service}<small>{item.category}</small></td><td><RiskBadge risk={item.risk} /></td><td className="ns-note">{item.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && <p className="muted ns-more">No common port matches. You can still type any port number in the builder.</p>}
      </div>
      <div className="modal-footer"><span>All probes are TCP connection attempts. UDP services (SNMP, DNS over UDP) are not tested.</span><div><button className="button primary" onClick={onClose}>Done</button></div></div>
    </Dialog>
  );
}

function SaveDialog({ what, builder, existing, request, onClose, onSaved }: { what: 'targets' | 'ports' | 'test'; builder: Builder; existing: Preset | null; request: Request; onClose: () => void; onSaved: (preset: Preset, message: string) => void }) {
  const [name, setName] = useState(existing?.name ?? (what === 'test' ? builder.name : ''));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [keepSources, setKeepSources] = useState(what === 'test' && (existing ? (existing.endpointIds?.length ?? 0) > 0 : false));
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const body = { kind: what, name, description, targets: builder.targets, ports: builder.ports,
    ...(what === 'test' ? { expect: builder.expect, speed: builder.speed, ping: builder.ping, resolveNames: builder.resolveNames, onlyResponsive: builder.onlyResponsive, endpointIds: keepSources ? builder.sources : [] } : {}) };
  const save = async (asNew: boolean) => {
    setBusy(true); setError('');
    try {
      const preset = existing && !asNew ? await request<Preset>(`/netscan/presets/${existing.id}`, 'PUT', body) : await request<Preset>('/netscan/presets', 'POST', body);
      onSaved(preset, existing && !asNew ? `Updated “${preset.name}”.` : `Saved “${preset.name}”.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  const title = what === 'test' ? (existing ? 'Update saved test' : 'Save as a test') : what === 'targets' ? 'Save target list' : 'Save port list';
  return (
    <Dialog title={title} subtitle={what === 'test' ? `${EXPECT_COPY[builder.expect].label} · ${builder.targets.join(', ')} · ${portsText(builder.ports) || 'ping only'}` : what === 'targets' ? builder.targets.join(', ') : portsText(builder.ports)} onClose={onClose}>
      <form className="ns-save-form" onSubmit={e => { e.preventDefault(); void save(false); }}>
        <label>Name<input value={name} maxLength={100} required placeholder={what === 'test' ? 'e.g. Everyone can print to the circ desk printer' : what === 'targets' ? 'e.g. Staff VLAN' : 'e.g. Printer ports'} onChange={e => setName(e.target.value)} /></label>
        <label>Notes (optional)<textarea value={description} maxLength={1000} rows={2} onChange={e => setDescription(e.target.value)} /></label>
        {what === 'test' && <label className="ns-toggle"><input type="checkbox" checked={keepSources} disabled={!builder.sources.length} onChange={e => setKeepSources(e.target.checked)} />
          <span><strong>Remember the {builder.sources.length} chosen computer{builder.sources.length === 1 ? '' : 's'}</strong><small>Pre-selects them when you run this test. You can still pick others each time.</small></span></label>}
        {error && <p className="ns-target-preview bad">{error}</p>}
        <div className="modal-footer"><span>Saved items are shared with everyone who uses this console.</span><div>
          {existing && <button type="button" className="button secondary" disabled={busy || !name.trim()} onClick={() => save(true)}>Save as new</button>}
          <button type="submit" className="button primary" disabled={busy || !name.trim()}>{busy && <Loader2 size={14} className="spin" />}{existing ? 'Update' : 'Save'}</button>
        </div></div>
      </form>
    </Dialog>
  );
}

function RunTestDialog({ test, endpoints, busy, onClose, onRun }: { test: Preset; endpoints: ScanEndpoint[]; busy: boolean; onClose: () => void; onRun: (sources: string[]) => void }) {
  const [sources, setSources] = useState<string[]>((test.endpointIds ?? []).filter(id => endpoints.some(ep => ep.id === id)));
  return (
    <Dialog title={`Run “${test.name}”`} subtitle={`${EXPECT_COPY[test.expect ?? 'discover'].label} · ${(test.targets ?? []).join(', ')} · ${portsText(test.ports ?? []) || 'ping only'}`} onClose={onClose} wide>
      <EndpointPicker endpoints={endpoints} value={sources} onChange={setSources} />
      <div className="modal-footer"><span>Each computer gets one scan job and its own pass/fail result.</span><div>
        <button className="button secondary" onClick={onClose}>Cancel</button>
        <button className="button primary" disabled={busy || !sources.length} onClick={() => onRun(sources)}>{busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}Run on {sources.length} computer{sources.length === 1 ? '' : 's'}</button>
      </div></div>
    </Dialog>
  );
}

// ---------------- Results ----------------
type Tab = 'hosts' | 'map' | 'exposure' | 'compare' | 'network';
function ScanResults({ id, request, endpoints, canRun, onBack, onRerun }: { id: string; request: Request; endpoints: ScanEndpoint[]; canRun: boolean; onBack: () => void; onRerun: (scan: Scan) => void }) {
  const [scan, setScan] = useState<Scan | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('hosts');
  const [source, setSource] = useState<string>('all');
  useEffect(() => {
    let stop = false; let timer = 0;
    const load = async () => {
      try { const next = await request<Scan>(`/netscans/${id}`); if (stop) return; setScan(next); setError(''); if (next.status !== 'finished') timer = window.setTimeout(load, 2000); }
      catch (err) { if (!stop) { setError(err instanceof Error ? err.message : String(err)); timer = window.setTimeout(load, 5000); } }
    };
    void load();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [id]);
  if (!scan) return <section className="panel ns-loading">{error ? <p className="ns-target-preview bad">{error}</p> : <><Loader2 className="spin" size={20} /> Loading scan…</>}<button className="button secondary small" onClick={onBack}><ArrowLeft size={14} />Back</button></section>;

  const sources = source === 'all' ? scan.sources : scan.sources.filter(s => s.endpointId === source);
  const merged = mergeHosts(sources);
  const allFindings = findings(sources);
  const risky = allFindings.filter(f => f.info.risk === 'critical' || f.info.risk === 'high');
  const finished = scan.sources.filter(s => s.finished).length;
  const selfIps = sources.flatMap(s => (s.interfaces ?? []).map(i => i.ip));
  const download = () => {
    const blob = new Blob(['﻿' + scanCsv(scan)], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `network-scan-${scan.createdAt.slice(0, 10)}-${scan.id.slice(0, 8)}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };
  const tabs: { key: Tab; label: string; icon: typeof Radar; count?: number; hidden?: boolean }[] = [
    { key: 'hosts', label: 'Hosts', icon: Table2, count: merged.length },
    { key: 'map', label: 'Subnet map', icon: MapIcon },
    { key: 'exposure', label: 'Exposure', icon: ShieldAlert, count: allFindings.length },
    { key: 'compare', label: 'Compare computers', icon: GitCompareArrows, hidden: scan.sources.length < 2 },
    { key: 'network', label: 'Source network', icon: Network },
  ];
  return (
    <div className="ns-results">
      <div className="ns-results-head">
        <button type="button" className="button secondary small" onClick={onBack}><ArrowLeft size={14} />Scanner</button>
        <div className="ns-results-title">
          <h2>{scan.name} <Verdict verdict={scan.verdict} expect={scan.expect} /></h2>
          <p>{EXPECT_COPY[scan.expect].label} · {scan.targets.map(t => t.input).join(', ')} · {scan.ports.length ? `${scan.ports.length} port${scan.ports.length === 1 ? '' : 's'}` : 'ping only'} · {SPEEDS[scan.speed].label} · started by {scan.createdBy} {ago(scan.createdAt)}</p>
        </div>
        <div className="ns-results-actions">
          {canRun && <button type="button" className="button secondary small" onClick={() => onRerun(scan)}><RotateCcw size={14} />Run again</button>}
          <button type="button" className="button secondary small" onClick={download} disabled={!merged.length}><Download size={14} />Export CSV</button>
        </div>
      </div>
      {error && <p className="ns-target-preview bad">{error}</p>}

      <div className="ns-sources-strip">
        {scan.sources.length > 1 && <button type="button" className={`ns-source-card all ${source === 'all' ? 'active' : ''}`} onClick={() => setSource('all')}><strong>All computers</strong><small>{finished}/{scan.sources.length} finished</small></button>}
        {scan.sources.map(s => <SourceCard key={s.endpointId} source={s} active={source === s.endpointId} expect={scan.expect} onClick={() => setSource(source === s.endpointId && scan.sources.length > 1 ? 'all' : s.endpointId)} />)}
      </div>

      {scan.expect !== 'discover' && <TestSummary scan={scan} sources={sources} />}

      <div className="ns-stats">
        <Stat icon={Monitor} label="Devices found" value={merged.length} hint={merged.filter(h => h.arpOnly).length ? `${merged.filter(h => h.arpOnly).length} seen only on the local network (ARP)` : 'answered ping, a port or ARP'} />
        <Stat icon={EthernetPort} label="Open services" value={merged.reduce((sum, h) => sum + h.open.length, 0)} hint={`across ${allFindings.length} distinct port${allFindings.length === 1 ? '' : 's'}`} />
        <Stat icon={ShieldAlert} label="High-risk exposures" value={risky.reduce((sum, f) => sum + f.hosts.length, 0)} hint={risky.length ? risky.slice(0, 3).map(f => f.info.service).join(', ') : 'none found'} tone={risky.length ? 'bad' : 'good'} />
        <Stat icon={Radar} label="Addresses scanned" value={scan.addresses} hint={`${(scan.addresses * scan.ports.length).toLocaleString()} probes per computer`} />
      </div>

      <section className="panel ns-tabs-panel">
        <div className="ns-tabbar">
          <div className="tabs" role="tablist">
            {tabs.filter(t => !t.hidden).map(t => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}><t.icon size={14} />{t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}</button>)}
          </div>
          {scan.status !== 'finished' && <span className="ns-live">Updating live</span>}
        </div>
        {tab === 'hosts' && <HostsTable hosts={merged} multi={sources.length > 1} names={new Map(scan.sources.map(s => [s.endpointId, s.endpointName]))} waiting={scan.status !== 'finished'} />}
        {tab === 'map' && <SubnetMap scan={scan} hosts={merged} selfIps={selfIps} />}
        {tab === 'exposure' && <Exposure list={allFindings} names={new Map(scan.sources.map(s => [s.endpointId, s.endpointName]))} multi={sources.length > 1} />}
        {tab === 'compare' && <Compare sources={scan.sources} />}
        {tab === 'network' && <SourceNetwork sources={sources} endpoints={endpoints} />}
      </section>
    </div>
  );
}

type MergedHost = ScanHost & { sources: string[] };
function mergeHosts(sources: ScanSource[]): MergedHost[] {
  const map = new Map<string, MergedHost>();
  for (const source of sources) for (const host of source.hosts ?? []) {
    const existing = map.get(host.ip);
    if (!existing) { map.set(host.ip, { ...host, open: [...host.open], sources: [source.endpointId] }); continue; }
    existing.sources.push(source.endpointId);
    existing.open = [...new Set([...existing.open, ...host.open])].sort((a, b) => a - b);
    existing.name ??= host.name; existing.mac ??= host.mac; existing.ttl ??= host.ttl;
    if (host.rtt !== null && (existing.rtt === null || host.rtt < existing.rtt)) existing.rtt = host.rtt;
    existing.arpOnly = existing.arpOnly && host.arpOnly;
  }
  return [...map.values()].sort((a, b) => ipNumber(a.ip)! - ipNumber(b.ip)!);
}

function SourceCard({ source, active, expect, onClick }: { source: ScanSource; active: boolean; expect: Expectation; onClick: () => void }) {
  const status = source.job.status;
  const pct = source.finished ? 100 : source.progress && source.progress.total ? Math.round(source.progress.done / source.progress.total * 100) : 0;
  const phase = source.finished ? (status === 'succeeded' ? 'Finished' : status === 'cancelled' ? 'Cancelled' : status === 'interrupted' ? 'Interrupted' : 'Failed')
    : status === 'queued' ? 'Waiting for the computer' : status === 'dispatched' ? 'Starting' : source.progress ? `${PHASE_LABEL[source.progress.phase] ?? 'Scanning'} · ${pct}%` : 'Starting';
  return (
    <button type="button" className={`ns-source-card ${active ? 'active' : ''} ${source.finished && status !== 'succeeded' ? 'bad' : ''}`} onClick={onClick} title={source.error ?? source.job.summary ?? undefined}>
      <span className="ns-source-top"><Monitor size={14} /><strong>{source.endpointName}</strong>{expect !== 'discover' && <Verdict verdict={source.test?.verdict ?? 'pending'} expect={expect} />}</span>
      <span className="ns-bar"><span className={source.finished ? 'done' : ''} style={{ width: `${Math.max(source.finished ? 100 : 3, pct)}%` }} /></span>
      <small>{phase}{source.hostsUp ? ` · ${source.hostsUp} found · ${source.openPorts} open` : ''}</small>
      {source.error && <small className="ns-error">{source.error}</small>}
      {source.finished && status !== 'succeeded' && !source.error && source.job.summary && <small className="ns-error">{source.job.summary}</small>}
    </button>
  );
}

function TestSummary({ scan, sources }: { scan: Scan; sources: ScanSource[] }) {
  const want = scan.expect === 'reachable';
  const failing = sources.filter(s => s.test?.verdict === 'fail');
  const passing = sources.filter(s => s.test?.verdict === 'pass');
  return (
    <section className={`panel ns-test-summary ${scan.verdict}`}>
      <div className="ns-test-summary-head">
        {scan.verdict === 'pass' ? <CircleCheckBig size={22} /> : scan.verdict === 'fail' ? <CircleX size={22} /> : <CircleDashed size={22} />}
        <div>
          <h3>{scan.verdict === 'pass' ? `Passed — every computer ${want ? 'can reach' : 'is blocked from'} every target` : scan.verdict === 'fail' ? `${failing.length} of ${sources.length} computer${sources.length === 1 ? '' : 's'} failed` : 'Waiting for results'}</h3>
          <p>{want ? 'Every address must accept a connection on every port.' : 'No address may accept a connection on any port.'} {passing.length > 0 && `${passing.length} passed.`}</p>
        </div>
      </div>
      {failing.length > 0 && (
        <ul className="ns-failures">
          {failing.map(s => (
            <li key={s.endpointId}><strong>{s.endpointName}</strong> — {s.test!.failed.toLocaleString()} of {s.test!.checked.toLocaleString()} checks {want ? 'could not connect' : 'connected'}:
              <span className="ns-failure-list">{(s.test!.failures ?? []).slice(0, 24).map(f => <code key={`${f.ip}:${f.port}`}>{f.ip}:{f.port} <small>{portInfo(f.port).service}</small></code>)}{(s.test!.failures?.length ?? 0) > 24 && <small>…and {s.test!.failed - 24} more</small>}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Stat({ icon: Icon, label, value, hint, tone }: { icon: typeof Radar; label: string; value: number; hint: string; tone?: 'good' | 'bad' }) {
  return <div className={`ns-stat ${tone ?? ''}`}><span className="ns-stat-icon"><Icon size={16} /></span><div><small>{label}</small><strong>{value.toLocaleString()}</strong><p>{hint}</p></div></div>;
}

function HostsTable({ hosts, multi, names, waiting }: { hosts: MergedHost[]; multi: boolean; names: Map<string, string>; waiting: boolean }) {
  const [query, setQuery] = useState(''); const [risk, setRisk] = useState<'all' | 'risky' | 'open'>('all'); const [open, setOpen] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const visible = hosts.filter(h => {
    if (risk === 'open' && !h.open.length) return false;
    const worst = hostRisk(h);
    if (risk === 'risky' && worst !== 'critical' && worst !== 'high') return false;
    if (!needle) return true;
    return h.ip.includes(needle) || (h.name ?? '').toLowerCase().includes(needle) || (h.mac ?? '').toLowerCase().includes(needle) || DEVICE_LABELS[deviceGuess(h)].toLowerCase().includes(needle)
      || h.open.some(port => String(port) === needle || portInfo(port).service.toLowerCase().includes(needle));
  });
  if (!hosts.length) return <div className="ns-empty big">{waiting ? <><Loader2 className="spin" size={22} /><p>Scanning… devices appear here as soon as they answer.</p></> : <><Radar size={22} /><p>No devices answered. The targets may be empty, offline, or blocked from this computer — for a hardening check, that can be good news.</p></>}</div>;
  return (
    <>
      <div className="ns-table-tools">
        <label className="ns-search"><Search size={14} /><input aria-label="Filter hosts" placeholder="Filter by IP, name, MAC, device type, port or service" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="ns-segmented small" role="radiogroup" aria-label="Show">
          {([['all', 'All'], ['open', 'With open ports'], ['risky', 'High risk']] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={risk === value} className={risk === value ? 'active' : ''} onClick={() => setRisk(value)}>{label}</button>)}
        </div>
      </div>
      <div className="table-scroll">
        <table className="ns-hosts">
          <thead><tr><th /><th>ADDRESS</th><th>DEVICE</th><th>OPEN PORTS</th><th>PING</th>{multi && <th>SEEN FROM</th>}</tr></thead>
          <tbody>
            {visible.flatMap(h => {
              const kind = deviceGuess(h); const Icon = DEVICE_ICONS[kind]; const worst = hostRisk(h); const expanded = open === h.ip;
              const rows = [
                <tr key={h.ip} className={`${expanded ? 'expanded' : ''} risk-${worst ?? 'none'}`} onClick={() => setOpen(expanded ? null : h.ip)}>
                  <td className="ns-toggle-cell">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                  <td><span className="ns-addr"><strong>{h.ip}</strong><small>{h.name ?? (h.arpOnly ? 'Seen on local network only' : 'No name')}</small></span></td>
                  <td><span className={`ns-device ns-device-${worst ?? 'none'}`}><Icon size={14} /><span>{DEVICE_LABELS[kind]}<small>{[osGuess(h.ttl), h.mac].filter(Boolean).join(' · ') || '—'}</small></span></span></td>
                  <td><span className="ns-port-list">{h.open.length ? h.open.slice(0, 12).map(port => <PortChip key={port} port={port} compact={h.open.length > 6} />) : <span className="muted">{h.closedCount ? `${h.closedCount} closed` : 'none'}</span>}{h.open.length > 12 && <span className="ns-more">+{h.open.length - 12}</span>}</span></td>
                  <td>{h.rtt !== null ? `${h.rtt} ms` : <span className="muted">no reply</span>}</td>
                  {multi && <td>{h.sources.length === names.size ? 'All' : h.sources.map(id => names.get(id)).join(', ')}</td>}
                </tr>,
              ];
              if (expanded) rows.push(<tr key={`${h.ip}-detail`} className="ns-detail-row"><td colSpan={multi ? 6 : 5}><HostDetail host={h} names={names} multi={multi} /></td></tr>);
              return rows;
            })}
          </tbody>
        </table>
        {!visible.length && <p className="muted ns-more">No device matches this filter.</p>}
      </div>
    </>
  );
}

function HostDetail({ host, names, multi }: { host: MergedHost; names: Map<string, string>; multi: boolean }) {
  return (
    <div className="ns-host-detail">
      <dl>
        <div><dt>Name</dt><dd>{host.name ?? '—'}</dd></div>
        <div><dt>MAC address</dt><dd>{host.mac ?? 'Not on the same local network'}</dd></div>
        <div><dt>Ping</dt><dd>{host.rtt !== null ? `${host.rtt} ms · TTL ${host.ttl ?? '?'}` : 'No reply'}</dd></div>
        <div><dt>Likely OS</dt><dd>{osGuess(host.ttl) ?? 'Unknown'}</dd></div>
        <div><dt>Refused ports</dt><dd>{host.closedCount ? `${host.closedCount} (host is up, nothing listening)` : '—'}</dd></div>
        {multi && <div><dt>Reachable from</dt><dd>{host.sources.map(id => names.get(id)).join(', ')}</dd></div>}
      </dl>
      {host.open.length > 0 ? (
        <div className="ns-port-cards">
          {[...host.open].sort((a, b) => RISK_ORDER.indexOf(portInfo(a).risk) - RISK_ORDER.indexOf(portInfo(b).risk) || a - b).map(port => { const info = portInfo(port); return (
            <div key={port} className={`ns-port-card ns-port-${info.risk}`}>
              <div><strong>{port}</strong><span>{info.service}</span><RiskBadge risk={info.risk} /></div>
              <p>{info.note}</p>
            </div>
          ); })}
        </div>
      ) : <p className="muted">No open ports among those scanned.</p>}
    </div>
  );
}

function SubnetMap({ scan, hosts, selfIps }: { scan: Scan; hosts: MergedHost[]; selfIps: string[] }) {
  const grids = useMemo(() => subnetGrids(scan, hosts, selfIps), [scan, hosts, selfIps.join()]);
  const [focus, setFocus] = useState<string | null>(null);
  const focused = hosts.find(h => h.ip === focus) ?? null;
  return (
    <div className="ns-map">
      <div className="ns-legend">
        <span><i className="cell down" />No answer</span><span><i className="cell up" />Up, nothing open</span><span><i className="cell open" />Open services</span>
        <span><i className="cell risky" />High-risk service</span><span><i className="cell self" />Scanning computer</span><span><i className="cell outside" />Not scanned</span>
      </div>
      <div className="ns-map-body">
      <div className="ns-grids">
        {grids.map(grid => (
          <figure key={grid.network} className="ns-grid">
            <figcaption><strong>{grid.network}</strong><small>{grid.up} up</small></figcaption>
            <div className="ns-cells">
              {grid.cells.map(cell => (
                <button key={cell.ip} type="button" className={`cell ${cell.state} ${focus === cell.ip ? 'focus' : ''}`} disabled={!cell.host}
                  title={`${cell.ip}${cell.host ? ` · ${cell.host.name ?? DEVICE_LABELS[deviceGuess(cell.host)]}${cell.host.open.length ? ` · ${cell.host.open.join(', ')}` : ''}` : cell.state === 'self' ? ' · scanning computer' : cell.state === 'down' ? ' · no answer' : ''}`}
                  aria-label={cell.host ? `${cell.ip} details` : cell.ip} onClick={() => setFocus(cell.ip)} />
              ))}
            </div>
            <div className="ns-axis"><span>.0</span><span>.255</span></div>
          </figure>
        ))}
      </div>
      <div className="ns-map-side">{focused ? <div className="ns-map-focus"><h4>{focused.ip}{focused.name ? ` · ${focused.name}` : ''}</h4><HostDetail host={focused} names={new Map()} multi={false} /></div>
        : <p className="muted ns-more">Click a coloured square to see that device. Hover any square for its address.</p>}</div>
      </div>
    </div>
  );
}

function Exposure({ list, names, multi }: { list: ReturnType<typeof findings>; names: Map<string, string>; multi: boolean }) {
  if (!list.length) return <div className="ns-empty big"><ShieldCheck size={22} /><p>No open services were found among the scanned ports.</p></div>;
  return (
    <div className="ns-exposure">
      {list.map(f => (
        <article key={f.port} className={`ns-finding ns-port-${f.info.risk}`}>
          <header><RiskBadge risk={f.info.risk} /><h4>{f.info.service} <span>port {f.port}</span></h4><strong>{f.hosts.length} device{f.hosts.length === 1 ? '' : 's'}</strong></header>
          <p>{f.info.note}</p>
          <div className="ns-finding-hosts">{f.hosts.slice(0, 40).map(h => <span key={h.ip} title={multi ? `Reachable from ${h.sources.map(id => names.get(id)).join(', ')}` : undefined}>{h.ip}{h.name ? <small>{h.name}</small> : null}{multi && <em>{h.sources.length}</em>}</span>)}{f.hosts.length > 40 && <span>+{f.hosts.length - 40} more</span>}</div>
        </article>
      ))}
    </div>
  );
}

function Compare({ sources }: { sources: ScanSource[] }) {
  const [onlyDiff, setOnlyDiff] = useState(true);
  const rows = compareSources(sources);
  const shown = onlyDiff ? rows.filter(r => r.differs) : rows;
  return (
    <div className="ns-compare">
      <div className="ns-table-tools">
        <p className="muted">Each column is a computer the scan ran from. Differences show where firewall rules or network segments give computers different access.</p>
        <label className="ns-toggle inline"><input type="checkbox" checked={onlyDiff} onChange={e => setOnlyDiff(e.target.checked)} /><span><strong>Only differences ({rows.filter(r => r.differs).length})</strong></span></label>
      </div>
      <div className="table-scroll">
        <table className="ns-compare-table">
          <thead><tr><th>DEVICE</th>{sources.map(s => <th key={s.endpointId}>{s.endpointName}</th>)}</tr></thead>
          <tbody>
            {shown.map(row => (
              <tr key={row.ip} className={row.differs ? 'differs' : ''}>
                <td><span className="ns-addr"><strong>{row.ip}</strong><small>{row.name ?? ''}</small></span></td>
                {row.cells.map((cell, i) => (
                  <td key={sources[i].endpointId} className={cell ? 'reach' : 'noreach'}>
                    {!sources[i].finished && !cell ? <span className="muted">…</span> : !cell ? <span className="ns-blocked">not reachable</span> : cell.open.length ? <span className="ns-port-list">{cell.open.map(port => <PortChip key={port} port={port} compact />)}</span> : <span className="muted">up, nothing open</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <p className="muted ns-more">{rows.length ? 'Every computer sees exactly the same devices and ports.' : 'No devices found yet.'}</p>}
      </div>
    </div>
  );
}

function SourceNetwork({ sources, endpoints }: { sources: ScanSource[]; endpoints: ScanEndpoint[] }) {
  return (
    <div className="ns-network">
      {sources.map(s => (
        <article key={s.endpointId} className="ns-network-card">
          <h4><Monitor size={15} />{s.endpointName}</h4>
          {(s.interfaces ?? []).length ? (
            <table><thead><tr><th>ADAPTER</th><th>ADDRESS</th><th>GATEWAY</th><th>MAC</th></tr></thead>
              <tbody>{s.interfaces!.map(i => <tr key={`${i.name}-${i.ip}`}><td>{i.name}</td><td><strong>{i.ip}{i.prefix !== null ? `/${i.prefix}` : ''}</strong></td><td>{i.gateways.join(', ') || '—'}</td><td>{i.mac || '—'}</td></tr>)}</tbody></table>
          ) : <p className="muted">{s.finished ? 'The computer did not report its network adapters.' : 'Reported when the scan starts.'}{endpoints.find(e => e.id === s.endpointId)?.inventory?.ipv4?.length ? ` Inventory addresses: ${endpoints.find(e => e.id === s.endpointId)!.inventory!.ipv4!.join(', ')}` : ''}</p>}
        </article>
      ))}
    </div>
  );
}
