"""State and persistence helpers for the Tk GUI, kept independent of Tk widgets."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path

from .config import ModelConfig, data_home, load_config, save_config
from .keychain import load_api_key, save_api_key
from .memory import MemoryCard, cards_to_prune, create_candidate, list_cards, prune_cards, select_relevant_cards, set_status
from .orchestrator import should_use_web
from .service import run_task


LANGUAGES = ("en", "zh-CN")


def preferences_path() -> Path:
    return data_home() / "gui.json"


def load_preferences() -> dict[str, str]:
    path = preferences_path()
    if not path.exists():
        return {"language": "en"}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"language": "en"}
    language = value.get("language") if isinstance(value, dict) else None
    return {"language": language if language in LANGUAGES else "en"}


def save_preferences(language: str) -> None:
    if language not in LANGUAGES:
        raise ValueError("GUI language must be en or zh-CN.")
    path = preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"language": language}, indent=2), encoding="utf-8")


@dataclass
class GuiTaskOptions:
    task: str
    web_mode: str = "auto"
    toa: bool = False
    toa_workers: int = 2
    stream: bool = True


class GuiController:
    """Application-facing facade around existing Ya configuration and memory APIs."""

    def __init__(self) -> None:
        self.config = load_config()
        self.language = load_preferences()["language"]
        self._session_api_key: str | None = None

    def set_language(self, language: str) -> None:
        save_preferences(language)
        self.language = language

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
        return options.stream and not options.toa and not should_use_web(options.task, options.web_mode)

    def run(self, options: GuiTaskOptions, on_content=None):
        api_key = self.api_key()
        if not api_key:
            raise ValueError("No DeepSeek API key found. Add one in Settings.")
        return run_task(
            api_key,
            options.task,
            self.config,
            web_mode=options.web_mode,
            toa=options.toa,
            toa_workers=options.toa_workers,
            on_content=on_content if self.can_stream(options) else None,
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
