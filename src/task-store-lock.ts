import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_WAIT_MS = 2000;
const RETRY_INTERVAL_MS = 20;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const OWNER_MARKER = /^owner-([1-9]\d*)-[a-f0-9-]{36}$/u;

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

function isWindowsContention(error: unknown): boolean {
  return process.platform === "win32" && hasCode(error, "EPERM", "EACCES", "EBUSY");
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only an absent process proves its ownership is stale.
    if (hasCode(error, "ESRCH")) return false;
    if (hasCode(error, "EPERM", "EACCES")) return true;
    throw error;
  }
}

function removeOwnerMarker(path: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      unlinkSync(path);
      return;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      if (!isWindowsContention(error) || attempt === 4) throw error;
      Atomics.wait(sleeper, 0, 0, RETRY_INTERVAL_MS);
    }
  }
}

function removeEmptyLock(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    // Windows can report access denied while another writer removes or replaces the directory.
    if (!hasCode(error, "ENOENT", "ENOTEMPTY", "EEXIST") && !isWindowsContention(error)) throw error;
  }
}

function clearAbandonedLock(path: string): void {
  try {
    if (!lstatSync(path).isDirectory()) {
      throw new Error(`Invalid Ya task store lock at "${path}".`);
    }
    const entries = readdirSync(path, { withFileTypes: true });
    if (entries.length === 0) {
      removeEmptyLock(path);
      return;
    }
    const owner = entries[0]!;
    const match = OWNER_MARKER.exec(owner.name);
    const pid = Number(match?.[1]);
    if (entries.length !== 1 || !owner.isFile() || !Number.isInteger(pid) || pid > 0x7fffffff) {
      throw new Error(`Invalid Ya task store lock owner at "${path}".`);
    }
    if (!isProcessAlive(pid)) {
      removeOwnerMarker(join(path, owner.name));
      removeEmptyLock(path);
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !isWindowsContention(error)) throw error;
  }
}

/**
 * Publish a nonempty owner directory atomically. Releasing or reclaiming a
 * lock removes only its unique marker, so another writer's lock stays intact.
 */
export function withTaskStoreLock<T>(file: string, action: () => T): T {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const lock = `${file}.lock`;
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let directory = mkdtempSync(join(parent, ".ya-task-lock-"));
  try {
    writeFileSync(join(directory, owner), "", { flag: "wx", mode: 0o600 });
    const deadline = performance.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        renameSync(directory, lock);
        directory = lock;
        break;
      } catch (error) {
        if (!hasCode(error, "EEXIST", "ENOTEMPTY") && !isWindowsContention(error)) throw error;
        clearAbandonedLock(lock);
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(`Ya task store is busy at "${file}". Retry the operation.`, { cause: error });
        }
        Atomics.wait(sleeper, 0, 0, Math.min(RETRY_INTERVAL_MS, remaining));
      }
    }
    return action();
  } finally {
    removeOwnerMarker(join(directory, owner));
    removeEmptyLock(directory);
  }
}
