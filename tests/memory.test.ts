import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MEMORY_CARDS,
  DuplicateMemoryError,
  MemoryLimitError,
  createCandidate,
  listCards,
  pruneCards,
  relevantContext,
  saveMemoryCards,
  selectRelevantCards,
  setStatus,
  type MemoryCard,
  type MemoryKind,
} from "../src/memory";
import { tempHome, type TempHome } from "./helpers";

describe("long-term memory", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  function approve(text: string, kind: MemoryKind = "procedure"): MemoryCard {
    return setStatus(createCandidate(text, "evidence", kind).id, "approved");
  }

  it("deduplicates normalized active cards", () => {
    const first = createCandidate("Cafe\u0301   workflow", "evidence");
    try {
      createCandidate("  CAFÉ workflow  ", "new evidence");
      throw new Error("expected a duplicate");
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateMemoryError);
      expect((error as DuplicateMemoryError).card.id).toBe(first.id);
    }
  });

  it("scopes deduplication to kind and active cards", () => {
    const candidate = createCandidate("Use concise answers", "evidence", "preference");
    createCandidate("Use concise answers", "evidence", "procedure");
    setStatus(candidate.id, "rejected");
    expect(createCandidate("use concise answers", "new evidence", "preference").id).not.toBe(candidate.id);
  });

  it("enforces the card limit after checking duplicates", () => {
    for (let index = 0; index < MAX_MEMORY_CARDS; index += 1) createCandidate(`card ${index}`, "evidence");
    expect(() => createCandidate("  CARD 0  ", "new evidence")).toThrow(DuplicateMemoryError);
    expect(() => createCandidate("one more card", "evidence")).toThrow(MemoryLimitError);
    expect(listCards()).toHaveLength(MAX_MEMORY_CARDS);
  });

  it("can prune a legacy oversized memory file", () => {
    saveMemoryCards(Array.from({ length: MAX_MEMORY_CARDS + 1 }, (_, index) => ({
      id: String(index).padStart(8, "0"),
      kind: "procedure" as const,
      text: `old card ${index}`,
      evidence: "evidence",
      status: "rejected" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      version: 1,
    })));
    expect(() => createCandidate("new card", "evidence")).toThrow(MemoryLimitError);
    expect(pruneCards()).toHaveLength(MAX_MEMORY_CARDS + 1);
    expect(listCards()).toEqual([]);
  });

  it("prunes rejected and revoked cards while preserving candidates and approvals", () => {
    const candidate = createCandidate("candidate", "evidence");
    const rejected = setStatus(createCandidate("rejected", "evidence").id, "rejected");
    const revoked = setStatus(createCandidate("revoked", "evidence").id, "revoked");
    const approved = setStatus(createCandidate("approved", "evidence").id, "approved");
    expect(new Set(pruneCards().map((card) => card.id))).toEqual(new Set([rejected.id, revoked.id]));
    expect(new Set(listCards().map((card) => card.id))).toEqual(new Set([candidate.id, approved.id]));
  });

  it("can include candidates in pruning without deleting approved cards", () => {
    const candidate = createCandidate("candidate", "evidence");
    const rejected = setStatus(createCandidate("rejected", "evidence").id, "rejected");
    const approved = setStatus(createCandidate("approved", "evidence").id, "approved");
    expect(new Set(pruneCards(true).map((card) => card.id))).toEqual(new Set([candidate.id, rejected.id]));
    expect(listCards().map((card) => card.id)).toEqual([approved.id]);
  });

  it("ranks exact phrases above a single keyword", () => {
    const keyword = approve("Use Python for automation");
    const phrase = approve("Use Python cache invalidation strategies");
    const matches = selectRelevantCards("Explain Python cache invalidation strategies");
    expect(matches.slice(0, 2).map(({ card }) => card.id)).toEqual([phrase.id, keyword.id]);
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  it("uses Chinese n-grams and ignores unrelated content", () => {
    const matching = approve("数据库索引优化应关注查询计划", "knowledge");
    const unrelated = approve("咖啡冲煮使用较低水温");
    const matches = selectRelevantCards("如何优化数据库索引性能");
    expect(matches.map(({ card }) => card.id)).toEqual([matching.id]);
    expect(matches.map(({ card }) => card.id)).not.toContain(unrelated.id);
  });

  it("ignores stop phrases and low relevance scores", () => {
    const stopPhrase = approve("如何使用这个工具");
    const lowScore = approve("数据管理流程");
    expect(selectRelevantCards("如何提问")).toEqual([]);
    expect(selectRelevantCards("数据").map(({ card }) => card.id)).not.toContain(lowScore.id);
    expect(selectRelevantCards("如何提问").map(({ card }) => card.id)).not.toContain(stopPhrase.id);
  });

  it("uses only approved cards and chooses the three newest ties", () => {
    const approved = Array.from({ length: 4 }, (_, index) => approve(`Python topic ${index}`));
    const candidate = createCandidate("Python candidate", "evidence");
    const rejected = setStatus(approve("Python rejected").id, "rejected");
    const cards = listCards().map((card, index) => ({ ...card, createdAt: `2026-01-01T00:00:0${index}.000Z` }));
    saveMemoryCards(cards);
    const matches = selectRelevantCards("Python", 3);
    expect(matches.map(({ card }) => card.id)).toEqual([approved[3]!.id, approved[2]!.id, approved[1]!.id]);
    expect(matches.map(({ card }) => card.id)).not.toContain(candidate.id);
    expect(matches.map(({ card }) => card.id)).not.toContain(rejected.id);
  });

  it("builds context from selected cards only", () => {
    const matching = approve("PostgreSQL index procedure");
    const unrelated = approve("Use dark mode", "preference");
    const context = relevantContext("Explain a PostgreSQL index");
    expect(context).toContain(matching.text);
    expect(context).not.toContain(unrelated.text);
  });
});
