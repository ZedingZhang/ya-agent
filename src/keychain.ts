import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const KEYCHAIN_SERVICE = "Ya DeepSeek API";
export const KEYCHAIN_ACCOUNT = "default";

export function macosKeychainAvailable(
  platform: NodeJS.Platform = process.platform,
  securityPath = "/usr/bin/security",
): boolean {
  return platform === "darwin" && existsSync(securityPath);
}

export function saveApiKey(apiKey: string): void {
  const value = apiKey.trim();
  if (!value) throw new Error("API key cannot be empty.");
  if (!macosKeychainAvailable()) {
    throw new Error("ya auth deepseek is available only on macOS. Set DEEPSEEK_API_KEY instead.");
  }
  try {
    execFileSync(
      "/usr/bin/security",
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    // Child-process errors can include the full argv. Never surface the key.
    throw new Error("Could not save the API key to macOS Keychain.");
  }
}

export function loadApiKey(): string | undefined {
  const environmentKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (environmentKey) return environmentKey;
  if (!macosKeychainAvailable()) return undefined;
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim() || undefined;
  } catch {
    return undefined;
  }
}
