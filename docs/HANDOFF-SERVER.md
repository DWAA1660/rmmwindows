# Server handoff — 2026-11-04

## Implemented

`server/src/index.mjs` launches Express on `HOST` (default `127.0.0.1`) / `PORT` (default 3000), starts a 15-second schedule tick, and handles graceful SIGTERM/SIGINT. `src/app.mjs` exports an injectable app/database factory for integration tests. Node 24+ required for built-in `node:sqlite`. Only external runtime dependency: Express 5 (locked in package-lock.json).

SQLite WAL with synchronous FULL stores administrator password hashes, hashed opaque sessions, hashed endpoint credentials/enrollment tokens, inventory, scripts, schedules, occurrences, jobs, every output chunk and audit events. First startup fails unless `ADMIN_USERNAME` and `ADMIN_PASSWORD` (14+ characters) are supplied. Existing administrator credentials are never overwritten on restart. Bootstrap password can be removed from container environment after account creation. Password reset/user management API remains follow-up work.

The full API in `docs/API.md` is implemented. Lists are arrays. Enrollment token creation returns `{token,...metadata}` once; listing never returns token/hash. `auth/login` returns the same `{user,csrfToken}` shape as `auth/me` and sets a 12-hour opaque HttpOnly SameSite=Strict cookie. Operator mutations require matching `Origin` and `X-CSRF-Token`; agent bearer credentials cannot authorize operator endpoints. Login and enrollment are rate limited. `TRUST_PROXY=1` enables one trusted proxy for client IP; only set behind the owned proxy with the container inaccessible externally and forwarded headers overwritten.

Inventory is normalized to the canonical field/collection types and rejects malformed arrays, invalid metrics and excessive counts/text. Unavailable numeric/text values remain null. Disk and software lists are bounded by the overall 1.5MB inventory size; oversized inventories fail explicitly instead of silently truncating. Endpoint revocation cancels only queued jobs and immediately disables the credential. Explicit reenrollment after revocation rotates the token and preserves the endpoint ID/history.

## Execution invariants

- Claim atomically changes `queued` to `dispatched`, stores only a dispatch token hash, and never redelivers. Start transitions `dispatched` to `running` exactly once; subsequent valid starts return `{mayExecute:false,status}`.
- Server restart, endpoint rollback, lost acknowledgments, timeouts and missed checkins never requeue jobs. Unresolved dispatched/running states remain visible for operator inspection; there is no automatic retry or inference of successful execution.
- Agents may complete a `dispatched` job only as `interrupted` (for uncertain claim/start responses). Running jobs can complete succeeded/failed/interrupted. Repeated matching completion is idempotent; conflicts return 409.
- Output new chunks must arrive contiguously beginning at sequence zero. Exact retries are idempotent, conflicting retries/gaps are rejected. Maximum chunk size is 65536 UTF-8 bytes, with no overall output cap. Output may be recovered after terminal completion.
- Read output with `after`/`limit`; cursor and `hasMore` indicate more pages. Download writes all accepted chunks in order, preserves exact emitted text, and honors HTTP backpressure. It does not add prefixes or strip stderr. A download of a running job contains accepted output through the time the query reaches its end, not future output.
- Bulk creation supports operator-scoped `idempotencyKey`; reuse with a different request fails. Cancel is allowed only before dispatch. Storage jobs accept absolute local drive paths, excluding UNC paths.

## Scheduling details

Intervals are 5–525600 minutes. Each due timestamp gets a unique occurrence row in the same transaction as job creation. A delayed tick advances directly to a future timestamp and skips intervals missed by at least one entire period. Schedules skip offline endpoints (>120 seconds since checkin) and endpoints with an unresolved occurrence of the same schedule, rather than accumulating or overlapping scripts. Re-enabling starts one interval into the future. Script contents are snapshotted into jobs at creation; updating a script changes future occurrences. Deleting a referenced script returns 409 until its schedules are deleted.

## Environment and update helper

`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `DATABASE_PATH`, `HOST`, `PORT`, `PUBLIC_ORIGIN`, `COOKIE_SECURE`, `TRUST_PROXY`, `APP_VERSION`, `UPDATE_HELPER_URL`, `UPDATE_HELPER_TOKEN`, optional `UPDATE_IMAGE`.

Production must set `PUBLIC_ORIGIN=https://rmm.parkcountylibrary.org` and `COOKIE_SECURE=true`. Set `HOST=0.0.0.0` only inside the isolated Docker container. The app never mounts Docker socket or invokes Docker/Git. Updates call the root-owned helper: `GET /status`, `POST /update` with `Authorization: Bearer <UPDATE_HELPER_TOKEN>` and `{}` JSON body. The operator's update request is audited. `GET /api/settings` reports `{version,updateEnabled,updateImage,publicOrigin,screenViewingEnabled:false,executionPolicy:'at-most-once'}`. The helper is disabled unless URL and token both exist.

