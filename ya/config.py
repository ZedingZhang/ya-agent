from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import json
import os


VALID_MODELS = {"flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro"}
VALID_EFFORTS = {"high", "max"}


@dataclass
class ModelConfig:
    model: str = "deepseek-v4-flash"
    thinking_enabled: bool = True
    reasoning_effort: str = "high"
    toa_token_budget: int = 8000
    toa_timeout: int = 90

    def validate(self) -> None:
        if self.model not in set(VALID_MODELS.values()):
            raise ValueError("Only deepseek-v4-flash and deepseek-v4-pro are supported.")
        if self.reasoning_effort not in VALID_EFFORTS:
            raise ValueError("reasoning effort must be 'high' or 'max'.")
        if not 1000 <= self.toa_token_budget <= 16000:
            raise ValueError("ToA token budget must be between 1000 and 16000.")
        if not 30 <= self.toa_timeout <= 180:
            raise ValueError("ToA timeout must be between 30 and 180 seconds.")

    @classmethod
    def from_dict(cls, value: dict) -> "ModelConfig":
        allowed = {field: value[field] for field in cls.__dataclass_fields__ if field in value}
        config = cls(**allowed)
        config.validate()
        return config

    def to_dict(self) -> dict:
        return asdict(self)


def data_home() -> Path:
    override = os.environ.get("YA_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".ya"


def config_path() -> Path:
    return data_home() / "config.json"


def load_config() -> ModelConfig:
    path = config_path()
    if not path.exists():
        return ModelConfig()
    with path.open(encoding="utf-8") as handle:
        return ModelConfig.from_dict(json.load(handle))


def save_config(config: ModelConfig) -> None:
    config.validate()
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(config.to_dict(), handle, ensure_ascii=True, indent=2)


def model_id(value: str) -> str:
    if value not in VALID_MODELS:
        raise ValueError("model must be 'flash' or 'pro'.")
    return VALID_MODELS[value]
