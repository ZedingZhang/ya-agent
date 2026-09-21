import {
  keychainAccount,
  keychainService,
  loadApiKey as loadNativeApiKey,
  macosKeychainAvailable as nativeMacosKeychainAvailable,
  saveApiKey as saveNativeApiKey,
} from "ya-core";

export const KEYCHAIN_SERVICE = keychainService();
export const KEYCHAIN_ACCOUNT = keychainAccount();

/**
 * macOS Keychain is reachable only on darwin with the `security` executable.
 * `platform` and `securityPath` stay injectable so the rule is testable
 * everywhere; the implementation lives in the Rust core.
 */
export function macosKeychainAvailable(
  platform: NodeJS.Platform = process.platform,
  securityPath = "/usr/bin/security",
): boolean {
  return nativeMacosKeychainAvailable(platform, securityPath);
}

/** `platform` and `securityPath` stay injectable for tests. */
export function saveApiKey(
  apiKey: string,
  platform?: NodeJS.Platform,
  securityPath?: string,
): void {
  saveNativeApiKey(apiKey, platform, securityPath);
}

/** The environment variable wins on every platform; Keychain is the macOS fallback. */
export function loadApiKey(): string | undefined {
  return loadNativeApiKey() ?? undefined;
}
