import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { atomicWriteFileSync, expandHome } from "../src/fs-utils";
import { errorMessage, isRecord } from "../src/guards";
import { tempHome, type TempHome } from "./helpers";

describe("shared guards and fs-utils", () => {
  let home: TempHome;

  beforeEach(() => { home = tempHome("ya-utils-"); });
  afterEach(() => home.cleanup());

  it("identifies plain object records and excludes primitives and arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });

  it("extracts messages from Error instances and arbitrary thrown values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(404)).toBe("404");
  });

  it("expands tilde prefixes relative to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/notes.txt")).toBe(join(homedir(), "notes.txt"));
    expect(expandHome("~\\notes.txt")).toBe(join(homedir(), "notes.txt"));
    expect(expandHome("/tmp/notes.txt")).toBe("/tmp/notes.txt");
    expect(expandHome("~other/notes.txt")).toBe("~other/notes.txt");
  });

  it("writes files atomically and cleans up temporary files on failure", () => {
    const target = join(home.path, "nested", "state.json");
    atomicWriteFileSync(target, '{"ok":true}\n');
    expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');
    expect(readdirSync(join(home.path, "nested"))).toEqual(["state.json"]);

    expect(() => atomicWriteFileSync(target, "new", {
      ensureDir: false,
      write: (tempPath) => {
        writeFileSync(tempPath, "partial", "utf8");
        throw new Error("Simulated write failure");
      },
    })).toThrow("Simulated write failure");

    expect(readFileSync(target, "utf8")).toBe('{"ok":true}\n');
    expect(readdirSync(join(home.path, "nested"))).toEqual(["state.json"]);
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });
});
