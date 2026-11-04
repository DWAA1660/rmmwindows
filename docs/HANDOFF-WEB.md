# Web console handoff — 2026-11-04

## Delivered

Website installation follow-up: Add endpoints includes `AgentInstaller` with direct install-script and ZIP links, current version/size/SHA256 and a copy-command button. It reads public `/api/agent-download` metadata; no token is included in the command. The endpoint prompts securely during installation. Availability errors disable the download/copy actions. Production UI and clipboard success were verified; screenshot is ignored at artifacts/website-agent-install.png.

`web/` contains a React 19 + TypeScript + Vite operational console with Lucide icons and locally bundled variable Manrope / DM Sans fonts. No CDN or external font connection is required; the server's self-only CSP works. Visual direction: dark blue-green sidebar, light neutral workspace, restrained sage/teal health indicators, compact inventory tables, and clear empty states. Responsive navigation collapses to a mobile drawer.

Implemented against the real `/api` contract, without fake fleet data:

- Administrator login/logout, HttpOnly same-origin sessions and in-memory CSRF nonce (`X-CSRF-Token`). Expired sessions return to login.
- Fleet dashboard: total/online/attention/active jobs, primary-drive storage ranking, recent activity, enrollment empty state.
- Endpoints: name/IP/domain/tag search, online/offline/low-storage filters, selections and bulk PowerShell/inventory/reboot actions.
- Endpoint detail: OS/build/architecture, domain membership, IP addresses, logged-on user, boot timestamp, CPU/memory, drive usage, searchable installed software, rename/revoke.
- PowerShell: fresh elevated noninteractive script jobs, saved script execution, explicit bulk reboot confirmation with a 30-second delay.
- Full job output: sequenced chunks appended in order, automatically paginated/polled every 2.5 seconds, stdout/stderr distinction, follow toggle, queued-job cancellation and full text download. No UI tail replacement or output slicing. Server output download is available even before all browser pages finish loading.
- Read-only storage explorer: scan a local directory; after all output pages for a completed storage job load, parse concatenated stdout JSON and render children sorted by reported size with bars, partial/error annotations and folder navigation. Opening a folder queues a **new** read-only scan through the existing confirmation/path form. Full JSON output and complete download remain available. No file deletion/content access.
- Script library create/edit/delete and run with endpoint selection. Card preview is four script source lines only; editor contains full script. Script source preview is separate from job output retention.
- Interval schedules create, enable/pause and delete. UI minimum 5 minutes matches server; first run is one interval in future.
- Enrollment token creation with use/expiry limits, copy once, token metadata listing.
- Administrative audit log.
- Settings: version/current host, update capability, GitHub pull/rebuild/restart request with confirmation, readable helper status/active commit/automatic checks, polling every 5 seconds. The update UI never invokes Docker directly.
- Explicitly unavailable consented remote assistance, with no covert screen capture.

## Source organization

- `web/src/main.tsx`: API client, shared entities/components, application views/forms, output/storage presentation. Source is formatted for handoff; future extraction into per-view modules is straightforward.
- `web/src/styles.css`: complete visual system and responsive breakpoints, reduced motion support.
- `web/vite.config.ts`: development proxy `/api` to `http://127.0.0.1:3000`.
- `web/package-lock.json`: locked dependencies. Vite production emits `web/dist`, served by server static middleware.

## Verification

- `npm install --prefix web`: successful; audit reported zero vulnerabilities.
- `npm run build --prefix web`: successful TypeScript strict compilation and Vite production build (last run after storage explorer + update status changes).
- Parent agent visually verified authenticated empty dashboard locally at 738px viewport with no layout issues. Main UI development did not depend on a demo account or mocked API.

## Accessibility and behavioral notes

Dialogs trap Tab focus, close with Escape and restore previous focus. Focus initialization runs once per mounted dialog so typing does not jump between inputs during rerenders. Buttons/checkboxes and output scroller have accessible names/focus states. Reboot, revocation, deletion and app update carry explicit confirmations. Inline errors float above dialogs; notifications use live status semantics. Keyboard and reduced-motion styles are present.

## Remaining limitations

- No MFA/SSO/RBAC/password change UI, consistent with initial server scope.
- Navigation state is in memory, so browser reload opens Overview; deep links/back navigation can be added later.
- Endpoint tags are searchable but tag editing is not exposed yet.
- The operator role is currently administrator throughout. Screen viewing/control is intentionally unavailable pending the consented desktop companion.
- Very large output can consume browser memory because preserving all loaded chunks is deliberate; full output download avoids needing all pages in browser memory. A future virtualized output viewer may improve this while preserving server data.
- Inventory/disk/software views reflect the last successful checkin, not a live interactive session. Storage directory scans are bounded by the agent; partial results are clearly labeled.
- Server/image update success and production font/layout behavior still need final deployed smoke verification by the owner.
