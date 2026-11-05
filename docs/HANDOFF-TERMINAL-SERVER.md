# Persistent terminal server handoff — 2026-11-04

## Implementation

`server/src/terminals.mjs` exports `mountTerminal({db,audit,fail,str,insertJob,jobView,getJob,validationIntervalMs?})`, returning `mountConsole`, `mountAgent`, `cleanup`, and `shutdown`. Coordinator integration mounts these on the existing authenticated/CSRF-checked operator router and bearer-only agent router, and calls shutdown before closing the database.

The server stores terminal session and command authorization state; the persistent PowerShell process belongs to the Windows service. Every submitted command creates an ordinary **distinct at-most-once job** of internal kind `terminal` with payload `{sessionId,script}`. The public `/jobs` route cannot create this kind. Standard durable output chunks, progress, pagination and full downloads remain unchanged. Neither terminal state nor authority makes a consumed job eligible for replay.

Additive schema **8** creates `terminal_sessions` and `terminal_commands`, preserving existing data and consumed jobs. The latter stores a unique command idempotency key/request hash and first `authorized_at` timestamp. The same migration adds `show_session_details INTEGER NOT NULL DEFAULT 1` to both support policy and support session snapshot tables, for the coordinator's independent visible-indicator policy change. Migration is repeatable; the existing account migration test now expects version 8.

## Operator API

All routes begin `/api`, require admin/operator and the creator's **original login session**, and use normal cookie/Origin/CSRF rules. Another login by the same account cannot adopt this terminal. Viewer access to terminal routes is refused.

- `POST /terminals {endpointId,idempotencyKey}` → session (201 new/200 idempotent). Requires endpoint inventory agent version ≥0.1.7. At most four open sessions per endpoint. Session fields: `id,endpointId,endpointName,operatorName,status,workingDirectory,expiresAt,createdAt,closedAt,reason`. Initial status `open`, working directory null, fixed expiry two hours.
- `GET /terminals/:id` → session plus `jobs` in creation order, using normal job response shape.
- `POST /terminals/:id/commands {command,idempotencyKey,timeoutSeconds?}` → one normal job (201 new/200 idempotent). Script 1–262144 characters, must contain non-whitespace; timeout 1–3600 seconds, default900. One queued/dispatched/running job per terminal. A matching retry returns its original job even after completion/closure; reusing the key for different script/timeout returns409. New commands on closed sessions return409.
- `POST /terminals/:id/close {}` → closed session. Cancels only queued commands. Dispatched/running states and output remain unchanged. New sessions require new idempotency keys.

Session idempotency keys are scoped to the original login session; command keys to the terminal. Request fields are explicitly allowlisted. Audits contain lifecycle, job IDs and timeout metadata, never script text or process output.

## Agent API

The usual enrolled endpoint bearer credential is required; matching another endpoint's ID grants no authority.

- `POST /agent/terminals/:id/authorize {jobId,instanceId:UUID}` requires an open terminal, current enabled creator admin/operator login, endpoint, and matching running internal terminal job. First successful authorization durably binds the service instance and consumes this command's grant before replying `{expiresAt,workingDirectory}`. Every retry of the same authorization returns409. A different service instance closes the session with reason `agent_restarted`; it cannot restore variables or replay commands. A lost successful response must remain uncertain and must never be retried as execution.
- `POST /agent/terminals/:id/state {instanceId,jobId,status:'open'|'closed',workingDirectory?}` requires a matching authorized job and bound instance. `open` updates require a currently running job. `closed` may also use the last authorized succeeded/failed/interrupted job, so an idle process dying can close its server session; this permission only ends access. Working directory is optional null/text up to4096 characters; it is display/state data. Closure reason is the constant `agent_closed`, not caller-provided content.
- `POST /agent/terminals/validate {instanceId,sessionIds:[UUID…]}` accepts up to eight IDs and returns `{allowed:[IDs]}`. Only open, unexpired, originally logged-in, enabled admin/operator, nonrevoked endpoint, same bound instance sessions are allowed. Foreign endpoint IDs are ignored without mutation. A different instance closes the endpoint's session. An unbound terminal is not allowed but remains available for its first authorized command.

The coordinator's agent manager polls validation every10seconds and kills helpers on denial or network failure. Server cleanup also checks open sessions every5seconds; GET/command/authorization requests check synchronously. No session resumes after server startup or shutdown: all open rows close, queued jobs cancel, and consumed grants/history remain intact. A restored endpoint cannot undo server consumption.

## Verification

`cd server; node --test test/terminals.test.mjs` — **7/7 pass** using real HTTP and synthetic agents/databases:

- Cookie/CSRF/original-login scopes, viewer denial, old-agent rejection, session idempotency and four-session cap.
- Separate immutable jobs, command idempotency/conflicts, one outstanding command, endpoint isolation, five concurrent grant requests producing exactly one grant, working-directory state, and prior command history.
- Idle close with a completed authorized job; stale open updates and other instance closure denied.
- Close cancels queued only; dispatched/running commands never requeue or authorize after closure.
- Changed agent instance closes without restoring state; foreign endpoint validation cannot change it.
- Expiry, logout, role loss and endpoint revocation end authority.
- Separate app instances reopening one temporary database close sessions while preserving consumed jobs/grants; graceful shutdown closes new sessions.

`node --test test/endpoint-inventory.test.mjs test/accounts.test.mjs` — **6/6 pass** after schema8. Initial full-suite run had only the support policy test's stale schema7 assertion failing; coordinator owns its update alongside policy/monitor tests. No actual Windows terminal, service, VM, staff desktop or production endpoint was used by these protocol tests; real process persistence belongs to the coordinator's isolated agent integration/self-tests.

## Practical limits

One application process owns terminal lifetime. Horizontal replicas would close each other's sessions and need a deliberate ownership protocol. Password/session changes, role changes, logout, endpoint revoke, transport failure, timeout/process failure, server restart and two-hour expiry intentionally sacrifice live process state. Historical command jobs/output remain reviewable through ordinary job APIs. Uncertain outstanding commands require an operator to close the terminal and inspect before a new session; no automatic replay or state reconstruction exists.
