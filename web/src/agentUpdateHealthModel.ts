export type AgentUpdatePhase =
  | "checking"
  | "current"
  | "disabled"
  | "deferred"
  | "downloading"
  | "verifying"
  | "installing"
  | "failed"
  | "retry_wait"
  | "unsupported";
export type AgentUpdateStatus = {
  schemaVersion: 1;
  installedVersion: string;
  availableVersion: string | null;
  phase: AgentUpdatePhase;
  stage: string | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  attempts: number;
  errorCode: string | null;
  summary: string;
  receivedAt: string;
};
export type AgentUpdateEndpoint = {
  id: string;
  hostname: string;
  displayName?: string;
  online: boolean;
  lastSeen: string;
  revoked?: boolean;
  inventory?: { agentVersion?: string };
  updateStatus?: AgentUpdateStatus | null;
};
export type AgentUpdateRow = {
  endpointId: string;
  endpointName: string;
  hostname: string;
  online: boolean;
  lastSeen: string;
  agentVersion: string | null;
  updateStatus: AgentUpdateStatus | null;
};
export type UpdateHealthKind =
  | "failed"
  | "unconfirmed"
  | "retry_wait"
  | "behind"
  | "legacy"
  | "missing"
  | "disabled"
  | "unsupported"
  | "progress"
  | "deferred"
  | "current"
  | "unknown";
export const UPDATE_REPORT_STALE_MS = 30 * 60 * 1000;
export const INSTALL_CONFIRMATION_MS = 30 * 60 * 1000;

const versionParts = (version?: string | null): number[] | null =>
  version && /^\d+\.\d+\.\d+$/.test(version)
    ? version.split(".").map(Number)
    : null;
