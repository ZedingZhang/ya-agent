import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  loadApiKey,
  macosKeychainAvailable,
  runSecurityInteractive,
  saveApiKey,
} from "../src/keychain";
import { splitSecurityLine } from "./keychain-fixture";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockKeychain } = await import("./keychain-fixture");
  return { ...actual, execFileSync: mockKeychain(actual.execFileSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === "/usr/bin/security" || actual.existsSync(path),
  };
});

const security = vi.mocked(execFileSync);

describe("security -i splitting", () => {
  it("matches Apple's split_line quoting", () => {
    expect(splitSecurityLine('"a\\"b\\\\c"')).toEqual(['a"b\\c']);
    expect(splitSecurityLine('"has space"')).toEqual(["has space"]);
    expect(splitSecurityLine("'a b'")).toEqual(["a b"]);
    expect(splitSecurityLine("a\\ b")).toEqual(["a b"]);
    expect(splitSecurityLine('""')).toEqual([""]);
    expect(splitSecurityLine('"add-generic-password" "-w" "a\\"b\\\\c"')).toEqual([
      "add-generic-password", "-w", 'a"b\\c',
    ]);
  });
});

describe("API key storage", () => {
  let previousApiKey: string | undefined;
  let scratch: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    security.mockClear();
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousApiKey;
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("loads the cross-platform environment variable first", () => {
    process.env.DEEPSEEK_API_KEY = "  test-key  ";
    expect(loadApiKey()).toBe("test-key");
  });

  it("returns undefined when neither the environment nor Keychain is available", () => {
    // A developer's Mac may already contain a real key. Make Keychain
    // unavailable explicitly instead of reading the machine's credentials.
    vi.stubGlobal("process", { ...process, platform: "linux" });
    try {
      expect(loadApiKey()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recognizes Keychain only on macOS with the security executable", () => {
    expect(macosKeychainAvailable("linux", "/usr/bin/security")).toBe(false);
    expect(macosKeychainAvailable("darwin", "/missing/security")).toBe(false);
    expect(macosKeychainAvailable("win32", "/usr/bin/security")).toBe(false);
  });

  it("keeps the documented Keychain identity", () => {
    expect(KEYCHAIN_SERVICE).toBe("Ya DeepSeek API");
    expect(KEYCHAIN_ACCOUNT).toBe("default");
  });

  it("explains the portable environment-variable fallback", () => {
    // The platform is explicit: on macOS `/usr/bin/security` really exists, so
    // an implicit platform would take the Keychain branch instead of this one.
    expect(() => saveApiKey("test-key", "linux", "/usr/bin/security")).toThrow(/DEEPSEEK_API_KEY/u);
  });

  it("rejects an empty API key before accessing Keychain", () => {
    expect(() => saveApiKey("  ", "linux", "/usr/bin/security")).toThrow(/cannot be empty/u);
  });

  it("never exposes the API key when the security command fails", () => {
    // A real, non-executable file stands in for /usr/bin/security so the
    // failure path actually runs instead of being mocked away.
    scratch = mkdtempSync(join(tmpdir(), "ya-keychain-"));
    const fakeSecurity = join(scratch, "security");
    writeFileSync(fakeSecurity, "not an executable\n");
    let message = "";
    try {
      saveApiKey("  test-key  ", "darwin", fakeSecurity);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Could not save the API key to macOS Keychain.");
    expect(message).not.toContain("test-key");
  });

  it("round-trips an API key on stdin and keeps it out of security's argv", () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    const secret = "k \"q\" \\ s";
    try {
      saveApiKey(`  ${secret}  `, "darwin", "/usr/bin/security");
      expect(loadApiKey()).toBe(secret);
      const calls = security.mock.calls.filter(([file]) => file === "/usr/bin/security");
      const adds = calls.filter(([, args]) => args?.[0] === "-i");
      expect(adds).toHaveLength(1);
      expect(adds[0]?.[1]).toEqual(["-i", "-q"]);
      expect((adds[0]?.[2] as { input?: string } | undefined)?.input).toBe(
        '"add-generic-password" "-U" "-s" "Ya DeepSeek API" "-a" "default" "-w" "k \\"q\\" \\\\ s"\n',
      );
      for (const [file, args] of calls) {
        expect(`${file}\0${(args ?? []).join("\0")}`).not.toContain(secret);
      }
    } finally {
      try {
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT]);
      } catch { /* The synthetic item may already be gone. */ }
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["line break", "a\nb", "Keychain values cannot contain line breaks or null bytes."],
    ["NUL", "a\0b", "Keychain values cannot contain line breaks or null bytes."],
    ["oversized value", "k".repeat(5000), "Keychain value is too long to store with macOS security."],
  ] as const)("does not spawn security for an API key with a %s", (_label, secret, expected) => {
    let message = "";
    try {
      saveApiKey(secret, "darwin", "/usr/bin/security");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(expected);
    expect(message).not.toContain(secret);
    expect(security).not.toHaveBeenCalled();
  });

  it("fills security's interactive line limit without handing the value a following empty command", () => {
    const spawnedLine = (argument: string): string | undefined => {
      security.mockClear();
      try {
        runSecurityInteractive(["add-generic-password", "-s", "length-probe", "-a", "probe", "-w", argument]);
      } catch {
        return undefined;
      }
      return (security.mock.calls[0]?.[2] as { input?: string } | undefined)?.input;
    };
    const one = spawnedLine("k");
    expect(one?.endsWith("\n")).toBe(true);
    expect(security.mock.calls[0]?.[1]).toEqual(["-i", "-q"]);
    const room = 4094 - (one!.length - 1);
    const full = spawnedLine("k".repeat(1 + room));
    expect(full?.replace(/\n$/u, "").length).toBe(4094);
    expect((security.mock.calls[0]?.[1] ?? []).join("\0")).not.toContain("k".repeat(20));
    expect(spawnedLine("k".repeat(2 + room))).toBeUndefined();
    expect(security).not.toHaveBeenCalled();
    expect(() => runSecurityInteractive(["w", "a\nb"])).toThrow("Keychain values cannot contain line breaks or null bytes.");
    expect(() => runSecurityInteractive(["w", "a\0b"])).toThrow("Keychain values cannot contain line breaks or null bytes.");
    expect(security).not.toHaveBeenCalled();
  });
});
