import type { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { vi } from "vitest";

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
    const service = args?.[args.indexOf("-s") + 1];
    const account = args?.[args.indexOf("-a") + 1];
    if (!service || !account) throw new Error("Unexpected synthetic Keychain command");
    const id = `${service}\0${account}`;
    if (args?.[0] === "add-generic-password") {
      entries.set(id, args[args.indexOf("-w") + 1]!);
      return "";
    }
    if (!entries.has(id)) throw Object.assign(new Error("Synthetic item not found"), { status: 44 });
    if (args?.[0] === "find-generic-password") return `${entries.get(id)}\n`;
    if (args?.[0] === "delete-generic-password") { entries.delete(id); return ""; }
    throw new Error("Unexpected synthetic Keychain command");
  }) as typeof execFileSync);
}