/** Unknown versions are not treated as failures or proven outdated versions. */
export function compareAgentVersions(
  left?: string | null,
  right?: string | null,
): -1 | 0 | 1 | null {
  const a = versionParts(left),
    b = versionParts(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
const age = (date: string | null | undefined, now: number): number | null => {
  const parsed = date ? Date.parse(date) : NaN;
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : null;
};

export function agentUpdateHealth(
  status: AgentUpdateStatus | null | undefined,
  agentVersion?: string | null,
  latestVersion?: string | null,
  now = Date.now(),
) {
  const olderReport =
    !!status &&
    compareAgentVersions(agentVersion, status.installedVersion) === 1;
  const installedVersion = olderReport
    ? agentVersion!
    : status?.installedVersion || agentVersion || null;
  const targetVersion = versionParts(latestVersion)
    ? latestVersion!
    : status?.availableVersion || null;
  const behind = compareAgentVersions(installedVersion, targetVersion) === -1;
  const reportAgeMs = age(status?.receivedAt, now);
  const stale =
    !!status && (reportAgeMs === null || reportAgeMs >= UPDATE_REPORT_STALE_MS);
  const legacy =
    compareAgentVersions(agentVersion || status?.installedVersion, "0.1.8") ===
    -1;
  let kind: UpdateHealthKind, label: string, reason: string;
  let priority = 0;
  if (!status) {
    kind = legacy ? "legacy" : "missing";
    label = legacy
      ? "Older agent · diagnostics unavailable"
      : "No update report received";
    reason = legacy
      ? "This older agent does not report update diagnostics. Its update success or failure is unknown."
      : "The server has not received update diagnostics from this endpoint.";
    priority = behind ? 3 : 1;
  } else if (olderReport) {
    kind = behind ? "behind" : "unknown";
    label = "Report from an older agent version";
    reason = `The endpoint reports ${agentVersion}; this update report describes ${status.installedVersion}. Request a fresh report before interpreting its result.`;
    priority = behind ? 3 : 1;
  } else if (status.phase === "failed") {
    kind = "failed";
    label = stale ? "Failure last reported" : "Update failure reported";
    reason =
      status.summary || "The agent reported that its update attempt failed.";
    priority = 6;
  } else if (
    status.phase === "installing" &&
    reportAgeMs !== null &&
    reportAgeMs >= INSTALL_CONFIRMATION_MS
  ) {
    kind = "unconfirmed";
    label = "Installation not confirmed";
    reason =
      "The last installation report was received over 30 minutes ago. No newer update result has been received; failure is not confirmed.";
    priority = 5;
  } else if (status.phase === "retry_wait") {
    kind = "retry_wait";
    label = "Waiting to retry";
    reason = status.summary || "The agent is waiting for its retry interval.";
    priority = 4;
  } else if (status.phase === "disabled") {
    kind = "disabled";
    label = "Automatic updates disabled";
    reason =
      status.summary ||
      "Automatic agent updates are disabled on this endpoint.";
    priority = behind ? 3 : 1;
  } else if (status.phase === "unsupported") {
    kind = "unsupported";
    label = "Automatic update unavailable";
    reason =
      status.summary ||
      "The agent reported that this update path is unsupported.";
    priority = 3;
  } else if (
    ["checking", "downloading", "verifying", "installing"].includes(
      status.phase,
    )
  ) {
    kind = "progress";
    label = `${stale ? "Last reported: " : ""}${status.phase === "checking" ? "Checking for updates" : status.phase === "downloading" ? "Downloading" : status.phase === "verifying" ? "Verifying package" : "Installing"}`;
    reason =
      status.summary || "The agent reported an update operation in progress.";
    priority = stale ? 2 : 0;
  } else if (status.phase === "deferred") {
    kind = "deferred";
    label = "Check deferred until idle";
    reason =
      status.summary ||
      "The agent is waiting until endpoint work is idle before checking for updates.";
    priority = behind ? 2 : 0;
  } else if (behind) {
    kind = "behind";
    label = "Update available";
    reason = `The endpoint reports agent ${installedVersion}; package ${targetVersion} is available.`;
    priority = 3;
  } else if (status.phase === "current") {
    kind = "current";
    label = stale ? "Current at last check" : "Current when checked";
    reason =
      status.summary ||
      "The agent reported that it matched the package available at its last check.";
  } else {
    kind = "unknown";
    label = "Update result unknown";
    reason = "An update report was received without a recognized result.";
    priority = 1;
  }
  return {
    kind,
    label,
    reason,
    priority,
    installedVersion,
    targetVersion,
    behind,
    stale,
    olderReport,
    legacy,
    reportAgeMs,
    hasReport: !!status,
    attention: priority > 0,
  };
}

/** Merge the canonical API report with the fleet's current display names and inventory. */
export function mergeAgentUpdateRows(
  endpoints: AgentUpdateEndpoint[],
  reports: AgentUpdateRow[],
): AgentUpdateRow[] {
  const byId = new Map(
    endpoints
      .filter((endpoint) => !endpoint.revoked)
      .map((endpoint) => [
        endpoint.id,
        {
          endpointId: endpoint.id,
          endpointName: endpoint.displayName || endpoint.hostname,
          hostname: endpoint.hostname,
          online: endpoint.online,
          lastSeen: endpoint.lastSeen,
          agentVersion: endpoint.inventory?.agentVersion || null,
          updateStatus: endpoint.updateStatus || null,
        },
      ]),
  );
  const revoked = new Set(
    endpoints
      .filter((endpoint) => endpoint.revoked)
      .map((endpoint) => endpoint.id),
  );
  for (const report of reports) {
    if (revoked.has(report.endpointId)) continue;
    const known = byId.get(report.endpointId);
    const knownTime = known?.updateStatus?.receivedAt
      ? Date.parse(known.updateStatus.receivedAt)
      : NaN;
    const reportTime = report.updateStatus?.receivedAt
      ? Date.parse(report.updateStatus.receivedAt)
      : NaN;
    const newerStatus =
      known?.updateStatus &&
      (!report.updateStatus ||
        (Number.isFinite(knownTime) &&
          (!Number.isFinite(reportTime) || knownTime > reportTime)))
        ? known.updateStatus
        : report.updateStatus;
    const knownCheckinNewer =
      !!known && Date.parse(known.lastSeen) > Date.parse(report.lastSeen);
    byId.set(report.endpointId, {
      ...report,
      endpointName:
        known?.endpointName || report.endpointName || report.hostname,
      updateStatus: newerStatus,
      ...(knownCheckinNewer
        ? {
            lastSeen: known.lastSeen,
            online: known.online,
            agentVersion: known.agentVersion || report.agentVersion,
          }
        : {}),
    });
  }
  return [...byId.values()];
}
