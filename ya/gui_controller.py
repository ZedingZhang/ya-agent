"""State and persistence helpers for the Tk GUI, kept independent of Tk widgets."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Callable

from .config import ModelConfig, data_home, load_config, save_config
from .keychain import load_api_key, save_api_key
from .local import LocalAction, LocalWorkspace, audit_log_files, audit_log_total_bytes, clear_audit_logs
from .memory import MemoryCard, cards_to_prune, create_candidate, list_cards, prune_cards, select_relevant_cards, set_status
from .orchestrator import should_use_web
from .service import run_task


LANGUAGES = ("en", "zh-CN")


def preferences_path() -> Path:
    return data_home() / "gui.json"


def load_preferences() -> dict[str, str | None]:
    path = preferences_path()
    if not path.exists():
        return {"language": "en", "workspace": None}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"language": "en", "workspace": None}
    language = value.get("language") if isinstance(value, dict) else None
    workspace = value.get("workspace") if isinstance(value, dict) else None
    return {"language": language if language in LANGUAGES else "en", "workspace": workspace if isinstance(workspace, str) else None}


def save_preferences(language: str, workspace: str | None) -> None:
    if language not in LANGUAGES:
        raise ValueError("GUI language must be en or zh-CN.")
    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"language": language, "workspace": workspace}, indent=2), encoding="utf-8")


@dataclass
class GuiTaskOptions:
    task: str
    web_mode: str = "auto"
    toa: bool = False
    toa_workers: int = 2
    stream: bool = True
    local: bool = False
    workspace: str | None = None


class GuiController:
    """Application-facing facade around existing Ya configuration and memory APIs."""

    def __init__(self) -> None:
        self.config = load_config()
        preferences = load_preferences()
        self.language = str(preferences["language"])
        self.workspace = preferences["workspace"]
        self._session_api_key: str | None = None

    def _save_preferences(self) -> None:
        save_preferences(self.language, self.workspace)

    def set_language(self, language: str) -> None:
        if language not in LANGUAGES:
            raise ValueError("GUI language must be en or zh-CN.")
        self.language = language
        self._save_preferences()

    def set_workspace(self, value: str) -> str:
        try:
            workspace = Path(value).expanduser().resolve(strict=True)
        except OSError as error:
            raise ValueError(f"Workspace does not exist: {value}") from error
        if not workspace.is_dir():
            raise ValueError(f"Workspace is not a directory: {workspace}")
        self.workspace = str(workspace)
        self._save_preferences()
        return self.workspace

    def valid_workspace(self) -> str | None:
        if not self.workspace:
            return None
        try:
            workspace = Path(self.workspace).expanduser().resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        return str(workspace) if workspace.is_dir() else None

    def save_config(self, config: ModelConfig) -> None:
        config.validate()
        save_config(config)
        self.config = config

    def set_session_api_key(self, api_key: str) -> None:
        if not api_key.strip():
            raise ValueError("API key cannot be empty.")
        self._session_api_key = api_key.strip()

    def save_macos_api_key(self, api_key: str) -> None:
        save_api_key(api_key)
        self._session_api_key = api_key.strip()

    def api_key(self) -> str | None:
        return self._session_api_key or load_api_key()

    def can_stream(self, options: GuiTaskOptions) -> bool:
        return options.stream and not options.toa and not options.local and not should_use_web(options.task, options.web_mode)

    def run(
        self,
        options: GuiTaskOptions,
        on_content=None,
        on_local_action: Callable[[LocalAction], bool] | None = None,
    ):
        api_key = self.api_key()
        if not api_key:
            raise ValueError("No DeepSeek API key found. Add one in Settings.")
        if options.local and options.toa:
            raise ValueError("Local workspace mode cannot be used with Tree of Agents.")
        local_workspace = None
        if options.local:
            workspace = options.workspace or self.valid_workspace()
            if not workspace:
                raise ValueError("Choose an existing local workspace before running this task.")
            local_workspace = LocalWorkspace(Path(workspace), on_local_action or (lambda _action: False))
        return run_task(
            api_key,
            options.task,
            self.config,
            web_mode=options.web_mode,
            toa=options.toa,
            toa_workers=options.toa_workers,
            on_content=on_content if self.can_stream(options) else None,
            local_workspace=local_workspace,
        )

    def cards(self) -> list[MemoryCard]:
        return list_cards()

    def relevant_cards(self, task: str):
        return select_relevant_cards(task)

    def create_memory(self, text: str, evidence: str, kind: str) -> MemoryCard:
        return create_candidate(text, evidence, kind)

    def set_memory_status(self, card_id: str, status: str) -> MemoryCard:
        return set_status(card_id, status)

    def prune_preview(self, include_candidates: bool = False) -> list[MemoryCard]:
        return cards_to_prune(include_candidates)

    def prune(self, include_candidates: bool = False) -> list[MemoryCard]:
        return prune_cards(include_candidates)

    def audit_logs(self) -> list[Path]:
        return audit_log_files()

    def audit_log_total_bytes(self) -> int:
        return audit_log_total_bytes()

    def clear_audit_logs(self) -> list[Path]:
        return clear_audit_logs()
