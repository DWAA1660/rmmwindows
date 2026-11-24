import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/manrope';
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Download,
  File,
  Folder,
  FolderSearch,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Package,
  Play,
  Plus,
  Power,
  Radar,
  RefreshCw,
  Router,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import './tokens.css';
import './styles.css';
import type { EndpointGroup } from './EndpointGroups';
import { AccountSettings } from './AccountSettings';
import { progressOutput } from './progress';
import type { JoinRequest } from './JoinRequests';
import { EndpointPicker } from './EndpointPicker';
import { BatchResults } from './BatchResults';
import { FileExplorer } from './FileExplorer';
import { RemoteSupport } from './RemoteSupport';
import { TerminalConsole } from './TerminalConsole';
import { SoftwareInventory } from './SoftwareInventory';
import { StarterScripts } from './StarterScripts';
import { filterActivity, isBrowsingJob } from './activityFilter';
import { CommandPalette } from './CommandPalette';
import type { PaletteItem } from './commandPaletteModel';
import { BulkAgentUpdate } from './BulkAgentUpdate';
import { NetworkScanner } from './NetworkScanner';
import { Firewall } from './Firewall';
import type {
  Audit,
  Chunk,
  Endpoint,
  Job,
  RunSummary,
  Schedule,
  Script,
  StorageResult,
  User,
  View,
} from './types';
import {
  endpointDisplayName,
  formatBytes,
  formatRelativeTime,
  formatTimestamp,
  isActiveJob,
  matchesEndpointSearch,
  titleCaseAction,
  usedDiskPercent,
} from './uiUtils';
import { Brand, StatusBadge } from './components/UiPrimitives';
import { Modal } from './components/Modal';
import { ConfirmDialog, type ConfirmDialogState } from './components/ConfirmDialog';
import { OverviewView } from './components/OverviewView';
import { EndpointsView } from './components/EndpointsView';
import { EndpointInspector } from './components/EndpointInspector';
import { ScriptsView } from './components/ScriptsView';
import { SchedulesView } from './components/SchedulesView';
import { ActivityView } from './components/ActivityView';
import { EnrollmentView } from './components/EnrollmentView';
import { AuditView } from './components/AuditView';
import { SettingsView } from './components/SettingsView';

