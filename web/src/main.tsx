import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/dm-sans";
import "@fontsource-variable/manrope";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Download,
  File,
  Folder,
  FolderSearch,
  HardDrive,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  Monitor,
  Pause,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2,
  Users,
  Wifi,
  X,
  XCircle,
  Package,
  Sparkles,
} from "lucide-react";
import "./styles.css";
import {EndpointGroups,type EndpointGroup} from './EndpointGroups';
import { AccountSettings, type AccountUser } from './AccountSettings';
import { progressOutput } from './progress';
import { JoinRequests, type JoinRequest } from './JoinRequests';
import { EndpointPicker } from './EndpointPicker';
import { BatchResults } from './BatchResults';
import { FileExplorer } from './FileExplorer';
import { RemoteSupport, openRemoteSupport } from './RemoteSupport';
import { SupportSettings } from './SupportSettings';
import { EndpointDirectory } from './EndpointDirectory';
import { TerminalConsole } from './TerminalConsole';
import { SoftwareInventory } from './SoftwareInventory';
import { StarterScripts } from './StarterScripts';
import { filterActivity, isBrowsingJob } from './activityFilter';
import { CommandPalette } from './CommandPalette';
import { FleetHealth } from './FleetHealth';
import { AgentUpdateHealth, AgentUpdateDetails } from './AgentUpdateHealth';
import type { AgentUpdateStatus } from './agentUpdateHealthModel';
import { scriptTemplates } from './scriptTemplates';
import type { PaletteItem } from './commandPaletteModel';

type Disk = {
  name: string;
  label?: string;
  totalBytes: number;
  freeBytes: number;
};
type Software = {
  name: string;
  version?: string;
  publisher?: string;
  installDate?: string;
};
type Inventory = {
  hostname?: string;
  osName?: string;
  osVersion?: string;
  architecture?: string;
  domain?: string;
  domainJoined?: boolean;
  ipv4?: string[];
  loggedOnUser?: string;
  bootTime?: string;
  cpuPercent?: number;
  memoryTotalBytes?: number;
  memoryUsedBytes?: number;
  agentVersion?: string;
  disks?: Disk[];
  software?: Software[];
  pendingReboot?: boolean | null;
  pendingRebootReasons?: string[];
  uptimeSeconds?: number | null;
  directory?: { canonicalName?: string | null; organizationalUnits?: string[] } | null;
};
type Endpoint = {
  updateStatus?: AgentUpdateStatus | null;
  groupId?: string;
  groupName?: string;
  id: string;
  hostname: string;
  displayName?: string;
  lastSeen: string;
  online: boolean;
  revoked?: boolean;
  tags?: string[];
  inventory?: Inventory;
};
type Job = {
  id: string;
  endpointId: string;
  kind: string;
  payload?: Record<string, unknown>;
  status: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  summary?: string;
  exitCode?: number;
};
type Script = {
  id: string;
  name: string;
  description: string;
  body: string;
  updatedAt: string;
};
type Schedule = {
  id: string;
  name: string;
  scriptId: string;
  endpointIds: string[];
  intervalMinutes: number;
  nextRunAt: string;
  enabled: boolean;
};
type Audit = {
  id: string;
  action: string;
  actor?: string;
  createdAt: string;
  details?: unknown;
  targetId?: string;
};
type User = AccountUser;
type View =
  | "overview"
  | "endpoints"
  | "software"
  | "scripts"
  | "schedules"
  | "activity"
  | "enrollment"
  | "audit"
  | "settings";
type Chunk = { sequence: number; stream: string; text: string };
type StorageResult = {
  path: string;
  partial?: boolean;
  scannedEntries?: number;
  note?: string;
  errors?: string[];
  entries: {
    name: string;
    path: string;
    isDirectory: boolean;
    sizeBytes?: number;
    skippedReparsePoint?: boolean;
    partial?: boolean;
    errors?: string[];
  }[];
};
// Session secrets stay in HttpOnly cookies. Only the CSRF nonce is kept in memory.
let csrfToken = "";

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch {
      /* Keep HTTP error for non-JSON proxy responses. */
    }
    if (response.status === 401 && path !== "/auth/login")
      window.dispatchEvent(new Event("session-expired"));
    throw new Error(message);
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
const bytes = (n?: number) =>
  n == null
    ? "—"
    : n >= 1099511627776
      ? `${(n / 1099511627776).toFixed(1)} TB`
      : n >= 1073741824
        ? `${(n / 1073741824).toFixed(1)} GB`
        : n >= 1048576
          ? `${(n / 1048576).toFixed(1)} MB`
          : `${n.toLocaleString()} B`;
const when = (value?: string) =>
  value ? new Date(value).toLocaleString() : "—";
const ago = (value?: string) => {
  if (!value) return "Never";
  const diff = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return diff < 60
    ? "Just now"
    : diff < 3600
      ? `${Math.floor(diff / 60)}m ago`
      : diff < 86400
        ? `${Math.floor(diff / 3600)}h ago`
        : `${Math.floor(diff / 86400)}d ago`;
};
const titleCase = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const endpointName = (ep?: Endpoint) =>
  ep?.displayName || ep?.hostname || "Unknown endpoint";
const usedPercent = (disk: Disk) =>
  disk.totalBytes > 0
    ? Math.min(
        100,
        Math.max(
          0,
          ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100,
        ),
      )
    : 0;
const getDisk = (ep: Endpoint) =>
  ep.inventory?.disks?.find((d) => d.name.startsWith("C")) ||
  ep.inventory?.disks?.[0];
const isActiveJob = (job: Job) =>
  ["queued", "dispatched", "running"].includes(job.status);

