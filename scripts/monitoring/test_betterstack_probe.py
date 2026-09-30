import importlib.util
import io
import json
import pathlib
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location(
    "probe", pathlib.Path(__file__).with_name("betterstack-probe.py"),
)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class HealthTests(unittest.TestCase):
    def test_health_contract(self):
        for app in ("main-app", "hosting-service", "firehose-service", "webhook-service"):
            status = "healthy" if app in ("firehose-service", "webhook-service") else "ok"
            self.assertTrue(probe.healthy(app, {"status": status}))
            for body in ({"status": "degraded"}, {}, None, []):
                self.assertFalse(probe.healthy(app, body))

    def test_standby_is_healthy_but_never_an_active_leader(self):
        body = {"status": "healthy", "ready": False, "leadership": {"state": "standby"}}
        self.assertTrue(probe.healthy("firehose-service", body))
        self.assertFalse(probe.active_leader(body))
        body.update(ready=True, leadership={"state": "acquired"})
        self.assertTrue(probe.active_leader(body))
        body["status"] = "degraded"
        self.assertFalse(probe.active_leader(body))

    def test_only_successful_health_sends_a_heartbeat(self):
        check = dict(app="main-app", container="wisp-place", port=8000,
                     path="/api/health", heartbeat_url="secret")
        container = [{"State": {"Running": True}, "NetworkSettings": {
            "Networks": {"proxy_network": {"IPAddress": "172.18.0.2"}},
        }}]
        for status, expected in (("ok", True), ("degraded", False)):
            response = io.BytesIO(json.dumps({"status": status}).encode())
            response.status = 200
            response.url = "http://172.18.0.2:8000/api/health"
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value = response
            with patch.object(probe.subprocess, "check_output", return_value=json.dumps(container)), \
                 patch.object(probe.urllib.request, "build_opener", return_value=opener), \
                 patch.object(probe, "ping") as ping, redirect_stdout(io.StringIO()):
                self.assertEqual(probe.probe(check, "leader-secret"), expected)
                self.assertEqual(ping.call_count, int(expected))

    def test_failure_does_not_leak_credentials_or_ping(self):
        output = io.StringIO()
        with patch.object(probe.subprocess, "check_output", side_effect=ValueError("secret")), \
             patch.object(probe, "ping") as ping, redirect_stdout(output):
            self.assertFalse(probe.probe({"app": "main-app", "container": "missing"}, "secret"))
            ping.assert_not_called()
        self.assertNotIn("secret", output.getvalue())

    def test_webhook_network_without_leader_heartbeat(self):
        check = dict(app="webhook-service", container="wisp-webhook-service", port=3003,
                     path="/health", network="pds_default", heartbeat_url="webhook-secret")
        container = [{"State": {"Running": True}, "NetworkSettings": {
            "Networks": {"pds_default": {"IPAddress": "172.18.0.2"}},
        }}]
        response = io.BytesIO(b'{"status":"healthy"}')
        response.status = 200
        response.url = "http://172.18.0.2:3003/health"
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value = response
        with patch.object(probe.subprocess, "check_output", return_value=json.dumps(container)), \
             patch.object(probe.urllib.request, "build_opener", return_value=opener), \
             patch.object(probe, "ping") as ping, redirect_stdout(io.StringIO()):
            self.assertTrue(probe.probe(check, None))
            ping.assert_called_once_with("webhook-secret")

    def test_rejects_unexpected_heartbeat_destination(self):
        with self.assertRaises(ValueError):
            probe.ping("https://example.com/api/v1/heartbeat/secret")


if __name__ == "__main__":
    unittest.main()
