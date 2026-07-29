from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import difflib
import json
from pathlib import Path
from typing import Callable

from .config import data_home


MAX_TEXT_BYTES = 1024 * 1024
MAX_LIST_ENTRIES = 200
MAX_SEARCH_RESULTS = 100
MAX_DIFF_LINES = 200


LOCAL_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "local_list",
            "description": "List up to 200 entries in a directory inside the authorized workspace.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "local_read",
            "description": "Read a UTF-8 text file up to 1 MiB inside the authorized workspace. Sensitive files are blocked.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "local_search",
            "description": "Search file names and non-sensitive UTF-8 text files inside the authorized workspace.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}, "path": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "local_mkdir",
            "description": "Create one directory inside the workspace. Its parent must already exist. The CLI will ask the user before writing.",
            "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "local_write",
            "description": "Create or replace a UTF-8 text file inside the workspace. Its parent must already exist. The CLI will show a diff and ask the user before writing.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "local_move",
            "description": "Move or rename a file or directory inside the workspace without replacing an existing destination. The CLI will ask the user before writing.",
            "parameters": {
                "type": "object",
                "properties": {"source": {"type": "string"}, "destination": {"type": "string"}},
                "required": ["source", "destination"],
            },
        },
    },
]


@dataclass(frozen=True)
class LocalAction:
    operation: str
    paths: tuple[Path, ...]
    summary: str
    diff: str | None = None


