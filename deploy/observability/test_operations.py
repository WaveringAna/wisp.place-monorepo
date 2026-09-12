import copy
import datetime
import importlib.util
import json
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = load("probe", "probe.py")
overlay = load("overlay", "gatus-overlay.py")
logging = load("logging_config", "verify-logging.py")


class OperationsTests(unittest.TestCase):
    def test_replica_contract_and_fallback(self):
        now = 1000
        replica = {"configured": True, "mode": "healthy", "usingPrimaryFallback": False,
                   "lastCheckedAt": datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()}
        body = {"database": {"readEndpoint": replica}}
        self.assertTrue(probe.replica_ok(body, now))
        for mode in ("lagging", "receiver_unhealthy", "unavailable", "unsafe", "writable", "primary"):
            replica["mode"] = mode
            self.assertFalse(probe.replica_ok(body, now))
        replica["mode"] = "healthy"
        replica["usingPrimaryFallback"] = True
        self.assertFalse(probe.replica_ok(body, now))
        replica["usingPrimaryFallback"] = False
        self.assertFalse(probe.replica_ok(body, now + 301))

    def test_standby_does_not_satisfy_or_fail_shared_ingestion(self):
        for state in ("standby", "acquiring", "releasing", "stopped"):
            self.assertIsNone(probe.ingestion_ok({"leadership": {"state": state}}))
        body = {"leadership": {"state": "acquired"}, "ready": True,
                "firehose": {"connected": True, "timeSinceLastEvent": 0, "consecutiveFailures": 0}}
        self.assertTrue(probe.ingestion_ok(body))
        body["firehose"]["timeSinceLastEvent"] = 300_000
        self.assertFalse(probe.ingestion_ok(body))
        with patch.object(probe, "inspect", side_effect=ValueError):
            result = probe.collect({"apps": {"main": "main", "firehose": "firehose"}}, {}, 1)
        self.assertIsNone(result["ingestion"])
        self.assertFalse(result["database"])

    def test_missing_samples_fail_instead_of_looking_healthy(self):
        for value in (None, True, "0", float("nan")):
            with self.assertRaises(ValueError):
                probe.number(value)
        with self.assertRaises(KeyError):
            probe.replica_ok({}, 1)

    def test_historical_dlq_is_baseline_new_entries_alert_even_when_trimmed(self):
        sample = {"pending": 0, "lag": 0, "oldest": False, "dlq": "1000-0"}
        state = {}
        self.assertTrue(probe.queue_ok(sample, state, 100))
        self.assertTrue(probe.queue_ok(sample, state, 200))
        sample["dlq"] = "2000-0"
        self.assertFalse(probe.queue_ok(sample, state, 300))
        self.assertFalse(probe.queue_ok(sample, state, 899))
        self.assertTrue(probe.queue_ok(sample, state, 900))
        sample["dlq"] = "0-0"
        self.assertTrue(probe.queue_ok(sample, state, 1000))

    def test_pending_age_and_backlog_windows_allow_retry(self):
        state = {}
        sample = {"pending": 1, "lag": 0, "oldest": "1000000-0", "dlq": "0-0"}
        self.assertTrue(probe.queue_ok(sample, state, 2799))
        self.assertFalse(probe.queue_ok(sample, state, 2800))
        sample.update(pending=0, lag=100)
        self.assertTrue(probe.queue_ok(sample, state, 3000))
        self.assertTrue(probe.queue_ok(sample, state, 3899))
        self.assertFalse(probe.queue_ok(sample, state, 3900))
        sample["lag"] = 0
        self.assertTrue(probe.queue_ok(sample, state, 3901))

    def test_debounce_recovers_without_stale_failure(self):
        state = {}
        self.assertTrue(probe.confirmed("queue", False, state, 0))
        self.assertTrue(probe.confirmed("queue", False, state, 179))
        self.assertFalse(probe.confirmed("queue", False, state, 180))
        self.assertTrue(probe.confirmed("queue", True, state, 181))
        self.assertTrue(probe.confirmed("queue", False, state, 182))
        self.assertIsNone(probe.confirmed("queue", None, state, 500))
        self.assertTrue(probe.confirmed("queue", False, state, 501))

    def test_redis_uses_actual_stream_and_password_only_on_stdin(self):
        container = {"Config": {"Env": ["REDIS_URL=redis://reader:secret@redis:6380/2",
                                         "WISP_REVALIDATE_STREAM=live-stream"]}}
        sample = {"pending": 0, "lag": 0, "oldest": False, "dlq": "0-0"}
        with patch.object(probe, "command", return_value=json.dumps(json.dumps(sample))) as command:
            self.assertEqual(probe.queue_snapshot(container, "redis-container"), sample)
        args, credential = command.call_args.args
        self.assertNotIn("secret", " ".join(args))
        self.assertEqual(credential, b"secret\n")
        self.assertEqual(args[-3:], ["live-stream", "wisp:revalidate:dlq", "firehose-service"])
        self.assertIn("EVAL_RO", args)

    def test_exporter_checks_stderr_without_printing_logs(self):
        container = {"Name": "app", "Config": {"Env": [
            "GRAFANA_LOKI_URL=http://logs", "GRAFANA_LOKI_PATH=/insert/loki/api/v1/push"]}}
        with patch.object(probe, "command", return_value="[LokiExporter] Failed to send logs to Loki\n" * 3) as command:
            self.assertFalse(probe.exporter_ok([container]))
            self.assertTrue(command.call_args.kwargs["combined"])

    def test_logsql_uses_real_jobs_and_empty_is_unhealthy(self):
        with patch.object(probe, "request", return_value='{"rows":"2"}\n') as request:
            self.assertTrue(probe.logs_ok("http://logs"))
            self.assertIn("main-app", request.call_args.args[0])
        with patch.object(probe, "request", return_value='{"rows":"0"}\n'):
            self.assertFalse(probe.logs_ok("http://logs"))

    def test_status_destination_is_fixed_and_credentials_not_redirected(self):
        destination = {"url": "https://status.wisp.place/api/v1/endpoints/operations_test/external", "token": "secret"}
        with patch.object(probe, "request") as request:
            probe.push(destination, False)
            self.assertNotIn("secret", request.call_args.args[0])
            self.assertEqual(request.call_args.kwargs["headers"], {"Authorization": "Bearer secret"})
        destination["url"] = "https://attacker.test/api/v1/endpoints/operations_test/external"
        with self.assertRaises(ValueError):
            probe.push(destination, True)
        self.assertIsNone(probe.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other"))

    def test_state_write_failure_withholds_healthy_grace_period_pushes(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config.json"
            config.write_text(json.dumps({"state_path": str(Path(directory) / "state.json")}))
            with (patch.object(probe.sys, "argv", ["probe", str(config)]),
                  patch.object(probe, "collect", return_value={"logs": False}),
                  patch.object(probe.os, "replace", side_effect=OSError("disk unavailable")),
                  patch.object(probe, "push") as push):
                with self.assertRaises(OSError):
                    probe.main()
                push.assert_not_called()

    def test_logging_guard_detects_missing_settings_without_values(self):
        config = {"services": {name: {"environment": {
            "GRAFANA_LOKI_URL": logging.URLS[0], "GRAFANA_LOKI_PATH": "/insert/loki/api/v1/push"}}
            for name in logging.APPS}}
        self.assertEqual(logging.verify(config), [])
        config["services"]["wisp-place"]["environment"]["GRAFANA_LOKI_URL"] = "secret"
        problems = logging.verify(config)
        self.assertEqual(len(problems), 1)
        self.assertNotIn("secret", problems[0])

    def test_overlay_preserves_existing_checks_and_delivery(self):
        existing = {"alerting": {"discord": {"webhook-url": "${DISCORD_WEBHOOK_URL}"}},
                    "external-endpoints": [{"group": "old", "name": "check"}],
                    "endpoints": [{"name": "website"}]}
        before = copy.deepcopy(existing)
        result = overlay.extend(existing)
        self.assertEqual(existing, before)
        self.assertEqual(result["alerting"], before["alerting"])
        self.assertEqual(result["endpoints"], before["endpoints"])
        self.assertEqual(result["external-endpoints"][0], before["external-endpoints"][0])
        self.assertEqual(len(result["external-endpoints"]), 12)
        with self.assertRaises(ValueError):
            overlay.extend(result)


if __name__ == "__main__":
    unittest.main()
