from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
import re
import unicodedata
from uuid import uuid4
import json

from .config import data_home


MAX_MEMORY_CARDS = 100
MAX_RELEVANT_MEMORY_CARDS = 3
MIN_RELEVANCE_SCORE = 3
ACTIVE_MEMORY_STATUSES = {"candidate", "approved"}
DEFAULT_PRUNE_STATUSES = {"rejected", "revoked"}
ENGLISH_WORD = re.compile(r"[a-z0-9][a-z0-9_-]*")
HAN_TEXT = re.compile(r"[\u4e00-\u9fff]+")
ENGLISH_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "is",
    "it", "of", "on", "or", "the", "this", "that", "to", "what", "when", "where", "with",
}
CHINESE_STOP_PHRASES = {
    "什么", "如何", "为什", "什么是", "怎么", "可以", "请问", "一个", "这个", "那个",
    "我们", "你们", "他们", "关于", "以及", "进行", "一下", "是否", "需要",
}


class DuplicateMemoryError(ValueError):
    def __init__(self, card: "MemoryCard") -> None:
        self.card = card
        super().__init__(f"Matching memory card already exists: {card.id}")


class MemoryLimitError(ValueError):
    pass


@dataclass
class MemoryCard:
    id: str
    kind: str
    text: str
    evidence: str
    status: str
    created_at: str
    version: int = 1


@dataclass(frozen=True)
class MemoryMatch:
    card: MemoryCard
    score: int


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


def normalize_memory_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", text).casefold()
    return re.sub(r"\s+", " ", normalized).strip()


def create_candidate(text: str, evidence: str, kind: str = "procedure") -> MemoryCard:
    if kind not in {"preference", "procedure", "knowledge"}:
        raise ValueError("memory kind must be preference, procedure, or knowledge.")
    cards = _load()
    normalized_text = normalize_memory_text(text)
    for existing in cards:
        if (
            existing.kind == kind
            and existing.status in ACTIVE_MEMORY_STATUSES
            and normalize_memory_text(existing.text) == normalized_text
        ):
            raise DuplicateMemoryError(existing)
    if len(cards) >= MAX_MEMORY_CARDS:
        raise MemoryLimitError(
            f"Memory card limit ({MAX_MEMORY_CARDS}) reached. Run: ya memory prune"
        )
    card = MemoryCard(
        id=uuid4().hex[:8],
        kind=kind,
        text=text.strip(),
        evidence=evidence.strip(),
        status="candidate",
        created_at=datetime.now(timezone.utc).isoformat(),
    )
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


def cards_to_prune(include_candidates: bool = False) -> list[MemoryCard]:
    statuses = set(DEFAULT_PRUNE_STATUSES)
    if include_candidates:
        statuses.add("candidate")
    return [card for card in _load() if card.status in statuses]


def prune_cards(include_candidates: bool = False) -> list[MemoryCard]:
    statuses = set(DEFAULT_PRUNE_STATUSES)
    if include_candidates:
        statuses.add("candidate")
    cards = _load()
    removed = [card for card in cards if card.status in statuses]
    if removed:
        _save([card for card in cards if card.status not in statuses])
    return removed


def _english_words(text: str) -> set[str]:
    return {
        word
        for word in ENGLISH_WORD.findall(text)
        if len(word) >= 2 and word not in ENGLISH_STOP_WORDS
    }


def _english_phrases(text: str) -> set[str]:
    words = [word for word in ENGLISH_WORD.findall(text) if word not in ENGLISH_STOP_WORDS]
    return {" ".join(words[index : index + 2]) for index in range(len(words) - 1)}


def _han_ngrams(text: str, width: int) -> set[str]:
    grams: set[str] = set()
    for run in HAN_TEXT.findall(text):
        grams.update(run[index : index + width] for index in range(len(run) - width + 1))
    return {gram for gram in grams if gram not in CHINESE_STOP_PHRASES}


def _memory_score(task: str, card: MemoryCard) -> int:
    task_text = normalize_memory_text(task)
    card_text = normalize_memory_text(card.text)
    if not task_text or not card_text:
        return 0

    shared_words = _english_words(task_text) & _english_words(card_text)
    shared_bigrams = _han_ngrams(task_text, 2) & _han_ngrams(card_text, 2)
    shared_phrases = (
        (_english_phrases(task_text) & _english_phrases(card_text))
        or (_han_ngrams(task_text, 3) & _han_ngrams(card_text, 3))
    )
    exact_containment = (
        min(len(task_text), len(card_text)) >= 4
        and (task_text in card_text or card_text in task_text)
    )
    phrase_score = 5 if shared_phrases or exact_containment else 0
    return phrase_score + 3 * len(shared_words) + len(shared_bigrams)


def _created_timestamp(card: MemoryCard) -> float:
    try:
        return datetime.fromisoformat(card.created_at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def select_relevant_cards(task: str, limit: int = MAX_RELEVANT_MEMORY_CARDS) -> list[MemoryMatch]:
    """Return approved cards ranked by local, deterministic task relevance."""
    matches = [
        MemoryMatch(card, score)
        for card in list_cards("approved")
        if (score := _memory_score(task, card)) >= MIN_RELEVANCE_SCORE
    ]
    matches.sort(key=lambda match: (-match.score, -_created_timestamp(match.card), match.card.id))
    return matches[:limit]


def relevant_context(task: str, limit: int = MAX_RELEVANT_MEMORY_CARDS) -> str:
    matches = select_relevant_cards(task, limit)
    if not matches:
        return ""
    lines = [f"- [{match.card.kind}] {match.card.text}" for match in matches]
    return "\n".join(lines)