class LocalWorkspace:
    """A deliberately small, workspace-confined filesystem tool set."""

    def __init__(self, root: Path, confirm: Callable[[LocalAction], bool]):
        resolved = root.expanduser().resolve(strict=True)
        if not resolved.is_dir():
            raise ValueError(f"Workspace is not a directory: {resolved}")
        self.root = resolved
        self.confirm = confirm

    @property
    def tool_handlers(self) -> dict[str, Callable[[dict], str]]:
        return {
            "local_list": self.list,
            "local_read": self.read,
            "local_search": self.search,
            "local_mkdir": self.mkdir,
            "local_write": self.write,
            "local_move": self.move,
        }

    def _resolve(self, value: object) -> Path:
        if not isinstance(value, str) or not value.strip():
            raise ValueError("A non-empty path is required.")
        path = Path(value).expanduser()
        target = (path if path.is_absolute() else self.root / path).resolve(strict=False)
        if target != self.root and self.root not in target.parents:
            raise ValueError("Path must remain inside the authorized workspace.")
        return target

    def _relative(self, path: Path) -> str:
        return str(path.relative_to(self.root)) or "."

    def _is_sensitive(self, path: Path) -> bool:
        lowered = path.name.casefold()
        suffix = path.suffix.casefold()
        if any(part == ".git" for part in path.parts):
            return True
        if lowered == ".env" or lowered.startswith(".env."):
            return True
        if lowered in {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"}:
            return True
        return suffix in {".pem", ".key", ".p12", ".pfx", ".kdbx", ".der", ".token"} or "secret" in lowered

    def _read_text(self, path: Path, allow_sensitive: bool = False) -> str:
        if self._is_sensitive(path) and not allow_sensitive:
            raise ValueError("Reading sensitive files is blocked in local mode.")
        if not path.is_file():
            raise ValueError(f"Not a file: {path}")
        if path.stat().st_size > MAX_TEXT_BYTES:
            raise ValueError("Text files larger than 1 MiB cannot be read or replaced.")
        data = path.read_bytes()
        if b"\0" in data:
            raise ValueError("Binary files cannot be read in local mode.")
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ValueError("Only UTF-8 text files can be read in local mode.") from error

    def _audit(self, operation: str, paths: tuple[Path, ...], status: str, error: str | None = None) -> None:
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "workspace": str(self.root),
            "operation": operation,
            "paths": [self._relative(path) for path in paths],
            "status": status,
        }
        if error:
            record["error"] = error
        path = data_home() / "actions.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=True) + "\n")

    def _confirm(self, action: LocalAction) -> bool:
        if self.confirm(action):
            return True
        self._audit(action.operation, action.paths, "denied")
        return False

    def list(self, args: dict) -> str:
        path = self._resolve(args.get("path", "."))
        if not path.is_dir():
            raise ValueError(f"Not a directory: {path}")
        entries = []
        for child in sorted(path.iterdir(), key=lambda item: item.name.casefold())[:MAX_LIST_ENTRIES]:
            kind = "symlink" if child.is_symlink() else "directory" if child.is_dir() else "file"
            entries.append({"path": self._relative(child), "type": kind})
        return json.dumps({"path": self._relative(path), "entries": entries, "limited": len(entries) == MAX_LIST_ENTRIES})

    def read(self, args: dict) -> str:
        path = self._resolve(args.get("path"))
        return json.dumps({"path": self._relative(path), "content": self._read_text(path)}, ensure_ascii=False)

    def search(self, args: dict) -> str:
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("A non-empty search query is required.")
        root = self._resolve(args.get("path", "."))
        if not root.is_dir():
            raise ValueError(f"Not a directory: {root}")
        needle = query.casefold()
        results: list[dict] = []
        for path in sorted(root.rglob("*"), key=lambda item: str(item).casefold()):
            if len(results) >= MAX_SEARCH_RESULTS:
                break
            if path.is_symlink() or not path.is_file() or self._is_sensitive(path):
                continue
            relative = self._relative(path)
            if needle in path.name.casefold():
                results.append({"path": relative, "match": "filename"})
                if len(results) >= MAX_SEARCH_RESULTS:
                    break
            try:
                text = self._read_text(path)
            except ValueError:
                continue
            for line_number, line in enumerate(text.splitlines(), start=1):
                if needle in line.casefold():
                    results.append({"path": relative, "match": "text", "line": line_number, "text": line[:400]})
                    if len(results) >= MAX_SEARCH_RESULTS:
                        break
        return json.dumps({"query": query, "results": results, "limited": len(results) == MAX_SEARCH_RESULTS}, ensure_ascii=False)

    def mkdir(self, args: dict) -> str:
        path = self._resolve(args.get("path"))
        action = LocalAction("mkdir", (path,), f"Create directory: {path}")
        try:
            if path.exists():
                raise ValueError(f"Path already exists: {path}")
            if not path.parent.is_dir():
                raise ValueError("Parent directory does not exist; create it first.")
            if not self._confirm(action):
                return json.dumps({"status": "denied", "operation": "mkdir", "path": self._relative(path), "reason": "User declined this action."})
            path.mkdir()
            self._audit("mkdir", (path,), "success")
            return json.dumps({"status": "ok", "operation": "mkdir", "path": self._relative(path)})
        except Exception as error:
            self._audit("mkdir", (path,), "error", str(error))
            raise

    def write(self, args: dict) -> str:
        path = self._resolve(args.get("path"))
        content = args.get("content")
        if not isinstance(content, str):
            raise ValueError("Text content is required.")
        try:
            if len(content.encode("utf-8")) > MAX_TEXT_BYTES:
                raise ValueError("Text content larger than 1 MiB cannot be written.")
            if path.exists() and path.is_dir():
                raise ValueError(f"Path is a directory: {path}")
            if not path.parent.is_dir():
                raise ValueError("Parent directory does not exist; create it first.")
            # Existing sensitive files are never sent through local_read/search. The
            # local CLI may still show their replacement diff to its owner.
            previous = self._read_text(path, allow_sensitive=True) if path.exists() else None
            diff = None
            summary = f"Create text file: {path}"
            if previous is not None:
                lines = list(difflib.unified_diff(previous.splitlines(keepends=True), content.splitlines(keepends=True), fromfile=str(path), tofile=str(path)))
                if len(lines) > MAX_DIFF_LINES:
                    lines = lines[:MAX_DIFF_LINES] + ["... diff truncated ...\n"]
                diff = "".join(lines)
                summary = f"Replace text file: {path}"
            action = LocalAction("write", (path,), summary, diff)
            if not self._confirm(action):
                return json.dumps({"status": "denied", "operation": "write", "path": self._relative(path), "reason": "User declined this action."})
            path.write_text(content, encoding="utf-8")
            self._audit("write", (path,), "success")
            return json.dumps({"status": "ok", "operation": "write", "path": self._relative(path)})
        except Exception as error:
            self._audit("write", (path,), "error", str(error))
            raise

    def move(self, args: dict) -> str:
        source = self._resolve(args.get("source"))
        destination = self._resolve(args.get("destination"))
        action = LocalAction("move", (source, destination), f"Move: {source} -> {destination}")
        try:
            if source == self.root or not source.exists():
                raise ValueError(f"Source does not exist: {source}")
            if destination.exists():
                raise ValueError(f"Destination already exists: {destination}")
            if not destination.parent.is_dir():
                raise ValueError("Destination parent directory does not exist.")
            if source.is_dir() and source in destination.parents:
                raise ValueError("Cannot move a directory into itself.")
            if not self._confirm(action):
                return json.dumps({"status": "denied", "operation": "move", "path": self._relative(source), "reason": "User declined this action."})
            source.rename(destination)
            self._audit("move", (source, destination), "success")
            return json.dumps({"status": "ok", "operation": "move", "source": self._relative(source), "destination": self._relative(destination)})
        except Exception as error:
            self._audit("move", (source, destination), "error", str(error))
            raise
