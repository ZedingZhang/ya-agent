"""Shared task execution used by the command line and native GUI clients."""

from __future__ import annotations

from typing import Callable

from .config import ModelConfig
from .deepseek import DeepSeekClient
from .orchestrator import RunResult, single_agent, toa_agent


def run_task(
    api_key: str,
    task: str,
    config: ModelConfig,
    *,
    web_mode: str = "auto",
    toa: bool = False,
    toa_workers: int = 2,
    on_content: Callable[[str], None] | None = None,
) -> RunResult:
    """Run one Ya task without choosing a presentation or credential mechanism."""
    client = DeepSeekClient(api_key)
    if toa:
        return toa_agent(client, task, config, toa_workers)
    return single_agent(client, task, config, web_mode=web_mode, on_content=on_content)
