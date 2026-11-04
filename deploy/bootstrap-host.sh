#!/usr/bin/env bash
# Run on the authorized shared Linux host as root AFTER repository deploy key setup.
# This installs only the Library RMM app, updater service and its own Nginx vhost.
set -euo pipefail
RMM_ROOT=/opt/library-rmm
test "$(id -u)" = 0 || { echo 'Run as root'; exit 1; }
test -f "$RMM_ROOT/github-deploy-key"
test -f "$RMM_ROOT/github-known-hosts"
export GIT_SSH_COMMAND="ssh -i $RMM_ROOT/github-deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$RMM_ROOT/github-known-hosts"
if [ ! -d "$RMM_ROOT/source/.git" ]; then
    git clone --branch main --single-branch git@github.com:DWAA1660/rmmwindows.git "$RMM_ROOT/source"
fi
install -m 0644 "$RMM_ROOT/source/deploy/compose.yml" "$RMM_ROOT/compose.yml"
install -m 0755 "$RMM_ROOT/source/deploy/update-helper.py" "$RMM_ROOT/update-helper.py"
install -m 0644 "$RMM_ROOT/source/deploy/library-rmm-updater.service" /etc/systemd/system/library-rmm-updater.service
install -d -m 0750 -o 1000 -g 1000 "$RMM_ROOT/data"
install -d -m 0700 "$RMM_ROOT/backups" "$RMM_ROOT/docker-config"
python3 - <<'PY'
from pathlib import Path
import os, secrets
root = Path('/opt/library-rmm')
env = root / '.env'
if not env.exists():
    password, token = secrets.token_urlsafe(24), secrets.token_hex(32)
    env.write_text(f'RMM_IMAGE=library-rmm:local\nADMIN_USERNAME=admin\nADMIN_PASSWORD={password}\nUPDATE_HELPER_TOKEN={token}\n')
    os.chmod(env, 0o600)
    access = root / 'bootstrap-access.txt'
    access.write_text(f'URL: https://rmm.parkcountylibrary.org\nUsername: admin\nPassword: {password}\nKeep this file private.\n')
    os.chmod(access, 0o600)
values = dict(line.split('=', 1) for line in env.read_text().splitlines() if '=' in line and not line.startswith('#'))
updater = root / 'updater.env'
if not updater.exists():
    updater.write_text(f"UPDATE_HELPER_TOKEN={values['UPDATE_HELPER_TOKEN']}\nRMM_SOURCE_URL=git@github.com:DWAA1660/rmmwindows.git\nRMM_UPDATE_BIND=172.29.60.1\nRMM_UPDATE_PORT=9441\nRMM_UPDATE_INTERVAL_SECONDS=300\nRMM_AUTO_UPDATE=true\n")
    os.chmod(updater, 0o600)
PY
if ! docker network inspect library-rmm >/dev/null 2>&1; then
    docker network create --subnet 172.29.60.0/24 --gateway 172.29.60.1 library-rmm
fi
python3 -m unittest discover -s "$RMM_ROOT/source/deploy" -p 'test_*.py' -v
set -a
. "$RMM_ROOT/updater.env"
set +a
python3 - <<'PY'
import importlib.util
spec = importlib.util.spec_from_file_location('update_helper','/opt/library-rmm/update-helper.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
raise SystemExit(0 if module.update(manual=True) else 1)
PY
systemctl daemon-reload
systemctl enable --now library-rmm-updater
install -d -m 0755 /var/www/library-rmm-acme
test ! -e /etc/nginx/sites-available/library-rmm.conf || cp -a /etc/nginx/sites-available/library-rmm.conf "$RMM_ROOT/nginx-before.conf"
install -m 0644 "$RMM_ROOT/source/deploy/nginx-http.conf" /etc/nginx/sites-available/library-rmm.conf
ln -sfn /etc/nginx/sites-available/library-rmm.conf /etc/nginx/sites-enabled/library-rmm.conf
nginx -t
systemctl reload nginx
certbot certonly --webroot -w /var/www/library-rmm-acme -d rmm.parkcountylibrary.org --non-interactive --agree-tos --register-unsafely-without-email --deploy-hook 'systemctl reload nginx'
install -m 0644 "$RMM_ROOT/source/deploy/nginx.conf" /etc/nginx/sites-available/library-rmm.conf
nginx -t
systemctl reload nginx
echo 'Library RMM deployed. Initial credentials: /opt/library-rmm/bootstrap-access.txt (root only)'