// Session secrets stay in HttpOnly cookies; only the CSRF nonce stays in memory.
let csrfToken = '';

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const raw = body instanceof Blob;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined
        ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }
        : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      /* Preserve HTTP status message for non-JSON responses. */
    }
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event('session-expired'));
    }
    throw new Error(message);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', 'POST', { username, password });
      const session = await api<{ user: User; csrfToken: string }>('/auth/me');
      csrfToken = session.csrfToken;
      onLogin(session.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-story">
        <Brand />
        <div className="login-copy">
          <span className="eyebrow">PARK COUNTY LIBRARY SYSTEM</span>
          <h1>Windows fleet management, built for reliability.</h1>
          <p>
            Monitor workstations across Cody, Powell, and Meeteetse, dispatch at-most-once
            maintenance, and support patrons cleanly on restore-on-reboot desktops.
          </p>
          <ul className="login-highlights">
            <li>
              <ShieldCheck size={16} />
              <span>At-most-once job execution — safe for Deep Freeze rollbacks</span>
            </li>
            <li>
              <Terminal size={16} />
              <span>Audited PowerShell, interactive shell, and file operations</span>
            </li>
            <li>
              <Monitor size={16} />
              <span>Policy-controlled browser remote support with visible indicator</span>
            </li>
          </ul>
        </div>
        <div className="login-footer">
          <span>rmm.parkcountylibrary.org</span>
          <span>Outbound HTTPS agents</span>
        </div>
      </div>

      <div className="login-form-side">
        <div className="login-form">
          <span className="section-label">OPERATIONS SIGN IN</span>
          <h2>Sign in to console</h2>
          <p>Use your library administrator or operator credentials.</p>
          <form onSubmit={(e) => void submit(e)}>
            <label>
              Username
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                placeholder="Administrator username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Enter password"
              />
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button type="submit" className="button primary login-submit" disabled={busy}>
              {busy ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <>
                  Sign in <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
          <div className="login-security">
            <ShieldCheck size={15} />
            <span>Authorized library IT personnel only. Sign-ins and actions are audited.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [selectedView, setView] = useState<View>('overview');
  const view = selectedView === 'firewall' && user?.role === 'viewer' ? 'overview' : selectedView;

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [updateStatus, setUpdateStatus] = useState<Record<string, unknown> | null>(null);
  const [tokens, setTokens] = useState<Record<string, unknown>[]>([]);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [groups, setGroups] = useState<EndpointGroup[]>([]);
  const [groupFilter, setGroupFilter] = useState('all');
  const [runs, setRuns] = useState<RunSummary[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string>();

  const [detail, setDetail] = useState<Endpoint | null>(null);
  const [jobDetail, setJobDetail] = useState<Job | null>(null);
  const [batch, setBatch] = useState<Job[] | null>(null);
  const [explorer, setExplorer] = useState<Endpoint | null>(null);
  const [terminalEndpoint, setTerminalEndpoint] = useState<Endpoint | null>(null);
  const [command, setCommand] = useState<{
    ids: string[];
    kind: string;
    script: string;
    path: string;
    chooseEndpoints?: boolean;
    timeoutMinutes?: number;
  } | null>(null);
  const [starterOpen, setStarterOpen] = useState(false);
  const [bulkUpdate, setBulkUpdate] = useState<string[] | null>(null);
  const [activitySearch, setActivitySearch] = useState('');
  const [activityKind, setActivityKind] = useState('all');
  const [showBrowsing, setShowBrowsing] = useState(false);
  const [scriptForm, setScriptForm] = useState<Partial<Script> | null>(null);
  const [scheduleForm, setScheduleForm] = useState(false);
  const [tokenForm, setTokenForm] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [busy, setBusy] = useState(false);

  const toastTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 5000);
  }, []);

  const fail = useCallback((err: unknown) => {
    setError(err instanceof Error ? err.message : String(err));
  }, []);

  const changeView = useCallback((next: View) => {
    setView(next);
    setSearch('');
    setFilter('all');
    setMobileNav(false);
  }, []);

  useEffect(() => {
    api<{ user: User; csrfToken: string }>('/auth/me')
      .then((s) => {
        csrfToken = s.csrfToken;
        setUser(s.user);
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));

    const expired = () => {
      setUser(null);
      csrfToken = '';
    };
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);

  const refresh = useCallback(
    async (showLoading = false) => {
      if (!user) return;
      if (showLoading) setLoading(true);
      try {
        const [eps, js, ss, sc, grps, rns] = await Promise.all([
          api<Endpoint[]>('/endpoints'),
          api<Job[]>('/jobs'),
          api<Script[]>('/scripts'),
          api<Schedule[]>('/schedules'),
          api<EndpointGroup[]>('/groups'),
          api<RunSummary[]>('/runs'),
        ]);
        setEndpoints(eps);
        setJobs(js);
        setScripts(ss);
        setSchedules(sc);
        setGroups(grps);
        setRuns(rns);
        api<JoinRequest[]>('/join-requests').then(setJoinRequests).catch(() => {});
        setLastRefresh(new Date().toISOString());
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    },
    [user, fail],
  );

  useEffect(() => {
    if (!user) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [user, refresh]);

  useEffect(() => {
    if (!user) return;
    if (view === 'audit') {
      api<Audit[]>('/audit?limit=100').then(setAudit).catch(fail);
    }
    if (view === 'settings') {
      api<Record<string, unknown>>('/settings').then(setSettings).catch(fail);
      api<Record<string, unknown>>('/settings/update')
        .then(setUpdateStatus)
        .catch(() => setUpdateStatus(null));
    }
    if (view === 'enrollment') {
      api<Record<string, unknown>[]>('/enrollment-tokens').then(setTokens).catch(fail);
    }
  }, [view, user, fail]);

  useEffect(() => {
    if (!user || view !== 'settings' || !settings.updateEnabled) return;
    const timer = window.setInterval(() => {
      api<Record<string, unknown>>('/settings/update')
        .then(setUpdateStatus)
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [view, user, settings.updateEnabled]);

  useEffect(() => {
    if (detail) {
      const latest = endpoints.find((e) => e.id === detail.id);
      if (latest) setDetail(latest);
    }
  }, [endpoints, detail?.id]);

  const activityJobs = useMemo(
    () =>
      filterActivity(
        jobs,
        { status: filter, kind: activityKind, query: activitySearch, showBrowsing },
        (job) => endpointDisplayName(endpoints.find((ep) => ep.id === job.endpointId)),
      ),
    [jobs, filter, activityKind, activitySearch, showBrowsing, endpoints],
  );

  const active = useMemo(() => endpoints.filter((ep) => !ep.revoked), [endpoints]);

  const groupScope = useMemo(
    () => active.filter((ep) => groupFilter === 'all' || ep.groupId === groupFilter),
    [active, groupFilter],
  );

  const filtered = useMemo(
    () =>
      active
        .filter((ep) => view !== 'endpoints' || groupFilter === 'all' || ep.groupId === groupFilter)
        .filter((ep) => matchesEndpointSearch(ep, search))
        .filter(
          (ep) =>
            filter === 'all' ||
            (filter === 'online' && ep.online) ||
            (filter === 'offline' && !ep.online) ||
            (filter === 'attention' && ep.inventory?.disks?.some((d) => usedDiskPercent(d) >= 85)) ||
            (filter === 'reboot' && ep.inventory?.pendingReboot === true),
        ),
    [active, view, groupFilter, search, filter],
  );

  const toggleSelected = useCallback(
    (id: string) =>
      setSelected((current) =>
        current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
      ),
    [],
  );

  const queueJobs = async (
    ids: string[],
    kind: string,
    payload: Record<string, unknown>,
    timeoutSeconds?: number,
  ) => {
    setBusy(true);
    setError('');
    try {
      const groupNames = [
        ...new Set(active.filter((ep) => ids.includes(ep.id)).map((ep) => ep.groupName || 'New endpoints')),
      ];
      const runLabel = `${groupNames.length === 1 ? groupNames[0] : 'Selected endpoints'} · ${kind}`;
      const result = await api<{ jobs: Job[] }>('/jobs', 'POST', {
        endpointIds: ids,
        kind,
        payload,
        timeoutSeconds: timeoutSeconds ?? (kind === 'storage' ? 900 : 300),
        idempotencyKey: crypto.randomUUID(),
        runName: runLabel,
      });
      notify(
        `${result.jobs.length} ${result.jobs.length === 1 ? 'job' : 'jobs'} queued. Each job runs at most once.`,
      );
      setCommand(null);
      await refresh();
      if (result.jobs.length === 1) setJobDetail(result.jobs[0]);
      else setBatch(result.jobs);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const openCommand = (kind: string, ids = selected, body = '', chooseEndpoints = false) => {
    if (!ids.length && !chooseEndpoints) {
      notify('Select at least one endpoint first.');
      return;
    }
    setCommand({ kind, ids, script: body, path: 'C:\\', chooseEndpoints });
  };

  const pendingJoins = joinRequests.filter((row) => row.status === 'pending').length;

  const navSections: {
    label: string;
    items: { key: View; label: string; icon: typeof Monitor; count?: number; badge?: string }[];
  }[] = [
    {
      label: 'Fleet',
      items: [
        { key: 'overview', label: 'Overview', icon: LayoutDashboard },
        { key: 'endpoints', label: 'Endpoints', icon: Monitor, count: active.length },
        { key: 'software', label: 'Software', icon: Package },
        { key: 'network', label: 'Network scanner', icon: Radar },
        ...(user?.role === 'viewer' ? [] : [{ key: 'firewall' as const, label: 'Firewall', icon: Router }]),
      ],
    },
    {
      label: 'Automation',
      items: [
        { key: 'scripts', label: 'Script library', icon: Code2 },
        { key: 'schedules', label: 'Schedules', icon: CalendarClock },
        {
          key: 'activity',
          label: 'Activity',
          icon: Activity,
          count: jobs.filter(isActiveJob).length || undefined,
          badge: 'Jobs in progress',
        },
      ],
    },
    {
      label: 'Administration',
      items: [
        {
          key: 'enrollment',
          label: 'Add endpoints',
          icon: Plus,
          count: pendingJoins || undefined,
          badge: 'Computers waiting for approval',
        },
        { key: 'audit', label: 'Audit log', icon: ShieldCheck },
        { key: 'settings', label: 'Settings', icon: Settings2 },
      ],
    },
  ];

  const pageInfo: Record<View, { title: string; subtitle: string }> = {
    overview: {
      title: 'Fleet overview',
      subtitle: 'Operational health, storage posture, and active tasks across the library fleet.',
    },
    endpoints: {
      title: 'Endpoints',
      subtitle: 'Inspect computers, organize branches, and dispatch at-most-once operations.',
    },
    software: {
      title: 'Software inventory',
      subtitle: 'Installed Windows applications and versions reported across the fleet.',
    },
    network: {
      title: 'Network scanner',
      subtitle: 'Verify reachability, open ports, and firewall isolation from library endpoints.',
    },
    firewall: {
      title: 'Firewall',
      subtitle: 'WatchGuard Firebox traffic and log sources.',
    },
    scripts: {
      title: 'Script library',
      subtitle: 'Reusable PowerShell routines ready for ad-hoc execution or scheduling.',
    },
    schedules: {
      title: 'Schedules',
      subtitle: 'Recurring interval tasks with strict non-replay guarantees.',
    },
    activity: {
      title: 'Activity & job output',
      subtitle: 'Every dispatched job and its complete retained stdout/stderr output.',
    },
    enrollment: {
      title: 'Add endpoints',
      subtitle: 'Deploy the Windows agent and approve waiting workstations.',
    },
    audit: {
      title: 'Audit log',
      subtitle: 'Immutable record of administrative actions and security events.',
    },
    settings: {
      title: 'Workspace settings',
      subtitle: 'Account security, remote support policy, and container updates.',
    },
  };

  const paletteItems: PaletteItem[] = [
    ...(Object.keys(pageInfo) as View[]).filter(key => key !== 'firewall' || user?.role !== 'viewer').map((key) => ({
      id: 'page:' + key,
      kind: 'page' as const,
      title: pageInfo[key].title,
      detail: pageInfo[key].subtitle,
    })),
    ...active.map((ep) => ({
      id: 'computer:' + ep.id,
      kind: 'computer' as const,
      title: endpointDisplayName(ep),
      detail: [
        ep.online ? 'Online' : 'Offline',
        ep.inventory?.ipv4?.join(', '),
        ep.inventory?.loggedOnUser,
        ep.groupName,
      ]
        .filter(Boolean)
        .join(' · '),
      keywords: [
        ep.hostname,
        ep.inventory?.osName,
        ep.inventory?.directory?.canonicalName,
        ep.tags?.join(' '),
      ]
        .filter(Boolean)
        .join(' '),
    })),
    ...(user?.role !== 'viewer'
      ? [
          {
            id: 'action:powershell',
            kind: 'action' as const,
            title: 'Run PowerShell on endpoints',
            keywords: 'script command run',
          },
          {
            id: 'action:starter',
            kind: 'action' as const,
            title: 'Browse starter scripts',
            keywords: 'templates cleanup update printer bitlocker',
          },
          {
            id: 'action:add',
            kind: 'action' as const,
            title: 'Add an endpoint',
            keywords: 'install enroll agent approve',
          },
        ]
      : []),
  ];

  const openEndpoints = (statusFilter: string) => {
    changeView('endpoints');
    setGroupFilter('all');
    setFilter(statusFilter);
  };

  const choosePaletteItem = (item: PaletteItem) => {
    if (item.id.startsWith('page:')) changeView(item.id.slice(5) as View);
    else if (item.id.startsWith('computer:')) {
      const ep = endpoints.find((entry) => entry.id === item.id.slice(9));
      if (ep) setDetail(ep);
    } else if (item.id === 'action:powershell') {
      setCommand({ kind: 'powershell', ids: selected, script: '', path: 'C:\\', chooseEndpoints: true });
    } else if (item.id === 'action:starter') {
      changeView('scripts');
      setStarterOpen(true);
    } else if (item.id === 'action:add') {
      changeView('enrollment');
    }
  };

  if (authLoading) {
    return (
      <div className="app-loading">
        <Brand />
        <Loader2 className="spin" size={20} />
        <span>Loading console…</span>
      </div>
    );
  }

  if (!user) return <Login onLogin={setUser} />;

  const canAct = user.role !== 'viewer';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
        <Brand />
        <nav className="nav-sections" aria-label="Console sections">
          {navSections.map((section) => (
            <div className="nav-group" key={section.label}>
              <span className="nav-section">{section.label}</span>
              {section.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={view === item.key ? 'nav-item active' : 'nav-item'}
                  aria-current={view === item.key ? 'page' : undefined}
                  onClick={() => changeView(item.key)}
                >
                  <item.icon size={16} />
                  <span>{item.label}</span>
                  {item.count !== undefined && (
                    <span
                      className={`nav-count tabular ${item.badge ? 'attention' : ''}`}
                      title={item.badge}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div
            className="sidebar-health"
            title="Jobs are consumed server-side before execution and never replayed automatically."
          >
            <ShieldCheck size={14} />
            <span>At-most-once execution</span>
          </div>
          <div className="profile">
            <span className="profile-avatar">{user.username.slice(0, 2).toUpperCase()}</span>
            <div className="profile-meta">
              <strong>{user.username}</strong>
              <small>{titleCaseAction(user.role)}</small>
            </div>
            <button
              type="button"
              aria-label="Sign out"
              title="Sign out"
              className="icon-button sidebar-logout"
              onClick={async () => {
                try {
                  await api('/auth/logout', 'POST', {});
                  setUser(null);
                  csrfToken = '';
                } catch (err) {
                  fail(err);
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {mobileNav && <div className="mobile-scrim" onClick={() => setMobileNav(false)} />}

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(!mobileNav)}
              aria-label="Toggle navigation"
            >
              <Menu size={18} />
            </button>
            <span className="breadcrumb">
              <span className="breadcrumb-root">Library RMM</span>
              <ChevronRight size={13} />
              <strong>{pageInfo[view].title}</strong>
            </span>
          </div>

          <div className="topbar-right">
            <button
              type="button"
              className="palette-hint"
              title="Quick search (Ctrl+K)"
              onClick={() => window.dispatchEvent(new Event('open-command-palette'))}
            >
              <Search size={14} />
              <span>Quick jump</span>
              <kbd>Ctrl+K</kbd>
            </button>
            <button
              type="button"
              className="button small secondary topbar-refresh"
              title={
                lastRefresh
                  ? `Last synced ${formatRelativeTime(lastRefresh).toLowerCase()} · refreshes every 10s`
                  : 'Refresh workspace'
              }
              aria-label="Refresh workspace"
              onClick={() => void refresh(true)}
            >
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <main className="main-content">
          <div className="page-heading">
            <div>
              <h1>{pageInfo[view].title}</h1>
              <p>{pageInfo[view].subtitle}</p>
            </div>
            <div className="page-actions">
              {view === 'scripts' && canAct && (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setStarterOpen(true)}
                  >
                    <Sparkles size={15} /> Starter scripts
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => setScriptForm({ name: '', description: '', body: '' })}
                  >
                    <Plus size={15} /> New script
                  </button>
                </>
              )}
              {view === 'schedules' && canAct && (
                <button
                  type="button"
                  className="button primary"
                  disabled={!scripts.length || !active.length}
                  onClick={() => setScheduleForm(true)}
                >
                  <Plus size={15} /> New schedule
                </button>
              )}
              {view === 'enrollment' && canAct && (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setNewToken(null);
                    setTokenForm(true);
                  }}
                >
                  <Plus size={15} /> Create token
                </button>
              )}
              {['overview', 'endpoints'].includes(view) && (
                <>
                  {canAct && (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!active.length}
                      onClick={() =>
                        setCommand({
                          kind: 'powershell',
                          ids: selected,
                          script: '',
                          path: 'C:\\',
                          chooseEndpoints: true,
                        })
                      }
                    >
                      <Terminal size={15} /> Run PowerShell
                    </button>
                  )}
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => changeView('enrollment')}
                  >
                    <Plus size={15} /> Add endpoint
                  </button>
                </>
              )}
            </div>
          </div>

          {error && (
            <div className="error-banner" role="alert">
              <XCircle size={17} />
              <span>{error}</span>
              <button
                type="button"
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError('')}
              >
                <X size={15} />
              </button>
            </div>
          )}

          {view === 'overview' && (
            <OverviewView
              endpoints={active}
              jobs={jobs}
              canAct={canAct}
              request={api}
              onOpenEndpoints={openEndpoints}
              onOpenEndpointDetail={setDetail}
              onOpenJob={setJobDetail}
              onChangeView={changeView}
              onOpenCommand={openCommand}
              onQueueJobs={queueJobs}
            />
          )}

          {view === 'endpoints' && (
            <EndpointsView
              groups={groups}
              groupFilter={groupFilter}
              onChangeGroup={setGroupFilter}
              activeEndpoints={active}
              groupScopeEndpoints={groupScope}
              filteredEndpoints={filtered}
              statusFilter={filter}
              onChangeStatusFilter={setFilter}
              search={search}
              onChangeSearch={setSearch}
              selected={selected}
              onChangeSelected={setSelected}
              onToggleSelected={toggleSelected}
              canAct={canAct}
              busy={busy}
              request={api}
              refresh={refresh}
              onError={fail}
              onNotify={notify}
              onOpenDetail={setDetail}
              onOpenCommand={(kind, ids) => openCommand(kind, ids)}
              onQueueJobs={queueJobs}
              onBulkUpdateAgent={(ids) => setBulkUpdate(ids)}
              onAddEndpoint={() => changeView('enrollment')}
              onResetFilters={() => {
                setGroupFilter('all');
                setFilter('all');
                setSearch('');
              }}
            />
          )}

          {view === 'software' && (
            <SoftwareInventory
              endpoints={endpoints}
              onOpenEndpoint={(id) => {
                const ep = endpoints.find((item) => item.id === id);
                if (ep) setDetail(ep);
              }}
            />
          )}

          {view === 'network' && (
            <NetworkScanner
              endpoints={endpoints}
              canRun={canAct}
              request={api}
              notify={notify}
              onConfirm={setConfirmDialog}
            />
          )}

          {view === 'scripts' && (
            <ScriptsView
              scripts={scripts}
              search={search}
              canEdit={canAct}
              onSearchChange={setSearch}
              onCreate={() => setScriptForm({ name: '', description: '', body: '' })}
              onEdit={(s) => setScriptForm(s)}
              onRun={(s) =>
                setCommand({
                  kind: 'powershell',
                  ids: selected.length ? selected : [],
                  script: s.body,
                  chooseEndpoints: true,
                  path: 'C:\\',
                })
              }
            />
          )}

          {view === 'firewall' && user.role !== 'viewer' && (
            <Firewall request={api} canManage={user.role === 'admin'} onOpenScanner={() => changeView('network')} />
          )}

          {view === 'schedules' && (
            <SchedulesView
              schedules={schedules}
              scripts={scripts}
              activeEndpoints={active}
              canEdit={canAct}
              onCreate={() => setScheduleForm(true)}
              onToggle={async (s) => {
                try {
                  await api(`/schedules/${s.id}`, 'PATCH', { enabled: !s.enabled });
                  await refresh();
                } catch (err) {
                  fail(err);
                }
              }}
              onDelete={(s) =>
                setConfirmDialog({
                  title: `Delete schedule “${s.name}”?`,
                  description:
                    'Future occurrences will stop immediately. Already-dispatched jobs remain in Activity.',
                  confirmLabel: 'Delete schedule',
                  tone: 'danger',
                  onConfirm: async () => {
                    await api(`/schedules/${s.id}`, 'DELETE');
                    await refresh();
                    notify('Schedule deleted.');
                  },
                })
              }
            />
          )}

          {view === 'activity' && (
            <ActivityView
              runs={runs}
              jobs={jobs}
              visibleJobs={activityJobs}
              browsingCount={jobs.filter(isBrowsingJob).length}
              endpoints={endpoints}
              statusFilter={filter}
              kindFilter={activityKind}
              search={activitySearch}
              showBrowsing={showBrowsing}
              onChangeStatusFilter={setFilter}
              onChangeKindFilter={setActivityKind}
              onChangeSearch={setActivitySearch}
              onToggleShowBrowsing={setShowBrowsing}
              onOpenRun={(runId) =>
                void api<{ jobs: Job[] }>(`/runs/${runId}`)
                  .then((result) => {
                    if (result.jobs.length === 1) setJobDetail(result.jobs[0]);
                    else setBatch(result.jobs);
                  })
                  .catch(fail)
              }
              onOpenJob={setJobDetail}
            />
          )}

          {view === 'enrollment' && (
            <EnrollmentView
              joinRequests={joinRequests}
              tokens={tokens}
              user={user}
              request={api}
              refresh={refresh}
              onConfirm={setConfirmDialog}
              onCreateToken={() => {
                setNewToken(null);
                setTokenForm(true);
              }}
            />
          )}

          {view === 'audit' && (
            <AuditView
              audit={audit}
              onRefresh={() => void api<Audit[]>('/audit?limit=100').then(setAudit).catch(fail)}
            />
          )}

          {view === 'settings' && (
            <SettingsView
              user={user}
              settings={settings}
              updateStatus={updateStatus}
              busy={busy}
              request={api}
              onProfile={setUser}
              onUpdateStatusChange={setUpdateStatus}
              onError={fail}
              onNotify={notify}
              onConfirm={setConfirmDialog}
            />
          )}
        </main>
      </div>

      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={16} />
          <span>{toast}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {detail && (
        <EndpointInspector
          endpoint={detail}
          user={user}
          busy={busy}
          request={api}
          refresh={refresh}
          onClose={() => setDetail(null)}
          onNotify={notify}
          onError={fail}
          onConfirm={setConfirmDialog}
          onOpenTerminal={(ep) => {
            setTerminalEndpoint(ep);
            setDetail(null);
          }}
          onOpenFiles={(ep) => {
            setExplorer(ep);
            setDetail(null);
          }}
          onRunPowerShell={(ep) => {
            setCommand({
              kind: 'powershell',
              ids: [ep.id],
              script: '',
              path: 'C:\\',
              chooseEndpoints: true,
            });
            setDetail(null);
          }}
          onQueueInventory={async (ids) => {
            await queueJobs(ids, 'inventory', {});
          }}
          onOpenReboot={(ep) => {
            openCommand('reboot', [ep.id]);
            setDetail(null);
          }}
          onOpenJob={setJobDetail}
        />
      )}

      {command && (
        <Modal
          title={
            command.kind === 'reboot'
              ? 'Reboot endpoints'
              : command.kind === 'storage'
                ? 'Explore storage'
                : 'Run PowerShell'
          }
          subtitle={
            command.ids.length
              ? `${command.ids.length} selected endpoint${command.ids.length !== 1 ? 's' : ''}`
              : 'Choose endpoints for this command'
          }
          wide
          onClose={() => setCommand(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!command.ids.length) {
                notify('Choose at least one endpoint.');
                return;
              }
              void queueJobs(
                command.ids,
                command.kind,
                command.kind === 'powershell'
                  ? { script: command.script }
                  : command.kind === 'reboot'
                    ? {
                        delaySeconds: 30,
                        reason: 'Administrator requested reboot from Library RMM',
                      }
                    : { path: command.path },
                command.kind === 'powershell'
                  ? (command.timeoutMinutes ?? 15) * 60
                  : undefined,
              );
            }}
          >
            {(command.chooseEndpoints || command.kind === 'powershell') && (
              <div className="field">
                <span className="field-label">Target endpoints</span>
                <EndpointPicker
                  endpoints={active}
                  value={command.ids}
                  onChange={(ids) => setCommand({ ...command, ids })}
                />
              </div>
            )}
            {command.kind === 'powershell' && (
              <>
                <div className="code-editor-header">
                  <span>
                    <Terminal size={14} /> Windows PowerShell
                  </span>
                  <span className="code-editor-meta">
                    LocalSystem · Noninteractive ·
                    <label className="inline-timeout">
                      Timeout
                      <select
                        aria-label="Command timeout"
                        value={command.timeoutMinutes ?? 15}
                        onChange={(e) =>
                          setCommand({ ...command, timeoutMinutes: Number(e.target.value) })
                        }
                      >
                        {[5, 15, 30, 60, 120, 240].map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
                          </option>
                        ))}
                      </select>
                    </label>
                  </span>
                </div>
                <textarea
                  className="code-editor"
                  aria-label="PowerShell script"
                  spellCheck={false}
                  required
                  value={command.script}
                  onChange={(e) => setCommand({ ...command, script: e.target.value })}
                  placeholder={'# Enter PowerShell commands\nGet-ComputerInfo | Format-List *'}
                />
                <div className="info-note compact">
                  <Terminal size={15} />
                  <p>
                    Each job runs in a fresh process. Complete stdout/stderr is retained, paginated,
                    and downloadable. Prefer <code>Format-List *</code> or{' '}
                    <code>ConvertTo-Json -Depth 10</code> over truncated tables.
                  </p>
                </div>
              </>
            )}
            {command.kind === 'reboot' && (
              <div className="confirmation-block">
                <span className="confirmation-icon">
                  <Power size={24} />
                </span>
                <h3>Restart selected endpoints?</h3>
                <p>
                  The agent schedules a 30-second Windows restart. This job executes at most once
                  and is never replayed after reboot or restore rollback.
                </p>
                <div className="target-chips">
                  {command.ids.map((id) => (
                    <span key={id}>
                      {endpointDisplayName(endpoints.find((ep) => ep.id === id))}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {command.kind === 'storage' && (
              <>
                <label className="field">
                  Directory path
                  <input
                    required
                    value={command.path}
                    onChange={(e) => setCommand({ ...command, path: e.target.value })}
                    placeholder="C:\"
                  />
                </label>
                <div className="info-note compact">
                  <FolderSearch size={16} />
                  <p>
                    Read-only scan reporting child entries and bounded recursive folder sizes.
                    Protected folders may report partial totals.
                  </p>
                </div>
              </>
            )}
            <div className="modal-footer">
              <span>
                <ShieldCheck size={14} /> At-most-once execution per endpoint
              </span>
              <div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setCommand(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !command.ids.length}
                  className={`button ${command.kind === 'reboot' ? 'danger' : 'primary'}`}
                >
                  {busy ? (
                    <Loader2 size={15} className="spin" />
                  ) : command.kind === 'reboot' ? (
                    <Power size={15} />
                  ) : (
                    <Play size={15} />
                  )}
                  {command.kind === 'reboot'
                    ? 'Confirm reboot'
                    : command.kind === 'storage'
                      ? 'Start scan'
                      : command.ids.length > 1
                        ? `Run on ${command.ids.length} endpoints`
                        : 'Run script'}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {scriptForm && (
        <Modal
          title={scriptForm.id ? 'Edit script' : 'Create script'}
          subtitle="Save a reusable PowerShell routine to your library."
          wide
          onClose={() => setScriptForm(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  `/scripts${scriptForm.id ? `/${scriptForm.id}` : ''}`,
                  scriptForm.id ? 'PUT' : 'POST',
                  {
                    name: scriptForm.name,
                    description: scriptForm.description,
                    body: scriptForm.body,
                  },
                );
                setScriptForm(null);
                await refresh();
                notify('Script saved to library.');
              } catch (err) {
                fail(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="form-grid">
              <label>
                Script name
                <input
                  required
                  maxLength={200}
                  value={scriptForm.name || ''}
                  onChange={(e) => setScriptForm({ ...scriptForm, name: e.target.value })}
                  placeholder="e.g. Disk cleanup & TRIM"
                />
              </label>
              <label>
                Description
                <input
                  maxLength={2000}
                  value={scriptForm.description || ''}
                  onChange={(e) =>
                    setScriptForm({ ...scriptForm, description: e.target.value })
                  }
                  placeholder="Optional summary for operators"
                />
              </label>
            </div>
            <div className="code-editor-header">
              <span>
                <Code2 size={14} /> PowerShell script
              </span>
              <span>Library script</span>
            </div>
            <textarea
              className="code-editor"
              aria-label="Script body"
              required
              spellCheck={false}
              value={scriptForm.body || ''}
              onChange={(e) => setScriptForm({ ...scriptForm, body: e.target.value })}
              placeholder="# Your PowerShell script"
            />
            <div className="modal-footer">
              {scriptForm.id ? (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={() =>
                    setConfirmDialog({
                      title: `Delete script “${scriptForm.name || 'Untitled'}”?`,
                      description:
                        'Deleting this script removes it from the library. Past jobs and output remain intact.',
                      confirmLabel: 'Delete script',
                      tone: 'danger',
                      onConfirm: async () => {
                        await api(`/scripts/${scriptForm.id}`, 'DELETE');
                        setScriptForm(null);
                        await refresh();
                        notify('Script deleted.');
                      },
                    })
                  }
                >
                  <Trash2 size={14} /> Delete script
                </button>
              ) : (
                <span />
              )}
              <div>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setScriptForm(null)}
                >
                  Cancel
                </button>
                <button type="submit" className="button primary" disabled={busy}>
                  {busy ? <Loader2 size={15} className="spin" /> : <Check size={15} />}
                  Save script
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {scheduleForm && (
        <Modal
          title="Create schedule"
          subtitle="Run a saved script on a fixed interval."
          onClose={() => setScheduleForm(false)}
        >
          <ScheduleForm
            scripts={scripts}
            endpoints={active}
            busy={busy}
            onCancel={() => setScheduleForm(false)}
            onSave={async (values) => {
              setBusy(true);
              try {
                await api('/schedules', 'POST', values);
                setScheduleForm(false);
                await refresh();
                notify('Schedule created.');
              } catch (err) {
                fail(err);
              } finally {
                setBusy(false);
              }
            }}
          />
        </Modal>
      )}

      {tokenForm && (
        <Modal
          title={newToken ? 'Enrollment token created' : 'Create enrollment token'}
          subtitle={
            newToken
              ? 'Copy this token now — the secret is only shown once.'
              : 'Allow unattended agent installs to bypass manual approval.'
          }
          onClose={() => {
            setTokenForm(false);
            setNewToken(null);
          }}
        >
          {newToken ? (
            <>
              <div className="token-secret">
                <code>{newToken}</code>
                <button
                  type="button"
                  className="button secondary small"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(newToken)
                      .then(() => notify('Enrollment token copied.'))
                      .catch(() => notify('Select the token and copy it manually.'));
                  }}
                >
                  <Copy size={14} /> Copy
                </button>
              </div>
              <div className="info-note compact">
                <ShieldCheck size={16} />
                <p>
                  Pass with <code>-EnrollmentToken</code> during automated deployment. Never check
                  tokens into source control.
                </p>
              </div>
              <div className="modal-footer">
                <span />
                <button
                  type="button"
                  className="button primary"
                  onClick={() => {
                    setTokenForm(false);
                    setNewToken(null);
                  }}
                >
                  <Check size={15} /> Done
                </button>
              </div>
            </>
          ) : (
            <TokenForm
              busy={busy}
              onCancel={() => setTokenForm(false)}
              onSave={async (values) => {
                setBusy(true);
                try {
                  const result = await api<{ token: string }>(
                    '/enrollment-tokens',
                    'POST',
                    values,
                  );
                  setNewToken(result.token);
                  setTokens(await api('/enrollment-tokens'));
                } catch (err) {
                  fail(err);
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </Modal>
      )}

      {terminalEndpoint && (
        <TerminalConsole
          endpoint={terminalEndpoint}
          request={api}
          onClose={() => setTerminalEndpoint(null)}
          onError={fail}
        />
      )}

      {explorer && (
        <Modal
          title={`Files · ${endpointDisplayName(explorer)}`}
          subtitle="Each file operation dispatches an audited job. Deletes are permanent."
          wide
          onClose={() => setExplorer(null)}
        >
          <FileExplorer
            endpoint={{
              id: explorer.id,
              name: endpointDisplayName(explorer),
              online: endpoints.find((ep) => ep.id === explorer.id)?.online ?? explorer.online,
            }}
            request={api}
            canWrite={canAct}
          />
        </Modal>
      )}

      <CommandPalette items={paletteItems} onSelect={choosePaletteItem} />

      {starterOpen && (
        <Modal
          title="Starter scripts"
          subtitle="Prebuilt routines for common library maintenance. Add to library or run directly."
          wide
          onClose={() => setStarterOpen(false)}
        >
          <StarterScripts
            existingNames={scripts.map((script) => script.name)}
            canEdit={canAct}
            onAdd={async (template) => {
              try {
                await api('/scripts', 'POST', {
                  name: template.name,
                  description: template.description,
                  body: template.body,
                });
                notify(`"${template.name}" added to script library.`);
                await refresh();
              } catch (err) {
                fail(err);
                throw err;
              }
            }}
            onRun={(template) => {
              setStarterOpen(false);
              setCommand({
                kind: 'powershell',
                ids: selected,
                script: template.body,
                path: 'C:\\',
                chooseEndpoints: true,
                timeoutMinutes: template.id === 'system-repair' ? 120 : 15,
              });
            }}
          />
        </Modal>
      )}

      {bulkUpdate && canAct && (
        <Modal
          title="Update Windows agents"
          subtitle={`${bulkUpdate.length} selected endpoint${bulkUpdate.length === 1 ? '' : 's'}`}
          wide
          onClose={() => setBulkUpdate(null)}
        >
          <BulkAgentUpdate
            endpoints={active.filter((ep) => bulkUpdate.includes(ep.id))}
            jobs={jobs}
            request={api}
            onQueued={() => {
              setSelected([]);
              void refresh();
            }}
            onOpenResults={(queued) => {
              setBulkUpdate(null);
              if (queued.length === 1) {
                const job = jobs.find((row) => row.id === queued[0].id);
                setJobDetail(job ?? (queued[0] as Job));
              } else {
                setBatch(queued as Job[]);
              }
            }}
            onClose={() => setBulkUpdate(null)}
          />
        </Modal>
      )}

      {batch && (
        <Modal
          title={`Batch results · ${batch.length} endpoints`}
          subtitle="Side-by-side job output. Each job runs at most once."
          wide
          onClose={() => setBatch(null)}
        >
          <BatchResults
            jobs={batch}
            nameOf={(id) => endpointDisplayName(endpoints.find((ep) => ep.id === id))}
            request={api}
            onOpen={(job) => setJobDetail(job as Job)}
          />
        </Modal>
      )}

      {jobDetail && (
        <JobOutput
          key={jobDetail.id}
          job={jobDetail}
          endpoint={endpoints.find((ep) => ep.id === jobDetail.endpointId)}
          onClose={() => setJobDetail(null)}
          onError={fail}
          onChanged={() => void refresh()}
          onExploreStorage={(path) => {
            setCommand({
              kind: 'storage',
              ids: [jobDetail.endpointId],
              script: '',
              path,
            });
            setJobDetail(null);
          }}
        />
      )}

      <ConfirmDialog dialog={confirmDialog} onClose={() => setConfirmDialog(null)} />
    </div>
  );
}

function TokenForm({
  busy,
  onCancel,
  onSave,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (values: unknown) => void;
}) {
  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState(1);
  const [hours, setHours] = useState(24);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ label, maxUses, expiresInHours: hours });
      }}
    >
      <label className="field">
        Label
        <input
          required
          maxLength={200}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Cody public kiosks"
        />
      </label>
      <div className="form-grid">
        <label>
          Maximum installations
          <input
            type="number"
            min={1}
            max={10000}
            required
            value={maxUses}
            onChange={(e) => setMaxUses(Number(e.target.value))}
          />
        </label>
        <label>
          Expires in (hours)
          <input
            type="number"
            min={1}
            max={720}
            required
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="modal-footer">
        <span />
        <div>
          <button className="button secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            <Plus size={15} /> Create token
          </button>
        </div>
      </div>
    </form>
  );
}

function ScheduleForm({
  scripts,
  endpoints,
  busy,
  onSave,
  onCancel,
}: {
  scripts: Script[];
  endpoints: Endpoint[];
  busy: boolean;
  onSave: (values: unknown) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [scriptId, setScriptId] = useState(scripts[0]?.id || '');
  const [ids, setIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(1440);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name,
          scriptId,
          endpointIds: ids,
          intervalMinutes: minutes,
          enabled: true,
        });
      }}
    >
      <label className="field">
        Schedule name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          placeholder="e.g. Nightly disk & update audit"
        />
      </label>
      <label className="field">
        Saved script
        <select
          value={scriptId}
          onChange={(e) => setScriptId(e.target.value)}
          required
        >
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Interval (minutes)
        <input
          type="number"
          min={5}
          max={525600}
          required
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <fieldset className="endpoint-picker-field">
        <legend>
          Target endpoints <span className="tabular">{ids.length} selected</span>
        </legend>
        <div className="endpoint-picker-scroll">
          {endpoints.map((ep) => (
            <label key={ep.id} className="schedule-ep-row">
              <input
                type="checkbox"
                checked={ids.includes(ep.id)}
                onChange={() =>
                  setIds(
                    ids.includes(ep.id)
                      ? ids.filter((id) => id !== ep.id)
                      : [...ids, ep.id],
                  )
                }
              />
              <span>{endpointDisplayName(ep)}</span>
              <StatusBadge status={ep.online ? 'online' : 'offline'} />
            </label>
          ))}
        </div>
      </fieldset>
      <div className="modal-footer">
        <span>First execution runs after the first interval elapses.</span>
        <div>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || !ids.length}>
            <CalendarClock size={15} /> Create schedule
          </button>
        </div>
      </div>
    </form>
  );
}

function JobOutput({
  job: initial,
  endpoint,
  onClose,
  onError,
  onChanged,
  onExploreStorage,
}: {
  job: Job;
  endpoint?: Endpoint;
  onClose: () => void;
  onError: (err: unknown) => void;
  onChanged: () => void;
  onExploreStorage: (path: string) => void;
}) {
  const [job, setJob] = useState(initial);
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const cursor = useRef(-1);
  const fetching = useRef(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const progress = useMemo(() => progressOutput(chunks), [chunks]);

  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setLoading(true);
    try {
      const result = await api<{
        chunks: Chunk[];
        nextCursor: number;
        hasMore: boolean;
      }>(`/jobs/${initial.id}/output?after=${cursor.current}&limit=200`);
      if (result.chunks.length) {
        setChunks((old) => [...old, ...result.chunks]);
        cursor.current =
          result.nextCursor ?? result.chunks[result.chunks.length - 1].sequence;
      }
      setHasMore(result.hasMore);
      setJob(await api<Job>(`/jobs/${initial.id}`));
    } catch (err) {
      onError(err);
    } finally {
      fetching.current = false;
      setLoading(false);
    }
  }, [initial.id, onError]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 1500);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (autoFollow && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [chunks, autoFollow]);

  const storage = useMemo<StorageResult | null>(() => {
    if (job.kind !== 'storage' || hasMore || isActiveJob(job) || !chunks.length) return null;
    try {
      const result = JSON.parse(
        chunks
          .filter((chunk) => chunk.stream === 'stdout')
          .map((chunk) => chunk.text)
          .join(''),
      );
      if (typeof result.path !== 'string' || !Array.isArray(result.entries)) return null;
      if (
        result.entries.some(
          (entry: StorageResult['entries'][number]) =>
            typeof entry.name !== 'string' || typeof entry.path !== 'string',
        )
      ) {
        return null;
      }
      return result as StorageResult;
    } catch {
      return null;
    }
  }, [chunks, hasMore, job]);

  const sortedStorage = storage
    ? [...storage.entries].sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
    : [];
  const maxStorageBytes = Math.max(
    1,
    ...sortedStorage.map((entry) => entry.sizeBytes || 0),
  );

  return (
    <Modal
      title={`${titleCaseAction(job.kind)} · ${endpointDisplayName(endpoint)}`}
      subtitle={`Job ${job.id}`}
      wide
      onClose={onClose}
    >
      <div className="output-summary">
        <StatusBadge status={job.status} />
        <span className="tabular">Created {formatTimestamp(job.createdAt)}</span>
        {job.exitCode != null && (
          <span className="tabular">
            Exit code <code>{job.exitCode}</code>
          </span>
        )}
      </div>

      {job.summary && <p className="job-summary">{job.summary}</p>}

      {['dispatched', 'running'].includes(job.status) && (
        <div className="info-note compact">
          <ShieldCheck size={15} />
          <p>
            This job is consumed and executes at most once. Verify endpoint state before creating a
            replacement job.
          </p>
        </div>
      )}

      {storage && (
        <section className="storage-explorer">
          <div className="storage-explorer-heading">
            <span>
              <FolderSearch size={16} />
              <strong className="mono">{storage.path}</strong>
            </span>
            <small className="tabular">
              {storage.scannedEntries?.toLocaleString() ?? storage.entries.length} entries scanned
            </small>
          </div>
          {storage.partial && (
            <p className="storage-partial">
              Partial scan: protected paths or traversal limits may affect totals.
            </p>
          )}
          {!!storage.note && <p className="storage-scan-note">{storage.note}</p>}
          {storage.entries.length ? (
            <div className="table-scroll storage-explorer-table">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Reported size</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStorage.map((entry, index) => (
                    <tr key={`${entry.path}-${index}`}>
                      <td>
                        {entry.isDirectory ? (
                          <button
                            type="button"
                            className="folder-link"
                            disabled={entry.skippedReparsePoint}
                            onClick={() => onExploreStorage(entry.path)}
                          >
                            <Folder size={14} />
                            <span>{entry.name}</span>
                            <ChevronRight size={12} />
                          </button>
                        ) : (
                          <span className="file-name">
                            <File size={14} />
                            {entry.name}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="storage-size tabular">
                          <span>{formatBytes(entry.sizeBytes)}</span>
                          <div className="progress-track">
                            <span
                              style={{
                                width: `${Math.min(100, Math.max(0, ((entry.sizeBytes || 0) / maxStorageBytes) * 100))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="storage-row-note" title={entry.errors?.join('; ')}>
                        {entry.skippedReparsePoint
                          ? 'Reparse point skipped'
                          : entry.partial
                            ? 'Partial'
                            : entry.errors?.length
                              ? `${entry.errors.length} error(s)`
                              : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="storage-scan-note">No child entries reported.</p>
          )}
        </section>
      )}

      <div className="code-editor-header output-header">
        <span>
          <Terminal size={14} /> Process output{' '}
          <span className="chunk-count tabular">{chunks.length} chunks loaded</span>
        </span>
        <label className="follow-toggle">
          <input
            type="checkbox"
            checked={autoFollow}
            onChange={(e) => setAutoFollow(e.target.checked)}
          />
          Follow output
        </label>
      </div>

      <pre className="output-console" ref={outputRef} tabIndex={0}>
        {chunks.length ? (
          progress.display.map((chunk) => (
            <span key={chunk.sequence} className={`output-${chunk.stream}`}>
              {chunk.text}
            </span>
          ))
        ) : (
          <span className="output-placeholder">
            {isActiveJob(job) ? 'Waiting for endpoint output…' : 'This job produced no output.'}
          </span>
        )}
      </pre>

      {progress.percent !== null && (
        <div className="live-job-progress" role="status">
          <span>
            Progress: <strong className="tabular">{progress.percent}%</strong>
          </span>
          <progress max={100} value={progress.percent} aria-label="Job progress" />
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          className="button secondary load-more"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowDownToLine size={15} /> Load next page of output
        </button>
      )}

      <div className="output-footer">
        <span>
          {hasMore
            ? 'More output is available on the server.'
            : 'Complete server output loaded (no truncation).'}
        </span>
        <span>
          {loading && <Loader2 size={12} className="spin" />} Live polling active
        </span>
      </div>

      <div className="modal-footer">
        <div>
          {job.status === 'queued' && (
            <button
              type="button"
              className="text-button danger-text"
              onClick={async () => {
                try {
                  await api(`/jobs/${job.id}/cancel`, 'POST', {});
                  await load();
                  onChanged();
                } catch (err) {
                  onError(err);
                }
              }}
            >
              <X size={14} /> Cancel queued job
            </button>
          )}
        </div>
        <div>
          <a className="button secondary" href={`/api/jobs/${job.id}/download`} download>
            <Download size={15} /> Download full output
          </a>
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

createRoot(document.getElementById('root')!).render(
  window.location.pathname.startsWith('/support/') ? <RemoteSupport /> : <App />,
);
