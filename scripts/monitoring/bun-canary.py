#!/usr/bin/env python3
import http.client
import json
import re
import socket
import sys
from pathlib import Path

SOCKET_PATH = "/var/run/docker.sock"
METRICS_PATH = "/api/v1/import/prometheus"
METRICS_HOST = "valefar.mesh.wisp.place"
SERVICES = ("wisp-place", "wisp-hosting-service", "wisp-firehose-service")
TIMEOUT = 3
MAX_RESPONSE = 512 * 1024
MEMORY_METRICS = (
    ("vmrss", "process_rss_bytes"),
    ("vmswap", "process_swap_bytes"),
    ("cgroup_memory", "cgroup_memory_current_bytes"),
    ("cgroup_swap", "cgroup_swap_current_bytes"),
)


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, socket_path=SOCKET_PATH):
        super().__init__("localhost", timeout=TIMEOUT)
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.socket_path)


def read_response(response):
    if response.status != 200:
        response.read(4096)
        raise RuntimeError("docker API request failed")
    body = response.read(MAX_RESPONSE + 1)
    if len(body) > MAX_RESPONSE:
        raise ValueError("docker response too large")
    return json.loads(body)


def docker_get(path, socket_path=SOCKET_PATH):
    connection = DockerConnection(socket_path)
    try:
        connection.request("GET", path, headers={"Connection": "close"})
        return read_response(connection.getresponse())
    finally:
        connection.close()


def container_info(socket_path=SOCKET_PATH):
    containers = {}
    for service in SERVICES:
        detail = docker_get("/containers/%s/json" % service, socket_path)
        containers[service] = detail
    return containers


def label(value):
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def metric_labels(service, image):
    return 'service="%s",host="sjo1",image="%s"' % (label(service), label(image))


def read_limited(path, limit):
    with open(path, "rb") as file:
        value = file.read(limit + 1)
    if len(value) > limit:
        raise ValueError("proc file too large")
    return value.decode()


def process_memory(pid, proc_root="/proc", cgroup_root="/sys/fs/cgroup"):
    process_path = Path(proc_root) / str(pid)
    status = read_limited(process_path / "status", 65536)
    values = {}
    for field in ("VmRSS", "VmSwap"):
        match = re.search(r"^%s:\s+(\d+)\s+kB$" % field, status, re.MULTILINE)
        if match:
            values[field.lower()] = int(match.group(1)) * 1024
    cgroup_text = read_limited(process_path / "cgroup", 65536)
    cgroup_path = next(
        (line.split(":", 2)[2].strip() for line in cgroup_text.splitlines()
         if line.startswith("0::")),
        None,
    )
    if cgroup_path is None or ".." in Path(cgroup_path).parts:
        raise ValueError("unsupported cgroup path")
    cgroup = Path(cgroup_root) / cgroup_path.lstrip("/")
    for filename, key in (("memory.current", "cgroup_memory"), ("memory.swap.current", "cgroup_swap")):
        try:
            values[key] = int(read_limited(cgroup / filename, 128).strip())
        except (FileNotFoundError, ValueError):
            pass
    return values


def metric_lines(containers, proc_root="/proc", cgroup_root="/sys/fs/cgroup"):
    lines = []
    for service in SERVICES:
        container = containers[service]
        config = container.get("Config", {})
        state = container.get("State", {})
        labels = metric_labels(service, config.get("Image") or container.get("Image", "unknown"))
        lines.append("bun_canary_up{%s} %d" % (labels, int(bool(state.get("Running")))))
        if "RestartCount" in container:
            lines.append("bun_canary_restarts_total{%s} %s" % (labels, container["RestartCount"]))
        health = state.get("Health", {}).get("Status")
        if health is not None:
            lines.append("bun_canary_healthy{%s} %d" % (labels, int(health == "healthy")))
        if state.get("Running") and state.get("Pid"):
            try:
                memory = process_memory(state["Pid"], proc_root, cgroup_root)
            except (OSError, ValueError):
                memory = {}
            for key, metric in MEMORY_METRICS:
                if key in memory:
                    lines.append("bun_canary_%s{%s} %d" % (metric, labels, memory[key]))
    return "\n".join(lines) + "\n"


def publish(payload):
    connection = http.client.HTTPConnection(METRICS_HOST, 8428, timeout=TIMEOUT)
    try:
        connection.request(
            "POST", METRICS_PATH, payload.encode(),
            {"Content-Type": "text/plain", "Connection": "close"},
        )
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            response.read(4096)
            raise RuntimeError("metrics endpoint rejected request")
        response.read(4096)
    finally:
        connection.close()


def main():
    try:
        publish(metric_lines(container_info()))
    except Exception as error:
        print("canary collector failed: %s" % error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
