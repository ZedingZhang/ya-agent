import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch, formatPatch } from "diff";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileChange, MAX_FILE_DIFF_CHARS, MAX_FILE_DIFF_LINES, type FileChange } from "../src/file-diff";
import { LocalWorkspace } from "../src/local";
import { tempHome, type TempHome } from "./helpers";

describe("file diff snapshots", () => {
  it("keeps scattered edits, exact line numbers and neutral context without inflating counts", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`).join("");
    const after = before.replace("line 8\n", "updated 8\n").replace("line 30\n", "updated 30\nextra\n");
    const change = createFileChange("code.txt", before, after, "edit");
    expect(change).toMatchObject({ path: "code.txt", operation: "edit", additions: 3, deletions: 2, truncated: false });
    expect(change.hunks).toHaveLength(2);
    expect(change.hunks[0]).toMatchObject({ oldStart: 5, newStart: 5 });
    expect(change.hunks[1]).toMatchObject({ oldStart: 27, newStart: 27 });
    expect(change.hunks[0]?.lines).toContain(" line 5");
    expect(applyPatch(before, formatPatch({ oldFileName: change.path, newFileName: change.path, hunks: change.hunks }))).toBe(after);
  });

  it.each([
    { before: undefined, after: "first\n\nlast\n", operation: "create", additions: 3, deletions: 0 },
    { before: "first\nlast\n", after: "", operation: "write", additions: 0, deletions: 2 },
    { before: undefined, after: "", operation: "create", additions: 0, deletions: 0 },
    { before: "same\n", after: "same\n", operation: "write", additions: 0, deletions: 0 },
  ])("handles creation, empty text and trailing newlines: $operation $after", ({ before, after, operation, additions, deletions }) => {
    const change = createFileChange("notes.txt", before, after, "write");
    expect(change).toMatchObject({ operation, additions, deletions, truncated: false });
    if (additions === 0 && deletions === 0) expect(change.hunks).toEqual([]);
  });

  it("preserves BOM, CRLF and missing-newline markers in the recorded diff", () => {
    const before = "\ufefffirst\r\nold\r\nlast";
    const after = "\ufefffirst\r\nnew\r\nlast\n";
    const change = createFileChange("script.ps1", before, after, "edit");
    const lines = change.hunks.flatMap((hunk) => hunk.lines);
    expect(lines).toContain(" \ufefffirst\r");
    expect(lines).toContain("-old\r");
    expect(lines).toContain("+new\r");
    expect(lines).toContain("\\ No newline at end of file");
    expect(applyPatch(before, formatPatch({ oldFileName: change.path, newFileName: change.path, hunks: change.hunks }))).toBe(after);
  });

  it("bounds stored lines while reporting complete statistics", () => {
    const change = createFileChange("large.txt", undefined, "added\n".repeat(MAX_FILE_DIFF_LINES + 50), "write");
    expect(change.additions).toBe(MAX_FILE_DIFF_LINES + 50);
    expect(change.truncated).toBe(true);
    expect(change.hunks.flatMap((hunk) => hunk.lines)).toHaveLength(MAX_FILE_DIFF_LINES);
  });

  it("bounds a single very long line and marks the preview as incomplete", () => {
    const change = createFileChange("long.txt", undefined, "x".repeat(MAX_FILE_DIFF_CHARS + 10), "write");
    expect(change).toMatchObject({ additions: 1, deletions: 0, truncated: true });
    const lines = change.hunks.flatMap((hunk) => hunk.lines);
    expect(lines.reduce((total, line) => total + line.length, 0)).toBeLessThanOrEqual(MAX_FILE_DIFF_CHARS);
    expect(lines[0]?.endsWith("…")).toBe(true);
  });
});

describe("successful file change delivery", () => {
  let home: TempHome;
  let root: string;
  let changes: FileChange[];
  let workspace: LocalWorkspace;
  beforeEach(() => {
    home = tempHome();
    root = join(home.path, "workspace");
    mkdirSync(root);
    changes = [];
    workspace = new LocalWorkspace(root, () => true, undefined, { onFileChange: (change) => changes.push(change) });
  });
  afterEach(() => home.cleanup());

  it("delivers each committed creation, replacement and edit without sending text to the model or audit", async () => {
    const delivered: string[] = [];
    workspace = new LocalWorkspace(root, () => true, undefined, { onFileChange: (change) => {
      changes.push(change);
      delivered.push(readFileSync(join(root, change.path), "utf8"));
    } });
    const created = await workspace.write({ path: "notes.txt", content: "private first\n" });
    await workspace.write({ path: "notes.txt", content: "private second\n" });
    const revision = JSON.parse(workspace.read({ path: "notes.txt" })).revision;
    await workspace.withSignal(new AbortController().signal).edit({ path: "notes.txt", expected_revision: revision,
      edits: [{ old_text: "second", new_text: "third" }] });
    expect(changes.map(({ operation, path }) => ({ operation, path }))).toEqual([
      { operation: "create", path: "notes.txt" }, { operation: "write", path: "notes.txt" }, { operation: "edit", path: "notes.txt" },
    ]);
    expect(new Set(changes.map((change) => change.id)).size).toBe(3);
    expect(delivered).toEqual(["private first\n", "private second\n", "private third\n"]);
    expect(changes[1]?.hunks[0]?.lines).toEqual(["-private first", "+private second"]);
    expect(created).not.toContain("private first");
    const audit = readFileSync(join(home.path, "actions.jsonl"), "utf8");
    for (const text of ["private first", "private second", "private third"]) expect(audit).not.toContain(text);
    // Snapshots remain usable after the live file has been changed again.
    expect(JSON.parse(JSON.stringify(changes))[0].hunks[0].lines).toEqual(["+private first"]);
  });

  it.each(["write", "edit"] as const)("does not announce a denied or conflicting %s as an applied change", async (operation) => {
    const path = join(root, "notes.txt");
    writeFileSync(path, "old\n");
    const args = { path: "notes.txt", content: "new\n", expected_revision: JSON.parse(workspace.read({ path: "notes.txt" })).revision,
      edits: [{ old_text: "old", new_text: "new" }] };
    workspace.confirm = () => false;
    expect(JSON.parse(await workspace[operation](args)).status).toBe("denied");
    workspace.confirm = () => { writeFileSync(path, "external\n"); return true; };
    await expect(workspace[operation](args)).rejects.toThrow("changed during approval");
    expect(changes).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("external\n");
  });

  it("does not announce cancelled writes or sensitive content", async () => {
    await workspace.write({ path: ".env", content: "TOKEN=private" });
    await workspace.write({ path: ".env", content: "TOKEN=updated" });
    await workspace.write({ path: "binary.dat", content: "text\0binary" });
    expect(changes).toEqual([]);
    const cancellation = new AbortController();
    workspace.confirm = () => { cancellation.abort(new Error("Stop")); return true; };
    await expect(workspace.withSignal(cancellation.signal).write({ path: "cancelled.txt", content: "never" })).rejects.toThrow("Stop");
    expect(changes).toEqual([]);
  });

  it("keeps a committed write successful when a presentation observer fails", async () => {
    workspace = new LocalWorkspace(root, () => true, undefined, { onFileChange: () => { throw new Error("View closed"); } });
    expect(JSON.parse(await workspace.write({ path: "notes.txt", content: "saved" })).status).toBe("ok");
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("saved");
  });
});
