# v0.1.0 — Initial preview

First self-hosted Windows endpoint management implementation for Park County Library.

- Linux Docker/Nginx web console with authenticated administrator access.
- Windows service agent with outbound HTTPS enrollment, inventory, software, disks, domain and IP details.
- Elevated noninteractive PowerShell jobs with full sequenced stdout/stderr, pagination and complete text downloads.
- Server-authoritative at-most-once job delivery designed to avoid repeating reboot/scripts after endpoint rollback.
- Bulk inventory/reboot/PowerShell, saved scripts, interval schedules and audit history.
- Read-only bounded storage-size exploration with explicit partial/error information.
- Private GitHub automatic app updates and administrator pull/restart button, scoped to the RMM container.
- Self-contained win-x64 agent package with PowerShell install/update/uninstall scripts and SHA256 checksums.

This is a preview release. The installer package is unsigned and requires administrator PowerShell. Validate service install/update/uninstall on a disposable Windows VM before broad rollout. No agent is installed automatically by the website. Metrics are inventory snapshots; historical telemetry, MFA/SSO/RBAC, signed MSI/EXE packaging, Action1 deployment, and consented screen assistance are follow-up work. Screen viewing/control is not implemented.

Extract the package and run `Install-Agent.ps1` as administrator; it prompts for an enrollment token created in the web console. See the included README and `docs/HANDOFF-AGENT.md` for details and replay/output guarantees.
