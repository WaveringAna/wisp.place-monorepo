import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def test_primary_requires_exactly_one_reachable_leader(self):
        class Http:
            def __init__(self, leaders):
                self.leaders = leaders

            def open(self, url, timeout):
                if not any(host in url for host in self.leaders):
                    raise OSError("not primary")
                response = io.BytesIO(b'{"role":"primary"}')
                response.status = 200
                return response

        for leaders in ([], [backup.HOSTS[0]], list(backup.HOSTS[:2])):
            with patch.object(backup.urllib.request, "build_opener", return_value=Http(leaders)):
                if len(leaders) == 1:
                    self.assertEqual(backup.primary(), leaders[0])
                else:
                    with self.assertRaises(RuntimeError):
                        backup.primary()

    def test_client_uses_read_only_credential_file_not_password_argument(self):
        args = backup.client(backup.HOSTS[0])
        self.assertIn("PGUSER=wisp_backup", args)
        self.assertIn("PGPASSFILE=/run/backup.pgpass", args)
        self.assertTrue(any(value.endswith("pgpass:/run/backup.pgpass:ro") for value in args))
        self.assertFalse(any("PGPASSWORD" in value for value in args))

    def test_mapping_signatures_are_independent_of_database_collation(self):
        self.assertEqual(backup.SIGNATURE_SQL.count('COLLATE "C"'), len(backup.MAPPINGS))
        for table in ("domains", "custom_domains", "sites"):
            self.assertIn("FROM public." + table, backup.SIGNATURE_SQL)

    def test_failed_restore_never_publishes_or_reports_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(backup, "ROOT", root), \
                 patch.object(backup.os.path, "ismount", return_value=True), \
                 patch.object(backup.shutil, "disk_usage", return_value=type("Disk", (), {"free": 3 * 1024**3})()), \
                 patch.object(backup, "primary", return_value=backup.HOSTS[0]), \
                 patch.object(backup, "dump", return_value={}), \
                 patch.object(backup, "restore_check", side_effect=ValueError("mismatch")), \
                 patch.object(backup, "heartbeat") as heartbeat:
                with self.assertRaises(ValueError):
                    backup.main()
                self.assertFalse((root / "latest").exists())
                self.assertEqual(len(list(root.glob("*.partial"))), 1)
                heartbeat.assert_not_called()

    def test_missing_storage_mount_fails_closed(self):
        with patch.object(backup.os.path, "ismount", return_value=False), \
             patch.object(backup, "dump") as dump:
            with self.assertRaises(RuntimeError):
                backup.main()
            dump.assert_not_called()

    def test_corrupt_archive_is_rejected_before_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "wisp.dump").write_bytes(b"corrupt")
            (root / "manifest.json").write_text(json.dumps({"sha256": {"wisp.dump": "wrong"}}))
            with patch.object(backup, "restore_check") as restore:
                with self.assertRaises(ValueError):
                    backup.verify_archive(root)
                restore.assert_not_called()


if __name__ == "__main__":
    unittest.main()
