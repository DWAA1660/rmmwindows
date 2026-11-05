# Next work and Claude handoff

Read `AGENTS.md`, `PROGRESS.md`, `ARCHITECTURE.md`, `API.md`, then the component `HANDOFF-*.md` files. Source is public GitHub `DWAA1660/rmmwindows`. `main` is deployed automatically; keep incomplete work on a feature branch. PRs opened for DWAA1660 must keep maintainer edits enabled where GitHub supports it (cross-repository PRs).

Current priority: validate the deployed agent0.1.6 remote companion on an identified disposable VM. Ordinary signed-in desktop view/control, admin notification settings and native policy-honoring Ctrl+Alt+Delete request are implemented; Windows sign-in/secure-desktop control is not. The user has been asked for a test VM endpoint; await that target before live desktop tests. See `HANDOFF-REMOTE-AGENT.md` for exact lifecycle checks and native API boundaries. Never claim synthetic relay tests exercised a real Windows desktop.

## Highest-priority validation

1. Install the preview package on a disposable Windows VM using a fresh token from the live console. Check service identity is LocalSystem, ACLs/ownership markers, reboot persistence, outbound TLS and inventory.
2. Run a harmless long-output command in the web console, confirm pagination and full download. Upgrade by rerunning the installer and confirm endpoint identity/history remain. Uninstall/reinstall preserving enrollment, then decommission/revoke.
3. Use a disposable VM with Reboot Restore (or equivalent rollback) to verify a single reboot/script job does not repeat across multiple real snapshot restores. Existing tests cover server persistence, concurrent authorization and recovery with no replay; physical restore-software validation has not been done.
4. Verify storage scan partial/error/reparse indicators on a nonproduction machine. Directory sizes are logical and bounded, not physical allocation totals.

No endpoint service has been installed by Codex. Current local Windows test processes were ordinary isolated console workers, never services; no shutdown request was sent.

## Product/security follow-up

- Add administrator password-change/account management, MFA/SSO and RBAC before expanding operator access. Preserve separate operator sessions and agent tokens.
- Add versioned database migrations and tested disaster recovery. Restoring an older server ledger can revive queued work; reconciliation is mandatory before agents reconnect.
- Add metric samples/time-series charts, configurable polling intervals, disk/agent health alerts and retention controls. Current metrics are 15-minute inventory snapshots by default.
- Add signed installer/MSI/EXE packaging, signed release manifests and documented agent upgrade policy. The current release is a self-contained executable plus administrator PowerShell scripts in a zip.
- Add Action1 release deployment later, as requested. Do not embed a long-lived multiuse enrollment token in a public release asset.
- Extend remote assistance to Windows sign-in/secure desktops only with a separate scoped SYSTEM desktop design and disposable-VM lifecycle validation. Current ordinary-user companion intentionally pauses there. Preserve the latest admin-configured form/countdown policy, visible indicator and emergency shortcut; no covert capture.
- Expand software inventory to unloaded user profiles and Store/MSIX as needed; current uninstall registry inventory is explicitly limited.

## Production operations

- Shared Linux host `/opt/library-rmm`; own Compose project and systemd updater only. Preserve every other website/container.
- `deploy/` files in Git describe infrastructure; the privileged helper and host Compose files are deliberately outside automatic source updates and require deliberate review/install to change.
- Web Settings pulls/builds/restarts this app, checks health, and preserves the SQLite database. Automatic check every 300 seconds. CI also publishes private GHCR images, but this host uses a read-only source deploy key and local image build.
- Initial operator login is in root-only `/opt/library-rmm/bootstrap-access.txt`; local user-private copy is ignored at `artifacts/admin-access.txt`. Never put either into Git or chat logs.
- Existing tests: server8, agent8, installer-path checks, updater4, actual .NET10 Windows-agent/API smoke. See exact commands and evidence in handoff docs and GitHub Actions.
