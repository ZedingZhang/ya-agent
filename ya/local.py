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
AUDIT_LOG_MAX_BYTES = 1024 * 1024
MAX_AUDIT_ARCHIVES = 3


def _audit_log_path(index: int = 0) -> Path:
    suffix = "" if index == 0 else f".{index}"
    return data_home() / f"actions{suffix}.jsonl"


def audit_log_files() -> list[Path]:
    """Return existing audit logs from newest to oldest."""
    return [path for index in range(MAX_AUDIT_ARCHIVES + 1) if (path := _audit_log_path(index)).is_file()]


def audit_log_total_bytes() -> int:
    return sum(path.stat().st_size for path in audit_log_files())


def clear_audit_logs() -> list[Path]:
    """Permanently remove the active audit log and its rotated archives."""
    removed = audit_log_files()
    for path in removed:
        path.unlink()
    return removed


def _tail_complete_lines(data: bytes, limit: int) -> bytes:
    """Keep recent complete JSONL records when rotating a pre-existing large log."""
    if len(data) <= limit:
        return data
    tail = data[-limit:]
    newline = tail.find(b"\n")
    return tail[newline + 1 :] if newline >= 0 else b""


def _rotate_audit_logs() -> None:
    for index in range(MAX_AUDIT_ARCHIVES, 0, -1):
        source = _audit_log_path(index - 1)
        destination = _audit_log_path(index)
        if not source.is_file():
            continue
        if index == MAX_AUDIT_ARCHIVES:
            destination.unlink(missing_ok=True)
        if index == 1 and source.stat().st_size > AUDIT_LOG_MAX_BYTES:
            data = _tail_complete_lines(source.read_bytes(), AUDIT_LOG_MAX_BYTES)
            temporary = destination.with_suffix(destination.suffix + ".tmp")
            temporary.write_bytes(data)
            temporary.replace(destination)
            source.unlink()
        else:
            source.replace(destination)


def append_audit_record(record: dict[str, object]) -> None:
    """Append an audit record while keeping the local audit history bounded."""
    encoded = (json.dumps(record, ensure_ascii=True) + "\n").encode("utf-8")
    active = _audit_log_path()
    active.parent.mkdir(parents=True, exist_ok=True)
    if active.is_file() and active.stat().st_size + len(encoded) > AUDIT_LOG_MAX_BYTES:
        _rotate_audit_logs()
    with active.open("ab") as handle:
        handle.write(encoded)


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


@dataclass(frozen=True)
class LocalActivity:
    """Metadata about one local tool operation, safe to show in a GUI."""

    operation: str
    paths: tuple[str, ...]
    status: str


class LocalWorkspace:
    """A deliberately small, workspace-confined filesystem tool set."""

    def __init__(
        self,
        root: Path,
        confirm: Callable[[LocalAction], bool],
        on_activity: Callable[[LocalActivity], None] | None = None,
    ):
        resolved = root.expanduser().resolve(strict=True)
        if not resolved.is_dir():
            raise ValueError(f"Workspace is not a directory: {resolved}")
        self.root = resolved
        self.confirm = confirm
        self.on_activity = on_activity

    def _activity(self, operation: str, paths: tuple[Path, ...], status: str) -> None:
        if self.on_activity is None:
            return
        try:
            self.on_activity(LocalActivity(operation, tuple(self._relative(path) for path in paths), status))
        except Exception:
            # Observers are presentation-only and must never affect the agent.
            pass

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
        append_audit_record(record)

    def _confirm(self, action: LocalAction) -> bool:
        if self.confirm(action):
            return True
        self._audit(action.operation, action.paths, "denied")
        self._activity(action.operation, action.paths, "denied")
        return False

    def list(self, args: dict) -> str:
        path = self._resolve(args.get("path", "."))
        if not path.is_dir():
            raise ValueError(f"Not a directory: {path}")
        entries = []
        for child in sorted(path.iterdir(), key=lambda item: item.name.casefold())[:MAX_LIST_ENTRIES]:
            kind = "symlink" if child.is_symlink() else "directory" if child.is_dir() else "file"
            entries.append({"path": self._relative(child), "type": kind})
        self._activity("list", (path,), "success")
        return json.dumps({"path": self._relative(path), "entries": entries, "limited": len(entries) == MAX_LIST_ENTRIES})

    def read(self, args: dict) -> str:
        path = self._resolve(args.get("path"))
        content = self._read_text(path)
        self._activity("read", (path,), "success")
        return json.dumps({"path": self._relative(path), "content": content}, ensure_ascii=False)

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
        self._activity("search", (root,), "success")
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
            self._activity("mkdir", (path,), "success")
            return json.dumps({"status": "ok", "operation": "mkdir", "path": self._relative(path)})
        except Exception as error:
            self._audit("mkdir", (path,), "error", str(error))
            self._activity("mkdir", (path,), "error")
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
            self._activity("write", (path,), "success")
            return json.dumps({"status": "ok", "operation": "write", "path": self._relative(path)})
        except Exception as error:
            self._audit("write", (path,), "error", str(error))
            self._activity("write", (path,), "error")
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
            self._activity("move", (source, destination), "success")
            return json.dumps({"status": "ok", "operation": "move", "source": self._relative(source), "destination": self._relative(destination)})
        except Exception as error:
            self._audit("move", (source, destination), "error", str(error))
            self._activity("move", (source, destination), "error")
            raise
