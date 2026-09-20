import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  loadApiKey,
  macosKeychainAvailable,
  saveApiKey,
} from "../src/keychain";

describe("API key storage", () => {
  let previousApiKey: string | undefined;
  let scratch: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
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
    expect(loadApiKey()).toBeUndefined();
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
    expect(() => saveApiKey("test-key")).toThrow(/DEEPSEEK_API_KEY/u);
  });

  it("rejects an empty API key before accessing Keychain", () => {
    expect(() => saveApiKey("  ")).toThrow(/cannot be empty/u);
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
});
