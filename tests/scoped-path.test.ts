import { lstatSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { folderPathResolver } from "../src/gui/scoped-path";
import { folderIdentityExecutable } from "../src/gui/folder-grants";
import { tempHome } from "./helpers";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});

it("rejects an unapproved absolute root before looking up its entries, including through an in-folder link", () => {
  const home = tempHome();
  try {
    const parent = realpathSync.native(home.path);
    const root = join(parent, "allowed");
    const outside = join(parent, "other");
    mkdirSync(root);
    mkdirSync(outside);
    const alias = join(root, "alias");
    symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
    const resolvePath = folderPathResolver(root, { path: root, identity: "test", version: "1" }, folderIdentityExecutable());
    vi.mocked(lstatSync).mockClear();
    expect(() => resolvePath(join(outside, "note"))).toThrow("inside the authorized workspace");
    if (process.platform === "win32") {
      expect(() => resolvePath(String.raw`\\unused.invalid\share\note`)).toThrow("inside the authorized workspace");
    }
    expect(lstatSync).not.toHaveBeenCalled();
    expect(() => resolvePath(join("alias", "note"))).toThrow("inside the authorized workspace");
    expect(vi.mocked(lstatSync).mock.calls.map(([path]) => path)).toEqual([alias]);
  } finally { home.cleanup(); }
});
