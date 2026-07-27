import os
import subprocess
import sys
import tempfile
import unittest
from io import StringIO
from unittest.mock import patch

from ya import cli
from ya.orchestrator import RunResult


class _TtyStringIO(StringIO):
    def isatty(self):
        return True


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

    def test_module_entrypoint_shows_help(self):
        completed = subprocess.run(
            [sys.executable, "-m", "ya", "--help"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertIn("usage: ya", completed.stdout)

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

    def test_ask_auto_renders_markdown_in_a_tty(self):
        stream = _TtyStringIO()
        result = RunResult(content="## Title\n\n**bold**", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "test"]), 0)
        self.assertIn("Title", stream.getvalue())
        self.assertIn("bold", stream.getvalue())
        self.assertNotIn("##", stream.getvalue())
        self.assertNotIn("**", stream.getvalue())

    def test_ask_auto_preserves_markdown_when_redirected(self):
        stream = StringIO()
        result = RunResult(content="## Title", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "test"]), 0)
        self.assertIn("## Title", stream.getvalue())

    def test_ask_markdown_format_bypasses_terminal_renderer(self):
        stream = _TtyStringIO()
        result = RunResult(content="## Title", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "test", "--format", "markdown"]), 0)
        self.assertIn("## Title", stream.getvalue())

    def test_ask_terminal_format_renders_when_redirected(self):
        stream = StringIO()
        result = RunResult(content="## Title", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "test", "--format", "terminal"]), 0)
        self.assertIn("Title", stream.getvalue())
        self.assertNotIn("##", stream.getvalue())

    def test_feedback_prompt_uses_plain_language(self):
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.sys.stdin.isatty", return_value=True), patch("builtins.input", return_value="n") as prompt:
            cli._collect_feedback(result, disabled=False)
        self.assertEqual(prompt.call_args.args[0], "\nLearn from this answer? [y/N] ")
