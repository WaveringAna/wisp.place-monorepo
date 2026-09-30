#!/usr/bin/env python3
"""Keep an atomic, consistent local recovery copy without stopping monitoring."""

import os
import pathlib
import shutil
import sqlite3

os.umask(0o077)
root = pathlib.Path("/opt/wisp-status")
backup = root / "backup"
backup.mkdir(mode=0o700, exist_ok=True)
with sqlite3.connect(f"file:{root}/data/gatus.db?mode=ro", uri=True) as source:
    with sqlite3.connect(backup / "gatus.next.db") as target:
        source.backup(target)
        if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("backup integrity check failed")
os.replace(backup / "gatus.next.db", backup / "gatus.db")
for name in ("config.yaml", "secrets.env", "compose.yaml"):
    shutil.copy2(root / name, backup / name)
print("status database and configuration backup verified")
