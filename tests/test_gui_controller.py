import os
import queue
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from ya import __version__
from ya.config import ModelConfig, load_config
from ya.gui import TEXT, YaApp
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

    def test_language_labels_and_about_copy_are_user_facing(self):
        self.assertEqual(TEXT["en"]["language_en"], "English")
        self.assertEqual(TEXT["en"]["language_zh"], "简体中文")
        self.assertEqual(TEXT["zh-CN"]["language_en"], "English")
        self.assertEqual(TEXT["zh-CN"]["language_zh"], "简体中文")
        self.assertIn(__version__, TEXT["en"]["about_text"].format(version=__version__))
        self.assertIn(__version__, TEXT["zh-CN"]["about_text"].format(version=__version__))

    def test_about_dialog_uses_current_version(self):
        app = type("AboutApp", (), {"root": object(), "t": lambda _self, key: TEXT["en"][key]})()
        with patch("ya.gui.messagebox.showinfo") as show:
            YaApp._show_about(app)
        self.assertEqual(show.call_args.args[0], "About Ya")
        self.assertIn(__version__, show.call_args.args[1])

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

    def test_workspace_entries_use_the_authorized_workspace(self):
        workspace = Path(self.temp.name) / "workspace"
        workspace.mkdir()
        (workspace / "notes.txt").write_text("private note", encoding="utf-8")
        (workspace / "folder").mkdir()
        controller = GuiController()
        controller.set_workspace(str(workspace))
        self.assertEqual(
            controller.workspace_entries(),
            [{"path": "folder", "type": "directory"}, {"path": "notes.txt", "type": "file"}],
        )

    def test_local_run_forwards_safe_activity_callback(self):
        workspace = Path(self.temp.name) / "workspace"
        workspace.mkdir()
        (workspace / "notes.txt").write_text("private note", encoding="utf-8")
        controller = GuiController()
        controller.set_session_api_key("key")
        controller.set_workspace(str(workspace))
        activities = []
        with patch("ya.gui_controller.run_task", return_value=RunResult("answer", "single", {})) as run:
            controller.run(GuiTaskOptions("Read notes", local=True), on_local_activity=activities.append)
        local_workspace = run.call_args.kwargs["local_workspace"]
        local_workspace.read({"path": "notes.txt"})
        self.assertEqual(activities[0].operation, "read")
        self.assertEqual(activities[0].paths, ("notes.txt",))
        self.assertEqual(activities[0].status, "success")

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

    def test_workspace_is_the_only_primary_gui_page_label(self):
        self.assertEqual(TEXT["en"]["workspace"], "Workspace")
        self.assertNotIn("ask", TEXT["en"])

    def test_memory_actions_and_relevant_cards(self):
        controller = GuiController()
        card = controller.create_memory("Use PostgreSQL indexes", "evidence", "procedure")
        controller.set_memory_status(card.id, "approved")
        self.assertEqual([match.card.id for match in controller.relevant_cards("Explain PostgreSQL indexes")], [card.id])
        controller.set_memory_status(card.id, "revoked")
        self.assertEqual([item.id for item in controller.prune_preview()], [card.id])
        self.assertEqual([item.id for item in controller.prune()], [card.id])

    def test_audit_actions_are_available_to_gui(self):
        controller = GuiController()
        from ya.local import append_audit_record

        append_audit_record({"record": 1})
        self.assertEqual([path.name for path in controller.audit_logs()], ["actions.jsonl"])
        self.assertGreater(controller.audit_log_total_bytes(), 0)
        self.assertEqual([path.name for path in controller.clear_audit_logs()], ["actions.jsonl"])
        self.assertEqual(controller.audit_logs(), [])

    def test_gui_audit_clear_requires_confirmation(self):
        controller = GuiController()
        from ya.local import append_audit_record

        append_audit_record({"record": 1})
        app = type("AuditApp", (), {"controller": controller, "root": object(), "t": lambda _self, key: TEXT["en"][key]})()
        with patch("ya.gui.messagebox.askyesno", return_value=False), patch("ya.gui.messagebox.showinfo"):
            YaApp._clear_audit(app)
        self.assertTrue(controller.audit_logs())
        with patch("ya.gui.messagebox.askyesno", return_value=True), patch("ya.gui.messagebox.showinfo") as show:
            YaApp._clear_audit(app)
        self.assertEqual(controller.audit_logs(), [])
        self.assertIn("Deleted 1 audit log file(s).", show.call_args.args[1])
