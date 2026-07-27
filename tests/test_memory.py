import os
import tempfile
import unittest

from ya import memory
from ya.memory import (
    MAX_MEMORY_CARDS,
    DuplicateMemoryError,
    MemoryCard,
    MemoryLimitError,
    create_candidate,
    list_cards,
    prune_cards,
    set_status,
)


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("YA_HOME")
        os.environ["YA_HOME"] = self.temp.name

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("YA_HOME", None)
        else:
            os.environ["YA_HOME"] = self.previous_home
        self.temp.cleanup()

    def test_normalized_active_cards_are_deduplicated(self):
        first = create_candidate("Cafe\u0301   workflow", "evidence")
        with self.assertRaises(DuplicateMemoryError) as error:
            create_candidate("  CAFÉ workflow  ", "new evidence")
        self.assertEqual(error.exception.card.id, first.id)

    def test_deduplication_is_scoped_to_kind_and_active_cards(self):
        candidate = create_candidate("Use concise answers", "evidence", kind="preference")
        create_candidate("Use concise answers", "evidence", kind="procedure")
        set_status(candidate.id, "rejected")
        recreated = create_candidate("use concise answers", "new evidence", kind="preference")
        self.assertNotEqual(candidate.id, recreated.id)

    def test_card_limit_rejects_new_unique_candidates(self):
        for index in range(MAX_MEMORY_CARDS):
            create_candidate(f"card {index}", "evidence")
        with self.assertRaises(DuplicateMemoryError):
            create_candidate("  CARD 0  ", "new evidence")
        with self.assertRaises(MemoryLimitError):
            create_candidate("one more card", "evidence")
        self.assertEqual(len(list_cards()), MAX_MEMORY_CARDS)

    def test_legacy_oversized_memory_can_be_pruned(self):
        memory._save(
            [
                MemoryCard(
                    id=f"{index:08d}",
                    kind="procedure",
                    text=f"old card {index}",
                    evidence="evidence",
                    status="rejected",
                    created_at="2026-01-01T00:00:00+00:00",
                )
                for index in range(MAX_MEMORY_CARDS + 1)
            ]
        )
        with self.assertRaises(MemoryLimitError):
            create_candidate("new card", "evidence")
        self.assertEqual(len(prune_cards()), MAX_MEMORY_CARDS + 1)
        self.assertEqual(list_cards(), [])

    def test_prune_preserves_candidates_and_approved_cards_by_default(self):
        candidate = create_candidate("candidate", "evidence")
        rejected = create_candidate("rejected", "evidence")
        revoked = create_candidate("revoked", "evidence")
        approved = create_candidate("approved", "evidence")
        set_status(rejected.id, "rejected")
        set_status(revoked.id, "revoked")
        set_status(approved.id, "approved")

        removed = prune_cards()

        self.assertEqual({card.id for card in removed}, {rejected.id, revoked.id})
        self.assertEqual({card.id for card in list_cards()}, {candidate.id, approved.id})

    def test_prune_can_include_candidates_without_deleting_approved_cards(self):
        candidate = create_candidate("candidate", "evidence")
        rejected = create_candidate("rejected", "evidence")
        approved = create_candidate("approved", "evidence")
        set_status(rejected.id, "rejected")
        set_status(approved.id, "approved")

        removed = prune_cards(include_candidates=True)

        self.assertEqual({card.id for card in removed}, {candidate.id, rejected.id})
        self.assertEqual([card.id for card in list_cards()], [approved.id])

    def test_prune_without_matches_leaves_cards_unchanged(self):
        approved = create_candidate("approved", "evidence")
        set_status(approved.id, "approved")

        self.assertEqual(prune_cards(), [])
        self.assertEqual([card.id for card in list_cards()], [approved.id])
