import os
import subprocess
import sys
import tempfile
import unittest
from io import StringIO
from pathlib import Path
from unittest.mock import patch

from ya import cli
from ya.memory import create_candidate, list_cards, set_status
from ya.local import LocalAction
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
            self.assertEqual(cli.main(["ask", "test", "--stream", "off"]), 0)
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

    def test_ask_streams_simple_tty_answers(self):
        stream = _TtyStringIO()
        result = RunResult(content="## Title\n\n**bold**", mode="single", usage={})

        def agent(client, task, config, web_mode, on_content):
            on_content("## Ti")
            on_content("tle\n\n**bold**")
            return result

        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", side_effect=agent), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "explain a concept"]), 0)
        self.assertIn("Title", stream.getvalue())
        self.assertIn("bold", stream.getvalue())
        self.assertNotIn("##", stream.getvalue())
        self.assertNotIn("**", stream.getvalue())

    def test_research_auto_does_not_request_streaming(self):
        stream = _TtyStringIO()
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result) as agent, patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "latest weather"]), 0)
        self.assertIsNone(agent.call_args.kwargs["on_content"])

    def test_local_mode_disables_streaming_and_passes_workspace(self):
        stream = _TtyStringIO()
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result) as agent, patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "create a folder", "--local", "--workspace", self.temp.name]), 0)
        self.assertIsNone(agent.call_args.kwargs["on_content"])
        self.assertEqual(agent.call_args.kwargs["local_workspace"].root, Path(self.temp.name).resolve())

    def test_local_and_toa_are_mutually_exclusive(self):
        self.assertEqual(cli.main(["ask", "test", "--local", "--toa"]), 2)

    def test_approve_requires_local(self):
        self.assertEqual(cli.main(["ask", "test", "--approve"]), 2)

    def test_workspace_requires_local(self):
        self.assertEqual(cli.main(["ask", "test", "--workspace", self.temp.name]), 2)

    def test_noninteractive_local_confirmation_requires_approve(self):
        action = LocalAction("mkdir", (Path(self.temp.name),), "Create directory")
        stream = StringIO()
        with patch("ya.cli.sys.stdin.isatty", return_value=False), patch("ya.cli.sys.stdout", stream):
            self.assertFalse(cli._local_confirm(action, approve_noninteractive=False))
            self.assertTrue(cli._local_confirm(action, approve_noninteractive=True))
        self.assertIn("require --approve", stream.getvalue())

    def test_show_memory_displays_selected_cards_before_answer(self):
        card = create_candidate("Use PostgreSQL indexes", "evidence")
        set_status(card.id, "approved")
        stream = StringIO()
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "Explain PostgreSQL indexes", "--show-memory"]), 0)
        self.assertIn("[Ya memory context]", stream.getvalue())
        self.assertIn(card.id, stream.getvalue())
        self.assertIn("score", stream.getvalue())

    def test_show_memory_reports_no_matching_cards(self):
        card = create_candidate("Use PostgreSQL indexes", "evidence")
        set_status(card.id, "approved")
        stream = StringIO()
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "Explain coffee brewing", "--show-memory"]), 0)
        self.assertIn("No approved memory met the relevance threshold.", stream.getvalue())
        self.assertNotIn(card.id, stream.getvalue())

    def test_show_memory_precedes_streaming_answer(self):
        card = create_candidate("Use PostgreSQL indexes", "evidence")
        set_status(card.id, "approved")
        stream = _TtyStringIO()
        result = RunResult(content="answer", mode="single", usage={})

        def agent(client, task, config, web_mode, on_content):
            on_content("answer")
            return result

        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", side_effect=agent), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "Explain PostgreSQL indexes", "--show-memory"]), 0)
        self.assertLess(stream.getvalue().index(card.id), stream.getvalue().index("[Ya single result]"))
        self.assertIn("answer", stream.getvalue())

    def test_memory_is_silent_without_show_memory(self):
        card = create_candidate("Use PostgreSQL indexes", "evidence")
        set_status(card.id, "approved")
        stream = StringIO()
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.load_api_key", return_value="key"), patch("ya.cli.single_agent", return_value=result), patch(
            "ya.cli._collect_feedback"
        ), patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["ask", "Explain PostgreSQL indexes"]), 0)
        self.assertNotIn("[Ya memory context]", stream.getvalue())
        self.assertNotIn(card.id, stream.getvalue())

    def test_feedback_prompt_uses_plain_language(self):
        result = RunResult(content="answer", mode="single", usage={})
        with patch("ya.cli.sys.stdin.isatty", return_value=True), patch("builtins.input", return_value="n") as prompt:
            cli._collect_feedback(result, disabled=False)
        self.assertEqual(prompt.call_args.args[0], "\nLearn from this answer? [y/N] ")

    def test_memory_prune_requires_yes_when_noninteractive(self):
        card = create_candidate("discard me", "evidence")
        set_status(card.id, "rejected")
        with patch("ya.cli.sys.stdin.isatty", return_value=False):
            self.assertEqual(cli.main(["memory", "prune"]), 2)
        self.assertEqual([existing.id for existing in list_cards()], [card.id])

    def test_memory_prune_can_be_declined_interactively(self):
        card = create_candidate("discard me", "evidence")
        set_status(card.id, "rejected")
        stream = StringIO()
        with patch("ya.cli.sys.stdin.isatty", return_value=True), patch("builtins.input", return_value="n"), patch(
            "ya.cli.sys.stdout", stream
        ):
            self.assertEqual(cli.main(["memory", "prune"]), 0)
        self.assertIn(card.id, stream.getvalue())
        self.assertIn("No memory cards deleted.", stream.getvalue())
        self.assertEqual([existing.id for existing in list_cards()], [card.id])

    def test_memory_prune_with_yes_deletes_default_statuses(self):
        rejected = create_candidate("rejected", "evidence")
        candidate = create_candidate("candidate", "evidence")
        set_status(rejected.id, "rejected")
        stream = StringIO()
        with patch("ya.cli.sys.stdout", stream):
            self.assertEqual(cli.main(["memory", "prune", "--yes"]), 0)
        self.assertIn(rejected.id, stream.getvalue())
        self.assertIn("Deleted 1 memory card(s).", stream.getvalue())
        self.assertEqual([existing.id for existing in list_cards()], [candidate.id])

    def test_memory_prune_can_include_candidates(self):
        candidate = create_candidate("candidate", "evidence")
        approved = create_candidate("approved", "evidence")
        set_status(approved.id, "approved")
        self.assertEqual(cli.main(["memory", "prune", "--include-candidates", "--yes"]), 0)
        self.assertEqual([existing.id for existing in list_cards()], [approved.id])
