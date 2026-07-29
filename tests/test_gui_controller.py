import os
import tempfile
import unittest
from unittest.mock import patch

from ya.config import ModelConfig, load_config
from ya.gui_controller import GuiController, GuiTaskOptions, load_preferences
from ya.memory import create_candidate, set_status
from ya.orchestrator import RunResult


class GuiControllerTests(unittest.TestCase):
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

    def test_language_defaults_to_english_and_persists(self):
        controller = GuiController()
        self.assertEqual(controller.language, "en")
        controller.set_language("zh-CN")
        self.assertEqual(load_preferences()["language"], "zh-CN")
        self.assertEqual(GuiController().language, "zh-CN")

    def test_config_and_session_key_are_local(self):
        controller = GuiController()
        config = ModelConfig(model="deepseek-v4-pro", thinking_enabled=True, reasoning_effort="max")
        controller.save_config(config)
        controller.set_session_api_key("session-key")
        self.assertEqual(load_config(), config)
        self.assertEqual(controller.api_key(), "session-key")

    def test_streaming_and_buffered_options(self):
        controller = GuiController()
        self.assertTrue(controller.can_stream(GuiTaskOptions("Explain recursion")))
        self.assertFalse(controller.can_stream(GuiTaskOptions("latest news")))
        self.assertFalse(controller.can_stream(GuiTaskOptions("Explain recursion", toa=True)))

    def test_run_passes_stream_callback_only_for_simple_tasks(self):
        controller = GuiController()
        controller.set_session_api_key("key")
        output = []
        with patch("ya.gui_controller.run_task", return_value=RunResult("answer", "single", {})) as run:
            controller.run(GuiTaskOptions("Explain recursion"), output.append)
        self.assertIsNotNone(run.call_args.kwargs["on_content"])
        with patch("ya.gui_controller.run_task", return_value=RunResult("answer", "single", {})) as run:
            controller.run(GuiTaskOptions("latest news"), output.append)
        self.assertIsNone(run.call_args.kwargs["on_content"])

    def test_memory_actions_and_relevant_cards(self):
        controller = GuiController()
        card = controller.create_memory("Use PostgreSQL indexes", "evidence", "procedure")
        controller.set_memory_status(card.id, "approved")
        self.assertEqual([match.card.id for match in controller.relevant_cards("Explain PostgreSQL indexes")], [card.id])
        controller.set_memory_status(card.id, "revoked")
        self.assertEqual([item.id for item in controller.prune_preview()], [card.id])
        self.assertEqual([item.id for item in controller.prune()], [card.id])
