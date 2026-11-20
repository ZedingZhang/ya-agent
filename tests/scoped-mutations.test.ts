import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textRevision } from "../src/edits";
import { FolderGrants } from "../src/gui/folder-grants";
import { GrantedFolderIO } from "../src/gui/folder-io";
import { auditLogPath, LocalWorkspace, type LocalAction } from "../src/local";
import { tempHome, type TempHome } from "./helpers";

describe("desktop folder mutations", () => {
  let home: TempHome;
  let root: string;
  let grants: FolderGrants;
  let workspace: LocalWorkspace<GrantedFolderIO>;
  const confirm = vi.fn<(action: LocalAction) => boolean>();
  const fileChanged = vi.fn();
  const note = join("drafts", "note.txt");
  const edit = { path: note, expected_revision: textRevision("draft"), edits: [{ old_text: "draft", new_text: "final" }] };

  beforeEach(async () => {
    home = tempHome();
    root = realpathSync(home.path);
    mkdirSync(join(root, "drafts"));
    writeFileSync(join(root, note), "draft");
    grants = new FolderGrants();
    const grant = await grants.grant("bot", root);
    confirm.mockReset().mockReturnValue(true);
    fileChanged.mockClear();
    workspace = new LocalWorkspace(root, confirm, undefined, {
      scopedFolder: new GrantedFolderIO(grants, "bot", grant), onFileChange: fileChanged,
    });
  });

  afterEach(() => {
    grants.revoke("bot");
    home.cleanup();
  });

  it("accepts absolute aliases of the authorized root and returns relative result and approval paths", async () => {
    const alias = root + "-alias";
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const check = async (spelling: string): Promise<void> => {
        expect(JSON.parse(await workspace.read({ path: join(spelling, note) }))).toMatchObject({ path: note, content: "draft" });
        expect(JSON.parse(await workspace.list({ path: join(spelling, "drafts") })).entries[0].path).toBe(note);
        expect(JSON.parse(await workspace.search({ path: join(spelling, "drafts"), query: "draft" })).results[0].path).toBe(note);
      };
      // Only aliases selected by the user are grant roots.
      await expect(workspace.read({ path: join(alias, note) })).rejects.toThrow("inside the authorized workspace");
      const grant = await grants.grant("bot", alias);
      workspace = new LocalWorkspace(root, confirm, undefined, { scopedFolder: new GrantedFolderIO(grants, "bot", grant) });
      await check(alias);
      if (root.toUpperCase() !== root && existsSync(root.toUpperCase())) await check(root.toUpperCase());
      const result = JSON.parse(await workspace.write({ path: join(alias, "new.txt"), content: "new" }));
      expect(result.path).toBe("new.txt");
      expect(confirm.mock.calls.at(-1)?.[0].paths).toEqual([join(root, "new.txt")]);
      await expect(workspace.read({ path: dirname(root) })).rejects.toThrow("inside the authorized workspace");
      confirm.mockImplementationOnce(() => {
        unlinkSync(alias);
        symlinkSync(dirname(root), alias, process.platform === "win32" ? "junction" : "dir");
        return true;
      });
      await expect(workspace.write({ path: join(alias, "stale.txt"), content: "stale" })).rejects.toThrow();
      expect(existsSync(join(root, "stale.txt"))).toBe(false);
    } finally { unlinkSync(alias); }
  });

  it("publishes the approved edit, records its diff, and moves files and directories between parents", async () => {
    await workspace.mkdir({ path: "archive" });
    linkSync(join(root, note), join(root, "earlier.txt"));
    expect(JSON.parse(await workspace.edit(edit))).toMatchObject({ status: "ok", revision: textRevision("final") });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ operation: "edit", diff: expect.stringContaining("+final") }));
    expect(fileChanged).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: "edit", path: note }));
    expect(readFileSync(join(root, "earlier.txt"), "utf8")).toBe("draft");
    await workspace.move({ source: note, destination: join("archive", "final.txt") });
    await workspace.move({ source: "drafts", destination: join("archive", "empty") });
    expect(readFileSync(join(root, "archive", "final.txt"), "utf8")).toBe("final");
    expect(readdirSync(join(root, "archive", "empty"))).toEqual([]);
    const events = readFileSync(auditLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map(({ operation, status }) => [operation, status])).toEqual([
      ["mkdir", "success"], ["edit", "success"], ["move", "success"], ["move", "success"],
    ]);
  });

  it("preserves a destination that appeared while a move was awaiting approval", async () => {
    const destination = join(root, "latest.txt");
    confirm.mockImplementation(() => { writeFileSync(destination, "newer"); return true; });
    await expect(workspace.move({ source: note, destination: "latest.txt" })).rejects.toThrow();
    expect(readFileSync(destination, "utf8")).toBe("newer");
    expect(readFileSync(join(root, note), "utf8")).toBe("draft");
  });

  it("shows and records the physical endpoints of in-folder aliases", async () => {
    symlinkSync(join(root, "drafts"), join(root, "latest"), process.platform === "win32" ? "junction" : "dir");
    const alias = join("latest", "note.txt");
    const physical = join(root, note);
    await workspace.write({ path: alias, content: "draft" });
    await workspace.edit({ ...edit, path: alias });
    await workspace.mkdir({ path: join("latest", "old") });
    await workspace.move({ source: alias, destination: join("latest", "old", "archived.txt") });
    const archive = join("drafts", "old");
    const endpoints = [[note], [note], [archive], [note, join(archive, "archived.txt")]];
    expect(confirm.mock.calls.map(([action]) => action.paths)).toEqual(endpoints.map((paths) => paths.map((p) => join(root, p))));
    expect(confirm.mock.calls[1]![0].diff).toContain(physical);
    expect(fileChanged.mock.calls.map(([change]) => change.path)).toEqual([note, note]);
    const events = readFileSync(auditLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.paths)).toEqual(endpoints);
  });

  it("releases handles after denial and leaves all three mutations unapplied", async () => {
    confirm.mockReturnValue(false);
    for (const result of [
      await workspace.mkdir({ path: "archive" }),
      await workspace.edit(edit),
      await workspace.move({ source: note, destination: "final.txt" }),
    ]) expect(JSON.parse(result).status).toBe("denied");
    expect(fileChanged).not.toHaveBeenCalled();
    expect(existsSync(join(root, "archive"))).toBe(false);
    expect(existsSync(join(root, "final.txt"))).toBe(false);
    expect(readFileSync(join(root, note), "utf8")).toBe("draft");
    renameSync(join(root, "drafts"), join(root, "released"));
  });

  it("preserves a newer revision saved while the edit preview is open", async () => {
    confirm.mockImplementation(() => { writeFileSync(join(root, note), "newer"); return true; });
    await expect(workspace.edit(edit)).rejects.toThrow(/changed/i);
    expect(readFileSync(join(root, note), "utf8")).toBe("newer");
    expect(fileChanged).not.toHaveBeenCalled();
  });

  it.each(["mkdir", "edit", "move"] as const)("abandons %s if the grant is revoked before commit", async (operation) => {
    confirm.mockImplementation(() => { grants.revoke("bot"); return true; });
    const result = operation === "mkdir" ? workspace.mkdir({ path: "new" })
      : operation === "edit" ? workspace.edit(edit) : workspace.move({ source: note, destination: "new" });
    await expect(result).rejects.toThrow(/access.*changed/i);
    expect(confirm).toHaveBeenCalledOnce();
    expect(existsSync(join(root, "new"))).toBe(false);
    expect(readFileSync(join(root, note), "utf8")).toBe("draft");
    expect(fileChanged).not.toHaveBeenCalled();
  });

  // Windows holds the parent directory open without allowing a rename.
  it.skipIf(process.platform === "win32").each(["mkdir", "edit", "move-source", "move-destination"])(
    "rejects a replaced parent during %s approval", async (operation) => {
      const parent = join(root, "drafts");
      writeFileSync(join(root, "other.txt"), "other");
      confirm.mockImplementation(() => {
        renameSync(parent, join(root, "archived"));
        mkdirSync(parent);
        return true;
      });
      const child = join("drafts", "new");
      const result = operation === "mkdir" ? workspace.mkdir({ path: child })
        : operation === "edit" ? workspace.edit(edit)
        : operation === "move-source" ? workspace.move({ source: note, destination: "saved" })
        : workspace.move({ source: "other.txt", destination: child });
      await expect(result).rejects.toThrow();
      expect(confirm).toHaveBeenCalledOnce();
      expect(readdirSync(parent)).toEqual([]);
      expect(readFileSync(join(root, "archived", "note.txt"), "utf8")).toBe("draft");
    },
  );
});
