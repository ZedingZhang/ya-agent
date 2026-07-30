import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from ya.local import (
    MAX_AUDIT_ARCHIVES,
    LocalWorkspace,
    MAX_DIFF_LINES,
    MAX_TEXT_BYTES,
    append_audit_record,
    audit_log_files,
    audit_log_total_bytes,
    clear_audit_logs,
)


class LocalWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("YA_HOME")
        os.environ["YA_HOME"] = self.temp.name
        self.root = Path(self.temp.name) / "workspace"
        self.root.mkdir()
        self.actions = []
        self.workspace = LocalWorkspace(self.root, self._approve)

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("YA_HOME", None)
        else:
            os.environ["YA_HOME"] = self.previous_home
        self.temp.cleanup()

    def _approve(self, action):
        self.actions.append(action)
        return True

    def test_list_read_and_search_text_and_filename(self):
        with (self.root / "notes.txt").open("w", encoding="utf-8", newline="\n") as handle:
            handle.write("Hello Ya\nFind this line\n")
        listing = json.loads(self.workspace.list({}))
        self.assertEqual(listing["entries"][0]["path"], "notes.txt")
        self.assertEqual(json.loads(self.workspace.read({"path": "notes.txt"}))["content"], "Hello Ya\nFind this line\n")
        results = json.loads(self.workspace.search({"query": "find"}))["results"]
        self.assertEqual(results[0]["match"], "text")
        self.assertEqual(results[0]["line"], 2)
        self.assertEqual(json.loads(self.workspace.search({"query": "notes"}))["results"][0]["match"], "filename")

    def test_activity_observer_exposes_metadata_without_file_contents(self):
        (self.root / "notes.txt").write_text("very private local text", encoding="utf-8")
        observed = []
        workspace = LocalWorkspace(self.root, self._approve, observed.append)
        workspace.list({})
        workspace.read({"path": "notes.txt"})
        workspace.search({"query": "private"})
        self.assertEqual(
            [(event.operation, event.paths, event.status) for event in observed],
            [("list", (".",), "success"), ("read", ("notes.txt",), "success"), ("search", (".",), "success")],
        )
        self.assertNotIn("very private local text", repr(observed))

    def test_blocks_escape_symlink_binary_large_and_sensitive_reads(self):
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("outside", encoding="utf-8")
        (self.root / "link").symlink_to(outside)
        (self.root / "binary.bin").write_bytes(b"a\0b")
        (self.root / "large.txt").write_bytes(b"x" * (MAX_TEXT_BYTES + 1))
        (self.root / ".env").write_text("SECRET=value", encoding="utf-8")
        for path in ("../outside.txt", "link", "binary.bin", "large.txt", ".env"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.workspace.read({"path": path})
        self.assertEqual(json.loads(self.workspace.search({"query": "SECRET"}))["results"], [])

    def test_mkdir_requires_existing_parent_and_write_never_creates_parent(self):
        with self.assertRaises(ValueError):
            self.workspace.mkdir({"path": "missing/child"})
        with self.assertRaises(ValueError):
            self.workspace.write({"path": "missing/file.txt", "content": "x"})
        self.assertFalse((self.root / "missing").exists())
        result = json.loads(self.workspace.mkdir({"path": "created"}))
        self.assertEqual(result["status"], "ok")
        self.assertTrue((self.root / "created").is_dir())

    def test_write_overwrite_diff_is_limited_and_denial_does_not_write(self):
        path = self.root / "answer.txt"
        path.write_text("old\n", encoding="utf-8")
        result = json.loads(self.workspace.write({"path": "answer.txt", "content": "new\n"}))
        self.assertEqual(result["status"], "ok")
        self.assertIn("-old", self.actions[-1].diff)
        self.assertEqual(path.read_text(encoding="utf-8"), "new\n")
        self.workspace.confirm = lambda action: False
        denied = json.loads(self.workspace.write({"path": "answer.txt", "content": "nope\n"}))
        self.assertEqual(denied["status"], "denied")
        self.assertEqual(path.read_text(encoding="utf-8"), "new\n")
        audit = (Path(self.temp.name) / "actions.jsonl").read_text(encoding="utf-8")
        self.assertIn('"status": "denied"', audit)
        self.assertNotIn("nope", audit)

    def test_sensitive_write_is_confirmed_but_not_readable_to_model(self):
        result = json.loads(self.workspace.write({"path": ".env", "content": "TOKEN=new"}))
        self.assertEqual(result["status"], "ok")
        with self.assertRaises(ValueError):
            self.workspace.read({"path": ".env"})

    def test_move_stays_in_workspace_and_does_not_overwrite(self):
        (self.root / "from.txt").write_text("x", encoding="utf-8")
        result = json.loads(self.workspace.move({"source": "from.txt", "destination": "to.txt"}))
        self.assertEqual(result["status"], "ok")
        self.assertTrue((self.root / "to.txt").exists())
        (self.root / "other.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.workspace.move({"source": "to.txt", "destination": "other.txt"})

    def test_overwrite_diff_is_truncated(self):
        path = self.root / "large-diff.txt"
        path.write_text("".join(f"old {number}\n" for number in range(300)), encoding="utf-8")
        self.workspace.write({"path": "large-diff.txt", "content": "".join(f"new {number}\n" for number in range(300))})
        self.assertIn("diff truncated", self.actions[-1].diff)
        self.assertLessEqual(len(self.actions[-1].diff.splitlines()), MAX_DIFF_LINES + 1)

    def test_audit_logs_rotate_and_evict_oldest_records(self):
        with patch("ya.local.AUDIT_LOG_MAX_BYTES", 120):
            for number in range(10):
                append_audit_record({"record": number, "value": "x" * 20})
        logs = audit_log_files()
        self.assertEqual([path.name for path in logs], ["actions.jsonl", "actions.1.jsonl", "actions.2.jsonl", "actions.3.jsonl"])
        self.assertLessEqual(audit_log_total_bytes(), 120 * (MAX_AUDIT_ARCHIVES + 1))
        records = []
        for path in logs:
            records.extend(json.loads(line)["record"] for line in path.read_text(encoding="utf-8").splitlines())
        self.assertNotIn(0, records)
        self.assertNotIn(1, records)
        self.assertEqual(sorted(records), list(range(2, 10)))

    def test_audit_rotation_keeps_complete_records_from_a_legacy_large_log(self):
        active = Path(self.temp.name) / "actions.jsonl"
        active.write_text("".join(json.dumps({"record": number, "value": "x" * 20}) + "\n" for number in range(6)), encoding="utf-8")
        with patch("ya.local.AUDIT_LOG_MAX_BYTES", 120):
            append_audit_record({"record": 6, "value": "x" * 20})
        archive = Path(self.temp.name) / "actions.1.jsonl"
        self.assertLessEqual(archive.stat().st_size, 120)
        self.assertTrue(archive.read_text(encoding="utf-8").endswith("\n"))
        for line in archive.read_text(encoding="utf-8").splitlines():
            json.loads(line)

    def test_clear_audit_logs_removes_active_and_archived_files(self):
        append_audit_record({"record": 1})
        archive = Path(self.temp.name) / "actions.1.jsonl"
        archive.write_text('{"record": 0}\n', encoding="utf-8")
        removed = clear_audit_logs()
        self.assertEqual([path.name for path in removed], ["actions.jsonl", "actions.1.jsonl"])
        self.assertEqual(audit_log_files(), [])
