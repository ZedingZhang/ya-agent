import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

import { loadApiKey, macosKeychainAvailable, saveApiKey } from "../src/keychain";

describe("API key storage", () => {
  let previousApiKey: string | undefined;

  beforeEach(() => {
    previousApiKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    mocks.existsSync.mockReset();
    mocks.existsSync.mockReturnValue(false);
    mocks.execFileSync.mockReset();
  });

  afterEach(() => {
    if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousApiKey;
    vi.restoreAllMocks();
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
  });

  it("explains the portable environment-variable fallback", () => {
    expect(() => saveApiKey("test-key")).toThrow(/DEEPSEEK_API_KEY/u);
  });

  it("rejects an empty API key before accessing Keychain", () => {
    expect(() => saveApiKey("  ")).toThrow(/cannot be empty/u);
  });

  it("never exposes the API key when the security command fails", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocks.existsSync.mockReturnValue(true);
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("Command failed with secret test-key");
    });
    let message = "";
    try {
      saveApiKey("  test-key  ");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("Could not save the API key to macOS Keychain.");
    expect(message).not.toContain("test-key");
  });
});
