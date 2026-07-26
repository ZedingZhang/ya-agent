from __future__ import annotations

import os
import subprocess


SERVICE = "Ya DeepSeek API"
ACCOUNT = "default"


def save_api_key(api_key: str) -> None:
    if not api_key.strip():
        raise ValueError("API key cannot be empty.")
    subprocess.run(
        ["security", "add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", api_key],
        check=True,
        capture_output=True,
        text=True,
    )


def load_api_key() -> str | None:
    environment_key = os.environ.get("DEEPSEEK_API_KEY")
    if environment_key:
        return environment_key
    result = subprocess.run(
        ["security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None
