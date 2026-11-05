# Endpoint/terminal/support improvements — work in progress handoff

Updated2026-11-04. Primary entry: CONTINUE-HERE.md. Current source feature/endpoint-terminal, production main065dc07 remains unchanged. User requested this immediate written checkpoint before usage exhaustion; no further feature work should replace documentation priority.

## Component ownership and current files

- windows_agent: InventoryCollector.cs, InventorySelfTests.cs; SupportProtocol/SelfTests; companion DesktopInput/SupportWindow, monitor geometry; now TerminalShell/TerminalSelfTests diagnostic fixes. Handoffs ENDPOINT-INVENTORY, REMOTE-AGENT, TERMINAL-AGENT.
- server contributor: canonicalInventory function and endpoint-inventory tests; new terminals.mjs, terminal tests, schema8 and accounts expectation; new TerminalConsole.tsx/CSS/UIhandoff.
- web contributor: EndpointGroups/CSS, EndpointDirectory/model/CSS/tests, RemoteSupport/CSS, SupportSettings, ENDPOINT-WEB/REMOTE-WEB handoffs.
- root: AgentWorker/Program DI, TerminalManager, expanded real-agent integration, main.tsx integration, support.mjs relay/settings, support tests/schema expectations, versions0.1.7 and master docs.

## Terminal architecture/API summary

Each session keeps one hidden Windows PowerShell process; every command is a DIFFERENT immutable at-most-once job with normal paginated/downloadable output. Server sessions are tied to endpoint+creator's original login, expire2hours, max4open/endpoint; a single outstanding command/session. Internal terminal jobs cannot be created through POST/jobs. A fresh durable job/start AND a first-only terminal command authorization must succeed before writing to the process. Agent service instance UUID binds the runspace; restart/rollback/changed instance cannot recreate state. Server restart/shutdown closes sessions and cancels queued jobs only.

- POST /api/terminals{endpointId,idempotencyKey} ->session, minagent0.1.7.
- GET /api/terminals/:id ->session+jobs.
- POST /api/terminals/:id/commands{command,idempotencyKey,timeoutSeconds?1..3600(default900)} ->job.
- POST /api/terminals/:id/close{} closes/cancelsQUEUEDonly.
- AgentPOST /api/agent/terminals/:id/authorize{jobId,instanceId} ->{expiresAt,workingDirectory}, onceonly; no retry on lost response.
- AgentPOST /api/agent/terminals/:id/state{instanceId,jobId,status:open|closed,workingDirectory?}; idle close accepts last authorized completed job, open requiresrunning.
- AgentPOST /api/agent/terminals/validate{instanceId,sessionIds[]} ->{allowed:[]}. Manager polls5seconds with5second deadline; network failure/revocation/closure kills shell, no reconnection.

TerminalShell uses a private same-user pipe verified by client PID; process receives per-command Base64 script and random byte fence, dot-sourced to preserve user variables/functions/cwd. Raw stdout/stderr pumps remove fences before adaptive decoding; chunks go straight to durable normal journal. Native stdin EOF; Read-Host/interactive full-screen apps unsupported. Timeout/exit/close ends whole session. Windows job object owns descendants and kills them on agent death. Background descendants with shared output must be handled explicitly, never silently attributed to a later command.

**Current blocker:** job accounting >1 falsely detects a normal console host/transient child and interrupts first command. Reproduced locally twice and full integration. See CONTINUE-HERE and TERMINAL-AGENT notes. Do not ship until fixed/repeatedly tested. Pump spool-failure kill also needs review.

## Inventory contract (agent0.1.7)

Existing inventory fields remain compatible. Newoptional known fields:

- directory{distinguishedName,canonicalName,organizationalUnits:[root→leaf names],domainController,site,error}; absent/unavailable areunknown, not false claims.
- hardware{manufacturer,model,serialNumber,biosVersion}.
- networkAdapters:[{name,mac,ipv4:[],gateways:[],dnsServers:[],dhcpEnabled:boolean|null}].
- pendingReboot:boolean|null,pendingRebootReasons:[],uptimeSeconds:number|null,inventoryCollectedAt:ISO|null.

ADlookup runs separately with hard5second deadline so offline DC/LDAP cannot block base inventory/heartbeat; no RSAT requirement, no SYSTEM LOGONSERVER assumption, LDAP filter/DN escaping tested. Windows directory placement and RMM endpoint groups are separate things; UI must not imply moving an RMM group moves AD OU.

## Remote support contract additions

Latest user explicitly wants independently configurable approval form and post-start indication, including **bothoff**. No banner/icon/tray/window is required when showSessionDetails=false. Emergency stop hotkey still works even hidden; expiry/audit/login and endpoint scopes remain. Defaults remain approvaltrue/15seconds/indicatortrue. Do not change production settings while testing. Earlier permanent-indicator / initial-notice-only restrictions were explicitly superseded.

Schema8 adds show_session_details DEFAULT1 to support_settings and support_sessions. GET/PATCH /settings/support adds showSessionDetails:boolean; omission preserves stored choice for older callers. Snapshot/claim/session expose it. Older0.1.6 support may keep defaultindicator; hidden setting requires0.1.7 (server currently gates on create). Companion supports both-off without initial flash. Hidden sessions end at lock/UAC/hardware reconfiguration; no hidden waiting-to-resume.

Device announces{type:displays,displays:[{id,name,width,height,isPrimary}]}(max16); selected metadata{type:display,id,width,height}. Browser sends{type:selectDisplay,displayId}. Relay validates known IDs, releasesinput, pausesframes/input, forwardsselection; companion releaseskeys, pauses, selectsactualScreenbounds, acknowledgesmatchingmetadata, resumes, then sendsfreshJPEG. Browser dropsoldframes/clears, requiresnewmatchingmetadata+unpaused+freshframe beforeuse; controlre-enableexplicit. Nativebounds and scaledJPEG dimensions remain separate; negativeoffsetcoordinate tests pass. Root relay implementations are present but new WS policy/monitor regression tests and browser QA are pending.

## Verification / release gate

Completed checks and exact failing evidence are in CONTINUE-HERE and latest PROGRESS. No full feature CI/package/browser/deployment done. Existing production0.1.6 remains healthy with prior default visible indicator. Do not merge/push this unfinished branch to main. Source and MD should be checkpointed on this feature branch after contributors finish their immediate notes; protect all other local changes.
