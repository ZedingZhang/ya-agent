import {
  basename,
  dirname,
  join,
} from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_AUDIT_ARCHIVES,
  MAX_DIFF_LINES,
  MAX_SEARCH_RESULTS,
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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readdirSync: vi.fn(actual.readdirSync), readFileSync: vi.fn(actual.readFileSync) };
});

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

  it.each(["text", "filename"])("stops traversal immediately when a %s match reaches the limit", (kind) => {
    const first = join(workspace.root, "a-first.txt");
    const lineCount = MAX_SEARCH_RESULTS - (kind === "filename" ? 1 : 0);
    writeFileSync(first, "needle\n".repeat(lineCount));
    if (kind === "filename") writeFileSync(join(workspace.root, "b-needle.txt"), "not read");
    const later = join(workspace.root, "z-later");
    mkdirSync(later);
    writeFileSync(join(later, "later.txt"), "needle");
    vi.mocked(readdirSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    const result = JSON.parse(workspace.search({ query: "needle" }));
    expect(result.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(result.limited).toBe(true);
    expect(result.results.at(-1).match).toBe(kind);
    expect(vi.mocked(readdirSync).mock.calls.map(([path]) => String(path))).toEqual([workspace.root]);
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path))).toEqual([first]);
  });

  it("preserves depth-first search ordering below the limit", () => {
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "one.txt"), "context\nneedle");
    writeFileSync(join(root, "b-needle.txt"), "needle");
    writeFileSync(join(root, "c.txt"), "needle");
    const result = JSON.parse(workspace.search({ query: "needle" }));
    expect(result.limited).toBe(false);
    expect(result.results.map(({ path, match, line }: { path: string; match: string; line?: number }) => ({ path, match, line })))
      .toEqual([
        { path: join("a", "one.txt"), match: "text", line: 2 },
        { path: "b-needle.txt", match: "filename", line: undefined },
        { path: "b-needle.txt", match: "text", line: 1 },
        { path: "c.txt", match: "text", line: 1 },
      ]);
  });

  it.each(["needle", "target"])("skips dependency and build directories for query %s at every depth", (query) => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "target.txt"), "needle");
    for (const parent of [root, join(root, "src")]) {
      for (const name of ["node_modules", "dist", ".next"]) {
        mkdirSync(join(parent, name));
        writeFileSync(join(parent, name, "target.txt"), "needle");
      }
    }
    vi.mocked(readdirSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    const result = JSON.parse(workspace.search({ query }));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].path).toBe(join("src", "target.txt"));
    expect(result.limited).toBe(false);
    expect(vi.mocked(readdirSync).mock.calls.map(([path]) => String(path)))
      .toEqual([workspace.root, join(workspace.root, "src")]);
    expect(vi.mocked(readFileSync).mock.calls.map(([path]) => String(path)))
      .toEqual([join(workspace.root, "src", "target.txt")]);
  });

  it.each(["node_modules", "dist", ".next"])("searches an explicitly selected %s root", (path) => {
    mkdirSync(join(root, path));
    writeFileSync(join(root, path, "target.txt"), "needle");
    mkdirSync(join(root, path, "node_modules"));
    writeFileSync(join(root, path, "node_modules", "nested.txt"), "needle");
    const result = JSON.parse(workspace.search({ query: "needle", path }));
    expect(result).toMatchObject({ limited: false, results: [{ path: join(path, "target.txt"), match: "text", line: 1 }] });
  });

  it("keeps similarly named directories and ordinary files searchable", () => {
    mkdirSync(join(root, "src"));
    for (const name of ["node_modules", "dist", ".next"]) writeFileSync(join(root, "src", name), "needle");
    for (const name of ["node_modules-copy", "dist-src", ".next-source"]) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "target.txt"), "needle");
    }
    const result = JSON.parse(workspace.search({ query: "needle" }));
    expect(result.results.map(({ path }: { path: string }) => path).sort()).toEqual([
      join("src", "node_modules"), join("src", "dist"), join("src", ".next"),
      join("node_modules-copy", "target.txt"), join("dist-src", "target.txt"), join(".next-source", "target.txt"),
    ].sort());
    expect(result.limited).toBe(false);
  });

  it("keeps sensitive, binary, invalid and oversized files out of text search", () => {
    writeFileSync(join(root, ".env"), "needle");
    writeFileSync(join(root, "binary.bin"), Buffer.from("needle\0"));
    writeFileSync(join(root, "invalid.txt"), Buffer.from([0xff]));
    writeFileSync(join(root, "large.txt"), "needle".padEnd(MAX_TEXT_BYTES + 1, "x"));
    writeFileSync(join(root, "ordinary.txt"), "needle");
    const result = JSON.parse(workspace.search({ query: "needle" }));
    expect(result).toMatchObject({ limited: false, results: [{ path: "ordinary.txt", match: "text", line: 1 }] });
  });

  it("preserves UTF-8 BOM bytes when reading and writing back a file", async () => {
    const path = join(root, "script.ps1");
    const content = '\ufeffWrite-Output "你好"\n';
    const original = Buffer.from(content, "utf8");
    writeFileSync(path, original);
    const result = JSON.parse(workspace.read({ path: "script.ps1" })) as { content: string };
    expect(result.content).toBe(content);
    await workspace.write({ path: "script.ps1", content: result.content });
    expect(readFileSync(path)).toEqual(original);
  });

  it("includes the original BOM in approval diffs when it is explicitly removed", async () => {
    writeFileSync(join(root, "script.ps1"), '\ufeffWrite-Output "你好"\n', "utf8");
    await workspace.write({ path: "script.ps1", content: 'Write-Output "你好"\n' });
    expect(actions.at(-1)?.diff).toContain('-\ufeffWrite-Output "你好"');
    expect(actions.at(-1)?.diff).toContain('+Write-Output "你好"');
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

  it.each([".env", ".env.local", "credentials.json", "id_rsa", "client.key", ".git/config", ".git-credentials", ".NETRC", ".NpmRc"])(
    "blocks creating or replacing sensitive file %s before approval", async (path) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      await expect(workspace.write({ path, content: "synthetic-new-value" })).rejects.toThrow(/sensitive/u);
      expect(existsSync(join(root, path))).toBe(false);
      writeFileSync(join(root, path), "synthetic-old-value", "utf8");
      await expect(workspace.write({ path, content: "synthetic-new-value" })).rejects.toThrow(/sensitive/u);
      expect(actions).toEqual([]);
      expect(readFileSync(join(root, path), "utf8")).toBe("synthetic-old-value");
      expect(() => workspace.read({ path })).toThrow(/sensitive/u);
      const audit = readFileSync(join(home.path, "actions.jsonl"), "utf8");
      expect(audit).not.toContain("synthetic-old-value");
      expect(audit).not.toContain("synthetic-new-value");
    },
  );

  it.each([".GIT", ".Git", ".gIt"])("blocks every local file operation inside %s", async (directory) => {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, "config"), "synthetic-credential");
    writeFileSync(join(root, "ordinary.txt"), "ordinary");
    expect(() => workspace.read({ path: `${directory}/config` })).toThrow(/sensitive/u);
    expect(() => workspace.list({ path: directory })).toThrow(/sensitive/u);
    expect(() => workspace.search({ path: directory, query: "synthetic" })).toThrow(/sensitive/u);
    expect(JSON.parse(workspace.search({ query: "synthetic" })).results).toEqual([]);
    await expect(workspace.write({ path: `${directory}/config`, content: "changed" })).rejects.toThrow(/sensitive/u);
    await expect(workspace.edit({ path: `${directory}/config`, expected_revision: "0".repeat(64), edits: [] })).rejects.toThrow(/sensitive/u);
    await expect(workspace.mkdir({ path: `${directory}/hooks` })).rejects.toThrow(/sensitive/u);
    await expect(workspace.move({ source: directory, destination: "metadata" })).rejects.toThrow(/sensitive/u);
    await expect(workspace.move({ source: "ordinary.txt", destination: `${directory}/hook` })).rejects.toThrow(/sensitive/u);
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, directory, "config"), "utf8")).toBe("synthetic-credential");
  });

  it("blocks alternate casing of an on-disk .git directory on a case-insensitive filesystem", async (context) => {
    mkdirSync(join(root, ".git"));
    if (!existsSync(join(root, ".GIT"))) { context.skip(); return; }
    writeFileSync(join(root, ".git", "config"), "synthetic-credential");
    for (const directory of [".GIT", ".Git", ".gIt"]) {
      expect(() => workspace.read({ path: `${directory}/config` })).toThrow(/sensitive/u);
      expect(() => workspace.search({ path: directory, query: "synthetic" })).toThrow(/sensitive/u);
      await expect(workspace.write({ path: `${directory}/config`, content: "changed" })).rejects.toThrow(/sensitive/u);
      await expect(workspace.edit({ path: `${directory}/config`, expected_revision: "0".repeat(64), edits: [] })).rejects.toThrow(/sensitive/u);
      await expect(workspace.mkdir({ path: `${directory}/hooks` })).rejects.toThrow(/sensitive/u);
      await expect(workspace.move({ source: directory, destination: "metadata" })).rejects.toThrow(/sensitive/u);
    }
    expect(actions).toEqual([]);
  });

  it("blocks writes through an alias into a sensitive directory", async () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "synthetic-old-value", "utf8");
    symlinkSync(join(root, ".git"), join(root, "metadata"), process.platform === "win32" ? "junction" : "dir");
    await expect(workspace.write({ path: "metadata/config", content: "synthetic-new-value" })).rejects.toThrow(/sensitive/u);
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("synthetic-old-value");
  });

  it("moves within the workspace without overwriting", async () => {
    writeFileSync(join(root, "from.txt"), "x", "utf8");
    expect(JSON.parse(await workspace.move({ source: "from.txt", destination: "to.txt" }))).toMatchObject({ status: "ok" });
    writeFileSync(join(root, "other.txt"), "x", "utf8");
    await expect(workspace.move({ source: "to.txt", destination: "other.txt" })).rejects.toThrow(/already exists/u);
  });

  it.each([".env", ".env.local", "credentials.json", "id_rsa", "private.pem", ".git/config"])(
    "blocks moving sensitive source %s before ordinary approval", async (source) => {
      mkdirSync(dirname(join(root, source)), { recursive: true });
      writeFileSync(join(root, source), "synthetic-credential", "utf8");
      await expect(workspace.move({ source, destination: "notes.txt" })).rejects.toThrow(/sensitive/u);
      expect(actions).toEqual([]);
      expect(readFileSync(join(root, source), "utf8")).toBe("synthetic-credential");
      expect(existsSync(join(root, "notes.txt"))).toBe(false);
      expect(readFileSync(join(home.path, "actions.jsonl"), "utf8")).not.toContain("synthetic-credential");
    },
  );

  it.each([".env", ".env.production", "credentials.json", "id_ed25519", "client.key", ".git/config"])(
    "blocks moving into sensitive destination %s before ordinary approval", async (destination) => {
      mkdirSync(dirname(join(root, destination)), { recursive: true });
      writeFileSync(join(root, "notes.txt"), "ordinary text", "utf8");
      await expect(workspace.move({ source: "notes.txt", destination })).rejects.toThrow(/sensitive/u);
      expect(actions).toEqual([]);
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("ordinary text");
      expect(existsSync(join(root, destination))).toBe(false);
    },
  );

  it("blocks renaming the entire .git directory", async () => {
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "synthetic-credential", "utf8");
    await expect(workspace.move({ source: ".git", destination: "metadata" })).rejects.toThrow(/sensitive/u);
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toBe("synthetic-credential");
    expect(existsSync(join(root, "metadata"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("checks resolved move paths for sensitive aliases", async () => {
    writeFileSync(join(root, ".env"), "synthetic-credential", "utf8");
    symlinkSync(join(root, ".env"), join(root, "alias.txt"));
    await expect(workspace.move({ source: "alias.txt", destination: "notes.txt" })).rejects.toThrow(/sensitive/u);
    mkdirSync(join(root, ".git"));
    symlinkSync(join(root, ".git"), join(root, "metadata"), "dir");
    writeFileSync(join(root, "ordinary.txt"), "ordinary text", "utf8");
    await expect(workspace.move({ source: "ordinary.txt", destination: "metadata/config" })).rejects.toThrow(/sensitive/u);
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("synthetic-credential");
    expect(existsSync(join(root, ".git", "config"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects a destination redirected into .git during approval", async () => {
    mkdirSync(join(root, "target"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "ordinary.txt"), "ordinary text", "utf8");
    workspace.confirm = () => {
      renameSync(join(root, "target"), join(root, "original-target"));
      symlinkSync(join(root, ".git"), join(root, "target"), "dir");
      return true;
    };
    await expect(workspace.move({ source: "ordinary.txt", destination: "target/config" }))
      .rejects.toThrow(/changed during approval/u);
    expect(readFileSync(join(root, "ordinary.txt"), "utf8")).toBe("ordinary text");
    expect(existsSync(join(root, ".git", "config"))).toBe(false);
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
