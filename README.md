# Park County Library RMM

Self-hosted Windows endpoint management with a Linux web console, Windows service agent, durable full command output, script library, schedules, inventory, storage inspection and bulk actions.

Target: **https://rmm.parkcountylibrary.org** · [Private source repository](https://github.com/DWAA1660/rmmwindows)

## Install an endpoint

In the web console, open **Add endpoints**, create an enrollment token, then copy the administrator PowerShell install command. [Install script](https://rmm.parkcountylibrary.org/install.ps1) and [agent ZIP](https://rmm.parkcountylibrary.org/downloads/library-rmm-agent-win-x64.zip) are hosted directly on the website; no GitHub login is required on endpoints. The script verifies the package checksum and securely prompts for your token. See `installer/README.md` for the command, download-only validation and manual installation.

## Workspaces

- `server/` — authenticated Node 24+ / Express API and SQLite durable state.
- `web/` — React / TypeScript console.
- `agent/` — .NET 10 Windows service, outbound HTTPS only.
- `installer/` — administrator installer, uninstall and package scripts.
- `deploy/` — isolated Docker Compose, Nginx vhost, scoped GitHub updater.
- `docs/` — architecture, API, deployment instructions, progress and contributor handoffs.

## Develop

Requires Node 24+, .NET 10 SDK for agent builds. In separate terminals:

```powershell
cd server
npm ci
$env:ADMIN_USERNAME = 'admin'
$env:ADMIN_PASSWORD = '<choose a strong development password>'
$env:PUBLIC_ORIGIN = 'http://localhost:5173'
$env:COOKIE_SECURE = 'false'
npm start
```

```powershell
cd web
npm ci
npm run dev
```

Never use development credentials in production. See `docs/DEPLOYMENT.md` for Linux setup and `docs/PROGRESS.md` for actual verification/deployment status.

## Two critical guarantees

**At-most-once commands:** the server consumes jobs before execution and never automatically reissues them. Reboot Restore or a rollback of the endpoint cannot reset the server ledger. An interrupted/ambiguous operation requires an explicit new operator request. This trades automatic retry for avoiding duplicate disruptive actions. Restoring the server database to an older snapshot can restore old queued jobs; do not restore and reconnect endpoints without reconciliation.

**Complete emitted output:** sequenced stdout/stderr chunks are durably stored, retrieved with pagination, and downloadable in full. The application does not silently cut off long results. PowerShell commands can apply their own formatting limits; prefer `Format-List`, `ConvertTo-Json -Depth ...` or explicit widths when needed.

## Remote assistance

Screen viewing is reserved for a separate interactive companion with user consent and an always-visible session indicator. Covert screen watching and remote input control are not implemented. Action1 release deployment is a later integration.

## Collaboration

Read `AGENTS.md` and the docs before contributing. Keep handoffs accurate, never commit secrets, and preserve replay prevention when changing the agent or job API.
