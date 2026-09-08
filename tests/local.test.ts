import {
  basename,
  join,
} from "node:path";
import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_AUDIT_ARCHIVES,
  MAX_DIFF_LINES,
  MAX_TEXT_BYTES,
  LocalWorkspace,
  appendAuditRecord,
  auditLogFiles,
  auditLogTotalBytes,
  clearAuditLogs,
  setAuditLogMaxBytesForTesting,
  type LocalAction,
  type LocalActivity,
} from "../src/local";
import { tempHome, type TempHome } from "./helpers";

describe("local workspace", () => {
  let home: TempHome;
  let root: string;
  let actions: LocalAction[];
  let workspace: LocalWorkspace;

  beforeEach(() => {
    home = tempHome();
    root = join(home.path, "workspace");
    mkdirSync(root);
    actions = [];
    workspace = new LocalWorkspace(root, (action) => {
      actions.push(action);
      return true;
    });
  });

  afterEach(() => {
    setAuditLogMaxBytesForTesting(1024 * 1024);
    home.cleanup();
  });

  it("lists, reads, and searches file names and text", () => {
    writeFileSync(join(root, "notes.txt"), "Hello Ya\nFind this line\n", "utf8");
    const listing = JSON.parse(workspace.list({})) as { entries: Array<{ path: string }> };
    expect(listing.entries[0]!.path).toBe("notes.txt");
    expect((JSON.parse(workspace.read({ path: "notes.txt" })) as { content: string }).content).toBe("Hello Ya\nFind this line\n");
    const textResults = (JSON.parse(workspace.search({ query: "find" })) as { results: Array<Record<string, unknown>> }).results;
    expect(textResults[0]).toMatchObject({ match: "text", line: 2 });
    const nameResults = (JSON.parse(workspace.search({ query: "notes" })) as { results: Array<Record<string, unknown>> }).results;
    expect(nameResults[0]).toMatchObject({ match: "filename" });
  });

  it("reports activity metadata without file contents", () => {
    writeFileSync(join(root, "notes.txt"), "very private local text", "utf8");
    const observed: LocalActivity[] = [];
    const observedWorkspace = new LocalWorkspace(root, () => true, (activity) => observed.push(activity));
    observedWorkspace.list({});
    observedWorkspace.read({ path: "notes.txt" });
    observedWorkspace.search({ query: "private" });
    expect(observed).toEqual([
      { operation: "list", paths: ["."], status: "success" },
      { operation: "read", paths: ["notes.txt"], status: "success" },
      { operation: "search", paths: ["."], status: "success" },
    ]);
    expect(JSON.stringify(observed)).not.toContain("very private local text");
  });

  it.skipIf(process.platform === "win32")("blocks escapes, symlinks, binary, large, and sensitive reads", () => {
    const outside = join(home.path, "outside.txt");
    writeFileSync(outside, "outside", "utf8");
    symlinkSync(outside, join(root, "link"));
    writeFileSync(join(root, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
    writeFileSync(join(root, "large.txt"), Buffer.alloc(MAX_TEXT_BYTES + 1, "x"));
    writeFileSync(join(root, ".env"), "SECRET=value", "utf8");
    for (const path of ["../outside.txt", "link", "binary.bin", "large.txt", ".env"]) {
      expect(() => workspace.read({ path }), path).toThrow();
    }
    const results = JSON.parse(workspace.search({ query: "SECRET" })) as { results: unknown[] };
    expect(results.results).toEqual([]);
  });

  it("requires existing parents for mkdir and write", async () => {
    await expect(workspace.mkdir({ path: "missing/child" })).rejects.toThrow(/Parent directory/u);
    await expect(workspace.write({ path: "missing/file.txt", content: "x" })).rejects.toThrow(/Parent directory/u);
    const result = JSON.parse(await workspace.mkdir({ path: "created" })) as { status: string };
    expect(result.status).toBe("ok");
    expect(statSync(join(root, "created")).isDirectory()).toBe(true);
  });

  it("shows overwrite diffs and does not write after denial", async () => {
    const path = join(root, "answer.txt");
    writeFileSync(path, "old\n", "utf8");
    expect(JSON.parse(await workspace.write({ path: "answer.txt", content: "new\n" }))).toMatchObject({ status: "ok" });
    expect(actions.at(-1)?.diff).toContain("-old");
    expect(readFileSync(path, "utf8")).toBe("new\n");
    workspace.confirm = () => false;
    expect(JSON.parse(await workspace.write({ path: "answer.txt", content: "nope\n" }))).toMatchObject({ status: "denied" });
    expect(readFileSync(path, "utf8")).toBe("new\n");
    const audit = readFileSync(join(home.path, "actions.jsonl"), "utf8");
    expect(audit).toContain('"status":"denied"');
    expect(audit).not.toContain("nope");
  });

  it("allows confirmed sensitive writes but keeps them unreadable to the model", async () => {
    expect(JSON.parse(await workspace.write({ path: ".env", content: "TOKEN=new" }))).toMatchObject({ status: "ok" });
    expect(() => workspace.read({ path: ".env" })).toThrow(/sensitive/u);
  });

  it("moves within the workspace without overwriting", async () => {
    writeFileSync(join(root, "from.txt"), "x", "utf8");
    expect(JSON.parse(await workspace.move({ source: "from.txt", destination: "to.txt" }))).toMatchObject({ status: "ok" });
    writeFileSync(join(root, "other.txt"), "x", "utf8");
    await expect(workspace.move({ source: "to.txt", destination: "other.txt" })).rejects.toThrow(/already exists/u);
  });

  it("truncates large overwrite diffs", async () => {
    writeFileSync(join(root, "large-diff.txt"), Array.from({ length: 300 }, (_, index) => `old ${index}\n`).join(""));
    await workspace.write({ path: "large-diff.txt", content: Array.from({ length: 300 }, (_, index) => `new ${index}\n`).join("") });
    const diff = actions.at(-1)?.diff ?? "";
    expect(diff).toContain("diff truncated");
    expect(diff.trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_DIFF_LINES + 1);
  });

  it("rotates audit logs and evicts the oldest records", () => {
    setAuditLogMaxBytesForTesting(120);
    for (let number = 0; number < 10; number += 1) appendAuditRecord({ record: number, value: "x".repeat(20) });
    const logs = auditLogFiles();
    expect(logs.map((path) => basename(path))).toEqual(["actions.jsonl", "actions.1.jsonl", "actions.2.jsonl", "actions.3.jsonl"]);
    expect(auditLogTotalBytes()).toBeLessThanOrEqual(120 * (MAX_AUDIT_ARCHIVES + 1));
    const records = logs.flatMap((path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { record: number }).record));
    expect(records).not.toContain(0);
    expect(records).not.toContain(1);
    expect([...records].sort((left, right) => left - right)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("keeps complete records when rotating a legacy oversized log", () => {
    const active = join(home.path, "actions.jsonl");
    writeFileSync(active, Array.from({ length: 6 }, (_, number) => `${JSON.stringify({ record: number, value: "x".repeat(20) })}\n`).join(""));
    setAuditLogMaxBytesForTesting(120);
    appendAuditRecord({ record: 6, value: "x".repeat(20) });
    const archive = join(home.path, "actions.1.jsonl");
    expect(statSync(archive).size).toBeLessThanOrEqual(120);
    const text = readFileSync(archive, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("clears active and archived audit logs", () => {
    appendAuditRecord({ record: 1 });
    writeFileSync(join(home.path, "actions.1.jsonl"), '{"record":0}\n');
    expect(clearAuditLogs().map((path) => basename(path))).toEqual(["actions.jsonl", "actions.1.jsonl"]);
    expect(auditLogFiles()).toEqual([]);
  });
});