function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? "brand-small" : ""}`}>
      <span className="brand-mark">
        <BookOpen size={23} strokeWidth={1.7} />
      </span>
      <div>
        <strong>
          library<span className="brand-dot">.</span>
        </strong>
        <span>ENDPOINT CONSOLE</span>
      </div>
    </div>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span />
      {titleCase(status)}
    </span>
  );
}
function Empty({
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
        <Icon size={29} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const first = container.current?.querySelector<HTMLElement>(
      "input,textarea,select,button",
    );
    first?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]",
          ) || [],
        );
        const firstEl = elements[0],
          lastEl = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === firstEl) {
          event.preventDefault();
          lastEl?.focus();
        } else if (!event.shiftKey && document.activeElement === lastEl) {
          event.preventDefault();
          firstEl?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={container}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", "POST", { username, password });
      const session = await api<{ user: User; csrfToken: string }>("/auth/me");
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
          <span className="eyebrow">PARK COUNTY LIBRARY</span>
          <h1>
            Your fleet.
            <br />
            In clear view.
          </h1>
          <p>
            One calm workspace for keeping every computer ready for the people
            who count on it.
          </p>
          <div className="login-feature">
            <ShieldCheck size={19} />
            <span>Secure management. Deliberate actions.</span>
          </div>
        </div>
        <div className="login-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-orbit orbit-three" />
          <span className="art-node node-one">
            <Monitor />
          </span>
          <span className="art-node node-two">
            <HardDrive />
          </span>
          <span className="art-node node-three">
            <Terminal />
          </span>
          <span className="art-center">
            <BookOpen size={37} />
          </span>
        </div>
        <div className="login-footer">
          Built for the way your library works.
        </div>
      </div>
      <div className="login-form-side">
        <div className="login-form">
          <span className="section-label">LIBRARY OPERATIONS</span>
          <h2>Welcome back</h2>
          <p>Sign in to your endpoint workspace.</p>
          <form onSubmit={submit}>
            <label>
              Username
              <input
                autoFocus
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                placeholder="Your administrator username"
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
                placeholder="Enter your password"
              />
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary login-submit" disabled={busy}>
              {busy ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <>
                  Sign in <ArrowRight size={17} />
                </>
              )}
            </button>
          </form>
          <div className="login-security">
            <ShieldCheck size={16} />
            <span>
              Authorized library administrators only.
              <br />
              Your actions are recorded in the audit log.
            </span>
          </div>
        </div>
        <span className="login-version">
          LIBRARY RMM <span>·</span> ENDPOINT OPERATIONS
        </span>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null),
    [authLoading, setAuthLoading] = useState(true),
    [view, setView] = useState<View>("overview");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [scripts, setScripts] = useState<Script[]>([]),
    [schedules, setSchedules] = useState<Schedule[]>([]),
    [audit, setAudit] = useState<Audit[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({}),
    [updateStatus, setUpdateStatus] = useState<Record<string, unknown> | null>(
      null,
    ),
    [tokens, setTokens] = useState<Record<string, unknown>[]>([]),
    [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [groups,setGroups]=useState<EndpointGroup[]>([]),[groupFilter,setGroupFilter]=useState('all');
  const [runs,setRuns]=useState<{id:string;name:string;createdAt:string;endpointCount:number;counts:Record<string,number>}[]>([]);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState<string[]>([]),
    [mobileNav, setMobileNav] = useState(false),
    [lastRefresh, setLastRefresh] = useState<string>();
  const [detail, setDetail] = useState<Endpoint | null>(null),
    [detailTab, setDetailTab] = useState<"overview" | "software">("overview"),
    [softwareSearch, setSoftwareSearch] = useState("");
  const [jobDetail, setJobDetail] = useState<Job | null>(null),
    [batch, setBatch] = useState<Job[] | null>(null),
    [explorer, setExplorer] = useState<Endpoint | null>(null),
    [terminalEndpoint, setTerminalEndpoint] = useState<Endpoint | null>(null),
    [command, setCommand] = useState<{
      ids: string[];
      kind: string;
      script: string;
      path: string;
      chooseEndpoints?: boolean;
      timeoutMinutes?: number;
    } | null>(null),
    [starterOpen, setStarterOpen] = useState(false),
    [activitySearch, setActivitySearch] = useState(""),
    [activityKind, setActivityKind] = useState("all"),
    [showBrowsing, setShowBrowsing] = useState(false),
    [scriptForm, setScriptForm] = useState<Partial<Script> | null>(null),
    [scheduleForm, setScheduleForm] = useState(false),
    [tokenForm, setTokenForm] = useState(false),
    [newToken, setNewToken] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 5000);
  };
  const fail = (err: unknown) =>
    setError(err instanceof Error ? err.message : String(err));
  const changeView = (next: View) => {
    setView(next);
    setSearch("");
    setFilter("all");
    setMobileNav(false);
  };
  useEffect(() => {
    api<{ user: User; csrfToken: string }>("/auth/me")
      .then((s) => {
        csrfToken = s.csrfToken;
        setUser(s.user);
      })
      .catch(() => {})
      .finally(() => setAuthLoading(false));
    const expired = () => {
      setUser(null);
      csrfToken = "";
    };
    window.addEventListener("session-expired", expired);
    return () => window.removeEventListener("session-expired", expired);
  }, []);
  const refresh = async (showLoading = false) => {
    if (!user) return;
    if (showLoading) setLoading(true);
    try {
      const [eps, js, ss, sc] = await Promise.all([
        api<Endpoint[]>("/endpoints"),
        api<Job[]>("/jobs"),
        api<Script[]>("/scripts"),
        api<Schedule[]>("/schedules"),
      ]);
      setEndpoints(eps);
      setJobs(js);
      setScripts(ss);
      setSchedules(sc);
      setGroups(await api<EndpointGroup[]>('/groups'));
      setRuns(await api('/runs'));
      // Polled with everything else so the "Add endpoints" badge shows waiting computers.
      api<JoinRequest[]>("/join-requests").then(setJoinRequests).catch(() => {});
      setLastRefresh(new Date().toISOString());
    } catch (err) {
      fail(err);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (!user) return;
    void refresh(true);
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [user]);
  useEffect(() => {
    if (!user) return;
    if (view === "audit")
      api<Audit[]>("/audit?limit=100").then(setAudit).catch(fail);
    if (view === "settings") {
      api<Record<string, unknown>>("/settings").then(setSettings).catch(fail);
      api<Record<string, unknown>>("/settings/update")
        .then(setUpdateStatus)
        .catch(() => setUpdateStatus(null));
    }
    if (view === "enrollment")
      api<Record<string, unknown>[]>("/enrollment-tokens")
        .then(setTokens)
        .catch(fail);
  }, [view, user]);
  useEffect(() => {
    if (!user || view !== "settings" || !settings.updateEnabled) return;
    // The host helper survives an app restart. Brief disconnects are expected here.
    const timer = window.setInterval(() => {
      api<Record<string, unknown>>("/settings/update")
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
  }, [endpoints]);
  // Activity list: folder listings hidden unless requested, plus status/type/text filters.
  const activityJobs = filterActivity(
    jobs,
    { status: filter, kind: activityKind, query: activitySearch, showBrowsing },
    (job) => endpointName(endpoints.find((ep) => ep.id === job.endpointId)),
  );
  const active = endpoints.filter((ep) => !ep.revoked),
    online = active.filter((ep) => ep.online),
    offline = active.length - online.length,
    lowDisk = active.filter((ep) =>
      ep.inventory?.disks?.some((d) => usedPercent(d) >= 85),
    );
  const filtered = active
    .filter(ep=>view!=='endpoints'||groupFilter==='all'||ep.groupId===groupFilter)
    .filter((ep) =>
      // Every word must match somewhere: name, IP, domain, tags, user, OS or AD OU path.
      search
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every((word) =>
          `${endpointName(ep)} ${ep.hostname} ${ep.inventory?.ipv4?.join(" ")} ${ep.inventory?.domain} ${ep.tags?.join(" ")} ${ep.inventory?.loggedOnUser ?? ""} ${ep.inventory?.osName ?? ""} ${ep.inventory?.directory?.canonicalName ?? ""} ${ep.groupName ?? ""}`
            .toLowerCase()
            .includes(word),
        ),
    )
    .filter(
      (ep) =>
        filter === "all" ||
        (filter === "online" && ep.online) ||
        (filter === "offline" && !ep.online) ||
        (filter === "attention" &&
          ep.inventory?.disks?.some((d) => usedPercent(d) >= 85)) ||
        (filter === "reboot" && ep.inventory?.pendingReboot === true),
    );
  const toggleSelected = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((e) => selected.includes(e.id));
  const queueJobs = async (
    ids: string[],
    kind: string,
    payload: Record<string, unknown>,
    timeoutSeconds?: number,
  ) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ jobs: Job[] }>("/jobs", "POST", {
        endpointIds: ids,
        kind,
        payload,
        timeoutSeconds: timeoutSeconds ?? (kind === "storage" ? 900 : 300),
        idempotencyKey: crypto.randomUUID(),
        runName: `${(()=>{const names=[...new Set(active.filter(ep=>ids.includes(ep.id)).map(ep=>ep.groupName||'New endpoints'))];return names.length===1?names[0]:'Selected endpoints';})()} · ${kind}`,
      });
      notify(
        `${result.jobs.length} ${result.jobs.length === 1 ? "job" : "jobs"} queued. Each job can execute only once.`,
      );
      setCommand(null);
      await refresh();
      if (result.jobs.length === 1) setJobDetail(result.jobs[0]);
      // Several computers: show every result live side by side.
      else setBatch(result.jobs);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const openCommand = (kind: string, ids = selected, body = "") => {
    if (!ids.length) {
      notify("Select at least one endpoint first.");
      return;
    }
    setCommand({ kind, ids, script: body, path: "C:\\" });
  };
  const nav: {
    key: View;
    label: string;
    icon: typeof Monitor;
    count?: number;
  }[] = [
    { key: "overview", label: "Overview", icon: LayoutDashboard },
    {
      key: "endpoints",
      label: "Endpoints",
      icon: Monitor,
      count: active.length,
    },
    { key: "software", label: "Software", icon: Package },
    { key: "scripts", label: "Script library", icon: Code2 },
    { key: "schedules", label: "Schedules", icon: CalendarClock },
    { key: "activity", label: "Activity", icon: Activity },
  ];
  const pageInfo: Record<View, { title: string; subtitle: string }> = {
    overview: {
      title: "Fleet overview",
      subtitle: "A clear picture of your library’s computers.",
    },
    endpoints: {
      title: "Endpoints",
      subtitle: "Every computer, one place to keep it running.",
    },
    software: {
      title: "Software",
      subtitle: "Every installed program across the fleet, by version.",
    },
    scripts: {
      title: "Script library",
      subtitle: "Your reliable routines, ready when you need them.",
    },
    schedules: {
      title: "Schedules",
      subtitle: "Thoughtful automation. Every occurrence tracked.",
    },
    activity: {
      title: "Activity",
      subtitle: "Every command and its complete response.",
    },
    enrollment: {
      title: "Add endpoints",
      subtitle: "Connect Windows computers securely to your workspace.",
    },
    audit: {
      title: "Audit log",
      subtitle: "A clear record of administrative actions.",
    },
    settings: {
      title: "Workspace settings",
      subtitle: "Application details and controlled updates.",
    },
  };
  // Ctrl+K quick search: every page, every active computer and the most common actions.
  const paletteItems: PaletteItem[] = [
    ...(Object.keys(pageInfo) as View[]).map((key) => ({
      id: "page:" + key,
      kind: "page" as const,
      title: pageInfo[key].title,
      detail: pageInfo[key].subtitle,
    })),
    ...active.map((ep) => ({
      id: "computer:" + ep.id,
      kind: "computer" as const,
      title: endpointName(ep),
      detail: [
        ep.online ? "Online" : "Offline",
        ep.inventory?.ipv4?.join(", "),
        ep.inventory?.loggedOnUser,
        ep.groupName,
      ]
        .filter(Boolean)
        .join(" · "),
      keywords: [ep.hostname, ep.inventory?.osName, ep.inventory?.directory?.canonicalName, ep.tags?.join(" ")]
        .filter(Boolean)
        .join(" "),
    })),
    ...(user?.role !== "viewer"
      ? [
          { id: "action:powershell", kind: "action" as const, title: "Run PowerShell on computers", keywords: "script command run" },
          { id: "action:starter", kind: "action" as const, title: "Browse starter scripts", keywords: "templates cleanup update printer bitlocker" },
          { id: "action:add", kind: "action" as const, title: "Add a computer", keywords: "install enroll agent approve" },
        ]
      : []),
  ];
  const choosePaletteItem = (item: PaletteItem) => {
    if (item.id.startsWith("page:")) changeView(item.id.slice(5) as View);
    else if (item.id.startsWith("computer:")) {
      const ep = endpoints.find((entry) => entry.id === item.id.slice(9));
      if (ep) setDetail(ep);
    } else if (item.id === "action:powershell")
      setCommand({ kind: "powershell", ids: selected, script: "", path: "C:\\", chooseEndpoints: true });
    else if (item.id === "action:starter") { changeView("scripts"); setStarterOpen(true); }
    else if (item.id === "action:add") changeView("enrollment");
  };
  const renderEndpointTable = (compact = false) => (
    <div className="table-scroll">
      <table className="endpoint-table">
        <thead>
          <tr>
            <th className="check-cell">
              <input
                aria-label="Select all visible endpoints"
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() =>
                  setSelected(
                    allVisibleSelected
                      ? selected.filter(
                          (id) => !filtered.some((e) => e.id === id),
                        )
                      : [
                          ...new Set([
                            ...selected,
                            ...filtered.map((e) => e.id),
                          ]),
                        ],
                  )
                }
              />
            </th>
            <th>ENDPOINT</th>
            <th>STATUS</th>
            <th>IP ADDRESS</th>
            {!compact && <th>DOMAIN</th>}
            <th>DISK USAGE</th>
            <th>LAST SEEN</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {filtered.slice(0, compact ? 6 : filtered.length).map((ep) => {
            const disk = getDisk(ep);
            return (
              <tr
                key={ep.id}
                className={selected.includes(ep.id) ? "selected-row" : ""}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${endpointName(ep)}`}
                    checked={selected.includes(ep.id)}
                    onChange={() => toggleSelected(ep.id)}
                  />
                </td>
                <td>
                  <button
                    className="endpoint-link"
                    onClick={() => {
                      setDetail(ep);
                      setDetailTab("overview");
                    }}
                  >
                    <span className="computer-icon">
                      <Monitor size={19} />
                    </span>
                    <span>
                      <strong>{endpointName(ep)}</strong>
                      <small>
                        {ep.inventory?.osName || "Windows · Awaiting inventory"}
                        {!compact && <span className="endpoint-group-label"> · {ep.groupName||'New endpoints'}</span>}
                      </small>
                    </span>
                  </button>
                </td>
                <td>
                  <Status status={ep.online ? "online" : "offline"} />
                  {ep.inventory?.pendingReboot === true && (
                    <span
                      className="reboot-badge"
                      title={(ep.inventory.pendingRebootReasons || []).join("\n") || "Windows reports a pending restart"}
                    >
                      Reboot pending
                    </span>
                  )}
                </td>
                <td className="mono muted">{ep.inventory?.ipv4?.[0] || "—"}</td>
                {!compact && (
                  <td>
                    {ep.inventory?.domainJoined ? (
                      <span className="domain-label">
                        <ShieldCheck size={13} />
                        {ep.inventory.domain}
                      </span>
                    ) : (
                      <span className="muted">Workgroup</span>
                    )}
                  </td>
                )}
                <td>
                  {disk ? (
                    <div className="table-disk">
                      <div>
                        <span>{Math.round(usedPercent(disk))}%</span>
                        <small>
                          {bytes(disk.totalBytes - disk.freeBytes)} /{" "}
                          {bytes(disk.totalBytes)}
                        </small>
                      </div>
                      <div className="progress-track">
                        <span
                          className={usedPercent(disk) >= 85 ? "warning" : ""}
                          style={{ width: `${usedPercent(disk)}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="muted">Awaiting inventory</span>
                  )}
                </td>
                <td className="muted nowrap">{ago(ep.lastSeen)}</td>
                <td>
                  <button
                    className="icon-button"
                    title="Open endpoint"
                    aria-label={`Open ${endpointName(ep)}`}
                    onClick={() => setDetail(ep)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  const renderSelection = () =>
    selected.length > 0 && (
      <div className="selection-toolbar">
        <span>
          <CheckCircle2 size={16} />
          <strong>{selected.length}</strong> selected
        </span>
        <div>
          <button onClick={() => openCommand("powershell")}>
            <Terminal size={15} />
            PowerShell
          </button>
          <button onClick={() => void queueJobs(selected, "inventory", {})}>
            <RefreshCw size={14} />
            Inventory
          </button>
          <button onClick={() => openCommand("reboot")}>
            <Power size={14} />
            Reboot
          </button>
          <button
            className="icon-button"
            aria-label="Clear selection"
            onClick={() => setSelected([])}
          >
            <X size={16} />
          </button>
        </div>
      </div>
    );

  if (authLoading)
    return (
      <div className="app-loading">
        <Brand />
        <Loader2 className="spin" />
        <span>Opening your workspace…</span>
      </div>
    );
  if (!user) return <Login onLogin={setUser} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <Brand />
        <div className="workspace-switch">
          <span className="workspace-avatar">PC</span>
          <div>
            <strong>Park County Library</strong>
            <small>IT workspace</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <span className="nav-section">WORKSPACE</span>
        <nav>
          {nav.map((item) => (
            <button
              key={item.key}
              className={view === item.key ? "nav-item active" : "nav-item"}
              onClick={() => changeView(item.key)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.count !== undefined && (
                <span className="nav-count">{item.count}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-health">
            <span className="live-dot" />
            <span>Server-authoritative execution</span>
            <ShieldCheck size={14} />
          </div>
          <button
            className={`nav-item ${view === "enrollment" ? "active" : ""}`}
            onClick={() => changeView("enrollment")}
          >
            <Plus size={18} />
            <span>Add endpoints</span>
            {joinRequests.some((row) => row.status === "pending") && (
              <span className="nav-count" title="Computers waiting for approval">
                {joinRequests.filter((row) => row.status === "pending").length}
              </span>
            )}
          </button>
          <button
            className={`nav-item ${view === "audit" ? "active" : ""}`}
            onClick={() => changeView("audit")}
          >
            <ShieldCheck size={18} />
            <span>Audit log</span>
          </button>
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => changeView("settings")}
          >
            <Settings2 size={18} />
            <span>Settings</span>
          </button>
          <div className="profile">
            <span className="profile-avatar">
              {user.username.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <strong>{user.username}</strong>
              <small>{titleCase(user.role)}</small>
            </div>
            <button
              aria-label="Sign out"
              title="Sign out"
              className="icon-button"
              onClick={async () => {
                try {
                  await api("/auth/logout", "POST", {});
                  setUser(null);
                  csrfToken = "";
                } catch (err) {
                  fail(err);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <div className="mobile-scrim" onClick={() => setMobileNav(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileNav(!mobileNav)}
              aria-label="Toggle navigation"
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb">
              Workspace <ChevronRight size={13} />{" "}
              <strong>{pageInfo[view].title}</strong>
            </span>
          </div>
          <div className="topbar-right">
            <span className="workspace-location">
              <span /> Park County Library
            </span>
            <span className="topbar-divider" />
            <button
              className="palette-hint"
              title="Quick search (Ctrl+K)"
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
            >
              <Search size={14} /> Search <kbd>Ctrl</kbd>
              <kbd>K</kbd>
            </button>
            <button
              className="icon-button"
              title="Refresh workspace"
              aria-label="Refresh workspace"
              onClick={() => void refresh(true)}
            >
              <RefreshCw size={17} className={loading ? "spin" : ""} />
            </button>
            <span className="topbar-avatar">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow dark">
                LIBRARY OPERATIONS <span>/</span>{" "}
                {new Date()
                  .toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })
                  .toUpperCase()}
              </div>
              <h1>{pageInfo[view].title}</h1>
              <p>{pageInfo[view].subtitle}</p>
            </div>
            <div className="page-actions">
              {view === "scripts" ? (
                <>
                  <button
                    className="button secondary"
                    onClick={() => setStarterOpen(true)}
                  >
                    <Sparkles size={16} />
                    Starter scripts
                  </button>
                  <button
                    className="button primary"
                    onClick={() =>
                      setScriptForm({ name: "", description: "", body: "" })
                    }
                  >
                    <Plus size={16} />
                    New script
                  </button>
                </>
              ) : view === "schedules" ? (
                <button
                  className="button primary"
                  disabled={!scripts.length || !active.length}
                  onClick={() => setScheduleForm(true)}
                >
                  <Plus size={16} />
                  New schedule
                </button>
              ) : view === "enrollment" ? (
                <button
                  className="button primary"
                  onClick={() => {
                    setNewToken(null);
                    setTokenForm(true);
                  }}
                >
                  <Plus size={16} />
                  Create enrollment token
                </button>
              ) : ["overview", "endpoints"].includes(view) ? (
                <>
                  <button
                    className="button secondary"
                    onClick={() => void refresh(true)}
                  >
                    <RefreshCw size={15} className={loading ? "spin" : ""} />
                    Refresh
                  </button>
                  {user.role !== "viewer" && (
                    <button
                      className="button secondary"
                      disabled={!active.length}
                      onClick={() =>
                        setCommand({
                          kind: "powershell",
                          ids: selected,
                          script: "",
                          path: "C:\\",
                          chooseEndpoints: true,
                        })
                      }
                    >
                      <Terminal size={15} />
                      Run PowerShell
                    </button>
                  )}
                  <button
                    className="button primary"
                    onClick={() => changeView("enrollment")}
                  >
                    <Plus size={16} />
                    Add endpoint
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <XCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {view === "overview" && (
            <>
              <div className="overview-banner">
                <div>
                  <span className="banner-kicker">
                    <span className="live-dot" /> YOUR WORKSPACE AT A GLANCE
                  </span>
                  <h2>
                    {active.length
                      ? "Everything you need. Nothing out of view."
                      : "Good things start with a connected fleet."}
                  </h2>
                  <p>
                    {active.length
                      ? `${online.length} of ${active.length} endpoints are online. ${lowDisk.length ? `${lowDisk.length} need a little more disk space.` : "Keep the day moving, from one clear workspace."}`
                      : "Add your first Windows endpoint to see its health, storage, and software here."}
                  </p>
                  <button
                    onClick={() =>
                      active.length
                        ? changeView("endpoints")
                        : changeView("enrollment")
                    }
                  >
                    {active.length
                      ? "Explore your endpoints"
                      : "Connect your first endpoint"}
                    <ArrowRight size={15} />
                  </button>
                </div>
                <div className="banner-graphic" aria-hidden="true">
                  <div className="graphic-ring ring-outer" />
                  <div className="graphic-ring ring-inner" />
                  <span className="graphic-main">
                    <Monitor size={35} strokeWidth={1.4} />
                  </span>
                  <span className="graphic-badge">
                    <Check size={15} />
                  </span>
                  <span className="graphic-small">
                    <ShieldCheck size={18} />
                  </span>
                  <span className="graphic-line" />
                </div>
              </div>
              <div className="stats-grid">
                <Stat
                  label="Total endpoints"
                  value={active.length}
                  icon={Monitor}
                  footer="Your connected Windows fleet"
                />
                <Stat
                  label="Online now"
                  value={online.length}
                  icon={Wifi}
                  accent="green"
                  footer={
                    active.length
                      ? `${Math.round((online.length / active.length) * 100)}% of your fleet is online`
                      : "Ready when agents check in"
                  }
                  percent={
                    active.length ? (online.length / active.length) * 100 : 0
                  }
                />
                <Stat
                  label="Need attention"
                  value={lowDisk.length + offline}
                  icon={Activity}
                  accent="amber"
                  footer={`${lowDisk.length} low storage · ${offline} offline`}
                />
                <Stat
                  label="Active jobs"
                  value={jobs.filter(isActiveJob).length}
                  icon={Terminal}
                  accent="purple"
                  footer={`${jobs.filter((j) => j.status === "succeeded").length} completed successfully`}
                />
              </div>
              <AgentUpdateHealth endpoints={active} request={api} onOpenEndpoint={id=>{const ep=endpoints.find(item=>item.id===id);if(ep)setDetail(ep);}}/>
              <FleetHealth
                endpoints={active}
                request={api}
                canAct={user.role !== "viewer"}
                onOpenEndpoint={(id) => {
                  const ep = endpoints.find((item) => item.id === id);
                  if (ep) setDetail(ep);
                }}
                onReboot={(ids) => openCommand("reboot", ids)}
                onRefreshInventory={(ids) => void queueJobs(ids, "inventory", {})}
                onCleanDisk={(ids) =>
                  setCommand({
                    kind: "powershell",
                    ids,
                    script: scriptTemplates.find((t) => t.id === "clean-temp")?.body ?? "",
                    path: "C:\\",
                    chooseEndpoints: true,
                  })
                }
              />
              <div className="dashboard-grid">
                <section className="panel fleet-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Endpoint health{" "}
                        <span className="count-chip">{active.length}</span>
                      </h2>
                      <p>
                        A quick check on the computers that keep things moving.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => changeView("endpoints")}
                    >
                      View all
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {renderSelection()}
                  {active.length ? (
                    renderEndpointTable(true)
                  ) : (
                    <Empty
                      title="Your fleet starts here"
                      description="Install the Windows agent on a computer. Its inventory and health will appear automatically."
                      action={
                        <button
                          className="button secondary"
                          onClick={() => changeView("enrollment")}
                        >
                          <Plus size={15} />
                          Add your first endpoint
                        </button>
                      }
                    />
                  )}
                  <div className="panel-bottom">
                    <span>
                      <span className="live-dot" /> Refreshes every 10 seconds
                    </span>
                    <span>
                      {lastRefresh
                        ? `Updated ${ago(lastRefresh).toLowerCase()}`
                        : "Waiting for first update"}
                    </span>
                  </div>
                </section>
                <section className="panel storage-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Storage watch</h2>
                      <p>Room to keep working.</p>
                    </div>
                    <HardDrive size={18} />
                  </div>
                  <div className="storage-summary">
                    <span>{active.filter((ep) => getDisk(ep)).length}</span>
                    <div>
                      monitored drives<small>Primary system disks</small>
                    </div>
                  </div>
                  {active.filter((ep) => getDisk(ep)).length ? (
                    <div className="storage-list">
                      {active
                        .filter((ep) => getDisk(ep))
                        .sort(
                          (a, b) =>
                            usedPercent(getDisk(b)!) - usedPercent(getDisk(a)!),
                        )
                        .slice(0, 4)
                        .map((ep) => {
                          const disk = getDisk(ep)!;
                          return (
                            <button
                              className="storage-item"
                              key={ep.id}
                              onClick={() => setDetail(ep)}
                            >
                              <div>
                                <span>{endpointName(ep)}</span>
                                <strong
                                  className={
                                    usedPercent(disk) >= 85 ? "text-amber" : ""
                                  }
                                >
                                  {Math.round(usedPercent(disk))}%
                                </strong>
                              </div>
                              <div className="progress-track">
                                <span
                                  style={{ width: `${usedPercent(disk)}%` }}
                                  className={
                                    usedPercent(disk) >= 85 ? "warning" : ""
                                  }
                                />
                              </div>
                              <small>
                                {bytes(disk.freeBytes)} free of{" "}
                                {bytes(disk.totalBytes)}
                              </small>
                            </button>
                          );
                        })}
                    </div>
                  ) : (
                    <div className="storage-empty">
                      <div className="storage-empty-chart">
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                      <p>Disk insights arrive with your first inventory.</p>
                    </div>
                  )}
                  <div className="storage-legend">
                    <span>
                      <i />
                      Healthy
                    </span>
                    <span>
                      <i />
                      85%+ used
                    </span>
                  </div>
                </section>
              </div>
              <div className="dashboard-lower">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Recent activity</h2>
                      <p>Clear outcomes. Complete output.</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => changeView("activity")}
                    >
                      All activity
                      <ArrowRight size={14} />
                    </button>
                  </div>
                  {jobs.length ? (
                    <div className="activity-list">
                      {jobs.slice(0, 4).map((job) => (
                        <button key={job.id} onClick={() => setJobDetail(job)}>
                          <span
                            className={`activity-icon ${job.status === "succeeded" ? "success" : ""}`}
                          >
                            {job.kind === "reboot" ? (
                              <Power size={17} />
                            ) : (
                              <Terminal size={17} />
                            )}
                          </span>
                          <div>
                            <strong>{titleCase(job.kind)}</strong>
                            <small>
                              {endpointName(
                                endpoints.find(
                                  (ep) => ep.id === job.endpointId,
                                ),
                              )}{" "}
                              · {ago(job.createdAt)}
                            </small>
                          </div>
                          <Status status={job.status} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="quiet-empty">
                      <Activity size={24} />
                      <div>
                        <strong>A fresh start</strong>
                        <p>Your endpoint actions will appear here.</p>
                      </div>
                    </div>
                  )}
                </section>
                <section className="safety-card">
                  <span className="safety-icon">
                    <ShieldCheck size={23} />
                  </span>
                  <span className="section-label">BUILT FOR PEACE OF MIND</span>
                  <h2>
                    One action.
                    <br />
                    One execution.
                  </h2>
                  <p>
                    Jobs are consumed on the server before execution. Endpoint
                    rollbacks cannot automatically replay a reboot or script.
                  </p>
                  <button
                    className="text-button"
                    onClick={() => changeView("activity")}
                  >
                    See job history
                    <ArrowRight size={14} />
                  </button>
                </section>
              </div>
            </>
          )}
          {view === "endpoints" && (
            <>
              <EndpointGroups groups={groups} current={groupFilter} onChange={id=>{setGroupFilter(id);setSelected([]);}} members={active} selected={selected} onSelect={setSelected} request={api} refresh={refresh} onError={fail} readOnly={user.role==='viewer'} onAdd={()=>changeView('enrollment')} onRun={(kind,ids)=>{setSelected(ids);if(kind==='inventory')void queueJobs(ids,kind,{});else openCommand(kind,ids);}}/>
              <div className="inline-stats">
                <span>
                  <i className="status-dot green" />
                  <strong>{online.length}</strong> online
                </span>
                <span>
                  <i className="status-dot gray" />
                  <strong>{offline}</strong> offline
                </span>
                <span>
                  <i className="status-dot amber" />
                  <strong>{lowDisk.length}</strong> low storage
                </span>
              </div>
              <section className="panel">
                <div className="table-toolbar">
                  <div className="tabs">
                    {[
                      ["all", "All endpoints"],
                      ["online", "Online"],
                      ["offline", "Offline"],
                      ["attention", "Low storage"],
                      [
                        "reboot",
                        `Needs reboot (${active.filter((ep) => ep.inventory?.pendingReboot === true).length})`,
                      ],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setFilter(key)}
                        className={filter === key ? "active" : ""}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search endpoints"
                      placeholder="Search name, IP, user, OU…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        aria-label="Clear search"
                        onClick={() => setSearch("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {renderSelection()}
                {filtered.length ? (
                  renderEndpointTable()
                ) : (
                  <Empty
                    title={
                      active.length
                        ? "No matching endpoints"
                        : "No endpoints connected yet"
                    }
                    description={
                      active.length
                        ? "Try another search or filter."
                        : "Create an enrollment token, then install the agent on a Windows computer."
                    }
                    action={
                      !active.length && (
                        <button
                          className="button primary"
                          onClick={() => changeView("enrollment")}
                        >
                          <Plus size={15} />
                          Connect endpoint
                        </button>
                      )
                    }
                  />
                )}
                <div className="panel-bottom">
                  <span>
                    {filtered.length} endpoint{filtered.length !== 1 ? "s" : ""}
                  </span>
                  <span>Outbound HTTPS · No inbound endpoint ports</span>
                </div>
              </section>
            </>
          )}
          {view === "scripts" && (
            <>
              <div className="section-toolbar">
                <div className="search-field">
                  <Search size={16} />
                  <input
                    aria-label="Search scripts"
                    placeholder="Search your script library…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <span className="muted">{scripts.length} saved scripts</span>
              </div>
              {scripts.length ? (
                <div className="script-grid">
                  {scripts
                    .filter((s) =>
                      `${s.name} ${s.description}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((script) => (
                      <section className="panel script-card" key={script.id}>
                        <div className="script-top">
                          <span className="script-icon">
                            <Code2 size={23} />
                          </span>
                          <span className="language-label">POWERSHELL</span>
                        </div>
                        <h2>{script.name}</h2>
                        <p>
                          {script.description || "No description provided."}
                        </p>
                        <pre>
                          {script.body.split("\n").slice(0, 4).join("\n")}
                        </pre>
                        <div className="script-card-footer">
                          <span>{ago(script.updatedAt)}</span>
                          <div>
                            <button
                              className="text-button"
                              onClick={() => setScriptForm(script)}
                            >
                              Edit
                            </button>
                            <button
                              className="button small secondary"
                              onClick={() =>
                                setCommand({
                                  kind: "powershell",
                                  ids: selected.length ? selected : [],
                                  script: script.body,
                                  chooseEndpoints: true,
                                  path: "C:\\",
                                })
                              }
                            >
                              <Play size={13} />
                              Run
                            </button>
                          </div>
                        </div>
                      </section>
                    ))}
                </div>
              ) : (
                <section className="panel">
                  <Empty
                    icon={Code2}
                    title="Make the everyday repeatable"
                    description="Save your PowerShell scripts once, then run them on selected endpoints or schedule them."
                    action={
                      <button
                        className="button primary"
                        onClick={() =>
                          setScriptForm({ name: "", description: "", body: "" })
                        }
                      >
                        <Plus size={15} />
                        Create a script
                      </button>
                    }
                  />
                </section>
              )}
              <div className="info-note">
                <ShieldCheck size={17} />
                <p>
                  Scripts run as LocalSystem in a fresh PowerShell process.
                  Review commands before running. Every invocation is a
                  separate, audited job.
                </p>
              </div>
            </>
          )}
          {view === "software" && (
            <SoftwareInventory
              endpoints={endpoints}
              onOpenEndpoint={(id) => {
                const ep = endpoints.find((item) => item.id === id);
                if (ep) setDetail(ep);
              }}
            />
          )}
          {view === "schedules" && (
            <>
              <div className="info-note">
                <CalendarClock size={18} />
                <p>
                  Each occurrence creates a unique job. After server downtime,
                  missed occurrences are skipped. Previously dispatched jobs are
                  never replayed.
                </p>
              </div>
              <section className="panel">
                {schedules.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>SCHEDULE</th>
                          <th>SCRIPT</th>
                          <th>ENDPOINTS</th>
                          <th>INTERVAL</th>
                          <th>NEXT RUN</th>
                          <th>STATUS</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {schedules.map((s) => (
                          <tr key={s.id}>
                            <td>
                              <strong>{s.name}</strong>
                            </td>
                            <td>
                              {scripts.find(
                                (script) => script.id === s.scriptId,
                              )?.name || "Deleted script"}
                            </td>
                            <td>{s.endpointIds.length} endpoints</td>
                            <td>Every {s.intervalMinutes} min</td>
                            <td>{when(s.nextRunAt)}</td>
                            <td>
                              <Status
                                status={s.enabled ? "enabled" : "paused"}
                              />
                            </td>
                            <td>
                              <div className="row-actions">
                                <button
                                  className="icon-button"
                                  title={
                                    s.enabled
                                      ? "Pause schedule"
                                      : "Enable schedule"
                                  }
                                  aria-label={
                                    s.enabled
                                      ? "Pause schedule"
                                      : "Enable schedule"
                                  }
                                  onClick={async () => {
                                    try {
                                      await api(`/schedules/${s.id}`, "PATCH", {
                                        enabled: !s.enabled,
                                      });
                                      await refresh();
                                    } catch (err) {
                                      fail(err);
                                    }
                                  }}
                                >
                                  {s.enabled ? (
                                    <Pause size={16} />
                                  ) : (
                                    <Play size={16} />
                                  )}
                                </button>
                                <button
                                  className="icon-button danger-text"
                                  aria-label={`Delete schedule ${s.name}`}
                                  onClick={async () => {
                                    if (
                                      !window.confirm(
                                        `Delete schedule “${s.name}”? Already-created jobs remain in activity.`,
                                      )
                                    )
                                      return;
                                    try {
                                      await api(`/schedules/${s.id}`, "DELETE");
                                      await refresh();
                                    } catch (err) {
                                      fail(err);
                                    }
                                  }}
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={CalendarClock}
                    title="Keep your routines on schedule"
                    description={
                      !scripts.length || !active.length
                        ? "Add an endpoint and save a script first. Then create an interval schedule for your routine checks."
                        : "Choose a script, select endpoints, and set how often it should run."
                    }
                    action={
                      <button
                        className="button secondary"
                        disabled={!scripts.length || !active.length}
                        onClick={() => setScheduleForm(true)}
                      >
                        <Plus size={15} />
                        Create schedule
                      </button>
                    }
                  />
                )}
              </section>
            </>
          )}
          {view === "activity" && (
            <section className="panel">
              <div className="panel-heading"><div><h2>Recent runs</h2><p>Reopen a run to compare every computer’s result and complete output.</p></div></div>
              <div className="recent-runs">{runs.slice(0,20).map(run=><button key={run.id} className="run-link" onClick={()=>void api<{jobs:Job[]}>(`/runs/${run.id}`).then(result=>{if(result.jobs.length===1)setJobDetail(result.jobs[0]);else setBatch(result.jobs);}).catch(fail)}><strong>{run.name}</strong><span>{run.endpointCount} computers · {when(run.createdAt)}</span><small>{Object.entries(run.counts).map(([status,count])=>`${count} ${status}`).join(' · ')}</small><span>View results →</span></button>)}{!runs.length&&<p className="muted">New actions will appear here as runs.</p>}</div>
              <div className="table-toolbar">
                <div className="tabs">
                  {[
                    ["all", "All jobs"],
                    ["active", "In progress"],
                    ["succeeded", "Completed"],
                    ["failed", "Failed"],
                  ].map(([key, label]) => (
                    <button
                      key={key}
                      className={filter === key ? "active" : ""}
                      onClick={() => setFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="activity-tools">
                  <div className="search-field">
                    <Search size={15} />
                    <input
                      aria-label="Search activity"
                      placeholder="Computer, command or result…"
                      value={activitySearch}
                      onChange={(e) => setActivitySearch(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Job type"
                    value={activityKind}
                    onChange={(e) => setActivityKind(e.target.value)}
                  >
                    <option value="all">All types</option>
                    <option value="powershell">PowerShell</option>
                    <option value="terminal">Terminal</option>
                    <option value="files">Files</option>
                    <option value="reboot">Reboot</option>
                    <option value="inventory">Inventory</option>
                    <option value="other">Other</option>
                  </select>
                  <label className="activity-browsing">
                    <input
                      type="checkbox"
                      checked={showBrowsing}
                      onChange={(e) => setShowBrowsing(e.target.checked)}
                    />
                    Show folder browsing ({jobs.filter(isBrowsingJob).length})
                  </label>
                  <span className="muted">
                    {activityJobs.length} of {jobs.length} jobs
                  </span>
                </div>
              </div>
              {activityJobs.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>ACTION</th>
                        <th>ENDPOINT</th>
                        <th>STATUS</th>
                        <th>CREATED</th>
                        <th>RESULT</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {activityJobs
                        .map((job) => (
                          <tr key={job.id}>
                            <td>
                              <button
                                className="table-text-link"
                                onClick={() => setJobDetail(job)}
                              >
                                <Terminal size={16} />
                                {titleCase(job.kind)}
                              </button>
                            </td>
                            <td>
                              {endpointName(
                                endpoints.find(
                                  (ep) => ep.id === job.endpointId,
                                ),
                              )}
                            </td>
                            <td>
                              <Status status={job.status} />
                            </td>
                            <td className="nowrap muted">
                              {when(job.createdAt)}
                            </td>
                            <td className="summary-cell" title={job.summary}>
                              {job.summary || "Awaiting endpoint"}
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label="View full job output"
                                onClick={() => setJobDetail(job)}
                              >
                                <ChevronRight size={17} />
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={Terminal}
                  title="No jobs in this view"
                  description="Run PowerShell, refresh inventory, or queue a reboot from Endpoints. Complete results will be available here."
                />
              )}
              <div className="panel-bottom">
                <span>
                  <ShieldCheck size={14} /> At-most-once execution
                </span>
                <span>Complete output available for every job</span>
              </div>
            </section>
          )}
          {view === "enrollment" && (
            <>
              <div className="enrollment-steps">
                <section className="panel step-card">
                  <span className="step-number">01</span>
                  <Download size={24} />
                  <h2>Install the agent</h2>
                  <p>
                    Run the PowerShell install command below as administrator.
                    No token is needed.
                  </p>
                </section>
                <section className="panel step-card">
                  <span className="step-number">02</span>
                  <ShieldCheck size={24} />
                  <h2>Approve it</h2>
                  <p>
                    The computer appears under Waiting for approval. Approve it
                    if you recognize it, or deny it.
                  </p>
                </section>
                <section className="panel step-card">
                  <span className="step-number">03</span>
                  <Monitor size={24} />
                  <h2>Meet your endpoint</h2>
                  <p>
                    The agent connects over HTTPS, reports inventory, and
                    becomes available in your fleet.
                  </p>
                </section>
              </div>
              <JoinRequests
                requests={joinRequests}
                request={api}
                canDecide={user.role !== "viewer"}
                onChanged={() => void refresh()}
              />
              <AgentInstaller />
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Enrollment tokens (optional)</h2>
                    <p>
                      Only needed to skip approval, for example in unattended
                      deployments: run the installer with -PromptForToken or
                      -EnrollmentToken. Secret values are shown once.
                    </p>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => {
                      setNewToken(null);
                      setTokenForm(true);
                    }}
                  >
                    <Plus size={14} />
                    Create token
                  </button>
                </div>
                {tokens.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>LABEL</th>
                          <th>USES</th>
                          <th>EXPIRES</th>
                          <th>CREATED</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tokens.map((token, i) => (
                          <tr key={String(token.id || i)}>
                            <td>
                              <strong>
                                {String(token.label || "Enrollment token")}
                              </strong>
                            </td>
                            <td>
                              {String(token.uses ?? token.usedCount ?? 0)} /{" "}
                              {String(token.maxUses ?? "—")}
                            </td>
                            <td>{when(String(token.expiresAt || ""))}</td>
                            <td>{when(String(token.createdAt || ""))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={ShieldCheck}
                    title="No enrollment tokens"
                    description="Tokens are optional. New computers can simply request to join and be approved above."
                  />
                )}
              </section>
              <div className="info-note">
                <Download size={18} />
                <p>
                  Downloads come directly from this server. New computers hold only
                  a private join secret until you approve them; nothing secret is in download URLs.
                  Action1 software deployment integration will be added later.
                  Server URL: <code>{window.location.origin}</code>
                </p>
              </div>
            </>
          )}
          {view === "audit" && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Administrative events</h2>
                  <p>The 100 most recent recorded actions.</p>
                </div>
                <button
                  className="button secondary small"
                  onClick={() =>
                    api<Audit[]>("/audit?limit=100").then(setAudit).catch(fail)
                  }
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
              </div>
              {audit.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>ACTION</th>
                        <th>ACTOR</th>
                        <th>TIME</th>
                        <th>DETAILS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audit.map((event, i) => (
                        <tr key={event.id || i}>
                          <td>
                            <strong>{event.action}</strong>
                          </td>
                          <td>{event.actor || "System"}</td>
                          <td className="nowrap">{when(event.createdAt)}</td>
                          <td>
                            <code className="audit-details">
                              {typeof event.details === "string"
                                ? event.details
                                : JSON.stringify(
                                    event.details || event.targetId || "",
                                  )}
                            </code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={ShieldCheck}
                  title="No audit events available"
                  description="Administrative changes and endpoint operations appear here."
                />
              )}
            </section>
          )}
          {view === "settings" && (
            <><AccountSettings user={user} request={api} onProfile={setUser}/>
            {user.role === 'admin' && <SupportSettings request={api} onError={fail}/>}
            <div className="settings-grid">
              <section className="panel settings-card">
                <div className="settings-card-heading">
                  <span className="settings-icon">
                    <Server size={22} />
                  </span>
                  <div>
                    <h2>Application updates</h2>
                    <p>From GitHub to your workspace.</p>
                  </div>
                </div>
                <div className="key-values">
                  <div>
                    <span>Installed version</span>
                    <strong>{String(settings.version || "0.1.0")}</strong>
                  </div>
                  <div>
                    <span>Update service</span>
                    <strong>
                      {settings.updateEnabled || settings.updatesEnabled
                        ? "Connected"
                        : "Not configured"}
                    </strong>
                  </div>
                  {!!settings.updateImage && (
                    <div>
                      <span>Container image</span>
                      <code>{String(settings.updateImage)}</code>
                    </div>
                  )}
                  <div>
                    <span>Current server</span>
                    <strong>{window.location.host}</strong>
                  </div>
                </div>
                <div className="update-explanation">
                  <ShieldCheck size={18} />
                  <p>
                    An update pulls the configured GitHub source, rebuilds the
                    container, and restarts this application. Your database and
                    endpoint job history stay in persistent storage.
                  </p>
                </div>
                {updateStatus && (
                  <div className="update-status">
                    <div>
                      <strong>Update status</strong>
                      <Status status={String(updateStatus.status || "idle")} />
                    </div>
                    <p>
                      {String(
                        updateStatus.message || "The update service is ready.",
                      )}
                    </p>
                    {!!updateStatus.activeCommit && (
                      <small>
                        Active commit{" "}
                        <code>
                          {String(updateStatus.activeCommit).slice(0, 12)}
                        </code>
                      </small>
                    )}
                    {typeof updateStatus.automatic === "boolean" && (
                      <small>
                        Automatic checks{" "}
                        {updateStatus.automatic ? "enabled" : "disabled"}
                      </small>
                    )}
                    {!!updateStatus.completedAt && (
                      <small>
                        Last completed {when(String(updateStatus.completedAt))}
                      </small>
                    )}
                  </div>
                )}
                <button
                  className="button primary"
                  disabled={
                    busy || !(settings.updateEnabled || settings.updatesEnabled)
                  }
                  onClick={async () => {
                    if (
                      !window.confirm(
                        "Pull the configured GitHub source, rebuild, and restart the web app? The console may be briefly unavailable. Endpoint jobs will not be replayed.",
                      )
                    )
                      return;
                    setBusy(true);
                    try {
                      const result = await api<Record<string, unknown>>(
                        "/settings/update",
                        "POST",
                        {},
                      );
                      setUpdateStatus(result);
                      notify(
                        "Update requested. This console may disconnect briefly while the app restarts.",
                      );
                    } catch (err) {
                      fail(err);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <RefreshCw size={15} className={busy ? "spin" : ""} />
                  Pull latest & restart app
                </button>
                <button
                  className="text-button update-check"
                  onClick={() =>
                    api<Record<string, unknown>>("/settings/update")
                      .then(setUpdateStatus)
                      .catch(fail)
                  }
                >
                  Check update status
                  <ArrowRight size={14} />
                </button>
              </section>
              <div>
                <section className="panel settings-card">
                  <div className="settings-card-heading">
                    <span className="settings-icon">
                      <ShieldCheck size={22} />
                    </span>
                    <div>
                      <h2>Execution safeguards</h2>
                      <p>Designed for restore-on-reboot computers.</p>
                    </div>
                  </div>
                  <ul className="check-list">
                    <li>
                      <CheckCircle2 size={17} />
                      Server consumes every job before execution
                    </li>
                    <li>
                      <CheckCircle2 size={17} />
                      No automatic replay after reboot or rollback
                    </li>
                    <li>
                      <CheckCircle2 size={17} />
                      Every accepted output chunk is retained
                    </li>
                    <li>
                      <CheckCircle2 size={17} />
                      Administrative actions are audited
                    </li>
                  </ul>
                  <p className="settings-footnote">
                    A lost execution acknowledgment can leave a job uncertain.
                    Review the endpoint before creating a new action.
                  </p>
                </section>
                <section className="panel settings-card remote-card">
                  <div className="settings-card-heading">
                    <span className="settings-icon">
                      <Users size={22} />
                    </span>
                    <div>
                      <h2>Remote assistance</h2>
                      <p>Browser support for signed-in desktops</p>
                    </div>
                  </div>
                  <p>
                    Open an endpoint and choose Remote support to view its primary
                    screen and control the visible mouse and keyboard. Agent 0.1.6
                    or newer is required. The sharing indicator stays visible;
                    Ctrl+Alt+Shift+F12 ends sharing locally. Windows sign-in and
                    protected screens cannot currently be viewed or controlled.
                  </p>
                </section>
              </div>
            </div></>
          )}
          <footer className="workspace-footer">
            <span>
              <BookOpen size={13} /> Library endpoint console
            </span>
            <span>Secure connections. Clear outcomes.</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={18} />
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {detail && (
        <Modal
          title={endpointName(detail)}
          subtitle={detail.hostname}
          wide
          onClose={() => setDetail(null)}
        >
          <div className="detail-status">
            <Status
              status={
                detail.revoked
                  ? "revoked"
                  : detail.online
                    ? "online"
                    : "offline"
              }
            />
            <span>Last seen {ago(detail.lastSeen)}</span>
            <span className="mono">{detail.id.slice(0, 8)}</span>
          </div>
          <div className="detail-actions">
            {user.role !== 'viewer' && <button
              className="button primary small"
              disabled={detail.revoked || !detail.online}
              onClick={() => {
                const version = detail.inventory?.agentVersion?.split('.').map(Number);
                if (!version || version.length !== 3 || version.some(n=>!Number.isInteger(n)) ||
                    (version[0] === 0 && version[1] === 1 && version[2] < 6) ||
                    (version[0] === 0 && version[1] < 1)) {
                  fail(new Error('Remote support needs agent 0.1.6 or newer. Restart the agent service when no jobs are running, or re-run the website installer to update.'));
                  return;
                }
                openRemoteSupport(detail.id);
              }}>
              <Monitor size={15} /> Remote support
            </button>}
            <button
              className="button primary small"
              disabled={detail.revoked}
              onClick={() => {
                setTerminalEndpoint(detail);
                setDetail(null);
              }}
            >
              <Terminal size={15} />
              Terminal
            </button>
            <button
              className="button secondary small"
              disabled={detail.revoked}
              onClick={() => void queueJobs([detail.id], "inventory", {})}
            >
              <RefreshCw size={14} />
              Refresh inventory
            </button>
            {user.role !== 'viewer' && <button
              className="button secondary small"
              disabled={detail.revoked || busy}
              title="Install the latest published agent on this computer"
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const published = await api<{ version: string }>("/agent-download").catch(() => null);
                  const current = detail.inventory?.agentVersion || "unknown";
                  const target = published ? `v${published.version}` : "the latest published version";
                  const message = current === published?.version
                    ? `${detail.displayName} already runs agent v${current}. Reinstall it anyway?`
                    : `Update the agent on ${detail.displayName} from v${current} to ${target}?`;
                  if (!window.confirm(`${message}\n\nThe agent restarts about 20 seconds after the job runs and the computer reconnects within a minute. An open terminal or remote support session on it will end.${detail.online ? "" : "\n\nThis computer is offline; the update runs when it reconnects."}`)) return;
                  const result = await api<{ job: Job; duplicate: boolean }>(`/endpoints/${detail.id}/update-agent`, "POST", { idempotencyKey: crypto.randomUUID() });
                  notify(`Agent update queued for ${detail.displayName}. It runs once.`);
                  await refresh();
                  setJobDetail(result.job);
                } catch (err) {
                  fail(err);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ArrowDownToLine size={14} />
              Update agent
            </button>}
            <button
              className="button secondary small"
              disabled={detail.revoked}
              onClick={() => {
                openCommand("reboot", [detail.id]);
                setDetail(null);
              }}
            >
              <Power size={14} />
              Reboot
            </button>
          </div>
          <div className="tabs detail-tabs">
            <button
              className={detailTab === "overview" ? "active" : ""}
              onClick={() => setDetailTab("overview")}
            >
              Overview & storage
            </button>
            <button
              className={detailTab === "software" ? "active" : ""}
              onClick={() => setDetailTab("software")}
            >
              Installed software{" "}
              <span className="count-chip">
                {detail.inventory?.software?.length || 0}
              </span>
            </button>
          </div>
          {detailTab === "overview" ? (
            <>
              <div className="detail-info">
                <DetailValue
                  label="Operating system"
                  value={detail.inventory?.osName}
                />
                <DetailValue
                  label="OS version"
                  value={detail.inventory?.osVersion}
                />
                <DetailValue
                  label="IP addresses"
                  value={detail.inventory?.ipv4?.join(", ")}
                />
                <DetailValue
                  label="Domain"
                  value={
                    detail.inventory?.domainJoined
                      ? detail.inventory.domain
                      : "Not domain joined"
                  }
                />
                <DetailValue
                  label="Logged-on user"
                  value={
                    detail.inventory?.loggedOnUser ||
                    "No interactive user reported"
                  }
                />
                <DetailValue
                  label="Last boot"
                  value={when(detail.inventory?.bootTime)}
                />
                <DetailValue
                  label="CPU usage"
                  value={
                    detail.inventory?.cpuPercent != null
                      ? `${detail.inventory.cpuPercent.toFixed(1)}%`
                      : undefined
                  }
                />
                <DetailValue
                  label="Memory"
                  value={
                    detail.inventory?.memoryTotalBytes
                      ? `${bytes(detail.inventory.memoryUsedBytes)} / ${bytes(detail.inventory.memoryTotalBytes)}`
                      : undefined
                  }
                />
                <DetailValue
                  label="Agent version"
                  value={detail.inventory?.agentVersion}
                />
                <DetailValue
                  label="Architecture"
                  value={detail.inventory?.architecture}
                />
              </div>
              <AgentUpdateDetails status={detail.updateStatus} agentVersion={detail.inventory?.agentVersion}/>
              <EndpointDirectory inventory={detail.inventory}/>
              <div className="detail-section-title">
                <h3>Disks & storage</h3>
                <button
                  className="text-button"
                  disabled={detail.revoked}
                  onClick={() => {
                    setExplorer(detail);
                    setDetail(null);
                  }}
                >
                  <FolderSearch size={15} />
                  Browse files
                </button>
              </div>
              {detail.inventory?.disks?.length ? (
                <div className="disk-cards">
                  {detail.inventory.disks.map((disk) => (
                    <div className="disk-card" key={disk.name}>
                      <div>
                        <span className="disk-icon">
                          <HardDrive size={22} />
                        </span>
                        <div>
                          <strong>
                            {disk.name} {disk.label && `· ${disk.label}`}
                          </strong>
                          <small>
                            {bytes(disk.freeBytes)} free of{" "}
                            {bytes(disk.totalBytes)}
                          </small>
                        </div>
                        <b
                          className={
                            usedPercent(disk) >= 85 ? "text-amber" : ""
                          }
                        >
                          {Math.round(usedPercent(disk))}%
                        </b>
                      </div>
                      <div className="progress-track">
                        <span
                          className={usedPercent(disk) >= 85 ? "warning" : ""}
                          style={{ width: `${usedPercent(disk)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No disk inventory received yet.</p>
              )}
              <div className="endpoint-admin">
                <button
                  className="text-button"
                  onClick={async () => {
                    const displayName = window.prompt(
                      "Display name",
                      detail.displayName || detail.hostname,
                    );
                    if (displayName === null) return;
                    try {
                      await api(`/endpoints/${detail.id}`, "PATCH", {
                        displayName,
                      });
                      await refresh();
                      notify("Endpoint name updated.");
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  Rename endpoint
                </button>
                <button
                  className="text-button danger-text"
                  disabled={detail.revoked}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `Revoke ${endpointName(detail)}? It will lose access and must be enrolled again. Queued jobs will not execute.`,
                      )
                    )
                      return;
                    try {
                      await api(`/endpoints/${detail.id}/revoke`, "POST", {});
                      setDetail(null);
                      await refresh();
                      notify("Endpoint credentials revoked.");
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  <ShieldOff size={14} />
                  Revoke endpoint
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="search-field software-search">
                <Search size={16} />
                <input
                  aria-label="Search installed software"
                  placeholder="Search software or publisher…"
                  value={softwareSearch}
                  onChange={(e) => setSoftwareSearch(e.target.value)}
                />
              </div>
              <div className="table-scroll software-table">
                <table>
                  <thead>
                    <tr>
                      <th>SOFTWARE</th>
                      <th>VERSION</th>
                      <th>PUBLISHER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.inventory?.software || [])
                      .filter((s) =>
                        `${s.name} ${s.publisher}`
                          .toLowerCase()
                          .includes(softwareSearch.toLowerCase()),
                      )
                      .map((s, i) => (
                        <tr key={`${s.name}-${i}`}>
                          <td>
                            <strong>{s.name}</strong>
                          </td>
                          <td className="mono">{s.version || "—"}</td>
                          <td>{s.publisher || "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                {!detail.inventory?.software?.length && (
                  <Empty
                    icon={Database}
                    title="No software inventory yet"
                    description="Refresh inventory to collect installed software."
                  />
                )}
              </div>
            </>
          )}
        </Modal>
      )}
      {command && (
        <Modal
          title={
            command.kind === "reboot"
              ? "Reboot endpoints"
              : command.kind === "storage"
                ? "Explore storage"
                : "Run PowerShell"
          }
          subtitle={
            command.ids.length
              ? `${command.ids.length} selected endpoint${command.ids.length !== 1 ? "s" : ""}`
              : "Choose endpoints for this script"
          }
          wide
          onClose={() => setCommand(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!command.ids.length) {
                notify("Choose at least one endpoint.");
                return;
              }
              void queueJobs(
                command.ids,
                command.kind,
                command.kind === "powershell"
                  ? { script: command.script }
                  : command.kind === "reboot"
                    ? {
                        delaySeconds: 30,
                        reason:
                          "Administrator requested reboot from Library RMM",
                      }
                    : { path: command.path },
                command.kind === "powershell"
                  ? (command.timeoutMinutes ?? 15) * 60
                  : undefined,
              );
            }}
          >
            {(command.chooseEndpoints || command.kind === "powershell") && (
              <div className="field">
                Run on computers
                <EndpointPicker
                  endpoints={active}
                  value={command.ids}
                  onChange={(ids) => setCommand({ ...command, ids })}
                />
              </div>
            )}
            {command.kind === "powershell" && (
              <>
                <div className="code-editor-header">
                  <span>
                    <Terminal size={15} /> Windows PowerShell
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
                  onChange={(e) =>
                    setCommand({ ...command, script: e.target.value })
                  }
                  placeholder={
                    "# Enter a PowerShell command or script\nGet-ComputerInfo | Format-List *"
                  }
                />
                <div className="info-note compact">
                  <Terminal size={16} />
                  <p>
                    A fresh process runs for this job. All emitted stdout and
                    stderr is retained, paginated, and downloadable. Use{" "}
                    <code>Format-List *</code> or{" "}
                    <code>ConvertTo-Json -Depth 10</code> when PowerShell’s own
                    table formatting hides values.
                  </p>
                </div>
              </>
            )}
            {command.kind === "reboot" && (
              <div className="confirmation-block">
                <span className="confirmation-icon">
                  <Power size={29} />
                </span>
                <h3>These computers will restart</h3>
                <p>
                  The agent requests a reboot with a 30-second delay. This job
                  cannot automatically run again, including after a
                  restore-on-reboot rollback.
                </p>
                <div className="target-chips">
                  {command.ids.map((id) => (
                    <span key={id}>
                      {endpointName(endpoints.find((ep) => ep.id === id))}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {command.kind === "storage" && (
              <>
                <label className="field">
                  Directory path
                  <input
                    required
                    value={command.path}
                    onChange={(e) =>
                      setCommand({ ...command, path: e.target.value })
                    }
                    placeholder="C:\"
                  />
                </label>
                <div className="info-note compact">
                  <FolderSearch size={17} />
                  <p>
                    This read-only scan reports child entries and bounded
                    recursive folder sizes. Large or protected directories may
                    report partial results. View its complete JSON output in
                    Activity.
                  </p>
                </div>
              </>
            )}
            <div className="modal-footer">
              <span>
                <ShieldCheck size={14} />
                One job per endpoint. No automatic replay.
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
                  className={`button ${command.kind === "reboot" ? "danger" : "primary"}`}
                >
                  {busy ? (
                    <Loader2 size={15} className="spin" />
                  ) : command.kind === "reboot" ? (
                    <Power size={15} />
                  ) : (
                    <Play size={15} />
                  )}{" "}
                  {command.kind === "reboot"
                    ? "Confirm reboot"
                    : command.kind === "storage"
                      ? "Start scan"
                      : command.ids.length > 1
                        ? `Run on ${command.ids.length} computers`
                        : "Run script"}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {scriptForm && (
        <Modal
          title={scriptForm.id ? "Edit script" : "Create script"}
          subtitle="Save a routine in your PowerShell library."
          wide
          onClose={() => setScriptForm(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api(
                  `/scripts${scriptForm.id ? `/${scriptForm.id}` : ""}`,
                  scriptForm.id ? "PUT" : "POST",
                  {
                    name: scriptForm.name,
                    description: scriptForm.description,
                    body: scriptForm.body,
                  },
                );
                setScriptForm(null);
                await refresh();
                notify("Script saved to your library.");
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
                  value={scriptForm.name || ""}
                  onChange={(e) =>
                    setScriptForm({ ...scriptForm, name: e.target.value })
                  }
                  placeholder="e.g. Get system diagnostics"
                />
              </label>
              <label>
                Description
                <input
                  maxLength={2000}
                  value={scriptForm.description || ""}
                  onChange={(e) =>
                    setScriptForm({
                      ...scriptForm,
                      description: e.target.value,
                    })
                  }
                  placeholder="What does this script do?"
                />
              </label>
            </div>
            <div className="code-editor-header">
              <span>
                <Code2 size={15} />
                PowerShell script
              </span>
              <span>Saved script</span>
            </div>
            <textarea
              className="code-editor"
              aria-label="Script body"
              required
              spellCheck={false}
              value={scriptForm.body || ""}
              onChange={(e) =>
                setScriptForm({ ...scriptForm, body: e.target.value })
              }
              placeholder="# Your PowerShell script"
            />
            <div className="modal-footer">
              {scriptForm.id ? (
                <button
                  type="button"
                  className="text-button danger-text"
                  onClick={async () => {
                    if (!window.confirm("Delete this saved script?")) return;
                    try {
                      await api(`/scripts/${scriptForm.id}`, "DELETE");
                      setScriptForm(null);
                      await refresh();
                    } catch (err) {
                      fail(err);
                    }
                  }}
                >
                  <Trash2 size={14} />
                  Delete script
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
                <button
                  type="submit"
                  className="button primary"
                  disabled={busy}
                >
                  {busy ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <Check size={15} />
                  )}
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
          subtitle="Set a regular interval for a saved script."
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
                await api("/schedules", "POST", values);
                setScheduleForm(false);
                await refresh();
                notify("Schedule created.");
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
          title={newToken ? "Your enrollment token" : "Create enrollment token"}
          subtitle={
            newToken
              ? "Copy it now. This secret will not be shown again."
              : "Authorize a limited number of Windows installations."
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
                  className="button secondary small"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(newToken)
                      .then(() => notify("Enrollment token copied."))
                      .catch(() =>
                        notify("Select the token and copy it manually."),
                      );
                  }}
                >
                  <Copy size={14} />
                  Copy
                </button>
              </div>
              <div className="info-note compact">
                <ShieldCheck size={17} />
                <p>
                  Provide this token to the agent installer. Store it securely
                  until installation; do not add it to source code or public
                  scripts.
                </p>
              </div>
              <div className="modal-footer">
                <span />
                <button
                  className="button primary"
                  onClick={() => {
                    setTokenForm(false);
                    setNewToken(null);
                  }}
                >
                  I’ve saved the token
                  <Check size={15} />
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
                    "/enrollment-tokens",
                    "POST",
                    values,
                  );
                  setNewToken(result.token);
                  setTokens(await api("/enrollment-tokens"));
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
      {terminalEndpoint && user && <TerminalConsole endpoint={terminalEndpoint} request={api} onClose={()=>setTerminalEndpoint(null)} onError={fail}/>}
      {explorer && user && (
        <Modal
          title={`Files · ${endpointName(explorer)}`}
          subtitle="Each action runs once on the computer. Deletes are permanent."
          wide
          onClose={() => setExplorer(null)}
        >
          <FileExplorer
            endpoint={{
              id: explorer.id,
              name: endpointName(explorer),
              online: endpoints.find((ep) => ep.id === explorer.id)?.online ?? explorer.online,
            }}
            request={api}
            canWrite={user.role !== "viewer"}
          />
        </Modal>
      )}
      <CommandPalette items={paletteItems} onSelect={choosePaletteItem} />
      {starterOpen && (
        <Modal
          title="Starter scripts"
          subtitle="Ready-made routines for common library IT tasks. Preview the code, add it to your library, or run it now."
          wide
          onClose={() => setStarterOpen(false)}
        >
          <StarterScripts
            existingNames={scripts.map((script) => script.name)}
            canEdit={user?.role !== "viewer"}
            onAdd={async (template) => {
              try {
                await api("/scripts", "POST", {
                  name: template.name,
                  description: template.description,
                  body: template.body,
                });
                notify(`"${template.name}" added to your script library.`);
                await refresh();
              } catch (err) {
                fail(err);
                throw err;
              }
            }}
            onRun={(template) => {
              setStarterOpen(false);
              setCommand({
                kind: "powershell",
                ids: selected,
                script: template.body,
                path: "C:\\",
                chooseEndpoints: true,
                timeoutMinutes: template.id === "system-repair" ? 120 : 15,
              });
            }}
          />
        </Modal>
      )}
      {batch && (
        <Modal
          title={`Results · ${batch.length} computers`}
          subtitle="Live output from every computer. Each job runs at most once."
          wide
          onClose={() => setBatch(null)}
        >
          <BatchResults
            jobs={batch}
            nameOf={(id) => endpointName(endpoints.find((ep) => ep.id === id))}
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
              kind: "storage",
              ids: [jobDetail.endpointId],
              script: "",
              path,
            });
            setJobDetail(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
  accent = "teal",
  footer,
  percent,
}: {
  label: string;
  value: number;
  icon: typeof Monitor;
  accent?: string;
  footer: string;
  percent?: number;
}) {
  return (
    <section className={`stat-card stat-${accent}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon size={19} />
        </span>
      </div>
      <div className="stat-value">
        {value.toLocaleString()}
        {percent !== undefined && (
          <span className="stat-percent">
            {Math.round(percent)}%<ArrowRight size={12} />
          </span>
        )}
      </div>
      <p>{footer}</p>
    </section>
  );
}
function DetailValue({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
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
  const [label, setLabel] = useState(""),
    [maxUses, setMaxUses] = useState(1),
    [hours, setHours] = useState(24);
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
          placeholder="e.g. Cody public computers"
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
          Expires in hours
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
          <button className="button primary" disabled={busy}>
            <Plus size={15} />
            Create token
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
  const [name, setName] = useState(""),
    [scriptId, setScriptId] = useState(scripts[0]?.id || ""),
    [ids, setIds] = useState<string[]>([]),
    [minutes, setMinutes] = useState(1440);
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
          placeholder="e.g. Daily diagnostics"
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
        Run every (minutes)
        <input
          type="number"
          min={5}
          max={525600}
          required
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <fieldset className="endpoint-picker">
        <legend>
          Endpoints <span>{ids.length} selected</span>
        </legend>
        {endpoints.map((ep) => (
          <label key={ep.id}>
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
            <span>{endpointName(ep)}</span>
            <Status status={ep.online ? "online" : "offline"} />
          </label>
        ))}
      </fieldset>
      <div className="modal-footer">
        <span>First run follows the chosen interval.</span>
        <div>
          <button type="button" className="button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || !ids.length}>
            <CalendarClock size={15} />
            Create schedule
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
  const [job, setJob] = useState(initial),
    [chunks, setChunks] = useState<Chunk[]>([]),
    [loading, setLoading] = useState(false),
    [hasMore, setHasMore] = useState(false),
    [autoFollow, setAutoFollow] = useState(true);
  const cursor = useRef(-1),
    fetching = useRef(false),
    outputRef = useRef<HTMLPreElement>(null);
  const progress = useMemo(()=>progressOutput(chunks),[chunks]);
  const load = async () => {
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
        // Advance only after a page is accepted; never replace earlier output with a tail.
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
  };
  useEffect(() => {
    void load();
    // Poll quickly so progress feels live; load() skips overlapping requests.
    const interval = window.setInterval(() => void load(), 1000);
    return () => window.clearInterval(interval);
  }, [initial.id]);
  useEffect(() => {
    if (autoFollow && outputRef.current)
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [chunks, autoFollow]);
  const storage = useMemo<StorageResult | null>(() => {
    // Parsing a partial page would misrepresent the scan. JSON remains available below.
    if (job.kind !== "storage" || hasMore || isActiveJob(job) || !chunks.length)
      return null;
    try {
      const result = JSON.parse(
        chunks
          .filter((chunk) => chunk.stream === "stdout")
          .map((chunk) => chunk.text)
          .join(""),
      );
      if (typeof result.path !== "string" || !Array.isArray(result.entries))
        return null;
      if (
        result.entries.some(
          (entry: StorageResult["entries"][number]) =>
            typeof entry.name !== "string" || typeof entry.path !== "string",
        )
      )
        return null;
      return result as StorageResult;
    } catch {
      return null;
    }
  }, [chunks, hasMore, job.kind, job.status]);
  const sortedStorage = storage
    ? [...storage.entries].sort(
        (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0),
      )
    : [];
  const maxStorageBytes = Math.max(
    1,
    ...sortedStorage.map((entry) => entry.sizeBytes || 0),
  );
  return (
    <Modal
      title={`${titleCase(job.kind)} · ${endpointName(endpoint)}`}
      subtitle={`Job ${job.id}`}
      wide
      onClose={onClose}
    >
      <div className="output-summary">
        <Status status={job.status} />
        <span>Created {when(job.createdAt)}</span>
        {job.exitCode != null && (
          <span>
            Exit code <code>{job.exitCode}</code>
          </span>
        )}
      </div>
      {job.summary && <p className="job-summary">{job.summary}</p>}
      {["dispatched", "running"].includes(job.status) && (
        <div className="info-note compact">
          <ShieldCheck size={15} />
          <p>
            This job has been consumed and will never be dispatched again. If an
            endpoint disappears, inspect its state before creating a replacement
            job.
          </p>
        </div>
      )}
      {storage && (
        <section className="storage-explorer">
          <div className="storage-explorer-heading">
            <span>
              <FolderSearch size={18} />
              <strong>{storage.path}</strong>
            </span>
            <small>
              {storage.scannedEntries?.toLocaleString() ??
                storage.entries.length}{" "}
              entries scanned
            </small>
          </div>
          {storage.partial && (
            <p className="storage-partial">
              This scan is partial. Protected paths, traversal limits, or errors
              may affect reported sizes.
            </p>
          )}
          {!!storage.note && (
            <p className="storage-scan-note">{storage.note}</p>
          )}
          {storage.entries.length ? (
            <div className="table-scroll storage-explorer-table">
              <table>
                <thead>
                  <tr>
                    <th>NAME</th>
                    <th>REPORTED SIZE</th>
                    <th>SCAN NOTES</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStorage.map((entry, index) => (
                    <tr key={`${entry.path}-${index}`}>
                      <td>
                        {entry.isDirectory ? (
                          <button
                            className="folder-link"
                            disabled={entry.skippedReparsePoint}
                            onClick={() => onExploreStorage(entry.path)}
                            title={
                              entry.skippedReparsePoint
                                ? "Reparse points are not followed"
                                : `Scan ${entry.path}`
                            }
                          >
                            <Folder size={15} />
                            <span>{entry.name}</span>
                            <ChevronRight size={12} />
                          </button>
                        ) : (
                          <span className="file-name">
                            <File size={15} />
                            {entry.name}
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="storage-size">
                          <span>{bytes(entry.sizeBytes)}</span>
                          <div className="progress-track">
                            <span
                              style={{
                                width: `${Math.min(100, Math.max(0, ((entry.sizeBytes || 0) / maxStorageBytes) * 100))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td
                        className="storage-row-note"
                        title={entry.errors?.join("; ")}
                      >
                        {entry.skippedReparsePoint
                          ? "Reparse point skipped"
                          : entry.partial
                            ? "Partial size"
                            : entry.errors?.length
                              ? `${entry.errors.length} error(s)`
                              : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="storage-scan-note">No child entries reported.</p>
          )}
          {!!storage.errors?.length && (
            <p className="storage-partial">
              {storage.errors.length} scan error(s). See complete JSON output
              below for details.
            </p>
          )}
          <div className="storage-explorer-footnote">
            Select a folder to queue a new read-only scan. Each scan runs once.
            Sizes reflect this scan’s timestamp.
          </div>
        </section>
      )}
      <div className="code-editor-header output-header">
        <span>
          <Terminal size={15} />
          Complete process output{" "}
          <span className="chunk-count">{chunks.length} chunks loaded</span>
        </span>
        <label>
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
            {isActiveJob(job)
              ? "Waiting for the endpoint to send output…"
              : "This job produced no output."}
          </span>
        )}
      </pre>
      {progress.percent!==null && <div className="live-job-progress" role="status"><span>Latest reported progress: <strong>{progress.percent}%</strong></span><progress max={100} value={progress.percent} aria-label="Latest progress reported by command"/></div>}
      {hasMore && (
        <button
          className="button secondary load-more"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowDownToLine size={15} />
          Load next page of output
        </button>
      )}
      <div className="output-footer">
        <span>
          {hasMore
            ? "More output is available. All chunks remain stored on the server."
            : "All available output loaded. No server-side truncation."}
        </span>
        <span>
          {loading && <Loader2 size={13} className="spin" />}Updates every
          second
        </span>
      </div>
      <div className="modal-footer">
        <div>
          {job.status === "queued" && (
            <button
              className="text-button danger-text"
              onClick={async () => {
                try {
                  await api(`/jobs/${job.id}/cancel`, "POST", {});
                  await load();
                  onChanged();
                } catch (err) {
                  onError(err);
                }
              }}
            >
              <X size={14} />
              Cancel queued job
            </button>
          )}
        </div>
        <div>
          <a
            className="button secondary"
            href={`/api/jobs/${job.id}/download`}
            download
          >
            <Download size={15} />
            Download full output
          </a>
          <button className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AgentInstaller() {
  const [manifest, setManifest] = useState<{version: string; runtime: string; sizeBytes: number; sha256: string} | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    api<{version: string; runtime: string; sizeBytes: number; sha256: string}>("/agent-download")
      .then(value => { if (active) setManifest(value); })
      .catch(reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);
  // Works in an administrator PowerShell window and unattended as SYSTEM (e.g. Action1
  // "Run script", 32- or 64-bit). A failure throws, so deployment tools report it as failed.
  const command = `$ProgressPreference = 'SilentlyContinue'\n[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12\n$installer = Join-Path $env:TEMP 'Install-LibraryRmm.ps1'\nInvoke-WebRequest -UseBasicParsing '${window.location.origin}/install.ps1' -OutFile $installer\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer\nif ($LASTEXITCODE -ne 0) { throw "Library RMM install failed with exit code $LASTEXITCODE" }`;
  return <section className="panel agent-installer">
    <div className="panel-heading"><div><h2>Install from this website</h2><p>Open Windows PowerShell as administrator on the computer you want to manage.</p></div><Download size={20}/></div>
    <div className="agent-installer-body">
      <div className="agent-download-actions">
        <a className={`button primary ${!manifest ? "download-unavailable" : ""}`} href="/install.ps1" download aria-disabled={!manifest} onClick={event => { if (!manifest) event.preventDefault(); }}><Download size={16}/>Download install script</a>
        <a className={`button secondary ${!manifest ? "download-unavailable" : ""}`} href="/downloads/library-rmm-agent-win-x64.zip" download aria-disabled={!manifest} onClick={event => { if (!manifest) event.preventDefault(); }}><ArrowDownToLine size={16}/>Download agent ZIP</a>
        <span className="muted">{manifest ? `v${manifest.version} · Windows x64 · ${bytes(manifest.sizeBytes)}` : error || "Checking installer availability…"}</span>
      </div>
      <div className="agent-command-heading"><strong>Or copy and run this command</strong><button className="button small secondary" disabled={!manifest} onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setError("Clipboard unavailable. Select and copy the command below."); } }}>{copied ? <Check size={14}/> : <Copy size={14}/>} {copied ? "Copied" : "Copy command"}</button></div>
      <pre className="agent-install-command"><code>{command}</code></pre>
      <p className="muted">The script verifies the package checksum and installs the agent, which then waits for your approval under Waiting for approval above. Re-running it updates an existing agent while preserving its identity. No reboot is required.</p>
      <p className="muted"><strong>Action1 or other deployment tools:</strong> paste the same command into a "Run script" action (PowerShell). It runs unattended as SYSTEM, switches to 64-bit PowerShell automatically, needs no token, and reports failure if the install fails. Each computer then appears under Waiting for approval.</p>
      {manifest && <details className="agent-package-integrity"><summary>Package SHA256</summary><code>{manifest.sha256}</code><a className="text-button" href="/downloads/library-rmm-agent-win-x64.zip.sha256" download>Download checksum</a></details>}
      {manifest && error && <p role="alert" className="danger-text">{error}</p>}
    </div>
  </section>;
}

createRoot(document.getElementById("root")!).render(
  window.location.pathname.startsWith('/support/') ? <RemoteSupport /> : <App />
);
