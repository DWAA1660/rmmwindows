# Park County Library RMM

## Initial design — 2026-11-04

Self-hosted Linux application at https://rmm.parkcountylibrary.org. Node 24 LTS/Express API with SQLite WAL durable state, React/Vite console, .NET 10 LTS Windows worker service installed as LocalSystem. Agents make outbound HTTPS requests only. SQLite and output live in a persistent Docker bind mount. Existing host websites must remain operational.

## Safety and delivery semantics

Jobs are at-most-once, not exactly-once. Server atomically consumes a queued job into dispatched; it never dispatches it again. Agent obtains an explicit durable start authorization before side effects. A second start request cannot authorize another execution. Lost responses may prevent execution; operator must inspect and create a new job. This prioritizes avoiding repeat reboots/scripts with Reboot Restore over automatic recovery. Local agent journals improve output recovery but are not the replay authority. A restored endpoint snapshot cannot reset server job state.

Job kinds: `powershell`, `reboot`, `inventory`, `storage`, `files` (remote file explorer: list/delete/move/copy/rename/mkdir/download, one operation per job, see API.md). Agents long-poll `jobs/claim` (`waitSeconds:20`) so a queued job starts within moments; the claim is the same single atomic transaction, so long-polling does not change at-most-once semantics. File downloads are uploaded in raw chunks to disk beside the database (bounded by per-file/total caps and 7-day expiry), never into the web root. PowerShell is noninteractive, hidden, elevated by LocalSystem service identity. Each job is a fresh PowerShell process, not a persistent interactive console. Output uses sequenced chunks and server-side deduplication, supports stdout/stderr, pagination and full attachment download. A shell command using formatting commands can itself truncate text; server preserves exactly what the process emits.

Web authentication uses password scrypt and opaque HttpOnly sessions; agent credentials are separate, random, hashed in server database. Enrollment tokens expire and have use limits. All command creation, enrollment, settings, and changes are audited. No external unauthenticated command path. Remote support uses a visible per-user companion and a session-scoped relay, described below; no covert viewing.

## Remote support

An operator opens a dedicated browser window for one endpoint. An internal `remote_support` job passes the ordinary durable at-most-once start gate, then the LocalSystem service launches a non-elevated WinForms companion in the active Windows user session. A random one-use named pipe restricted to SYSTEM and that user's SID verifies both process identities and transfers only a short-lived support credential, never the agent credential. The launch job completes independently of the live support session; neither automatically reconnects or replays.

Admin-only settings persist the staff-notice policy: enabled by default,15seconds, configurable1–300seconds. Per the user's latest instruction, timeout approves; decline/closing refuses. The admin may disable the form for an already signed-in unattended VM. New sessions snapshot these settings, so editing policy cannot change an in-progress notice. Every mode requires a persistent topmost sharing indicator and a functioning displayed Ctrl+Alt+Shift+F12 local emergency end shortcut; no staff Stop button. The browser operator retains End session. There are no frames or inputs before the local notification policy completes and the operator is connected.

The companion captures the primary display and visible cursor as memory-only JPEG frames, at most1600pixels wide/about3fps. Normalized mouse coordinates and a fixed keyboard-code allowlist feed ordinary Windows SendInput, subject to UIPI. It cannot view/control Winlogon, lock screens, UAC secure desktops or higher-integrity applications. Desktop changes pause sharing and clear the browser frame; local Resume is required after returning to the original desktop. Windows sign-in support is separate work requiring disposable-VM validation.

The unprivileged web server relays same-origin WebSockets without recording frames or keystrokes. Browser tickets are one-use,30seconds, bound to the creating login session; device grants are one-use and endpoint/session/job scoped. One controller and one companion per session; all sessions end on disconnect, account/logout revocation, endpoint revocation, expiry or server restart. Maximum session30minutes. Audit records lifecycle and policy changes, never image/key content or secrets. Backpressure may drop stale live frames; durable command output remains fully retained on its separate transport.

Schema v6 adds support sessions/tickets; additive v7 adds persistent admin policy and immutable per-session snapshots. The current relay is single-process; horizontal replicas need deliberate shared ownership/routing. Nginx must forward Upgrade/Connection for `/api/support/`; the application gets no Docker socket or additional public port.

## Updates

Schema v5 adds organizational endpoint groups and persisted job-run snapshots. Installer and approval flow is unchanged; the database default assigns all newly inserted agents to permanent New endpoints. Each endpoint belongs to one group. Moving/deleting groups changes organization only, never agent credentials or queued/dispatched jobs. Bulk run membership is a launch-time snapshot; group changes do not add targets or replay work. Existing global roles apply; groups do not create permission boundaries.

Account schema v2 adds email, role and disabled fields in an additive transaction; existing administrators and credentials are preserved. Roles are checked against current database state for each request. Password changes/reset, disabling and role changes delete affected sessions. All sensitive account mutations require acting-user password confirmation and CSRF/origin checks, with rate limiting. Preserve at least one enabled administrator. Email is contact-only; no SMTP/reset-email workflow is configured. Do not roll back to pre-account-management images after creating restricted users, as older code does not enforce these roles.

GitHub Actions builds an image in GHCR. The initial host update service uses a separate read-only deploy key to fetch private GitHub `main` and build a commit-tagged local image, preserving data and restarting only this stack after health checks. This avoids storing broad GitHub PAT/GHCR credentials on the shared host. Admin UI requests updates via a narrowly scoped authenticated update helper; Docker socket is never exposed to the web container. The helper and Compose config are reviewed host files outside the auto-updated checkout. Pending/running jobs are never requeued during upgrades. A failed revision is not automatically retried until a new commit arrives; manual retry is explicit.

## Scope boundaries

Agent distribution is hosted by the app: `/install.ps1`, a public x64 ZIP, and public checksum/metadata. The Docker build cross-publishes the self-contained Windows service and packages the existing administrator installer. Public artifacts contain no enrollment token. An authenticated operator creates a token separately and the installer prompts securely. The bootstrap verifies HTTPS metadata/package SHA256 before extraction; it supports download-only validation without installing a service.

Action1 release deployment integration later. The administrator PowerShell installer packages self-contained agent and support companion binaries. Only the companion subtree permits Users read/execute; agent credentials/spool stay SYSTEM/Admin-only. MFA/SSO, mature alerts, signed installers and Windows secure sign-in support remain follow-up work.