Static SPA is served from `web/dist` relative to project root (`/app/web/dist` when server is `/app/server`). API missing routes return JSON errors. Security headers include CSP, frame blocking, MIME sniff prevention and HSTS with secure cookies. No CORS is enabled.

## Verification

`cd server; npm test` — 8 integration tests passed on Node 26.13.0 / Windows. Tests cover:

- No default administrator; cookie/CSRF/origin/session isolation.
- Use-limited enrollment, hashed secrets, revocation and explicit reenrollment.
- Canonical inventory validation and null metrics.
- Concurrent claim/start (10 requests each), endpoint isolation and idempotent bulk reboot requests.
- More than 1MB of mixed stdout/stderr and Unicode text, exact pagination/download, duplicate/mismatched uploads, byte limits and sequence gaps.
- A regression with many small astral-Unicode/emoji chunks, exact full download and a bounded request timeout.
- Persisted consumed dispatch across independent server instances and interrupted recovery.
- One schedule occurrence, overlap prevention and downtime backlog skip.

`node deploy/test-agent-integration.mjs` — PASS against the real **.NET 10 Windows agent** and real API, with temporary enrollment/config/database and no service installation. Final validation used checkout-local SDK 10.0.403; net10.0-windows build and API smoke completed in 5.1 seconds with 67 chunks. Verified exactly 300000 UTF-8 stdout bytes containing checkmarks/emoji, independent stderr, sequenced pagination, exact complete download, and no redispatch of the completed command. The test builds the agent, runs one harmless output-only PowerShell command, kills its own console agent and removes its isolated temporary state. Launcher selects `DOTNET_PATH`, then checkout-local `artifacts/dotnet-sdk/dotnet.exe` when present, then PATH `dotnet`; it requires the .NET 10 DLL and never falls back to an older target.

The real-agent test exposed a download hang missed by the original larger plain-text chunks: direct HTTP writes of SQLite-returned Unicode strings stalled during backpressure. Explicit UTF-8 `Buffer` writes fixed the observed failure; both the focused regression and two consecutive real-agent runs now pass. The test harness has phase logs, bounded HTTP timeouts, a safe high loopback port (this workstation's ephemeral range can include fetch-forbidden ports), and forced closure of its own keep-alive connections on teardown.

The original stalled integration test's isolated temporary directory `C:\Users\datnip\AppData\Local\Temp\library-rmm-e2e-gzLBS0` remains after its two identified test processes were terminated. Automatic approval review rejected cleanup with the stated reason `blocked by policy`, including a narrower explicit-file cleanup. It contains only the abandoned private test database/config/scripts, with random test-only credentials; no production credentials. Later passing runs cleaned their own temporary state. No further deletion attempts are needed for release.

## Follow-up limitations

One administrator role; no MFA/SSO/RBAC or password change UI yet. No automatic retention pruning (preserving output is intentional); monitor and back up volume capacity. No real screen viewing endpoint. No default/demo fleet or fake metrics. Production host/agent smoke tests and release packaging are owned by root. SQLite schema is version 1; later schema changes need explicit migrations that preserve consumed jobs/occurrences/output. Health, login, token-gated agent enrollment and public installer distribution can be reached without an operator session; management and enrollment-token creation require authentication. Running jobs with an irrecoverably lost endpoint journal remain unresolved instead of being retried.

## Website distribution follow-up

`src/downloads.mjs` mounts explicit public metadata, ZIP/checksum and bootstrap routes before operator middleware. Bundled archive integrity is checked at startup and metadata uses a field allowlist. The bootstrap template uses configured HTTPS PUBLIC_ORIGIN only, never Host headers; no tokens are embedded. Missing-package development builds return explicit503. Docker cross-publishes/packages the Windows x64 agent and copies all runtime files with `--chown=node:node`, preserving readability even when the privileged updater checks out files with restrictive permissions. `test/downloads.test.mjs` adds public distribution/auth-boundary/tamper tests (server suite now10); `test/container-smoke.mjs` runs against the completed image as non-root and downloads/rehashes its actual archive.
