# Linux deployment and GitHub updates

## Design for the shared host

Host: `170.205.30.132`, Ubuntu, Docker Compose and Nginx already installed. Existing websites remain in their existing stacks. RMM uses project `library-rmm`, container service `rmm`, loopback port `127.0.0.1:8088`, dedicated network `172.29.60.0/24`, and persistent bind mount `/opt/library-rmm/data`. No ports 80/443 are claimed by Docker; existing host Nginx routes the domain.

## Host files

```text
/opt/library-rmm/
  source/                    private GitHub checkout
  compose.yml                reviewed host stack config
  .env                       root-only app bootstrap/update secrets
  updater.env                root-only updater configuration
  github-deploy-key          read-only repository deploy key (0600)
  github-known-hosts          verified GitHub SSH host key
  update-helper.py           reviewed privileged helper, outside app checkout
  update-status.json         persisted update result and revision
  bootstrap-access.txt       root-only initial operator login
  data/rmm.db                durable database, uid 1000
  backups/                   consistent pre-update SQLite backups, most recent 20
```

The helper and Compose configuration are intentionally outside the auto-updated source tree. Updating infrastructure needs a deliberate host installation step; app updates cannot silently change host services, networking or updater permissions.

## Initial installation

After host inspection and read-only deploy key registration, `deploy/bootstrap-host.sh` automates steps 3–10 below. It generates fresh credentials, not shared defaults. Read the script before running it on a shared host.

1. Use SSH to inspect existing containers, ports, routes and Nginx configuration. Verify 8088 and the network subnet are unused.
2. Create `/opt/library-rmm` (0750), generate a separate SSH Ed25519 deploy key on the host, register **only its public key** as a read-only deploy key on `DWAA1660/rmmwindows`, and verify GitHub's host fingerprint against GitHub documentation. Never copy the private key off the server.
3. Clone `git@github.com:DWAA1660/rmmwindows.git` into `source` using that key and the verified known-hosts file.
4. Copy `deploy/compose.yml`, `deploy/update-helper.py` and `deploy/library-rmm-updater.service` into the paths shown. Create `data` owned by uid/gid 1000 and `backups` mode 0700.
5. Generate a random administrator password and a separate random update helper token. Write root-only `.env` using `.env.example`; record the initial login in a root-only file. Do not reuse the SSH password for app authentication.
6. Write `updater.env` (0600):

   ```dotenv
   UPDATE_HELPER_TOKEN=<same random secret as app .env>
   RMM_SOURCE_URL=git@github.com:DWAA1660/rmmwindows.git
   RMM_UPDATE_BIND=172.29.60.1
   RMM_UPDATE_PORT=9441
   RMM_UPDATE_INTERVAL_SECONDS=300
   RMM_AUTO_UPDATE=true
   ```

7. Ensure the dedicated external Docker network exists before starting the helper: `docker network create --subnet 172.29.60.0/24 --gateway 172.29.60.1 library-rmm`. Inspect existing networks/routes first; the helper binds its private gateway address.
8. Run the helper's `update(manual=True)` once with the protected updater environment loaded to build and start the first container. Enable/start `library-rmm-updater.service` after the network exists. The web app never receives `/var/run/docker.sock`.
9. Install the HTTP-only Nginx vhost from `nginx-http.conf`, validate with `nginx -t`, and reload Nginx. Issue a certificate with existing Certbot/webroot into `/var/www/library-rmm-acme` for `rmm.parkcountylibrary.org`. Install `nginx.conf`, validate, and reload. Configure certificate renewal to reload Nginx.
10. Verify public HTTPS, authentication, container health, updater status, and that all pre-existing Docker containers remain running. Use a fresh enrollment token for a test endpoint; do not install on the development machine implicitly.

## Automatic and manual application updates

Push reviewed code to private GitHub `main`. GitHub Actions tests server, builds web and agent, and publishes GHCR images. The host's read-only deploy key fetches `main` every five minutes. It builds the app with Docker (including server tests and frontend compilation), backs up SQLite, then recreates **only** service `rmm` and waits for health. The Settings button requests the same process immediately and also forces a restart when already current.

The current installation uses private GitHub source pull/build, so the host requires no broad GitHub PAT or GHCR credentials. CI additionally publishes images to `ghcr.io/dwaa1660/rmmwindows:main` and immutable SHA tags for future image-only deployments. It does not deploy an untested agent to endpoints automatically.

An app outage while it restarts is expected; refresh after health succeeds. Agents reconnect. Dispatched/running jobs remain consumed and never replay. The updater builds before stopping the running app; build failures leave it running. Failed health checks attempt restoration of the previous image. The failed commit is suppressed from automatic retry until a new commit arrives; manual retry remains available.

Protect `main` and limit write access: any person or workflow able to modify deployed code can modify endpoint-management behavior. CI approval gates/branch protection should be configured for the team's preferred review policy. Local Docker tests execute before the updater switches images; the updater does not wait for all remote GitHub checks.

## Backups, restore and disk use

Pre-update SQLite snapshots are consistent live backups including WAL contents. They include credentials hashes and script/output data; protect them. Copy encrypted backups off-host for disaster recovery. Application images accumulate by commit; review space and remove only unused `library-rmm` images manually. The helper does not run global Docker prune on a shared host.

**Do not restore an old server ledger and reconnect agents without reconciliation.** Server rollback can revive previously queued jobs. Stop agents or revoke credentials, clear/reconcile pending work, then re-enroll as appropriate. Endpoint snapshot rollback alone is covered by the server-authoritative at-most-once protocol.

Image rollback does not automatically undo database migrations. Changes must be additive/backward compatible or ship an explicit migration/restore plan. Review `docs/PROGRESS.md` for verified current deployment status.

## Operations

```bash
systemctl status library-rmm-updater
journalctl -u library-rmm-updater --since today
docker compose -p library-rmm -f /opt/library-rmm/compose.yml --env-file /opt/library-rmm/.env ps
docker compose -p library-rmm -f /opt/library-rmm/compose.yml --env-file /opt/library-rmm/.env logs --tail 100 rmm
```

Never run `docker compose down -v` or global prune as an update step. Never put the updater port in public Nginx. Keep `.env`, updater token and deploy private key out of screenshots/logs/commits.
