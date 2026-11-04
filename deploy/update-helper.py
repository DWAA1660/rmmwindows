#!/usr/bin/env python3
"""Privileged, narrow update broker. Never accepts a command, ref or path over HTTP.

Runs only the dedicated library-rmm Compose project. Web container has no Docker
socket. Remote GitHub main code is trusted deployment input; protect that branch.
"""
import hmac
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(os.environ.get("RMM_ROOT", "/opt/library-rmm")).resolve()
TOKEN = os.environ.get("UPDATE_HELPER_TOKEN", "")
SOURCE_URL = os.environ.get("RMM_SOURCE_URL", "git@github.com:DWAA1660/rmmwindows.git")
AUTO_SECONDS = max(60, int(os.environ.get("RMM_UPDATE_INTERVAL_SECONDS", "300")))
AUTO_ENABLED = os.environ.get("RMM_AUTO_UPDATE", "true").lower() == "true"
BIND = os.environ.get("RMM_UPDATE_BIND", "172.29.60.1")
PORT = int(os.environ.get("RMM_UPDATE_PORT", "9441"))
LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
STATE = {"status": "idle", "message": "Ready", "automatic": AUTO_ENABLED}


def now():
    return datetime.now(timezone.utc).isoformat()


def set_state(**fields):
    with STATE_LOCK:
        STATE.update(fields)
        (ROOT / "update-status.json").write_text(json.dumps(STATE), encoding="utf-8")


def run(args, *, cwd=None, timeout=900, extra_env=None):
    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_SSH_COMMAND"] = (
        f"ssh -i {ROOT}/github-deploy-key -o IdentitiesOnly=yes "
        f"-o StrictHostKeyChecking=yes -o UserKnownHostsFile={ROOT}/github-known-hosts"
    )
    if extra_env:
        env.update(extra_env)
    result = subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, check=False)
    # Log bounded diagnostics to the root-only journal, never environment values.
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stdout[-4000:]}")
    return result.stdout.strip()


def compose(*args, image=None):
    return run(["docker", "compose", "--project-name", "library-rmm", "--file",
                str(ROOT / "compose.yml"), "--env-file", str(ROOT / ".env"), *args],
               cwd=ROOT, extra_env={"RMM_IMAGE": image} if image else None)


def backup_database():
    source = ROOT / "data/rmm.db"
    if not source.exists():
        return
    folder = ROOT / "backups"
    folder.mkdir(exist_ok=True, mode=0o700)
    target = folder / (datetime.now(timezone.utc).strftime("rmm-%Y%m%dT%H%M%S-%f.db"))
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as current:
        with sqlite3.connect(target) as backup:
            current.backup(backup)
    # Keep the most recent 20 consistent backups. No deletion outside backups/.
    for old in sorted(folder.glob("rmm-*.db"), reverse=True)[20:]:
        old.unlink()


def update(manual=False):
    """Build before stopping. Never automatically retry the same failed commit."""
    if not LOCK.acquire(blocking=False):
        return False
    previous_image = None
    candidate = None
    switched = False
    try:
        set_state(status="checking", message="Checking GitHub main", startedAt=now())
        source = ROOT / "source"
        if not (source / ".git").exists():
            run(["git", "clone", "--branch", "main", "--single-branch", SOURCE_URL, str(source)])
        run(["git", "fetch", "--prune", "origin", "main"], cwd=source)
        candidate = run(["git", "rev-parse", "origin/main"], cwd=source)
        if not re.fullmatch(r"[a-f0-9]{40}", candidate):
            raise RuntimeError("Invalid commit from GitHub")
        with STATE_LOCK:
            active = STATE.get("activeCommit")
            blocked = STATE.get("failedCommit")
        if not manual and candidate in (active, blocked):
            set_state(status="idle", message="No new update" if candidate == active else
                      "Failed update requires manual retry or a new commit", checkedAt=now())
            return True
        run(["git", "checkout", "--detach", candidate], cwd=source)
        image = f"library-rmm:{candidate}"
        set_state(status="building", message="Building updated application", targetCommit=candidate)
        run(["docker", "build", "--build-arg", f"APP_VERSION={candidate}", "--tag", image, "."],
            cwd=source, timeout=1800)
        container = compose("ps", "--quiet", "rmm")
        if container:
            previous_image = run(["docker", "inspect", "--format", "{{.Image}}", container])
        backup_database()
        set_state(status="restarting", message="Restarting application; waiting for health")
        switched = True
        compose("up", "--detach", "--no-deps", "--force-recreate", "--wait",
                "--wait-timeout", "90", "rmm", image=image)
        # Persist selected local image only after health succeeds.
        env_path = ROOT / ".env"
        lines = env_path.read_text(encoding="utf-8").splitlines()
        lines = [line for line in lines if not line.startswith("RMM_IMAGE=")]
        env_path.write_text("\n".join([f"RMM_IMAGE={image}", *lines]) + "\n", encoding="utf-8")
        os.chmod(env_path, 0o600)
        set_state(status="succeeded", message="Application updated and healthy", activeCommit=candidate,
                  failedCommit=None, completedAt=now())
        return True
    except Exception as error:
        message = str(error)
        if switched and previous_image:
            try:
                rollback_tag = "library-rmm:rollback"
                run(["docker", "tag", previous_image, rollback_tag])
                compose("up", "--detach", "--no-deps", "--force-recreate", "--wait",
                        "--wait-timeout", "90", "rmm", image=rollback_tag)
                message += "; previous application image restored"
            except Exception as rollback_error:
                message += f"; rollback failed: {rollback_error}"
        set_state(status="failed", message=message[-5000:], failedCommit=candidate, completedAt=now())
        return False
    finally:
        LOCK.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "LibraryRMMUpdater"

    def log_message(self, *_):
        pass  # Do not log headers, bearer tokens, or request content.

    def respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.respond(401, {"error": "Unauthorized"})
        if self.path != "/status":
            return self.respond(404, {"error": "Not found"})
        with STATE_LOCK:
            result = dict(STATE)
        self.respond(200, result)

    def do_POST(self):
        if not self.authorized():
            return self.respond(401, {"error": "Unauthorized"})
        if self.path != "/update":
            return self.respond(404, {"error": "Not found"})
        # Requests carry no configuration. Reject arbitrary update arguments.
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond(400, {"error": "Invalid length"})
        if length < 0 or length > 2:
            return self.respond(400, {"error": "Update accepts no arguments"})
        body = self.rfile.read(length)
        if body not in (b"", b"{}"):
            return self.respond(400, {"error": "Update accepts no arguments"})
        if LOCK.locked():
            return self.respond(409, {"error": "Update already running"})
        self.respond(202, {"status": "accepted", "message": "GitHub update requested"})
        threading.Thread(target=update, kwargs={"manual": True}, daemon=True).start()


def automatic():
    while True:
        time.sleep(AUTO_SECONDS)
        update()


if __name__ == "__main__":
    if len(TOKEN) < 32:
        raise SystemExit("UPDATE_HELPER_TOKEN must be at least 32 characters")
    ROOT.mkdir(parents=True, exist_ok=True)
    state_file = ROOT / "update-status.json"
    if state_file.exists():
        try:
            STATE.update(json.loads(state_file.read_text(encoding="utf-8")))
            STATE.update(status="idle", automatic=AUTO_ENABLED)
        except (OSError, ValueError):
            pass
    if AUTO_ENABLED:
        threading.Thread(target=automatic, daemon=True).start()
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
