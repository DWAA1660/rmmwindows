# Collaboration instructions

- Read `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, and `docs/API.md` before changes.
- Keep progress, verification, limitations, and handoff notes updated in Markdown.
- Never put credentials, enrollment tokens, agent tokens, or production databases in Git.
- For every pull request opened for DWAA1660, keep `maintainer_can_modify: true` when supported.
- Endpoint commands use server-authoritative **at-most-once** dispatch. Never automatically requeue dispatched/running jobs, including after timeout, reboot, snapshot rollback, or lost acknowledgment.
- Preserve every accepted output chunk and provide paginated reading plus complete download. Never silently truncate output.
- Screen viewing must have explicit session consent and a persistent visible indicator. No covert capture.
- Do not disrupt other services on the shared Linux Docker host or mount the Docker socket in the web app.
