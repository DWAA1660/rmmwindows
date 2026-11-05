import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentUpdateHealth,
  compareAgentVersions,
  mergeAgentUpdateRows,
} from "../src/agentUpdateHealthModel.ts";
import { fleetHealth } from "../src/fleetHealthModel.ts";

const now = Date.parse("2026-11-05T18:00:00Z");
const status = (changes = {}) => ({
  schemaVersion: 1,
  installedVersion: "0.1.8",
  availableVersion: "0.1.9",
  phase: "failed",
  stage: "install",
  checkedAt: "2026-11-05T17:57:00Z",
  lastAttemptAt: "2026-11-05T17:57:00Z",
  nextRetryAt: null,
  attempts: 1,
  errorCode: "installer_failed",
  summary: "The installer reported a failure.",
  receivedAt: "2026-11-05T17:59:00Z",
  ...changes,
});

test("old or missing telemetry is unknown and never a reported update failure", () => {
  const old = agentUpdateHealth(null, "0.1.6", "0.1.8", now);
  assert.equal(old.kind, "legacy");
  assert.equal(old.hasReport, false);
  assert.equal(old.behind, true);
  assert.match(old.reason, /does not report update diagnostics/);
  const modern = agentUpdateHealth(undefined, "0.1.8", "0.1.8", now);
  assert.equal(modern.kind, "missing");
  assert.equal(modern.behind, false);
  const unknown = agentUpdateHealth(null, undefined, "0.1.8", now);
  assert.equal(unknown.kind, "missing");
  assert.equal(unknown.behind, false);
  assert.equal(compareAgentVersions(undefined, "0.1.8"), null);
});

test("reported failures, retries and stale unconfirmed installs remain distinct", () => {
  const failed = agentUpdateHealth(status(), "0.1.8", "0.1.9", now);
  assert.equal(failed.kind, "failed");
  assert.equal(failed.stale, false);
  const retry = agentUpdateHealth(
    status({ phase: "retry_wait", nextRetryAt: "2026-11-05T18:30:00Z" }),
    "0.1.8",
    "0.1.9",
    now,
  );
  assert.equal(retry.kind, "retry_wait");
  assert.notEqual(retry.kind, "failed");
  const stale = agentUpdateHealth(
    status({ receivedAt: "2026-11-05T16:00:00Z" }),
    "0.1.8",
    "0.1.9",
    now,
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.label, "Failure last reported");
  const unconfirmed = agentUpdateHealth(
    status({
      phase: "installing",
      receivedAt: "2026-11-05T17:00:00Z",
      checkedAt: "2099-01-01T00:00:00Z",
    }),
    "0.1.8",
    "0.1.9",
    now,
  );
  assert.equal(unconfirmed.kind, "unconfirmed");
  assert.match(unconfirmed.reason, /failure is not confirmed/);
  const freshInstall = agentUpdateHealth(
    status({ phase: "installing", checkedAt: "2000-01-01T00:00:00Z" }),
    "0.1.8",
    "0.1.9",
    now,
  );
  assert.equal(
    freshInstall.kind,
    "progress",
    "freshness uses receivedAt, not the endpoint clock",
  );
});

test("version availability is separate from progress and historical reports", () => {
  const available = agentUpdateHealth(
    status({ phase: "current", summary: "Current at last check." }),
    "0.1.8",
    "0.1.9",
    now,
  );
  assert.equal(available.kind, "behind");
  assert.equal(available.behind, true);
  const oldFailure = agentUpdateHealth(
    status({ installedVersion: "0.1.7" }),
    "0.1.8",
    "0.1.8",
    now,
  );
  assert.equal(oldFailure.kind, "unknown");
  assert.equal(oldFailure.behind, false);
  assert.equal(oldFailure.olderReport, true);
  assert.equal(
    agentUpdateHealth(status({ phase: "disabled" }), "0.1.8", "0.1.9", now)
      .kind,
    "disabled",
  );
  assert.equal(
    agentUpdateHealth(status({ phase: "deferred" }), "0.1.8", "0.1.9", now)
      .kind,
    "deferred",
  );
  assert.equal(
    agentUpdateHealth(
      status({ phase: "current", availableVersion: "0.1.8" }),
      "0.1.8",
      "0.1.8",
      now,
    ).kind,
    "current",
  );
});

test("report merging ignores revoked endpoints and never downgrades fresher checkins", () => {
  const fresh = status({
    receivedAt: "2026-11-05T17:59:00Z",
    phase: "current",
  });
  const merged = mergeAgentUpdateRows(
    [
      {
        id: "one",
        hostname: "ONE",
        displayName: "Front desk",
        online: true,
        lastSeen: "2026-11-05T17:59:30Z",
        inventory: { agentVersion: "0.1.8" },
        updateStatus: fresh,
      },
      {
        id: "gone",
        hostname: "GONE",
        online: false,
        lastSeen: "2026-01-01T00:00:00Z",
        revoked: true,
      },
    ],
    [
      {
        endpointId: "one",
        endpointName: "Old name",
        hostname: "ONE",
        online: false,
        lastSeen: "2026-11-05T17:50:00Z",
        agentVersion: "0.1.7",
        updateStatus: status({ receivedAt: "2026-11-05T17:50:00Z" }),
      },
      {
        endpointId: "gone",
        endpointName: "GONE",
        hostname: "GONE",
        online: true,
        lastSeen: "2026-11-05T17:59:00Z",
        agentVersion: "0.1.8",
        updateStatus: fresh,
      },
    ],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].endpointName, "Front desk");
  assert.equal(merged[0].online, true);
  assert.equal(merged[0].agentVersion, "0.1.8");
  assert.equal(merged[0].updateStatus.phase, "current");
});

test("fleet advice no longer recommends a computer reboot to update the agent", () => {
  const issues = fleetHealth(
    [
      {
        id: "one",
        hostname: "ONE",
        online: true,
        lastSeen: "2026-11-05T17:59:00Z",
        inventory: { agentVersion: "0.1.6", uptimeSeconds: 40 * 86400 },
      },
    ],
    "0.1.8",
    now,
  );
  assert.match(
    issues.find((issue) => issue.key === "agent").advice,
    /agent-service-only restart/,
  );
  assert.doesNotMatch(
    issues.find((issue) => issue.key === "agent").advice,
    /after a reboot/,
  );
  assert.doesNotMatch(
    issues.find((issue) => issue.key === "uptime").advice,
    /agent update|agent itself/i,
  );
});
