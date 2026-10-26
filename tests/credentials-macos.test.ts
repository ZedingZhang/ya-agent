import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logoutDeepSeek } from "../src/account";
import { ModelConfig } from "../src/config";
import { accountCredentialPath, clearAccountCredential, DEEPSEEK_PLATFORM, loadAccountCredential, saveAccountCredential } from "../src/credentials";
import { DeepSeekClient } from "../src/deepseek";
import { KEYCHAIN_SERVICE } from "../src/keychain";
import { tempHome, type TempHome } from "./helpers";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { mockKeychain } = await import("./keychain-fixture");
  return { ...actual, execFileSync: mockKeychain(actual.execFileSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const nativePlatform = process.platform;
const security = vi.mocked(execFileSync);
const missing = () => { throw Object.assign(new Error("Synthetic missing item"), { status: 44 }); };

describe("macOS account Keychain storage", () => {
  let home: TempHome;
  beforeEach(() => {
    home = tempHome();
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    security.mockClear();
  });
  afterEach(() => {
    security.mockReset();
    vi.mocked(readFileSync).mockRestore();
    clearAccountCredential();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    home.cleanup();
  });

  const passwordCalls = () => security.mock.calls.filter(([file]) => file === "/usr/bin/security");
  function passwordResponses(...responses: Array<typeof execFileSync>) {
    const original = security.getMockImplementation()!;
    security.mockImplementation((...args: Parameters<typeof execFileSync>) => {
      const response = args[0] === "/usr/bin/security" ? responses.shift() : undefined;
      return (response ?? original)(...args);
    });
  }

  function legacy(token = "legacy-synthetic-token") {
    const record = JSON.stringify({ version: 1, issuer: DEEPSEEK_PLATFORM, token });
    mkdirSync(dirname(accountCredentialPath()), { recursive: true });
    writeFileSync(accountCredentialPath(), record);
    return record;
  }

  it("persists a new grant without a plaintext credential file, separately from API keys", () => {
    saveAccountCredential({ kind: "account", token: "synthetic-new-token" });
    expect(loadAccountCredential()).toEqual({ kind: "account", token: "synthetic-new-token" });
    expect(existsSync(accountCredentialPath())).toBe(false);
    expect(security).toHaveBeenCalled();
    for (const [file, args] of passwordCalls()) {
      expect(file).toBe("/usr/bin/security");
      expect(args?.[args.indexOf("-s") + 1]).not.toBe(KEYCHAIN_SERVICE);
    }
  });

  it("isolates Keychain entries for different YA_HOME directories", () => {
    saveAccountCredential({ kind: "account", token: "first-home-token" });
    vi.stubEnv("YA_HOME", join(home.path, "other-home"));
    expect(loadAccountCredential()).toBeUndefined();
    saveAccountCredential({ kind: "account", token: "other-home-token" });
    expect(loadAccountCredential()?.token).toBe("other-home-token");
    clearAccountCredential();
    vi.unstubAllEnvs();
    expect(loadAccountCredential()?.token).toBe("first-home-token");
  });

  it("migrates an existing file only after persisting and verifying the Keychain grant", () => {
    legacy();
    expect(loadAccountCredential()).toEqual({ kind: "account", token: "legacy-synthetic-token" });
    expect(existsSync(accountCredentialPath())).toBe(false);
    expect(passwordCalls().map(([, args]) => args?.[0])).toEqual([
      "find-generic-password", "add-generic-password", "find-generic-password",
    ]);
    expect(loadAccountCredential()?.token).toBe("legacy-synthetic-token");
  });

  it("keeps the Keychain grant authoritative and removes a stale plaintext record", () => {
    saveAccountCredential({ kind: "account", token: "current-token" });
    legacy("old-token");
    expect(loadAccountCredential()?.token).toBe("current-token");
    expect(existsSync(accountCredentialPath())).toBe(false);
    clearAccountCredential();
    expect(loadAccountCredential()).toBeUndefined();
  });

  it("retains the legacy grant and sanitizes errors when migration cannot save", () => {
    const record = legacy();
    passwordResponses(missing, () => { throw new Error("argv includes legacy-synthetic-token"); });
    expect(() => loadAccountCredential()).toThrow(/Keychain/u);
    expect(readFileSync(accountCredentialPath(), "utf8")).toBe(record);
    expect(() => {
      passwordResponses(missing, () => { throw new Error("argv includes legacy-synthetic-token"); });
      loadAccountCredential();
    }).not.toThrow(/legacy-synthetic-token/u);
  });

  it.each(["read fails", "read differs"])("retains the legacy file when migration verification %s", (failure) => {
    const record = legacy();
    const original = security.getMockImplementation()!;
    passwordResponses(missing, original, failure === "read fails"
      ? () => { throw Object.assign(new Error("Denied private-value"), { status: 36 }); }
      : () => "different-token\n");
    expect(() => loadAccountCredential()).toThrow(/Keychain/u);
    expect(readFileSync(accountCredentialPath(), "utf8")).toBe(record);
  });

  it("surfaces Keychain read failures instead of falling back to plaintext", () => {
    const record = legacy();
    passwordResponses(() => { throw Object.assign(new Error("Denied private-value"), { status: 36 }); });
    expect(() => loadAccountCredential()).toThrow(/Keychain/u);
    expect(readFileSync(accountCredentialPath(), "utf8")).toBe(record);
    expect(passwordCalls()).toHaveLength(1);
  });

  it("does not write plaintext if a new Keychain save fails", () => {
    passwordResponses(() => { throw new Error("argv includes synthetic-new-token"); });
    expect(() => saveAccountCredential({ kind: "account", token: "synthetic-new-token" })).toThrow(/Keychain/u);
    expect(existsSync(accountCredentialPath())).toBe(false);
  });

  it("leaves the existing API-key entry untouched through account save, migration and logout", () => {
    const apiArgs = ["-s", KEYCHAIN_SERVICE, "-a", "default"];
    execFileSync("/usr/bin/security", ["add-generic-password", ...apiArgs, "-w", "synthetic-api-key"], { encoding: "utf8" });
    legacy();
    loadAccountCredential();
    saveAccountCredential({ kind: "account", token: "replacement-token" });
    clearAccountCredential();
    expect(execFileSync("/usr/bin/security", ["find-generic-password", ...apiArgs, "-w"], { encoding: "utf8" })).toBe("synthetic-api-key\n");
  });

  it("retains both backends if Keychain removal fails", () => {
    saveAccountCredential({ kind: "account", token: "current-token" });
    const record = legacy();
    passwordResponses(() => { throw new Error("Denied private-value"); });
    expect(() => clearAccountCredential()).toThrow(/Keychain/u);
    expect(readFileSync(accountCredentialPath(), "utf8")).toBe(record);
    expect(loadAccountCredential()?.token).toBe("current-token");
  });

  it("rejects a corrupt Keychain grant without exposing it and allows sign-out recovery", () => {
    saveAccountCredential({ kind: "account", token: "valid-token" });
    passwordResponses(() => "private-value with whitespace\n");
    expect(() => loadAccountCredential()).toThrow("Invalid DeepSeek account credential in Keychain");
    clearAccountCredential();
    expect(loadAccountCredential()).toBeUndefined();
  });

  it.each(["", "line\nbreak", "with space", "nul\0byte"])("rejects invalid grants before accessing Keychain (%j)", (token) => {
    expect(() => saveAccountCredential({ kind: "account", token })).toThrow("Invalid DeepSeek account credential");
    expect(security).not.toHaveBeenCalled();
    expect(existsSync(accountCredentialPath())).toBe(false);
  });

  it.each(["{bad-json", '{"version":1,"issuer":"https://wrong.example","token":"private-value"}'])(
    "rejects a corrupt legacy record without exposing it (%s)", (value) => {
      legacy();
      writeFileSync(accountCredentialPath(), value);
      expect(() => loadAccountCredential()).toThrow(/Run: ya logout deepseek/u);
      expect(() => loadAccountCredential()).not.toThrow(/private-value/u);
      clearAccountCredential();
      expect(loadAccountCredential()).toBeUndefined();
    },
  );

  it("does not clear a replacement grant after a stale 401", async () => {
    saveAccountCredential({ kind: "account", token: "replacement-token" });
    await expect(new DeepSeekClient({ kind: "account", token: "old-token" }, async () => new Response("", { status: 401 }))
      .complete([], new ModelConfig(), 100)).rejects.toThrow("Sign in again");
    expect(loadAccountCredential()?.token).toBe("replacement-token");
    clearAccountCredential("replacement-token");
    expect(loadAccountCredential()).toBeUndefined();
  });

  it.each(["save", "logout", "401 cleanup"])("serializes migration against a competing %s", (action) => {
    legacy();
    const compete = () => action === "save"
      ? saveAccountCredential({ kind: "account", token: "replacement-token" })
      : clearAccountCredential(action === "401 cleanup" ? "legacy-synthetic-token" : undefined);
    const read = vi.mocked(readFileSync).getMockImplementation()!;
    let blocked = false;
    vi.mocked(readFileSync).mockImplementationOnce(((...args: Parameters<typeof readFileSync>) => {
      const snapshot = read(...args);
      try { compete(); } catch (error) {
        expect(String(error)).toMatch(/storage.*busy/iu);
        blocked = true;
      }
      return snapshot;
    }) as typeof readFileSync);
    loadAccountCredential();
    expect(blocked).toBe(true);
    compete();
    expect(loadAccountCredential()?.token).toBe(action === "save" ? "replacement-token" : undefined);
    expect(existsSync(join(home.path, "auth", "account.lock"))).toBe(false);
  });

  it("holds the same lock across a conditional 401 read and deletion", () => {
    saveAccountCredential({ kind: "account", token: "rejected-token" });
    const original = security.getMockImplementation()!;
    let blocked = false;
    passwordResponses(((...args: Parameters<typeof execFileSync>) => {
      const snapshot = original(...args);
      try { saveAccountCredential({ kind: "account", token: "replacement-token" }); }
      catch (error) {
        expect(String(error)).toMatch(/storage.*busy/iu);
        blocked = true;
      }
      return snapshot;
    }) as typeof execFileSync);
    clearAccountCredential("rejected-token");
    expect(blocked).toBe(true);
    saveAccountCredential({ kind: "account", token: "replacement-token" });
    clearAccountCredential("rejected-token");
    expect(loadAccountCredential()?.token).toBe("replacement-token");
  });

  it("logs out and removes the same Keychain grant before remote revocation", async () => {
    saveAccountCredential({ kind: "account", token: "logout-token" });
    await expect(logoutDeepSeek(async (_url, init) => {
      expect(loadAccountCredential()).toBeUndefined();
      expect(init?.headers).toMatchObject({ "x-dsh-auth-token": "logout-token" });
      throw new Error("Remote unavailable");
    })).resolves.toBe(false);
    expect(loadAccountCredential()).toBeUndefined();
    expect(existsSync(accountCredentialPath())).toBe(false);
  });

  it.runIf(nativePlatform === "darwin")("round-trips only a synthetic, isolated account through the real macOS Keychain", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    security.mockImplementation(actual.execFileSync);
    try {
      saveAccountCredential({ kind: "account", token: "synthetic-native-keychain-token" });
      expect(loadAccountCredential()?.token).toBe("synthetic-native-keychain-token");
      expect(existsSync(accountCredentialPath())).toBe(false);
      clearAccountCredential("stale-token");
      expect(loadAccountCredential()?.token).toBe("synthetic-native-keychain-token");
      clearAccountCredential();
      expect(loadAccountCredential()).toBeUndefined();
    } finally {
      clearAccountCredential();
      security.mockReset();
    }
  });

  it.runIf(nativePlatform === "darwin")("blocks a real competing process and recovers its exited PID lock", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    security.mockImplementation(actual.execFileSync);
    const record = legacy();
    const lock = join(home.path, "auth", "account.lock");
    const holder = spawn(process.execPath, ["-e", `
      require("node:child_process").execFileSync("/usr/bin/shlock", ["-f", process.argv[1], "-p", String(process.pid)], {stdio: "ignore"});
      process.stdout.write("locked"); setTimeout(() => {}, 15000);
    `, lock], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    try {
      try {
        await once(holder, "spawn");
        await Promise.race([
          once(holder.stdout!, "data"),
          once(holder, "exit").then(() => { throw new Error("Lock holder exited before acquisition"); }),
        ]);
        expect(() => loadAccountCredential()).toThrow(/storage.*busy/iu);
        expect(readFileSync(accountCredentialPath(), "utf8")).toBe(record);
      } finally {
        if (holder.exitCode === null && holder.signalCode === null) {
          const exited = once(holder, "exit");
          holder.kill();
          await exited;
        }
        // shlock protects recently created locks while their owner starts up.
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      expect(loadAccountCredential()?.token).toBe("legacy-synthetic-token");
      expect(existsSync(accountCredentialPath())).toBe(false);
      expect(existsSync(lock)).toBe(false);
    } finally {
      try { clearAccountCredential(); } finally { security.mockReset(); }
    }
  }, 20_000);
});
