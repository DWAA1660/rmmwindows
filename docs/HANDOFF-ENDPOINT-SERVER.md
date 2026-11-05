# Endpoint diagnostics server handoff — 2026-11-04

## Additive inventory contract

The agent, server and web contributors agreed these optional inventory fields:

```text
directory: null | {
  distinguishedName: string|null, canonicalName: string|null,
  organizationalUnits: string[], domainController: string|null,
  site: string|null, error: string|null
}
hardware: null | {manufacturer, model, serialNumber, biosVersion} // nullable strings
networkAdapters: [{name: string|null, mac: string|null, ipv4: string[],
  gateways: string[], dnsServers: string[], dhcpEnabled: boolean|null}]
pendingReboot: boolean|null
pendingRebootReasons: string[]
uptimeSeconds: number|null
inventoryCollectedAt: ISO timestamp with timezone|null
```

Organizational units are decoded OU **names**, root to leaf, including literal commas/Unicode; `distinguishedName` retains the original LDAP escaping. Existing `domainJoined` distinguishes a workgroup from a domain lookup failure. Directory errors are collection-status data; they never grant directory access. Uptime may contain fractional seconds. Collection timestamps normalize to UTC millisecond precision like existing inventory dates.

`canonicalInventory` in `server/src/app.mjs` deep-whitelists all nested fields. Unknown properties are dropped. Absent/null parent objects become null, absent/null arrays become empty arrays, and absent metrics/booleans become null. Older agents keep working; unavailable data is never invented as false or zero. A heartbeat without an inventory preserves the prior snapshot. An invalid checkin is rejected before replacing it. All original inventory fields and behavior are unchanged.

Bounds: directory DN/canonical name 4096 characters; 64 OU names of 512 characters; DC/site 512; collection error 1000. Hardware manufacturer/serial 256; model/BIOS 512. At most128 network adapters, name512/MAC100 characters; each address collection at most128 entries of100 characters. At most64 reboot reasons of512 characters. Nonnegative finite uptime at most JavaScript's maximum safe integer. ISO timestamp text at most64 characters and requires a timezone. Existing whole-inventory and HTTP body limits remain effective; oversized data is rejected explicitly, not truncated.

## Verification

`cd server; node --test test/endpoint-inventory.test.mjs` — **3/3 pass**. Synthetic real HTTP tests cover exact nested roundtrip, escaped-comma OU data, false/zero/null values, unknown-property removal, heartbeat preservation, old-agent compatibility, directory lookup error state, and28 malformed/over-limit inputs rejected atomically. No actual endpoint, VM, LDAP query, shell job or production host was used by this test.

Only the `canonicalInventory` function was changed in app.mjs; the coordinator owns persistent-terminal integration elsewhere in that file.
