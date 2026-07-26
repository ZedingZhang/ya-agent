from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import json

from .config import data_home


@dataclass
class MemoryCard:
    id: str
    kind: str
    text: str
    evidence: str
    status: str
    created_at: str
    version: int = 1


def memory_path() -> Path:
    return data_home() / "memory.json"


def _load() -> list[MemoryCard]:
    path = memory_path()
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as handle:
        return [MemoryCard(**item) for item in json.load(handle)]


def _save(cards: list[MemoryCard]) -> None:
    path = memory_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump([asdict(card) for card in cards], handle, ensure_ascii=False, indent=2)


def create_candidate(text: str, evidence: str, kind: str = "procedure") -> MemoryCard:
    if kind not in {"preference", "procedure", "knowledge"}:
        raise ValueError("memory kind must be preference, procedure, or knowledge.")
    card = MemoryCard(
        id=uuid4().hex[:8],
        kind=kind,
        text=text.strip(),
        evidence=evidence.strip(),
        status="candidate",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    cards = _load()
    cards.append(card)
    _save(cards)
    return card


def list_cards(status: str | None = None) -> list[MemoryCard]:
    cards = _load()
    return [card for card in cards if card.status == status] if status else cards


def set_status(card_id: str, status: str) -> MemoryCard:
    if status not in {"approved", "rejected", "revoked"}:
        raise ValueError("invalid memory status")
    cards = _load()
    for card in cards:
        if card.id == card_id:
            card.status = status
            card.version += 1
            _save(cards)
            return card
    raise ValueError("memory card not found")


def relevant_context(limit: int = 3) -> str:
    cards = list_cards("approved")[:limit]
    if not cards:
        return ""
    lines = [f"- [{card.kind}] {card.text}" for card in cards]
    return "\n".join(lines)
