import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Info,
  Loader2,
  RefreshCw,
  ShieldCheck,
  WifiOff,
} from "lucide-react";
import {
  agentUpdateHealth,
  mergeAgentUpdateRows,
  type AgentUpdateEndpoint,
  type AgentUpdateRow,
  type AgentUpdateStatus,
  type UpdateHealthKind,
} from "./agentUpdateHealthModel";
import "./AgentUpdateHealth.css";

export type {
  AgentUpdateEndpoint,
  AgentUpdateStatus,
} from "./agentUpdateHealthModel";
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const dateText = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString()
    : "Not reported";
const phaseText = (value?: string | null) =>
  value
    ? value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
    : "Not reported";
const important = (kind: UpdateHealthKind) =>
  ["failed", "unconfirmed", "retry_wait"].includes(kind);

function UpdateBadge({
  model,
}: {
  model: ReturnType<typeof agentUpdateHealth>;
}) {
  return (
    <span
      className={`auh-badge auh-badge-${model.kind} ${model.stale || model.olderReport ? "auh-badge-historical" : ""}`}
    >
      <i />
      {model.label}
    </span>
  );
}

/** Read-only dashboard reporting. A missing report is never presented as an update failure. */
export function AgentUpdateHealth({
  endpoints,
  request,
  onOpenEndpoint,
}: {
  endpoints: AgentUpdateEndpoint[];
  request: Request;
  onOpenEndpoint: (id: string) => void;
}) {
  const [reports, setReports] = useState<AgentUpdateRow[]>([]),
    [latestVersion, setLatestVersion] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"attention" | "all" | "reported">(
      "attention",
    ),
    [expanded, setExpanded] = useState(false),
    [now, setNow] = useState(Date.now());
  const busy = useRef(false),
    mounted = useRef(true),
    successful = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const result = await Promise.allSettled([
        request<AgentUpdateRow[]>("/agent-updates"),
        request<{ version: string }>("/agent-download"),
      ]);
      if (!mounted.current) return;
      if (result[0].status === "fulfilled") {
        if (!Array.isArray(result[0].value))
          throw new Error(
            "The server returned an invalid agent-update report.",
          );
        setReports(result[0].value);
        successful.current = true;
        setError("");
      } else
        setError(
          result[0].reason instanceof Error
            ? result[0].reason.message
            : "Agent update reports could not be refreshed.",
        );
      setLatestVersion(
        result[1].status === "fulfilled" ? result[1].value.version : null,
      );
      setNow(Date.now());
    } catch (failure) {
      if (mounted.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      busy.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [request]);
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 20000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);
  const rows = useMemo(
    () =>
      mergeAgentUpdateRows(endpoints, reports)
        .map((row) => ({
          row,
          model: agentUpdateHealth(
            row.updateStatus,
            row.agentVersion,
            latestVersion,
            now,
          ),
        }))
        .sort(
          (left, right) =>
            right.model.priority - left.model.priority ||
            left.row.endpointName.localeCompare(right.row.endpointName),
        ),
    [endpoints, reports, latestVersion, now],
  );
  const attention = rows.filter((entry) => entry.model.attention),
    reportedIssues = rows.filter((entry) => important(entry.model.kind));
  const filtered =
    filter === "all"
      ? rows
      : filter === "reported"
        ? reportedIssues
        : attention;
  const visible = expanded ? filtered : filtered.slice(0, 8);
  const noTelemetry = rows.filter((entry) => !entry.model.hasReport).length;
  const failureCount = rows.filter(
    (entry) => entry.model.kind === "failed",
  ).length;
  const pendingCount = rows.filter((entry) =>
    ["unconfirmed", "retry_wait"].includes(entry.model.kind),
  ).length;
  return (
    <section
      className="panel agent-update-health"
      aria-label="Agent update health"
    >
      <div className="panel-heading">
        <div>
          <h2>
            <ArrowUpCircle size={17} />
            Agent update health
          </h2>
          <p>
            {rows.length
              ? `${failureCount} reported failure${failureCount === 1 ? "" : "s"} · ${pendingCount} retry/unconfirmed · ${noTelemetry} without diagnostics`
              : "Windows agent update results appear here after endpoints report them."}
            {latestVersion ? ` · Latest package ${latestVersion}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="button small secondary"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={13} className={loading ? "spin" : ""} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="auh-load-error" role="alert">
          <Info size={14} />
          <p>
            {error}
            {successful.current
              ? " Showing the last received results."
              : " Update state is unknown until reports can be loaded."}
          </p>
        </div>
      )}
      <div
        className="auh-filter-row"
        role="group"
        aria-label="Filter agent update reports"
      >
        <button
          className={filter === "attention" ? "active" : ""}
          onClick={() => {
            setFilter("attention");
            setExpanded(false);
          }}
        >
          Needs attention <span>{attention.length}</span>
        </button>
        <button
          className={filter === "reported" ? "active" : ""}
          onClick={() => {
            setFilter("reported");
            setExpanded(false);
          }}
        >
          Reported failures & retries <span>{reportedIssues.length}</span>
        </button>
        <button
          className={filter === "all" ? "active" : ""}
          onClick={() => {
            setFilter("all");
            setExpanded(false);
          }}
        >
          All endpoints <span>{rows.length}</span>
        </button>
      </div>
      {loading && !rows.length ? (
        <div className="auh-empty" role="status">
          <Loader2 size={22} className="spin" />
          <p>Loading agent update reports…</p>
        </div>
      ) : visible.length ? (
        <div className="auh-report-list">
          {visible.map(({ row, model }) => (
            <article className="auh-report" key={row.endpointId}>
              <div className="auh-report-heading">
                <button
                  type="button"
                  className="auh-endpoint"
                  onClick={() => onOpenEndpoint(row.endpointId)}
                >
                  <span
                    className={`auh-online-dot ${row.online ? "online" : ""}`}
                  />
                  <strong>{row.endpointName || row.hostname}</strong>
                  <ChevronRight size={13} />
                </button>
                <UpdateBadge model={model} />
              </div>
              <div className="auh-version-line">
                <span>
                  Installed{" "}
                  <strong>{model.installedVersion || "Unknown"}</strong>
                </span>
                {model.targetVersion && (
                  <>
                    <ArrowRight size={11} />
                    <span>
                      Available <strong>{model.targetVersion}</strong>
                    </span>
                  </>
                )}
                {!row.online && (
                  <span className="auh-context-chip">
                    <WifiOff size={11} />
                    Offline · last seen {dateText(row.lastSeen)}
                  </span>
                )}
                {model.stale && (
                  <span className="auh-context-chip">
                    <Clock3 size={11} />
                    Stale report · current result unknown
                  </span>
                )}
              </div>
              <p className="auh-reason">{model.reason}</p>
              <div className="auh-report-meta">
                <span>Last check: {dateText(row.updateStatus?.checkedAt)}</span>
                {row.updateStatus?.nextRetryAt && (
                  <span>
                    Next retry: {dateText(row.updateStatus.nextRetryAt)}
                  </span>
                )}
                {row.updateStatus?.errorCode && (
                  <code>{row.updateStatus.errorCode}</code>
                )}
              </div>
              {!row.online && model.hasReport && (
                <p className="auh-historical-note">
                  This is the endpoint’s last report. Being offline does not
                  confirm an update failure.
                </p>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="auh-empty">
          <CheckCircle2 size={23} />
          <strong>
            {rows.length
              ? filter === "reported"
                ? "No failures or retries reported"
                : "No update issues reported in this view"
              : "No endpoint reports yet"}
          </strong>
          <p>
            {rows.length
              ? "Only reported evidence is shown. Missing diagnostics remain unknown."
              : "Enrolled endpoints appear here after they check in."}
          </p>
        </div>
      )}
      {filtered.length > 8 && (
        <button
          type="button"
          className="auh-expand"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? "Show fewer endpoints"
            : `Show all ${filtered.length} endpoints`}
          <ChevronDown size={13} className={expanded ? "auh-rotated" : ""} />
        </button>
      )}
      <div className="auh-guidance">
        <ShieldCheck size={15} />
        <p>
          Agent 0.1.8 and later checks periodically while idle. Older agents
          check at service startup; when idle, restart only the agent service or
          run the installer to upgrade. A computer reboot is not required for an
          agent update.
        </p>
      </div>
    </section>
  );
}

/** Compact endpoint-detail view using the same evidence/freshness rules as the dashboard. */
export function AgentUpdateDetails({
  status,
  agentVersion,
  online,
  latestVersion,
}: {
  status?: AgentUpdateStatus | null;
  agentVersion?: string;
  online?: boolean;
  latestVersion?: string;
}) {
  const model = agentUpdateHealth(status, agentVersion, latestVersion);
  return (
    <section
      className="agent-update-details"
      aria-label="Endpoint agent update diagnostics"
    >
      <header>
        <h3>
          <ArrowUpCircle size={16} />
          Agent update diagnostics
        </h3>
        <UpdateBadge model={model} />
      </header>
      <p className="auh-detail-reason">{model.reason}</p>
      {(online === false || model.stale || model.olderReport) && (
        <p className="auh-detail-context">
          <Info size={13} />
          {online === false
            ? "Endpoint offline. This report describes its last known update state."
            : model.olderReport
              ? "The report belongs to an older installed version; a fresh report is needed."
              : "The report is stale. The endpoint’s current update result is unknown."}
        </p>
      )}
      <dl className="auh-detail-grid">
        <div>
          <dt>Installed version</dt>
          <dd>{model.installedVersion || "Not reported"}</dd>
        </div>
        <div>
          <dt>Available version</dt>
          <dd>{model.targetVersion || "Not reported"}</dd>
        </div>
        <div>
          <dt>Last check (endpoint time)</dt>
          <dd>{dateText(status?.checkedAt)}</dd>
        </div>
        <div>
          <dt>Report received (server time)</dt>
          <dd>{dateText(status?.receivedAt)}</dd>
        </div>
        <div>
          <dt>Last attempt</dt>
          <dd>{dateText(status?.lastAttemptAt)}</dd>
        </div>
        <div>
          <dt>Next retry</dt>
          <dd>{dateText(status?.nextRetryAt)}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{phaseText(status?.stage)}</dd>
        </div>
        <div>
          <dt>Attempts reported</dt>
          <dd>{status ? status.attempts : "Not reported"}</dd>
        </div>
        {status?.errorCode && (
          <div className="auh-detail-code">
            <dt>Error code</dt>
            <dd>
              <code>{status.errorCode}</code>
            </dd>
          </div>
        )}
      </dl>
      <p className="auh-detail-guidance">
        {!model.hasReport
          ? "Agent 0.1.8 or later is required to report update diagnostics. No received report means update success or failure is unknown."
          : "Only the agent’s safe update summary and metadata are shown. Full installer logs are not transmitted."}
      </p>
    </section>
  );
}
