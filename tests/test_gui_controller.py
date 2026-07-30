import os
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from ya.config import ModelConfig, load_config
from ya.gui import YaApp
from ya.gui_controller import GuiController, GuiTaskOptions, load_preferences
from ya.memory import create_candidate, set_status
from ya.local import LocalAction
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

    def test_workspace_persists_but_invalid_saved_workspace_is_not_usable(self):
        workspace = Path(self.temp.name) / "workspace"
        workspace.mkdir()
        controller = GuiController()
        self.assertIsNone(controller.workspace)
        self.assertEqual(controller.set_workspace(str(workspace)), str(workspace.resolve()))
        self.assertEqual(load_preferences()["workspace"], str(workspace.resolve()))
        self.assertEqual(GuiController().valid_workspace(), str(workspace.resolve()))
        workspace.rmdir()
        self.assertIsNone(GuiController().valid_workspace())

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
        self.assertFalse(controller.can_stream(GuiTaskOptions("Explain recursion", local=True)))

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

    def test_local_run_passes_workspace_and_confirmation_callback(self):
        workspace = Path(self.temp.name) / "workspace"
        workspace.mkdir()
        controller = GuiController()
        controller.set_session_api_key("key")
        controller.set_workspace(str(workspace))
        action = LocalAction("mkdir", (workspace / "notes",), "Create directory")
        with patch("ya.gui_controller.run_task", return_value=RunResult("answer", "single", {})) as run:
            controller.run(GuiTaskOptions("Create notes", local=True), on_local_action=lambda received: received == action)
        local_workspace = run.call_args.kwargs["local_workspace"]
        self.assertEqual(local_workspace.root, workspace.resolve())
        self.assertTrue(local_workspace.confirm(action))
        self.assertIsNone(run.call_args.kwargs["on_content"])

    def test_local_and_toa_are_rejected_by_controller(self):
        controller = GuiController()
        controller.set_session_api_key("key")
        with self.assertRaises(ValueError):
            controller.run(GuiTaskOptions("test", toa=True, local=True))

    def test_gui_local_action_bridge_waits_for_main_thread_decision(self):
        app = type("GuiBridge", (), {"events": queue.Queue()})()
        action = LocalAction("mkdir", (Path(self.temp.name) / "notes",), "Create directory")
        result = []
        worker = threading.Thread(target=lambda: result.append(YaApp._request_local_action(app, action)))
        worker.start()
        event, request = app.events.get(timeout=1)
        self.assertEqual(event, "local_action")
        self.assertEqual(request.action, action)
        request.approved = True
        request.completed.set()
        worker.join(timeout=1)
        self.assertEqual(result, [True])

    def test_memory_actions_and_relevant_cards(self):
        controller = GuiController()
        card = controller.create_memory("Use PostgreSQL indexes", "evidence", "procedure")
        controller.set_memory_status(card.id, "approved")
        self.assertEqual([match.card.id for match in controller.relevant_cards("Explain PostgreSQL indexes")], [card.id])
        controller.set_memory_status(card.id, "revoked")
        self.assertEqual([item.id for item in controller.prune_preview()], [card.id])
        self.assertEqual([item.id for item in controller.prune()], [card.id])
