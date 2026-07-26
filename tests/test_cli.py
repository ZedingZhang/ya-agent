import os
import tempfile
import unittest
from unittest.mock import patch

from ya import cli


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("YA_HOME")
        os.environ["YA_HOME"] = self.temp.name

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("YA_HOME", None)
        else:
            os.environ["YA_HOME"] = self.previous_home
        self.temp.cleanup()

    def test_effort_requires_thinking(self):
        with patch("ya.cli.load_api_key", return_value="key"):
            self.assertEqual(cli.main(["ask", "test", "--thinking", "off", "--reasoning-effort", "max"]), 2)

    def test_config_set_pro(self):
        self.assertEqual(cli.main(["config", "set", "model", "pro"]), 0)

    def test_toa_requires_explicit_noninteractive_permission(self):
        parser = cli._parser()
        args = parser.parse_args(["ask", "test", "--toa"])
        with patch("ya.cli.sys.stdin.isatty", return_value=False):
            with self.assertRaises(ValueError):
                cli._toa_confirm(args, cli.ModelConfig())

    def test_toa_worker_limit_is_enforced_by_parser(self):
        parser = cli._parser()
        with self.assertRaises(SystemExit):
            parser.parse_args(["ask", "test", "--toa", "--toa-workers", "3"])
