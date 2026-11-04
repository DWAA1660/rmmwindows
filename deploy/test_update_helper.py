"""Regression tests for scoped updates, failed-revision suppression and backups."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("update_helper", Path(__file__).with_name("update-helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(helper, "ROOT", self.root)
        self.root_patch.start()
        (self.root / "source/.git").mkdir(parents=True)
        helper.STATE.clear()
        helper.STATE.update(status="idle")

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def test_live_sqlite_backup_is_consistent(self):
        (self.root / "data").mkdir()
        with sqlite3.connect(self.root / "data/rmm.db") as db:
            db.execute("pragma journal_mode=wal")
            db.execute("create table ledger (id text)")
            db.execute("insert into ledger values ('consumed-job')")
        helper.backup_database()
        backup = next((self.root / "backups").glob("*.db"))
        with sqlite3.connect(backup) as db:
            self.assertEqual(db.execute("select id from ledger").fetchone()[0], "consumed-job")

    def test_auto_does_not_redeploy_active_or_failed_revision(self):
        revision = "a" * 40
        for key in ("activeCommit", "failedCommit"):
            helper.STATE.clear()
            helper.STATE[key] = revision
            calls = []

            def fake_run(args, **kwargs):
                calls.append(args)
                return revision if "rev-parse" in args else ""

            with patch.object(helper, "run", side_effect=fake_run):
                self.assertTrue(helper.update())
            self.assertFalse(any(args[0] == "docker" for args in calls))

    def test_build_failure_never_restarts_running_application(self):
        revision = "b" * 40
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if args[:2] == ["docker", "build"]:
                raise RuntimeError("build failed")
            return revision if "rev-parse" in args else ""

        with patch.object(helper, "run", side_effect=fake_run):
            self.assertFalse(helper.update(manual=True))
        self.assertEqual(helper.STATE["failedCommit"], revision)
        self.assertFalse(any("compose" in args for args in calls))

    def test_healthy_deploy_is_scoped_and_persists_image(self):
        revision = "c" * 40
        (self.root / ".env").write_text("RMM_IMAGE=old\nADMIN_USERNAME=admin\n")
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "rev-parse" in args:
                return revision
            return ""

        with patch.object(helper, "run", side_effect=fake_run):
            self.assertTrue(helper.update(manual=True))
        deploy = next(args for args in calls if "up" in args)
        self.assertIn("--no-deps", deploy)
        self.assertIn("--wait", deploy)
        self.assertEqual(deploy[-1], "rmm")
        self.assertNotIn("down", deploy)
        self.assertEqual(helper.STATE["activeCommit"], revision)
        self.assertIn(f"RMM_IMAGE=library-rmm:{revision}", (self.root / ".env").read_text())


if __name__ == "__main__":
    unittest.main()
