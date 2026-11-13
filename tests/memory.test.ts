import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  MAX_MEMORY_CARDS,
  DuplicateMemoryError,
  MemoryLimitError,
  createCandidate,
  cardsToPrune,
  listCards,
  pruneCards,
  relevantContext,
  memoryPath,
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

  function legacyCards(cards: MemoryCard[]): void {
    writeFileSync(join(home.path, "memory.json"), JSON.stringify(cards.map(({ createdAt, ...card }) => ({
      ...card, created_at: createdAt,
    }))));
  }

  function fixture(index: number, status: MemoryCard["status"] = "candidate"): MemoryCard {
    return {
      id: String(index).padStart(8, "0"), kind: "procedure", text: `card ${index}`,
      evidence: "evidence", status, createdAt: "2026-01-01T00:00:00.000Z", version: 1,
    };
  }

  function native<T>(code: string): T {
    const response = spawnSync(process.env.YA_MEMORY_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
      ["-X", "utf8", "-c", `import json, sys\nfrom octop_memory import Memory, MemoryService\nm = Memory(namespace='ya', backend_config={'db_path': sys.argv[1]})\n${code}\nm.backend.close()`, memoryPath()],
      { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    expect(response.status, response.stderr).toBe(0);
    return JSON.parse(response.stdout) as T;
  }

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
    legacyCards(Array.from({ length: MAX_MEMORY_CARDS }, (_, index) => fixture(index)));
    expect(() => createCandidate("  CARD 0  ", "new evidence")).toThrow(DuplicateMemoryError);
    expect(() => createCandidate("one more card", "evidence")).toThrow(MemoryLimitError);
    expect(listCards()).toHaveLength(MAX_MEMORY_CARDS);
  });

  it("can prune a legacy oversized memory file", () => {
    legacyCards(Array.from({ length: MAX_MEMORY_CARDS + 1 }, (_, index) => fixture(index, "rejected")));
    expect(() => createCandidate("new card", "evidence")).toThrow(MemoryLimitError);
    expect(pruneCards(cardsToPrune().map(card => card.id))).toHaveLength(MAX_MEMORY_CARDS + 1);
    expect(listCards()).toEqual([]);
  });

  it("prunes rejected and revoked cards while preserving candidates and approvals", () => {
    const candidate = createCandidate("candidate", "evidence");
    const rejected = setStatus(createCandidate("rejected", "evidence").id, "rejected");
    const revoked = setStatus(createCandidate("revoked", "evidence").id, "revoked");
    const approved = setStatus(createCandidate("approved", "evidence").id, "approved");
    expect(new Set(pruneCards(cardsToPrune().map(card => card.id)).map((card) => card.id))).toEqual(new Set([rejected.id, revoked.id]));
    expect(new Set(listCards().map((card) => card.id))).toEqual(new Set([candidate.id, approved.id]));
  });

  it("can include candidates in pruning without deleting approved cards", () => {
    const candidate = createCandidate("candidate", "evidence");
    const rejected = setStatus(createCandidate("rejected", "evidence").id, "rejected");
    const approved = setStatus(createCandidate("approved", "evidence").id, "approved");
    expect(new Set(pruneCards(cardsToPrune(true).map(card => card.id), true).map((card) => card.id))).toEqual(new Set([candidate.id, rejected.id]));
    expect(listCards().map((card) => card.id)).toEqual([approved.id]);
  });

  it("prunes only confirmed IDs that are still prunable", () => {
    const shown = createCandidate("shown candidate", "evidence");
    const changed = createCandidate("approved after preview", "evidence");
    const confirmed = cardsToPrune(true).map((card) => card.id);
    setStatus(changed.id, "approved");
    const unseen = createCandidate("created after preview", "evidence");
    expect(pruneCards(confirmed, true).map((card) => card.id)).toEqual([shown.id]);
    expect(listCards().map((card) => card.id)).toEqual([changed.id, unseen.id]);
  });

  it("uses Octop's native recall order", () => {
    approve("Use Python for automation");
    approve("Use Python cache invalidation strategies");
    const matches = selectRelevantCards("Explain Python cache invalidation strategies");
    const ids = native<string[]>("result = MemoryService(m).recall('Explain Python cache invalidation strategies', limit=3)\nprint(json.dumps([m.get_atom(s.source_id).candidate_id for s in result.snippets]))");
    expect(matches.map(({ card }) => card.id)).toEqual(ids);
    expect(matches.every((match) => match.score === null)).toBe(true);
  });

  it("uses Chinese n-grams and ignores unrelated content", () => {
    const matching = approve("数据库索引优化应关注查询计划", "knowledge");
    const unrelated = approve("咖啡冲煮使用较低水温");
    const matches = selectRelevantCards("如何优化数据库索引性能");
    expect(matches.map(({ card }) => card.id)).toEqual([matching.id]);
    expect(matches.map(({ card }) => card.id)).not.toContain(unrelated.id);
  });

  it("returns no context for blank or unrelated queries", () => {
    approve("数据管理流程");
    expect(selectRelevantCards(" ")).toEqual([]);
    expect(selectRelevantCards("coffee brewing")).toEqual([]);
    expect(selectRelevantCards("数据", 0)).toEqual([]);
  });

  it("uses only approved cards and caps Octop recall at three", () => {
    const approved = [
      approve("Python testing uses pytest"), approve("Python formatting uses black"),
      approve("Python dependencies use pip"), approve("Python typing uses mypy"),
    ];
    const candidate = createCandidate("Python candidate", "evidence");
    const rejected = setStatus(approve("Python rejected").id, "rejected");
    const matches = selectRelevantCards("Python", 3);
    expect(matches).toHaveLength(3);
    expect(matches.every(({ card }) => approved.some((item) => item.id === card.id))).toBe(true);
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

  it("migrates all legacy statuses once and preserves the original JSON", () => {
    const cards = [fixture(1), fixture(2, "approved"), fixture(3, "rejected"), fixture(4, "revoked")];
    cards[1]!.text = "PostgreSQL migration procedure";
    cards[1]!.version = 5;
    legacyCards(cards);
    const original = readFileSync(join(home.path, "memory.json"), "utf8");
    expect(listCards()).toEqual(cards);
    expect(existsSync(memoryPath())).toBe(true);
    expect(selectRelevantCards("PostgreSQL").map(({ card }) => card.id)).toEqual([cards[1]!.id]);
    pruneCards(cardsToPrune(true).map(card => card.id), true);
    expect(listCards()).toEqual([cards[1]]);
    expect(readFileSync(join(home.path, "memory.json"), "utf8")).toBe(original);
  });

  it("rolls back a failed migration and retries corrected legacy data", () => {
    const valid = fixture(1, "approved");
    legacyCards([valid, { ...fixture(2), createdAt: "invalid date" }]);
    expect(() => listCards()).toThrow("Octop Memory");
    legacyCards([valid, fixture(2)]);
    expect(listCards()).toEqual([valid, fixture(2)]);
  });

  it("accepts legacy camelCase timestamps and default versions", () => {
    const card = fixture(1, "approved");
    writeFileSync(join(home.path, "memory.json"), JSON.stringify([{ ...card, created_at: null, version: null }]));
    expect(listCards()).toEqual([card]);
    expect(setStatus(card.id, "revoked").version).toBe(2);
  });

  it("revokes and reapproves a card without duplicate live atoms", () => {
    const card = approve("PostgreSQL index workflow");
    setStatus(card.id, "approved");
    expect(selectRelevantCards("PostgreSQL")).toHaveLength(1);
    setStatus(card.id, "revoked");
    expect(selectRelevantCards("PostgreSQL")).toEqual([]);
    setStatus(card.id, "approved");
    expect(selectRelevantCards("PostgreSQL").map(({ card }) => card.id)).toEqual([card.id]);
    setStatus(card.id, "rejected");
    pruneCards(cardsToPrune().map(card => card.id));
    expect(listCards()).toEqual([]);
    expect(selectRelevantCards("PostgreSQL")).toEqual([]);
    expect(native<number[]>("print(json.dumps([len(m.list_candidates()), len(m.list_atoms(include_deprecated=True)), len(m.list_raw()), len([n for n in m.get_tree() if n.level == 'leaf'])]))"))
      .toEqual([0, 0, 0, 0]);
  });

  it("serializes concurrent candidate creation and deduplication", async () => {
    const adapter = readFileSync(join(process.cwd(), "src", "octop-memory.py"), "utf8");
    const create = (text: string): Promise<{ result?: MemoryCard; error?: { code: string } }> => new Promise((resolve, reject) => {
      const child = spawn(process.env.YA_MEMORY_PYTHON ?? (process.platform === "win32" ? "python" : "python3"),
        ["-X", "utf8", "-c", adapter], { windowsHide: true });
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => { output += String(chunk); });
      child.stderr.on("data", (chunk) => { errors += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(errors));
        else {
          try { resolve(JSON.parse(output)); }
          catch (error) { reject(error); }
        }
      });
      child.stdin.end(JSON.stringify({ operation: "create", home: home.path, maxCards: MAX_MEMORY_CARDS,
        text, evidence: "parallel test", kind: "procedure" }));
    });
    const results = await Promise.all([create("same card"), create("same card"), create("another card")]);
    expect(results.filter((result) => result.result)).toHaveLength(2);
    expect(results.filter((result) => result.error?.code === "duplicate")).toHaveLength(1);
    expect(listCards()).toHaveLength(2);
  });

  it("keeps a failed approval atomic", () => {
    const card = createCandidate("atomic PostgreSQL approval", "evidence");
    native("m.backend._conn.execute(\"CREATE TRIGGER fail_atom BEFORE INSERT ON ya_atoms BEGIN SELECT RAISE(ABORT, 'injected failure'); END\")\nprint('null')");
    expect(() => setStatus(card.id, "approved")).toThrow("injected failure");
    expect(listCards()).toEqual([card]);
    expect(native<number>("print(len(m.list_atoms()))")).toBe(0);
    native("m.backend._conn.execute('DROP TRIGGER fail_atom')\nprint('null')");
    expect(setStatus(card.id, "approved").status).toBe("approved");
  });

  it("keeps candidates and archived raw evidence out of automatic context", () => {
    createCandidate("PostgreSQL unapproved instruction", "PostgreSQL raw evidence");
    expect(selectRelevantCards("PostgreSQL")).toEqual([]);
    native("m.add_raw('PostgreSQL archived message', event_type='user_message', host='ya')\nprint('null')");
    expect(relevantContext("PostgreSQL")).toBe("");
  });

  it("reports an unavailable Python interpreter without changing memory", () => {
    const card = createCandidate("Keep my data", "evidence");
    const previous = process.env.YA_MEMORY_PYTHON;
    process.env.YA_MEMORY_PYTHON = join(home.path, "missing-python");
    try { expect(() => setStatus(card.id, "approved")).toThrow("Octop Memory failed"); }
    finally {
      if (previous === undefined) delete process.env.YA_MEMORY_PYTHON;
      else process.env.YA_MEMORY_PYTHON = previous;
    }
    expect(listCards()).toEqual([card]);
  });
});
