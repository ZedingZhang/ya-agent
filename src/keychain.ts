import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export const KEYCHAIN_SERVICE = "Ya DeepSeek API";
export const KEYCHAIN_ACCOUNT = "default";

// security's interactive readline stores at most 4095 bytes (MAX_LINE_LEN - 1).
// A 4095-byte line leaves the terminating newline unread, and that empty
// command can replace a failing exit status. 4094 leaves room for the newline.
const MAX_SECURITY_INTERACTIVE_LINE = 4094;
const INTERACTIVE_LINE_BREAK = "Keychain values cannot contain line breaks or null bytes.";
const INTERACTIVE_LINE_TOO_LONG = "Keychain value is too long to store with macOS security.";

export function macosKeychainAvailable(
  platform: NodeJS.Platform = process.platform,
  securityPath = "/usr/bin/security",
): boolean {
  return platform === "darwin" && existsSync(securityPath);
}

function quoteSecurityArgument(value: string): string {
  return `"${value.replace(/[\\"]/gu, (character) => `\\${character}`)}"`;
}

function securityInteractiveLine(argv: readonly string[]): string {
  // A newline would start a second command. A NUL would truncate the C string.
  if (argv.some((argument) => /[\0\n]/u.test(argument))) {
    throw new Error(INTERACTIVE_LINE_BREAK);
  }
  const line = argv.map(quoteSecurityArgument).join(" ");
  if (line.length > MAX_SECURITY_INTERACTIVE_LINE) {
    throw new Error(INTERACTIVE_LINE_TOO_LONG);
  }
  return line;
}

/** Run one `security` subcommand with its arguments on stdin, not in argv. */
export function runSecurityInteractive(
  argv: readonly string[],
  securityPath = "/usr/bin/security",
  options: { timeout?: number } = {},
): string {
  // `ps` on macOS shows every local user the argv of /usr/bin/security. -i reads
  // one command from stdin; -q only suppresses the "returned N" stderr line.
  // The process status is still the subcommand's status, including 44.
  return execFileSync(securityPath, ["-i", "-q"], {
    encoding: "utf8",
    input: `${securityInteractiveLine(argv)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeout,
  });
}

export function saveApiKey(
  apiKey: string,
  platform: NodeJS.Platform = process.platform,
  securityPath = "/usr/bin/security",
): void {
  const value = apiKey.trim();
  if (!value) throw new Error("API key cannot be empty.");
  if (!macosKeychainAvailable(platform, securityPath)) {
    throw new Error("ya auth deepseek is available only on macOS. Set DEEPSEEK_API_KEY instead.");
  }
  try {
    runSecurityInteractive(
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value],
      securityPath,
    );
  } catch (error) {
    // Raised before spawn. The text names the limit, not the key.
    if (error instanceof Error
      && (error.message === INTERACTIVE_LINE_BREAK || error.message === INTERACTIVE_LINE_TOO_LONG)) {
      throw error;
    }
    // Never surface the child-process error. It repeats the command invocation.
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
