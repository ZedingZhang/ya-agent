import json
import os
from pathlib import Path
import tempfile
import unittest

from ya.local import LocalWorkspace, MAX_DIFF_LINES, MAX_TEXT_BYTES


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
