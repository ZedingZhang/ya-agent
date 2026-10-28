import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withMemoryLock } from "../src/memory-lock";
import { tempHome, type TempHome } from "./helpers";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync), readFileSync: vi.fn(actual.readFileSync) };
});

describe("memory lock contention", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); vi.clearAllMocks(); });
  afterEach(() => home.cleanup());

  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s while inspecting a lock being deleted", (code) => {
    const path = join(home.path, "memory.json.lock");
    vi.mocked(linkSync).mockImplementationOnce(() => {
      writeFileSync(path, JSON.stringify({ pid: process.pid }));
      throw Object.assign(new Error("Locked"), { code: "EEXIST" });
    });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      unlinkSync(path);
      throw Object.assign(new Error("Deletion pending"), { code });
    });
    const commit = vi.fn(() => "committed");
    expect(withMemoryLock(path, commit)).toBe("committed");
    expect(commit).toHaveBeenCalledTimes(1);
    expect(linkSync).toHaveBeenCalledTimes(2);
    expect(existsSync(path)).toBe(false);
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries a transient %s when publishing the next lock", (code) => {
    const path = join(home.path, "memory.json.lock");
    vi.mocked(linkSync).mockImplementationOnce(() => { throw Object.assign(new Error("Deletion pending"), { code }); });
    expect(withMemoryLock(path, () => "committed")).toBe("committed");
    expect(linkSync).toHaveBeenCalledTimes(2);
    expect(existsSync(path)).toBe(false);
  });
});
