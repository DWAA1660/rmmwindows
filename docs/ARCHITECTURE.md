# Park County Library RMM

## Initial design — 2026-11-04

Self-hosted Linux application at https://rmm.parkcountylibrary.org. Node 24 LTS/Express API with SQLite WAL durable state, React/Vite console, .NET 10 LTS Windows worker service installed as LocalSystem. Agents make outbound HTTPS requests only. SQLite and output live in a persistent Docker bind mount. Existing host websites must remain operational.

## Safety and delivery semantics

Jobs are at-most-once, not exactly-once. Server atomically consumes a queued job into dispatched; it never dispatches it again. Agent obtains an explicit durable start authorization before side effects. A second start request cannot authorize another execution. Lost responses may prevent execution; operator must inspect and create a new job. This prioritizes avoiding repeat reboots/scripts with Reboot Restore over automatic recovery. Local agent journals improve output recovery but are not the replay authority. A restored endpoint snapshot cannot reset server job state.

Job kinds: `powershell`, `reboot`, `inventory`, `storage`. PowerShell is noninteractive, hidden, elevated by LocalSystem service identity. Each job is a fresh PowerShell process, not a persistent interactive console. Output uses sequenced chunks and server-side deduplication, supports stdout/stderr, pagination and full attachment download. A shell command using formatting commands can itself truncate text; server preserves exactly what the process emits.

Web authentication uses password scrypt and opaque HttpOnly sessions; agent credentials are separate, random, hashed in server database. Enrollment tokens expire and have use limits. All command creation, enrollment, settings, and changes are audited. No external unauthenticated command path. Screen capture is deferred until a consented per-user companion is implemented; no covert viewing.

## Updates

GitHub Actions builds an image in GHCR. The initial host update service uses a separate read-only deploy key to fetch private GitHub `main` and build a commit-tagged local image, preserving data and restarting only this stack after health checks. This avoids storing broad GitHub PAT/GHCR credentials on the shared host. Admin UI requests updates via a narrowly scoped authenticated update helper; Docker socket is never exposed to the web container. The helper and Compose config are reviewed host files outside the auto-updated checkout. Pending/running jobs are never requeued during upgrades. A failed revision is not automatically retried until a new commit arrives; manual retry is explicit.

## Scope boundaries

Agent distribution is hosted by the app: `/install.ps1`, a public x64 ZIP, and public checksum/metadata. The Docker build cross-publishes the self-contained Windows service and packages the existing administrator installer. Public artifacts contain no enrollment token. An authenticated operator creates a token separately and the installer prompts securely. The bootstrap verifies HTTPS metadata/package SHA256 before extraction; it supports download-only validation without installing a service.

Action1 deployment integration later. Initial installer is an administrator-run PowerShell installer for self-contained agent binaries, with packaging workflow. No unattended remote input control or covert screen capture. RBAC/MFA/SSO, mature alerts and remote assistance are follow-up work.
