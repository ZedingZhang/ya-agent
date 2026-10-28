import type { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { vi } from "vitest";

function isSpace(character: string): boolean {
  return character === " " || character === "\f" || character === "\n"
    || character === "\r" || character === "\t" || character === "\v";
}

/** Apple's `security -i` split_line: quotes, backslash escapes, and whitespace. */
export function splitSecurityLine(line: string): string[] {
  const args: string[] = [];
  let state: "skip" | "read" | "read-esc" | "quoted" | "quoted-esc" = "skip";
  let quote = "";
  let current = "";
  const finish = () => {
    args.push(current);
    current = "";
    state = "skip";
  };
  for (const character of line) {
    if (state === "skip") {
      if (isSpace(character)) continue;
      if (character === "\"" || character === "'") {
        quote = character;
        state = "quoted";
        current = "";
        continue;
      }
      state = "read";
      current = "";
    }
    if (state === "read") {
      if (character === "\\") {
        state = "read-esc";
        continue;
      }
      if (isSpace(character)) {
        finish();
        continue;
      }
      current += character;
      continue;
    }
    if (state === "quoted") {
      if (character === "\\") {
        state = "quoted-esc";
        continue;
      }
      if (character === quote) {
        finish();
        continue;
      }
      current += character;
      continue;
    }
    current += character;
    state = state === "read-esc" ? "read" : "quoted";
  }
  if (state !== "skip") args.push(current);
  return args;
}

function inputText(options: unknown): string | undefined {
  if (typeof options !== "object" || options === null || !("input" in options)) return undefined;
  const input = (options as { input?: unknown }).input;
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array) return Buffer.from(input).toString("utf8");
  return undefined;
}

/** Argv actually executed, or the command read from stdin for `security -i`. */
export function securityInvocation(args: readonly string[] | null | undefined, options?: unknown): string[] {
  if (args?.[0] !== "-i") return [...(args ?? [])];
  const text = inputText(options);
  if (text === undefined) throw new Error("Unexpected synthetic Keychain command");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.includes("\n")) throw new Error("Unexpected synthetic Keychain command");
  return splitSecurityLine(line);
}

/** Keep account/UI unit tests away from the developer's real Keychain. */
export function mockKeychain(original: typeof execFileSync): typeof execFileSync {
  const entries = new Map<string, string>();
  return vi.fn(((...arguments_: Parameters<typeof execFileSync>) => {
    const [file, args] = arguments_;
    if (file === "/usr/bin/shlock") {
      const path = args?.[args.indexOf("-f") + 1];
      if (!path || existsSync(path)) throw Object.assign(new Error("Synthetic lock busy"), { status: 1 });
      writeFileSync(path, `${args?.[args.indexOf("-p") + 1]}\n`, { flag: "wx" });
      return "";
    }
    if (file !== "/usr/bin/security") return original(...arguments_);
    const command = securityInvocation(args, arguments_[2]);
    const service = command[command.indexOf("-s") + 1];
    const account = command[command.indexOf("-a") + 1];
    if (!service || !account) throw new Error("Unexpected synthetic Keychain command");
    const id = `${service}\0${account}`;
    if (command[0] === "add-generic-password") {
      const passwordIndex = command.indexOf("-w");
      const password = command[passwordIndex + 1];
      if (passwordIndex < 0 || password === undefined) throw new Error("Unexpected synthetic Keychain command");
      entries.set(id, password);
      return "";
    }
    if (!entries.has(id)) throw Object.assign(new Error("Synthetic item not found"), { status: 44 });
    if (command[0] === "find-generic-password") return `${entries.get(id)}\n`;
    if (command[0] === "delete-generic-password") { entries.delete(id); return ""; }
    throw new Error("Unexpected synthetic Keychain command");
  }) as typeof execFileSync);
}
