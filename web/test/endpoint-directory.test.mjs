import { test } from "node:test";
import assert from "node:assert/strict";
import {
  endpointDiagnostics,
  diagnosticUptime,
} from "../src/endpointDirectoryModel.ts";

test("missing and legacy diagnostics remain unknown rather than false negatives", () => {
  const empty = endpointDiagnostics(undefined);
  assert.equal(empty.membership, "unknown");
  assert.equal(empty.pendingReboot, null);
  assert.equal(empty.hasExtendedReport, false);
  const old = endpointDiagnostics({
    agentVersion: "0.1.6",
    domainJoined: true,
    domain: "library.example",
    directory: null,
    hardware: null,
    networkAdapters: [],
    pendingReboot: null,
  });
  assert.equal(old.membership, "joined");
  assert.equal(old.requiresUpgrade, true);
  assert.equal(old.directory.distinguishedName, null);
  assert.equal(old.pendingReboot, null);
  assert.equal(old.hasExtendedReport, false);
  assert.equal(
    endpointDiagnostics({ agentVersion: "0.1.7", domainJoined: false })
      .membership,
    "workgroup",
  );
  assert.equal(
    endpointDiagnostics({ agentVersion: "1.0.0" }).requiresUpgrade,
    false,
  );
});

test("AD hierarchy order, offline lookup error and explicit pending reboot survive presentation", () => {
  const result = endpointDiagnostics({
    agentVersion: "0.1.7",
    domainJoined: true,
    domain: "library.example",
    directory: {
      distinguishedName:
        "CN=Desk,OU=Research\\, Public,OU=Library,DC=library,DC=example",
      canonicalName: "library.example/Library/Research, Public/Desk",
      organizationalUnits: ["Library", "Research, Public"],
      domainController: null,
      site: "Main site",
      error: "Directory lookup timed out.",
    },
    pendingReboot: true,
    pendingRebootReasons: ["Windows Update"],
    inventoryCollectedAt: "2026-11-04T18:20:00Z",
    uptimeSeconds: 90061,
  });
  assert.deepEqual(result.directory.organizationalUnits, [
    "Library",
    "Research, Public",
  ]);
  assert.equal(result.membership, "joined");
  assert.equal(result.directory.error, "Directory lookup timed out.");
  assert.equal(result.directory.domainController, null);
  assert.equal(result.pendingReboot, true);
  assert.deepEqual(result.pendingRebootReasons, ["Windows Update"]);
  assert.equal(result.hasExtendedReport, true);
  assert.equal(result.requiresUpgrade, false);
  assert.equal(diagnosticUptime(result.uptimeSeconds), "1d 1h 1m");
});

test("workgroup and adapter fields handle nullable diagnostics without inventing values", () => {
  const result = endpointDiagnostics({
    domainJoined: false,
    domain: "WORKGROUP",
    directory: { distinguishedName: null, organizationalUnits: [] },
    hardware: {
      manufacturer: "Vendor",
      model: "Model",
      serialNumber: null,
      biosVersion: "1.2",
    },
    networkAdapters: [
      {
        name: "Ethernet",
        mac: null,
        ipv4: ["10.0.0.4"],
        gateways: [],
        dnsServers: ["10.0.0.1"],
        dhcpEnabled: null,
      },
    ],
    pendingReboot: false,
    inventoryCollectedAt: "invalid",
    uptimeSeconds: -2,
  });
  assert.equal(result.membership, "workgroup");
  assert.equal(result.pendingReboot, false);
  assert.equal(result.networkAdapters[0].dhcpEnabled, null);
  assert.deepEqual(result.networkAdapters[0].gateways, []);
  assert.equal(result.inventoryCollectedAt, null);
  assert.equal(result.uptimeSeconds, null);
  assert.equal(result.hardware.serialNumber, null);
  assert.equal(diagnosticUptime(null), "Not reported");
  assert.equal(diagnosticUptime(3599), "59m");
});
