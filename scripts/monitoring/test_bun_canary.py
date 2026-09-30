import importlib.util
import io
from types import SimpleNamespace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_SPEC = importlib.util.spec_from_file_location(
    "canary", Path(__file__).with_name("bun-canary.py")
)
canary = importlib.util.module_from_spec(MODULE_SPEC)
MODULE_SPEC.loader.exec_module(canary)


class CanaryTest(unittest.TestCase):
    def test_labels_escape(self):
        escaped = canary.label('a"b\\c\nd')
        self.assertEqual(escaped, 'a\\"b\\\\c\\nd')

    def test_memory_and_metrics_from_mocked_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            process = root / "proc" / "42"
            cgroup = root / "cg" / "x"
            process.mkdir(parents=True)
            cgroup.mkdir(parents=True)
            (process / "status").write_text("VmRSS: 12 kB\nVmSwap: 3 kB\n")
            (process / "cgroup").write_text("0::/x\n")
            (cgroup / "memory.current").write_text("99\n")
            (cgroup / "memory.swap.current").write_text("7\n")
            memory = canary.process_memory(42, root / "proc", root / "cg")
            self.assertEqual(memory, {"vmrss": 12288, "vmswap": 3072, "cgroup_memory": 99, "cgroup_swap": 7})
            containers = {
                service: {
                    "Config": {"Image": "img:v1"},
                    "State": {"Running": True, "Pid": 42, "Health": {"Status": "healthy"}},
                    "RestartCount": 2,
                }
                for service in canary.SERVICES
            }
            metrics = canary.metric_lines(containers, root / "proc", root / "cg")
            self.assertIn("bun_canary_process_rss_bytes{service=\"wisp-place\",host=\"sjo1\",image=\"img:v1\"} 12288", metrics)
            self.assertNotIn("pid=", metrics)

    @patch.object(canary.http.client, "HTTPConnection")
    def test_publish_mocked_api(self, connection_class):
        connection_class.return_value.getresponse.return_value.status = 204
        canary.publish("metric 1\n")
        connection_class.return_value.request.assert_called_once()

    def test_docker_response_is_bounded(self):
        response = SimpleNamespace(status=200, read=io.BytesIO(b"x" * (canary.MAX_RESPONSE + 1)).read)
        with self.assertRaisesRegex(ValueError, "too large"):
            canary.read_response(response)

    def test_docker_error_does_not_include_response_contents(self):
        response = SimpleNamespace(status=404, read=io.BytesIO(b"private details").read)
        with self.assertRaisesRegex(RuntimeError, "^docker API request failed$"):
            canary.read_response(response)

    @patch.object(canary.http.client, "HTTPConnection")
    def test_rejected_publish_closes_connection(self, connection_class):
        connection = connection_class.return_value
        connection.getresponse.return_value.status = 500
        with self.assertRaisesRegex(RuntimeError, "metrics endpoint rejected"):
            canary.publish("metric 1\n")
        connection.close.assert_called_once()

    def test_missing_measurement_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            process = Path(directory) / "proc" / "1"
            process.mkdir(parents=True)
            (process / "status").write_text("VmRSS: 1 kB\n")
            (process / "cgroup").write_text("0::/x\n")
            memory = canary.process_memory(1, Path(directory) / "proc", Path(directory) / "cg")
            self.assertNotIn("cgroup_memory", memory)


if __name__ == "__main__":
    unittest.main()
