import { dirname, join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountCredentialPath, clearAccountCredential, loadAccountCredential, saveAccountCredential } from "../src/credentials";
import { LocalWorkspace } from "../src/local";
import { tempHome, type TempHome } from "./helpers";

describe("DeepSeek account credential storage", () => {
  let home: TempHome;
  beforeEach(() => { home = tempHome(); });
  afterEach(() => home.cleanup());

  it("atomically persists an issuer-bound grant outside general configuration", () => {
    expect(loadAccountCredential()).toBeUndefined();
    saveAccountCredential({ kind: "account", token: "first-token" });
    saveAccountCredential({ kind: "account", token: "replacement-token" });
    expect(loadAccountCredential()).toEqual({ kind: "account", token: "replacement-token" });
    expect(readdirSync(dirname(accountCredentialPath()))).toEqual(["credentials.json"]);
    expect(existsSync(join(home.path, "config.json"))).toBe(false);
    expect(readFileSync(accountCredentialPath(), "utf8")).toContain('"issuer":"https://platform.deepseek.com"');
    if (process.platform !== "win32") {
      expect(statSync(accountCredentialPath()).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(accountCredentialPath())).mode & 0o777).toBe(0o700);
    }
  });

  it("does not clear a newer credential when an older request is rejected", () => {
    saveAccountCredential({ kind: "account", token: "new-token" });
    clearAccountCredential("old-token");
    expect(loadAccountCredential()?.token).toBe("new-token");
    clearAccountCredential("new-token");
    expect(loadAccountCredential()).toBeUndefined();
  });

  it.each([
    '{"token":"private-token"',
    '{"version":1,"issuer":"https://attacker.example","token":"private-token"}',
    '{"version":1,"issuer":"https://platform.deepseek.com","token":"line\\nbreak"}',
  ])("rejects corrupt or foreign grants without including their contents in errors", (value) => {
    saveAccountCredential({ kind: "account", token: "valid" });
    writeFileSync(accountCredentialPath(), value);
    expect(() => loadAccountCredential()).toThrow(/Run: ya logout deepseek/u);
    try { loadAccountCredential(); } catch (error) { expect(String(error)).not.toContain("private-token"); }
    clearAccountCredential();
    expect(loadAccountCredential()).toBeUndefined();
  });

  it("keeps stored account tokens out of local model reads and search", () => {
    saveAccountCredential({ kind: "account", token: "private-account-token" });
    const workspace = new LocalWorkspace(home.path, () => false);
    expect(() => workspace.read({ path: "auth/credentials.json" })).toThrow(/sensitive/u);
    expect(JSON.parse(workspace.search({ query: "private-account-token" })).results).toEqual([]);
  });
});
