"""Ya's synchronous host adapter for octop-memory 1.0.4.

Requests and responses use UTF-8 JSON over stdin/stdout. Native candidates own
text and evidence. Octop metadata holds Ya's card order, status, and version.
Each request closes its database before returning to the CLI or Electron.
"""

import json
import sys
import unicodedata
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from uuid import uuid4

STATE_KEY = "ya.cards.v1"
MIGRATION_KEY = "ya.memory-json.v1"
KINDS = {"preference": "Preference", "procedure": "Fact", "knowledge": "Fact"}
UTC = timezone.utc


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def card_view(memory, entry):
    candidate = memory.get_candidate(entry["id"])
    if candidate is None:
        raise ValueError(f"Missing Octop candidate for Ya card {entry['id']}")
    return {
        "id": candidate.id,
        "text": candidate.assertion,
        "kind": candidate.payload["ya_kind"],
        "evidence": candidate.payload["ya_evidence"],
        "createdAt": candidate.payload["ya_created_at"],
        "status": entry["status"],
        "version": entry["version"],
    }


def add_card(memory, card):
    from octop_memory.types import Candidate

    when = datetime.fromisoformat(card["createdAt"].replace("Z", "+00:00"))
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    raw = memory.add_raw(card["text"], event_type="manual", host="ya", timestamp=when,
                         payload={"evidence": card["evidence"]})
    memory.add_candidate(Candidate(
        id=card["id"], raw_event_ids=[raw.id], candidate_type=KINDS[card["kind"]],
        status="needs_review", title=card["text"][:80], assertion=card["text"],
        verbatim_quote=card["text"], quote_event_id=raw.id,
        subject_name=card["kind"], subject_entity_type="Fact", target_entity_id=None,
        confidence="high", importance="medium", recommended_action="needs_review",
        promotion_reason="Explicit Ya feedback", extractor_version="ya/v1", created_at=when,
        payload={"ya_kind": card["kind"], "ya_evidence": card["evidence"], "ya_created_at": card["createdAt"]},
    ))
    entry = {"id": card["id"], "status": "candidate", "version": card["version"]}
    apply_status(memory, entry, card["status"])
    return entry


def apply_status(memory, entry, status):
    from octop_memory.types import AtomCard, Entity, JournalEntry

    candidate = memory.get_candidate(entry["id"])
    now = datetime.now(UTC)
    if status == "approved" and entry["status"] != "approved":
        # Ya approval is explicit. Preserve separately approved cards even when
        # their wording overlaps, and keep every atom tied to its own evidence.
        entity = memory.find_entity_by_name(candidate.subject_name, entity_type="Fact")
        if entity is None:
            entity = Entity(str(uuid4()), "Fact", candidate.subject_name, [], 0, now)
            memory.add_entity(entity)
        atom = AtomCard(
            id=str(uuid4()), entity_id=entity.id, candidate_id=candidate.id,
            raw_event_ids=candidate.raw_event_ids, assertion=candidate.assertion,
            verbatim_quote=candidate.verbatim_quote, quote_event_id=candidate.quote_event_id,
            search_terms=[candidate.subject_name], occurred_at=candidate.created_at,
            confidence=candidate.confidence, importance=candidate.importance, created_at=candidate.created_at,
        )
        branch = memory.get_or_create_entity_branch(entity.id)
        memory.add_atom(atom, parent_id=branch.id)
        memory.bump_entity_atom_count(entity.id, delta=1, last_promoted_at=now)
        memory.mark_entity_page_dirty(entity.id, when=now)
        memory.update_candidate_status(candidate.id, status="promoted", decided_by="user", decided_at=now,
                                       target_entity_id=entity.id)
        memory.append_journal(JournalEntry(
            id=str(uuid4()), timestamp=now, action="promote", actor="user",
            target_entity_id=entity.id, target_atom_id=atom.id, target_candidate_id=candidate.id,
            note="Approved in Ya",
        ))
    elif status in ("rejected", "revoked"):
        for atom in memory.list_atoms(limit=1_000_000):
            if atom.candidate_id == candidate.id:
                memory.deprecate_atom(atom.id, note=f"{status} in Ya")
        memory.update_candidate_status(candidate.id, status="rejected", decided_by="user", decided_at=now)
    entry["status"] = status


def delete_card(memory, entry):
    """Delete only this card's native records, inside the caller's transaction.

    Octop 1.0.4 exposes soft deletion through Memory. Physical per-card pruning
    requires its SQLite connection, as in Octop's own lifecycle GC.
    """
    candidate = memory.get_candidate(entry["id"])
    conn = memory.backend._conn
    for atom in memory.list_atoms(include_deprecated=True, limit=1_000_000):
        if atom.candidate_id != candidate.id:
            continue
        memory.deprecate_atom(atom.id, note="Pruned in Ya")
        for node in memory.get_tree():
            if node.atom_id == atom.id:
                memory.backend.delete_node(node.id)
        conn.execute("DELETE FROM ya_atoms WHERE id = ?", (atom.id,))
    conn.execute("DELETE FROM ya_journal WHERE target_candidate_id = ?", (candidate.id,))
    conn.execute("DELETE FROM ya_candidates WHERE id = ?", (candidate.id,))
    for raw_id in candidate.raw_event_ids:
        conn.execute("DELETE FROM ya_raw_events WHERE id = ?", (raw_id,))


