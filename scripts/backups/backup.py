#!/usr/bin/env python3
"""Pull a consistent PostgreSQL archive; publish it only after an isolated restore."""

import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import time
import urllib.request

IMAGE = "postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193"
HOSTS = ("stolas.mesh.wisp.place", "baal.mesh.wisp.place", "sjo1.mesh.wisp.place", "sin1.mesh.wisp.place")
ROOT = Path("/storage/wisp-db-backups")
CONFIG = Path("/home/regent/.config/wisp-db-backup")
DOCKER = "/run/current-system/sw/bin/docker"
MAPPINGS = ("domains", "custom_domains", "sites")
SIGNATURE_SQL = "SELECT json_build_object(" + ",".join(
    f"'{table}',(SELECT json_build_object('rows',count(*),'digest',"
    f"md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE \"C\"),''))) "
    f"FROM public.{table} t)" for table in MAPPINGS
) + ");"


def command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=900, stderr=subprocess.DEVNULL, **kwargs)


def primary():
    leaders = []
    http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for host in HOSTS:
        try:
            with http.open(f"http://{host}:8008/primary", timeout=5) as response:
                body = json.load(response)
                if response.status == 200 and body.get("role") in ("primary", "master"):
                    leaders.append(host)
        except (OSError, ValueError):
            pass
    if len(leaders) != 1:
        raise RuntimeError("expected exactly one reachable primary")
    return leaders[0]


def client(host):
    return [DOCKER, "run", "--rm", "-i", "--network", "host",
            "--label", "com.centurylinklabs.watchtower.enable=false",
            "--user", f"{os.getuid()}:{os.getgid()}",
            "-v", f"{CONFIG}/pgpass:/run/backup.pgpass:ro",
            "-e", "PGPASSFILE=/run/backup.pgpass", "-e", f"PGHOST={host}",
            "-e", "PGDATABASE=wisp", "-e", "PGUSER=wisp_backup",
            "-e", "PGCONNECT_TIMEOUT=10", "-e", "PGSSLMODE=disable",
            "-e", "PGOPTIONS=-c idle_in_transaction_session_timeout=600000 -c statement_timeout=600000",
            IMAGE]


def query(session, sql):
    session.stdin.write(sql + "\n")
    session.stdin.flush()
    with selectors.DefaultSelector() as selector:
        selector.register(session.stdout, selectors.EVENT_READ)
        if not selector.select(30):
            raise TimeoutError("snapshot query timed out")
    result = session.stdout.readline().strip()
    if not result:
        raise RuntimeError("snapshot session closed")
    return result


def dump(host, directory):
    args = client(host)
    session = subprocess.Popen(args + ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, text=True)
    try:
        snapshot = query(session, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")
        if not re.fullmatch(r"[0-9A-F]+-[0-9A-F]+-[0-9]+", snapshot):
            raise ValueError("invalid snapshot")
        expected = json.loads(query(session, SIGNATURE_SQL))
        (directory / "source-mappings.json").write_text(json.dumps(expected, indent=2) + "\n")
        with (directory / "wisp.dump").open("xb") as output:
            command(args + ["pg_dump", "--format=custom", "--compress=6",
                            "--lock-wait-timeout=30s", "--snapshot=" + snapshot], stdout=output)
            output.flush()
            os.fsync(output.fileno())
        session.communicate("ROLLBACK;\n", timeout=15)
        if session.returncode:
            raise RuntimeError("snapshot session failed")
        with (directory / "roles.sql").open("xb") as output:
            command(args + ["pg_dumpall", "--globals-only", "--no-role-passwords", "--database=wisp"], stdout=output)
        return expected
    finally:
        if session.poll() is None:
            session.kill()
            session.wait()


def restore_check(directory, expected):
    name = "wisp-db-restore-" + directory.name.removesuffix(".partial").lower()
    command([DOCKER, "run", "--rm", "-d", "--name", name, "--network", "none",
             "--label", "com.centurylinklabs.watchtower.enable=false",
             "--tmpfs", "/var/lib/postgresql/data:rw,size=512m",
             "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE], stdout=subprocess.DEVNULL)
    try:
        for attempt in range(60):
            ready = subprocess.run([DOCKER, "exec", name, "pg_isready", "-U", "postgres"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise TimeoutError("isolated restore database did not start")
        command([DOCKER, "exec", name, "createdb", "-U", "postgres", "restorecheck"])
        with (directory / "wisp.dump").open("rb") as source:
            command([DOCKER, "exec", "-i", name, "pg_restore", "-U", "postgres",
                     "--exit-on-error", "--no-owner", "--no-privileges", "-d", "restorecheck"], stdin=source)
        result = command([DOCKER, "exec", name, "psql", "-XAt", "-U", "postgres",
                          "-d", "restorecheck", "-c", SIGNATURE_SQL], stdout=subprocess.PIPE, text=True)
        actual = json.loads(result.stdout)
        if actual != expected:
            raise ValueError("restored mapping counts or contents differ from source snapshot")
        return actual
    finally:
        # Only this disposable, network-isolated test container is stopped; its DB is tmpfs.
        command([DOCKER, "stop", "--time", "10", name], stdout=subprocess.DEVNULL)


def heartbeat():
    destination = json.loads((CONFIG / "monitor.json").read_text())
    url = "https://status.wisp.place/api/v1/endpoints/operations_database-backup/external?success=true"
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    request = urllib.request.Request(url, data=b"", method="POST",
                                     headers={"Authorization": "Bearer " + destination["token"]})
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError("backup heartbeat rejected")


def verify_archive(directory):
    directory = directory.resolve()
    manifest = json.loads((directory / "manifest.json").read_text())
    for name in ("wisp.dump", "roles.sql"):
        with (directory / name).open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != manifest["sha256"][name]:
            raise ValueError("archive checksum mismatch")
    restore_check(directory, manifest["mapping_signatures"])
    print("stored archive checksums and isolated restore verified", flush=True)


def main():
    os.umask(0o077)
    if not os.path.ismount("/storage"):
        raise RuntimeError("backup storage is not mounted")
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if shutil.disk_usage(ROOT).free < 2 * 1024 ** 3:
            raise RuntimeError("less than 2 GiB free on backup storage")
        started = datetime.datetime.now(datetime.timezone.utc)
        stamp = started.strftime("%Y%m%dT%H%M%S.%fZ")
        directory = ROOT / (stamp + ".partial")
        directory.mkdir(mode=0o700)
        host = primary()
        expected = dump(host, directory)
        restored = restore_check(directory, expected)
        checksums = {}
        for path in (directory / "wisp.dump", directory / "roles.sql"):
            with path.open("rb") as source:
                checksums[path.name] = hashlib.file_digest(source, "sha256").hexdigest()
        manifest = {"started_at": started.isoformat(), "primary": host, "client_image": IMAGE,
                    "verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "mapping_signatures": restored, "sha256": checksums}
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        directory.rename(ROOT / stamp)
        (ROOT / "latest.next").symlink_to(stamp)
        os.replace(ROOT / "latest.next", ROOT / "latest")
        print(f"verified backup {stamp}; mapping rows " + json.dumps({k: v["rows"] for k, v in restored.items()}), flush=True)
        heartbeat()
        print("backup freshness reported", flush=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--verify":
            verify_archive(Path(sys.argv[2]))
        elif len(sys.argv) == 1:
            main()
        else:
            raise ValueError("usage: backup.py [--verify backup-directory]")
    except Exception as error:
        print(f"backup failed ({type(error).__name__}); no success heartbeat sent", file=sys.stderr)
        sys.exit(1)
