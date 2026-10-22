import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "./config";

export const DEEPSEEK_PLATFORM = "https://platform.deepseek.com";

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

export function loadAccountCredential(): AccountCredential | undefined {
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

export function saveAccountCredential(credential: AccountCredential): void {
  if (!/^[\x21-\x7e]+$/u.test(credential.token)) throw new Error("Invalid DeepSeek account credential.");
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
  rmSync(accountCredentialPath(), { force: true });
}
