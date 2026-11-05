# Endpoint directory and diagnostic inventory — 2026-11-04

Agent slice: `agent/InventoryCollector.cs` and `agent/InventorySelfTests.cs`. Coordinator owns versioning, entry-point test registration, integration and rollout; other contributors own API normalization and endpoint UI. No endpoint was restarted, repaired, queried remotely or otherwise changed by this work.

## Additive contract

Existing domain membership fields remain authoritative. Missing new fields from an older agent mean not reported, not a negative finding.

```text
directory: {
  distinguishedName: string|null,
  canonicalName: string|null,
  organizationalUnits: string[], // decoded OU names, ROOT to LEAF
  domainController: string|null,
  site: string|null,
  error: string|null
}
hardware: {manufacturer,model,serialNumber,biosVersion} // nullable strings
networkAdapters: [{name,mac,ipv4:[],gateways:[],dnsServers:[],dhcpEnabled:boolean|null}]
pendingReboot: boolean|null
pendingRebootReasons: string[]
uptimeSeconds: number|null
inventoryCollectedAt: UTC ISO string
```

Workgroup computers receive an empty directory object with null fields, an empty OU list and no lookup error; `domainJoined:false` identifies that case. Joined computers with unavailable/offline AD retain `domainJoined:true` and report unknown directory facts plus an explanatory error. No controller is inferred from the service account's `LOGONSERVER` variable.

## Active Directory lookup

- Uses Windows PowerShell 5.1/.NET Framework `System.DirectoryServices`, requiring no RSAT module or extra endpoint dependency.
- The machine domain comes from `Domain.GetComputerDomain()`, controller from `FindDomainController().Name`, site from that controller's site metadata.
- LDAP binds to the selected controller's RootDSE, reads `defaultNamingContext`, and performs one subtree search for the escaped computer `sAMAccountName` ending in `$`. Secure authentication, LDAP signing and sealing are requested; no clear-text password or alternate credentials are used. Properties requested: `distinguishedName`, `canonicalName`; one-result limit, no referral chasing, two-second client/server search limits.
- ALL discovery, bind and search operations run in a separate hidden PowerShell process with a hard **five-second process timeout**, including process startup. DirectorySearcher timeout alone would not bound controller discovery/initial bind. Timeout terminates that process tree, reports a directory error, and preserves ordinary inventory. It does not create or rerun a management job.
- Progressive JSON snapshots preserve a discovered DC or computer DN when a later step times out. Unknown facts remain null. Directory bounds match the server: DN/canonical 4096 chars, DC/site 512, at most 64 OU names of 512 chars, error 1000. Bounds cause an explicit directory warning instead of failing all inventory.
- DN hierarchy parsing handles escaped commas/backslashes/plus signs, quoted values, and UTF-8 hexadecimal escapes. `CN=Computers` is a container rather than an OU; it is not invented as an OU name. Raw DN/canonical path retain container information.

## Local diagnostics

Manufacturer/model come from the existing local computer CIM result. BIOS serial/version are optional local `Win32_BIOS` data (five-second CIM operation timeout). Active non-loopback NIC data uses local .NET network-interface properties: adapter name, colon-formatted MAC, IPv4 addresses, configured gateways and DNS servers, DHCP when available. No DNS lookup or remote network probe is performed for those fields.

Reboot status is a read-only registry-indicator summary: component servicing, Windows Update, pending file renames, differing configured/active computer names, and pending Netlogon membership indicators. A known positive gives `true`; no indicators with successful reads gives `false`; unreadable required indicators with no known positive give `null`. Reasons describe indicators rather than proving a reboot will fix a problem. Registry is never modified. Uptime derives from the existing boot timestamp; negative clock skew is clamped to zero.

## Verification

Release build with warnings as errors passed. New self-test code covers LDAP and PowerShell literal escaping; normal/escaped/quoted/UTF-8 OU hierarchies; CN-container distinction; complete and partially timed-out results; safe unknowns; explicit bounds; and parsing both actual PowerShell scripts with the Windows PowerShell AST without executing LDAP or repair operations.

`InventorySelfTests.RunAsync` is registered and passed in the ordinary agent `--self-test` run; it also passed through an isolated ignored harness. Coordinator runs the existing real-agent/API integration to verify actual local inventory output and server acceptance. No AD domain controller is available in this development environment, so real domain discovery/LDAP authorization/site reporting require a test endpoint on the library domain after rollout. No claim of real AD connectivity testing is made.

Primary API references: [DirectorySearcher timeouts](https://learn.microsoft.com/en-us/dotnet/api/system.directoryservices.directorysearcher.clienttimeout), [LDAP filter escaping](https://learn.microsoft.com/en-us/windows/win32/adsi/search-filter-syntax), [distinguished-name escaping](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ldap/distinguished-names).

Checkpoint: this slice's Release compilation and registered inventory self-tests passed. No new repairs/domain/endpoint actions were performed. Further integration and rollout paused at the user's usage-budget handoff; coordinator owns the final package/version and real API acceptance test. Terminal work in the same agent currently has a separate confirmed conhost-counting race; see `HANDOFF-TERMINAL-AGENT.md` before claiming the overall suite green.
