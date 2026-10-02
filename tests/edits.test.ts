import { chmodSync, existsSync, fchownSync, fstatSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TEXT_BYTES, LocalWorkspace, type LocalAction, type LocalActivity } from "../src/local";
import { tempHome, type TempHome } from "./helpers";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fchownSync: vi.fn(actual.fchownSync), fstatSync: vi.fn(actual.fstatSync), renameSync: vi.fn(actual.renameSync) };
});

describe("reliable local edits", () => {
  let home: TempHome;
  let root: string;
  let workspace: LocalWorkspace;
  let actions: LocalAction[];
  const request = (path: string, old_text: string, new_text: string) => ({
    path, expected_revision: JSON.parse(workspace.read({ path })).revision as string, edits: [{ old_text, new_text }],
  });
  beforeEach(() => {
    home = tempHome();
    root = join(home.path, "workspace");
    mkdirSync(root);
    actions = [];
    workspace = new LocalWorkspace(root, (action) => { actions.push(action); return true; });
  });
  afterEach(() => home.cleanup());

  it("applies a disjoint batch against the original bytes and returns a new revision", async () => {
    const path = join(root, "code.ts");
    const original = '\ufeffconst first = "你好";\r\nconst second = 2;\r\n// keep 🙂';
    writeFileSync(path, original);
    const args = request("code.ts", '"你好"', '"hello"');
    args.edits.push({ old_text: "second = 2", new_text: "second = 3" });
    const result = JSON.parse(await workspace.toolHandlers.local_edit!(args));
    const expected = original.replace('"你好"', '"hello"').replace("second = 2", "second = 3");
    expect(readFileSync(path)).toEqual(Buffer.from(expected));
    expect(result).toMatchObject({ status: "ok", operation: "edit", path: "code.ts", applied_edits: 2 });
    expect(result.revision).toBe(JSON.parse(workspace.read({ path: "code.ts" })).revision);
    expect(result.revision).not.toBe(args.expected_revision);
    expect(actions[0]).toMatchObject({ operation: "edit" });
    expect(actions[0]?.diff).toContain('-const second = 2;');
    expect(actions[0]?.diff).toContain('+const second = 3;');
    expect(readdirSync(root)).toEqual(["code.ts"]);
  });

  it("supports insertion using context, deletion and replacement text matching another original range", async () => {
    writeFileSync(join(root, "code.txt"), "alpha\nbeta\ngamma\n");
    const args = request("code.txt", "alpha\n", "beta\ninserted\n");
    args.edits.push({ old_text: "beta\n", new_text: "" });
    await workspace.edit(args);
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("beta\ninserted\ngamma\n");
  });

  it.each([
    [{ old_text: "absent", new_text: "x" }],
    [{ old_text: "repeat", new_text: "x" }],
    [{ old_text: "unique", new_text: "x" }, { old_text: "nique", new_text: "y" }],
    [{ old_text: "unique", new_text: "x" }, { old_text: "absent", new_text: "y" }],
    [{ old_text: "", new_text: "x" }],
    [{ old_text: "unique", new_text: "unique" }],
    [{ old_text: "unique", new_text: "\0" }],
    [{ old_text: "unique", new_text: "\ud800" }],
    [{ old_text: "unique" }],
    [null],
  ])("rejects invalid or ambiguous batches without approval or partial changes: %j", async (...edits) => {
    const original = "unique repeat repeat";
    writeFileSync(join(root, "code.txt"), original);
    const args = { ...request("code.txt", "unique", "x"), edits };
    await expect(workspace.edit(args)).rejects.toThrow();
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe(original);
    expect(readdirSync(root)).toEqual(["code.txt"]);
  });

  it("rejects even overlapping occurrences of the same search text", async () => {
    writeFileSync(join(root, "code.txt"), "aaa");
    await expect(workspace.edit(request("code.txt", "aa", "b"))).rejects.toThrow("more than once");
  });

  it("rejects a match that would split an emoji's surrogate pair", async () => {
    writeFileSync(join(root, "code.txt"), "keep 🙂 intact");
    await expect(workspace.edit(request("code.txt", "\ud83d", "x"))).rejects.toThrow("valid UTF-8");
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("keep 🙂 intact");
  });

  it.each([[], Array.from({ length: 101 }, () => ({ old_text: "old", new_text: "new" }))])("bounds the number of replacements", async (edits) => {
    writeFileSync(join(root, "code.txt"), "old");
    await expect(workspace.edit({ ...request("code.txt", "old", "new"), edits })).rejects.toThrow("1–100");
    expect(actions).toEqual([]);
  });

  it("rejects stale or missing revisions before approval", async () => {
    const path = join(root, "code.txt");
    writeFileSync(path, "old");
    const args = request("code.txt", "old", "new");
    writeFileSync(path, "old plus manual changes");
    await expect(workspace.edit(args)).rejects.toThrow("revision changed");
    await expect(workspace.edit({ ...args, expected_revision: undefined })).rejects.toThrow("local_read");
    expect(actions).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("old plus manual changes");
  });

  it("refuses read-only files instead of bypassing their write protection", async () => {
    const path = join(root, "locked.txt");
    writeFileSync(path, "old");
    chmodSync(path, 0o444);
    try {
      await expect(workspace.edit(request("locked.txt", "old", "new"))).rejects.toThrow("Read-only files cannot be edited");
      expect(actions).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe("old");
      expect(readdirSync(root)).toEqual(["locked.txt"]);
    } finally {
      chmodSync(path, 0o666);
    }
  });

  it.skipIf(process.platform === "win32")("refuses an edit whose ownership it cannot restore", async () => {
    const path = join(root, "code.txt");
    writeFileSync(path, "old");
    const args = request("code.txt", "old", "new");
    vi.mocked(fstatSync).mockReturnValueOnce({ uid: 4242, gid: 4242 } as unknown as ReturnType<typeof fstatSync>);
    vi.mocked(fchownSync).mockImplementationOnce(() => { throw new Error("EPERM: operation not permitted"); });
    await expect(workspace.edit(args)).rejects.toThrow("Cannot preserve the owner");
    expect(readFileSync(path, "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["code.txt"]);
  });

  it("publishes a new inode, so hard links keep the previous content", async () => {
    const path = join(root, "code.txt");
    const linked = join(root, "linked.txt");
    writeFileSync(path, "old");
    linkSync(path, linked);
    expect(statSync(path).nlink).toBe(2);
    await workspace.edit(request("code.txt", "old", "new"));
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readFileSync(linked, "utf8")).toBe("old");
    expect(statSync(path).nlink).toBe(1);
  });

  it.each(["change", "replace", "delete"])("rejects a file %s during approval", async (operation) => {
    const path = join(root, "code.txt");
    writeFileSync(path, "old");
    const args = request("code.txt", "old", "new");
    workspace.confirm = () => {
      if (operation === "change") writeFileSync(path, "manual");
      if (operation === "replace") { renameSync(path, join(root, "backup.txt")); writeFileSync(path, "old"); }
      if (operation === "delete") unlinkSync(path);
      return true;
    };
    await expect(workspace.edit(args)).rejects.toThrow();
    if (operation !== "delete") expect(readFileSync(path, "utf8")).toBe(operation === "change" ? "manual" : "old");
    else expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).some((name) => name.startsWith(".ya-edit-"))).toBe(false);
  });

  it("rejects a parent redirected outside the workspace during approval", async () => {
    const sub = join(root, "sub");
    const outside = join(home.path, "outside");
    mkdirSync(sub); mkdirSync(outside);
    writeFileSync(join(sub, "code.txt"), "old");
    writeFileSync(join(outside, "code.txt"), "outside");
    const args = request("sub/code.txt", "old", "new");
    workspace.confirm = () => {
      renameSync(sub, join(root, "backup"));
      symlinkSync(outside, sub, process.platform === "win32" ? "junction" : "dir");
      return true;
    };
    await expect(workspace.edit(args)).rejects.toThrow("inside");
    expect(readFileSync(join(outside, "code.txt"), "utf8")).toBe("outside");
    expect(readFileSync(join(root, "backup", "code.txt"), "utf8")).toBe("old");
  });

  it("handles concurrent approvals without overwriting an earlier edit", async () => {
    writeFileSync(join(root, "code.txt"), "old");
    const args = request("code.txt", "old", "first");
    const approvals: Array<(value: boolean) => void> = [];
    workspace.confirm = () => new Promise<boolean>((resolve) => approvals.push(resolve));
    const first = workspace.edit(args);
    const second = workspace.edit({ ...args, edits: [{ old_text: "old", new_text: "second" }] });
    approvals[0]!(true);
    await first;
    const rejected = expect(second).rejects.toThrow("changed during approval");
    approvals[1]!(true);
    await rejected;
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("first");
  });

  it("does not write on denial or cancellation, even after late approval", async () => {
    writeFileSync(join(root, "code.txt"), "old");
    const args = request("code.txt", "old", "new");
    workspace.confirm = () => false;
    expect(JSON.parse(await workspace.edit(args)).status).toBe("denied");
    const controller = new AbortController();
    let approve!: (value: boolean) => void;
    const cancelled = new LocalWorkspace(root, () => new Promise<boolean>((resolve) => { approve = resolve; }), undefined, { signal: controller.signal });
    const task = cancelled.edit(args);
    controller.abort(new Error("Stop"));
    await expect(task).rejects.toThrow("Stop");
    approve(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["code.txt"]);
  });

  it("blocks sensitive, binary, oversized, missing and outside files", async () => {
    writeFileSync(join(root, ".env"), "old");
    writeFileSync(join(root, "binary"), Buffer.from([0, 1]));
    writeFileSync(join(root, "large"), "x".repeat(MAX_TEXT_BYTES + 1));
    writeFileSync(join(root, "invalid"), Buffer.from([0xff]));
    for (const path of [".env", "binary", "large", "invalid", "missing", "..", "../outside"]) {
      await expect(workspace.edit({ path, expected_revision: "0".repeat(64), edits: [{ old_text: "old", new_text: "new" }] })).rejects.toThrow();
    }
    expect(actions).toEqual([]);
  });

  it("rejects oversized results without touching the original", async () => {
    writeFileSync(join(root, "code.txt"), "old");
    await expect(workspace.edit(request("code.txt", "old", "x".repeat(MAX_TEXT_BYTES + 1)))).rejects.toThrow("1 MiB");
    expect(actions).toEqual([]);
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("old");
  });

  it("keeps the original intact and cleans staging files if publishing fails", async () => {
    writeFileSync(join(root, "code.txt"), "old");
    const args = request("code.txt", "old", "new");
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("Simulated rename failure"); });
    await expect(workspace.edit(args)).rejects.toThrow("Simulated rename failure");
    expect(readFileSync(join(root, "code.txt"), "utf8")).toBe("old");
    expect(readdirSync(root)).toEqual(["code.txt"]);
  });

  it.skipIf(process.platform === "win32")("preserves executable permissions", async () => {
    const path = join(root, "code.sh");
    writeFileSync(path, "echo old\n");
    chmodSync(path, 0o755);
    await workspace.edit(request("code.sh", "old", "new"));
    expect(statSync(path).mode & 0o777).toBe(0o755);
  });

  it("logs edit metadata without source or replacement contents", async () => {
    writeFileSync(join(root, "code.txt"), "private original text");
    const observed: LocalActivity[] = [];
    const instrumented = new LocalWorkspace(root, () => true, (event) => observed.push(event));
    await instrumented.edit(request("code.txt", "private original text", "private replacement text"));
    const audit = readFileSync(join(home.path, "actions.jsonl"), "utf8");
    expect(audit).toContain('"operation":"edit"');
    expect(audit).toContain('"replacements":1');
    expect(audit).not.toContain("private original text");
    expect(audit).not.toContain("private replacement text");
    expect(observed).toEqual([{ operation: "edit", paths: ["code.txt"], status: "success" }]);
  });
});
