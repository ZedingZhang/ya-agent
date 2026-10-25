import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./config";

export const DEEPSEEK_PLATFORM = "https://platform.deepseek.com";
const ACCOUNT_KEYCHAIN_SERVICE = "Ya DeepSeek Platform Account";

export interface AccountCredential {
  kind: "account";
  token: string;
}

/** A platform grant is distinct from an API key and uses a different wire protocol. */
export type DeepSeekCredential = string | AccountCredential;

export function accountCredentialPath(): string {
  // The existing workspace tools block files named credentials.json from model reads and diffs.
  return join(dataHome(), "auth", "credentials.json");
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function accountKeychain(operation: "find" | "add" | "delete", token?: string): string | undefined {
  // Share CLI/GUI logins while keeping different YA_HOME directories isolated.
  const account = createHash("sha256").update(dataHome()).digest("hex");
  const args = [`${operation}-generic-password`, "-s", ACCOUNT_KEYCHAIN_SERVICE, "-a", account];
  if (operation === "find") args.push("-w");
  if (operation === "add") args.push("-U", "-w", token!);
  try {
    const value = execFileSync("/usr/bin/security", args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000,
    });
    return operation === "find" ? value.replace(/\r?\n$/u, "") : undefined;
  } catch (error) {
    // security returns the low byte of errSecItemNotFound (-25300), or 44.
    if (operation !== "add" && (error as { status?: number }).status === 44) return undefined;
    // Child-process errors can contain the full argv and therefore the grant.
    throw new Error("Could not access the DeepSeek account in macOS Keychain. Unlock Keychain and try again; any existing credential file is retained.");
  }
}

function removeCredentialFile(): void {
  try { rmSync(accountCredentialPath(), { force: true }); }
  catch { throw new Error("Could not remove the plaintext DeepSeek account credential file. Run: ya logout deepseek"); }
}

function loadFileCredential(): AccountCredential | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(accountCredentialPath(), "utf8")) as unknown;
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error("Could not read the DeepSeek account credential. Run: ya logout deepseek");
  }
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1
    || !("issuer" in value) || value.issuer !== DEEPSEEK_PLATFORM
    || !("token" in value) || typeof value.token !== "string" || !/^[\x21-\x7e]+$/u.test(value.token)) {
    throw new Error("Invalid DeepSeek account credential. Run: ya logout deepseek");
  }
  return { kind: "account", token: value.token };
}

export function loadAccountCredential(): AccountCredential | undefined {
  if (process.platform !== "darwin") return loadFileCredential();
  const token = accountKeychain("find");
  if (token !== undefined) {
    if (!/^[\x21-\x7e]+$/u.test(token)) throw new Error("Invalid DeepSeek account credential in Keychain. Run: ya logout deepseek");
    removeCredentialFile();
    return { kind: "account", token };
  }
  const legacy = loadFileCredential();
  if (legacy) saveAccountCredential(legacy);
  return legacy;
}

export function saveAccountCredential(credential: AccountCredential): void {
  if (!/^[\x21-\x7e]+$/u.test(credential.token)) throw new Error("Invalid DeepSeek account credential.");
  if (process.platform === "darwin") {
    accountKeychain("add", credential.token);
    if (accountKeychain("find") !== credential.token) {
      throw new Error("Could not verify the DeepSeek account in macOS Keychain. Any existing credential file is retained.");
    }
    removeCredentialFile();
    return;
  }
  const directory = join(dataHome(), "auth");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = accountCredentialPath();
  const temporary = `${path}.${randomUUID()}.token`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: 1, issuer: DEEPSEEK_PLATFORM, token: credential.token })}\n`,
      { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch {
    throw new Error("Could not save the DeepSeek account credential.");
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A failed request from an older login must not remove a replacement credential. */
export function clearAccountCredential(rejectedToken?: string): void {
  if (rejectedToken !== undefined && loadAccountCredential()?.token !== rejectedToken) return;
  if (process.platform === "darwin") accountKeychain("delete");
  removeCredentialFile();
}
