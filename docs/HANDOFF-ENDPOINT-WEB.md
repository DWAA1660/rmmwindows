# Endpoint groups and diagnostics UI handoff — 2026-11-04

## Delivered

- Updated `web/src/EndpointGroups.tsx`, preserving its existing public props and behavior for group creation/edit, full-group selection, bulk jobs and membership moves. Scoped `EndpointGroups.css` adds a selected-group heading with discoverable **Edit group** / **Delete group** buttons.
- Custom-group deletion opens a concrete inline confirmation with group name, current membership count, destination selector (default New endpoints), and explicit statement that computers are not deleted/revoked/uninstalled/rebooted and that jobs/history remain. The selected destination is sent through existing `DELETE /api/groups/:id {moveToGroupId}`. Deleting a group clears selected endpoints, switches to the destination and refreshes. No production group was deleted or moved during development.
- Permanent New endpoints displays **Default group · protected**, without edit/delete actions. Viewer/read-only mode has no management controls or mutation forms; role changes close any open editor/confirmation. Errors and success appear in live inline feedback. Existing group action limit250 is retained.
- New `web/src/EndpointDirectory.tsx` exports `EndpointDirectory({inventory})`, accepting optional/unknown inventory for compatibility with the existing parent type. Root owns import and endpoint-detail placement. `EndpointDirectory.css` is self-contained and responsive.
- Read-only diagnostics presentation includes AD membership with separate joined/workgroup/unknown states; root-to-leaf decoded OU names; full distinguished name/copy; canonical name; domain controller and site; offline/failed directory lookup message that does **not** override membership; manufacturer/model/serial/BIOS; adapter IPv4/MAC/gateways/DNS/DHCP state; nullable pending reboot plus reasons; uptime and collection time.
- Missing or legacy diagnostic fields stay unknown. Old agents show **agent0.1.7 or later + refresh inventory required**. No absent/null field is interpreted as “not domain joined” or “no reboot pending.” Explicit existing `domainJoined:false` is respected as reported Windows workgroup membership. Pending reboot false is described as no checked indicator reported in that snapshot, not a guarantee of current system state.

## Agreed inventory extension

Agent/server contract:

```ts
directory: null | {
  distinguishedName: string | null;
  canonicalName: string | null;
  organizationalUnits: string[]; // decoded names, root to leaf
  domainController: string | null;
  site: string | null;
  error: string | null;
};
hardware: null | {manufacturer: string|null; model: string|null; serialNumber: string|null; biosVersion: string|null};
networkAdapters: {name:string|null; mac:string|null; ipv4:string[]; gateways:string[]; dnsServers:string[]; dhcpEnabled:boolean|null}[];
pendingReboot: boolean | null;
pendingRebootReasons: string[];
uptimeSeconds: number | null;
inventoryCollectedAt: string | null; // ISO timestamp
```

Existing `domainJoined`, `domain` and `agentVersion` supply membership/version. A workgroup can report an empty directory object; lookup errors can occur on joined endpoints. The model never attempts a new LDAP lookup or parses/reorders the supplied distinguished name.

## Verification

- `npm test --prefix web`:7/7 pass, including3 new focused model tests in `web/test/endpoint-directory.test.mjs`.
- Tests cover missing/legacy unknowns, version requirement, OU root-to-leaf order and comma-bearing names, full DN preservation, joined/offline lookup error without false workgroup fallback, explicit pending reboot/reasons, nullable hardware/adapters/DHCP, invalid timestamps/uptime and display duration.
- `npm run build --prefix web`: strict TypeScript and Vite production build pass after these components (before root's pending `EndpointDirectory` placement).
- Browser visual checks and real0.1.7 inventory collection are coordinator/agent follow-up work. No live AD/network/reboot configuration is changed by these views.

## Limits

Snapshots reflect collection time. Unreported values may mean an older agent, lookup failure, inaccessible provider or no collected data; they are not inferred. AD groups/OU editing, domain join/leave, driver changes and network changes are not provided. A default AD `CN=Computers` container can legitimately produce no OU names; full DN/canonical name remains available. Directory and local RMM organizational groups are separate concepts.
