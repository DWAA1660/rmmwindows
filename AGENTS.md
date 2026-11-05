# Collaboration instructions

- Read `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, and `docs/API.md` before changes.
- Keep progress, verification, limitations, and handoff notes updated in Markdown.
- Never put credentials, enrollment tokens, agent tokens, or production databases in Git.
- For every pull request opened for DWAA1660, keep `maintainer_can_modify: true` when supported.
- Endpoint commands use server-authoritative **at-most-once** dispatch. Never automatically requeue dispatched/running jobs, including after timeout, reboot, snapshot rollback, or lost acknowledgment.
- Preserve every accepted output chunk and provide paginated reading plus complete download. Never silently truncate output.
- Screen support must retain a persistent sharing indicator. Per the user's 2026-11-04 override, the admin controls whether to show the approve/decline form and its1–300second countdown (default15); expiration approves requested access, closing/declining refuses. Disabled form permits immediate sharing on the signed-in desktop only after the visible indicator is ready. No staff Stop button; display a working local emergency stop shortcut. No covert capture. Native Ctrl+Alt+Delete must honor Windows policy; do not substitute ordinary key injection or claim unsupported Windows sign-in control works.
- Do not disrupt other services on the shared Linux Docker host or mount the Docker socket in the web app.
