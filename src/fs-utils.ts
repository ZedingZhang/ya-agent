import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AtomicWriteOptions {
  mode?: number;
  flag?: string;
  suffix?: string;
  ensureDir?: boolean;
  dirMode?: number;
  write?: (tempPath: string, content: string | Buffer) => void;
}

/** Expands a leading `~` or `~/`/`~\` prefix using the current user's home directory. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Atomically writes `content` to `targetPath` via a sibling temporary file and rename,
 * removing the temporary file if writing or renaming fails.
 */
export function atomicWriteFileSync(
  targetPath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  if (options.ensureDir !== false) {
    mkdirSync(dirname(targetPath), {
      recursive: true,
      ...(options.dirMode !== undefined ? { mode: options.dirMode } : {}),
    });
  }
  const temporary = `${targetPath}.${process.pid}.${randomUUID()}.${options.suffix ?? "tmp"}`;
  try {
    if (options.write) {
      options.write(temporary, content);
    } else {
      writeFileSync(temporary, content, {
        ...(typeof content === "string" ? { encoding: "utf8" } : {}),
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        flag: options.flag ?? "wx",
      });
    }
    renameSync(temporary, targetPath);
  } finally {
    rmSync(temporary, { force: true });
  }
}
