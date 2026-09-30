import importlib.util
import io
import json
import pathlib
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = load("gatus-probe")
config = load("gatus-config")


class GatusTests(unittest.TestCase):
    def test_complete_configuration_without_embedded_secrets(self):
        data = config.configuration()
        self.assertEqual(len(data["endpoints"]), 10)
        self.assertEqual(len(data["external-endpoints"]), 14)
        keys = [(x["group"], x["name"]) for x in data["endpoints"] + data["external-endpoints"]]
        self.assertEqual(len(keys), len(set(keys)))
        for endpoint in data["external-endpoints"]:
            self.assertTrue(endpoint["token"].startswith("${"))
            self.assertEqual(endpoint["heartbeat"]["interval"], "3m")
        self.assertEqual(data["alerting"]["discord"]["webhook-url"], "${DISCORD_WEBHOOK_URL}")

    def test_health_policy_and_leader(self):
        self.assertTrue(probe.healthy("webhook-service", {"status": "healthy"}))
        self.assertFalse(probe.healthy("main-app", {"status": "degraded"}))
        self.assertFalse(probe.healthy("hosting-service", None))
        standby = {"status": "healthy", "ready": False, "leadership": {"state": "standby"}}
        self.assertTrue(probe.healthy("firehose-service", standby))
        self.assertFalse(probe.active_leader(standby))
        self.assertTrue(probe.active_leader(dict(standby, ready=True, leadership={"state": "acquired"})))

    def test_probe_pushes_only_successful_webhook_health(self):
        check = dict(app="webhook-service", container="webhooks", port=3003, path="/health",
                     network="pds_default", destination={"token": "secret"})
        container = [{"State": {"Running": True}, "NetworkSettings": {
            "Networks": {"pds_default": {"IPAddress": "172.18.0.2"}},
        }}]
        for status, expected in (("healthy", True), ("degraded", False)):
            response = io.BytesIO(json.dumps({"status": status}).encode())
            response.status = 200
            response.url = "http://172.18.0.2:3003/health"
            opener = MagicMock()
            opener.open.return_value.__enter__.return_value = response
            with patch.object(probe.subprocess, "check_output", return_value=json.dumps(container)), \
                 patch.object(probe.urllib.request, "build_opener", return_value=opener), \
                 patch.object(probe, "push") as push, redirect_stdout(io.StringIO()):
                self.assertEqual(probe.probe(check, None), expected)
                self.assertEqual(push.call_count, int(expected))

    def test_failure_withholds_status_and_redacts_exception(self):
        output = io.StringIO()
        with patch.object(probe.subprocess, "check_output", side_effect=ValueError("secret")), \
             patch.object(probe, "push") as push, redirect_stdout(output):
            self.assertFalse(probe.probe({"app": "main-app", "container": "missing"}, None))
            push.assert_not_called()
        self.assertNotIn("secret", output.getvalue())

    def test_push_authentication_and_destination(self):
        url = "https://status.wisp.place/api/v1/endpoints/global_webhooks/external"
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.status = 200
        with patch.object(probe.urllib.request, "build_opener", return_value=opener):
            probe.push({"url": url, "token": "secret"}, True)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.full_url, url + "?success=true")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        with self.assertRaises(ValueError):
            probe.push({"url": "https://example.com/external", "token": "secret"}, True)


if __name__ == "__main__":
    unittest.main()