def migrate(memory, home, entries):
    if memory.get_meta(MIGRATION_KEY) is not None:
        return
    legacy = home / "memory.json"
    if legacy.exists():
        cards = json.loads(legacy.read_text(encoding="utf-8-sig"))
        if not isinstance(cards, list):
            raise ValueError("Memory file must contain a JSON array.")
        ids = {entry["id"] for entry in entries}
        for stored in cards:
            card = dict(stored)
            if card.get("created_at") is not None:
                card["createdAt"] = card["created_at"]
            if type(card.get("version")) not in (int, float):
                card["version"] = 1
            for field in ("id", "kind", "text", "evidence", "status", "createdAt"):
                if not isinstance(card.get(field), str):
                    raise ValueError(f"Invalid memory card {field}.")
            if card["kind"] not in KINDS or card["status"] not in ("candidate", "approved", "rejected", "revoked"):
                raise ValueError("Invalid memory card kind or status.")
            if card["id"] in ids:
                raise ValueError(f"Duplicate legacy memory card id {card['id']}")
            entries.append(add_card(memory, card))
            ids.add(card["id"])
    memory.set_meta(MIGRATION_KEY, "complete")


def dispatch(memory, entries, request):
    operation = request["operation"]
    if operation == "list":
        return [card_view(memory, entry) for entry in entries
                if not request.get("status") or entry["status"] == request["status"]]
    if operation == "create":
        for entry in entries:
            card = card_view(memory, entry)
            if (card["status"] in ("candidate", "approved") and card["kind"] == request["kind"]
                    and normalize(card["text"]) == normalize(request["text"])):
                return {"error": {"code": "duplicate", "message": "Matching memory already exists", "card": card}}
        if len(entries) >= request["maxCards"]:
            return {"error": {"code": "limit", "message": f"Memory card limit ({request['maxCards']}) reached. Run: ya memory prune"}}
        card = {
            "id": uuid4().hex[:8], "kind": request["kind"], "text": request["text"],
            "evidence": request["evidence"], "status": "candidate", "version": 1,
            "createdAt": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        entries.append(add_card(memory, card))
        return card
    if operation == "status":
        entry = next((entry for entry in entries if entry["id"] == request["cardId"]), None)
        if entry is None:
            raise ValueError("memory card not found")
        apply_status(memory, entry, request["status"])
        entry["version"] += 1
        return card_view(memory, entry)
    if operation == "prune":
        confirmed = set(request["confirmedIds"])
        removed = [entry for entry in entries if entry["id"] in confirmed
                   and (entry["status"] in ("rejected", "revoked")
                        or (request["includeCandidates"] and entry["status"] == "candidate"))]
        cards = [card_view(memory, entry) for entry in removed]
        for entry in removed:
            delete_card(memory, entry)
            entries.remove(entry)
        return cards
    raise ValueError(f"Unknown memory operation {operation}")


def run(request):
    if sys.version_info < (3, 12):
        raise RuntimeError("Octop Memory requires Python 3.12+. Set YA_MEMORY_PYTHON to a supported interpreter.")
    try:
        if version("octop-memory") != "1.0.4":
            raise ImportError("Unsupported Octop Memory version")
        from octop_memory import Memory, MemoryService
    except ImportError as error:
        raise RuntimeError("Install octop-memory==1.0.4 with python -m pip install octop-memory==1.0.4. "
                           "Set YA_MEMORY_PYTHON to that Python interpreter if needed.") from error

    home = Path(request["home"])
    home.mkdir(parents=True, exist_ok=True)
    # Octop's schema migrations run before its transaction API is available.
    # OS locks serialize openers and are released even if a process exits early.
    with (home / "memory.init.lock").open("a+b") as lock:
        lock.seek(0)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        memory = Memory(namespace="ya", backend_config={"db_path": str(home / "memory.sqlite")})
    try:
        with memory.backend.transaction():
            # Acquire SQLite's writer lock before reading host state. Concurrent
            # CLI/GUI requests then serialize deduplication, limits and migration.
            memory.set_meta("ya.write-lock", "1")
            entries = json.loads(memory.get_meta(STATE_KEY) or "[]")
            migrate(memory, home, entries)
            memory.set_meta(STATE_KEY, json.dumps(entries))
        if request["operation"] == "recall":
            # Recall runs outside the writer transaction because Octop gathers
            # sources on worker threads. Only approved, live atoms enter context.
            result = MemoryService(memory, host="ya").recall(request["query"], limit=request["limit"])
            matches = []
            with memory.backend.transaction():
                entries = json.loads(memory.get_meta(STATE_KEY) or "[]")
                approved = {entry["id"]: entry for entry in entries if entry["status"] == "approved"}
                for snippet in result.snippets:
                    atom = memory.get_atom(snippet.source_id)
                    if atom is not None and atom.deprecated_at is None and atom.candidate_id in approved:
                        card = card_view(memory, approved[atom.candidate_id])
                        # Respect Octop's prompt budget when the snippet is truncated.
                        card["text"] = snippet.text
                        matches.append({"card": card, "score": None})
            return {"result": matches}
        with memory.backend.transaction():
            memory.set_meta("ya.write-lock", "1")
            entries = json.loads(memory.get_meta(STATE_KEY) or "[]")
            result = dispatch(memory, entries, request)
            memory.set_meta(STATE_KEY, json.dumps(entries))
        if isinstance(result, dict) and "error" in result:
            return result
        return {"result": result}
    finally:
        memory.backend.close()


if __name__ == "__main__":
    try:
        response = run(json.load(sys.stdin))
    except Exception as error:
        response = {"error": {"message": f"Octop Memory: {error}"}}
    print(json.dumps(response, ensure_ascii=False))
