# Terminal UI usage handoff — checkpoint 2026-11-04

## Current files and status

New component source exists in `web/src/TerminalConsole.tsx` and `web/src/TerminalConsole.css`. This contributor changed no main-app files. The component was typechecked by `cd web; npm run build` and the Vite production build passed. One final bounded fix was applied immediately before this documentation checkpoint: a ref now retains an unresolved command request and prevents Enter/normal Run from generating a new request ID after an uncertain send. **Build has not been rerun after that final guard.** No more implementation is being done after this checkpoint at the user's urgent usage handoff request. Coordinator is not deploying this unfinished branch.

Export:

```tsx
TerminalConsole({
  endpoint: { id: string, hostname: string, displayName?: string, online?: boolean },
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>,
  onClose: () => void,
  onError: (error: unknown) => void
})
```

Pass the normal console API callback whose paths omit `/api` and already handle cookie/Origin/CSRF. Endpoint changes remount the internal lifecycle by endpoint ID. Caller must wire the endpoint's persistent-terminal action to this component and verify it is the intended action instead of the old one-shot shell dialog. No Linux server terminal is exposed here.

## Implemented behavior

- Own accessible modal markup, heading/description, focus trap/restore, Escape and explicit X labels. Closing an established live terminal awaits `POST /terminals/:id/close` before dismissing; failure retains the modal with an error. End closes the PowerShell process at the agent's next validation, about10seconds. Closed sessions remain inspectable until dismissed.
- Creates a terminal once on mount with a stable idempotency key and shared promise to tolerate React StrictMode replay. Explicit opening retry reuses the key. Server requires agent0.1.7+ and binds the session to the original enabled admin/operator login.
- Polls the terminal and job list each second. Reads output with stable per-job cursors, up to ten200-chunk pages per poll, continuing backlog on subsequent polls. Every received chunk is retained; there is no output tail slicing or length cap. Earlier pages remain visible if a later request fails. Finished output is periodically rechecked to accept late recovered chunks.
- Collapsible per-command history with status, exit code, summary, existing `progressOutput` rendering, emitted percentage, stdout/stderr/system styling and a full attachment download link. Earlier history collapses when a new command is accepted; output remains in component memory and on the server. Auto-follow can be turned off while reading.
- Bottom command editor stays open after commands, displays last reported working directory, supports Enter to run, Shift+Enter for multiline, and Up/Down history only at the first/last editor line. One command at a time; default15minute timeout, choices up to60minutes. Failing commands allow another command when the terminal remains open.
- An uncertain POST holds its exact command, timeout and idempotency key. **No automatic execution retry.** The explicit “Retry same request” button uses that same body/key; it returns the existing job or queues it once if the first request never arrived. Normal Run and Enter are blocked by the retained request ref until this is resolved or the session ends.
- Shows endpoint offline, server/transport errors, agent compatibility errors, expiry and closure reasons. Commands are disabled after expiry/closure or while offline. Variables/functions/current folder are documented as belonging to the same Windows PowerShell process; commands must finish without prompts.

## Server contract and completed work

The separate server slice is implemented in `server/src/terminals.mjs`, schema8 in `server/src/db.mjs`, with seven synthetic real HTTP lifecycle tests passing. See `docs/HANDOFF-TERMINAL-SERVER.md`. Endpoint directory/hardware/network/reboot inventory canonicalization and three HTTP tests also pass; see `docs/HANDOFF-ENDPOINT-SERVER.md`. Coordinator owns terminal manager/agent integration, main-app integration and all remote-support policy/monitor work.

Component API calls:

- `POST /terminals {endpointId,idempotencyKey}` → session.
- `GET /terminals/:id` → session plus normal job objects.
- `POST /terminals/:id/commands {command,timeoutSeconds,idempotencyKey}` → normal job.
- `POST /terminals/:id/close {}` → closed session.
- `GET /jobs/:id/output?after=...&limit=200` → chunks/cursor/hasMore.
- Same-origin attachment `/api/jobs/:id/download` retains exact stored text, including stderr.

## Remaining verification / limits

1. Rerun `cd web; npm run build` after the final retained-request guard and coordinator integration. Then run the final server suite; the last full suite before coordinator support changes only failed a support test's stale schema7 assertion (actual8), not terminal or inventory tests.
2. Coordinator must verify the main action opens this component and no conflicting legacy shell is still shown. Verify real persistent variables/functions/current-directory behavior through the coordinator's isolated agent test. No VM/service/native desktop testing was performed by this contributor.
3. Browser QA remains: create/open errors, one-command lock, Enter/multiline/history, CR progress, many output pages, collapse/reopen, disabling follow, downloads, expired/closed sessions, uncertain POST explicit same-key retry, End failure/retry, focus trap and mobile layout. No visual screenshot/browser interaction was performed for this component.
4. Unmount/pagehide attempts an authenticated close through the provided callback. The callback abstraction does not expose headers or keepalive, so a browser navigating away may cancel that request. Normal X/End awaits server confirmation. The server's two-hour fixed expiry and login/revocation checks remain the fallback; no silent execution retry or reconstructed session is added.
5. Full accepted output is held in browser memory while this modal is open. Collapsing a command removes its large output DOM but retains chunks. Very large sessions may use substantial memory; full server download remains available. No virtualization or memory cap is implemented, so output is never silently discarded.

The persistent-terminal process implementation, dual-monitor transport and compact visible support indicator are separate coordinator/agent/web tasks and must be reviewed with their own handoffs before merging/deploying.
