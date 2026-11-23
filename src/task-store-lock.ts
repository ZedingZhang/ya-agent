import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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

/** Reclaim abandoned locks and report whether the contention has a live owner. */
function clearAbandonedLock(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) {
      throw new Error(`Invalid Ya task store lock at "${path}".`);
    }
    const entries = readdirSync(path, { withFileTypes: true });
    if (entries.length === 0) {
      removeEmptyLock(path);
      return false;
    }
    const owner = entries[0]!;
    const match = OWNER_MARKER.exec(owner.name);
    const pid = Number(match?.[1]);
    if (entries.length !== 1 || !owner.isFile() || !Number.isInteger(pid) || pid > 0x7fffffff) {
      throw new Error(`Invalid Ya task store lock owner at "${path}".`);
    }
    if (isProcessAlive(pid)) return true;
    removeOwnerMarker(join(path, owner.name));
    removeEmptyLock(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !isWindowsContention(error)) throw error;
  }
  return false;
}

/**
 * Publish a nonempty owner directory atomically. Releasing or reclaiming a
 * lock removes only its unique marker, so another writer's lock stays intact.
 */
function prepareTaskStoreLock(file: string) {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true });
  const lock = `${file}.lock`;
  const owner = `owner-${process.pid}-${randomUUID()}`;
  let directory = mkdtempSync(join(parent, ".ya-task-lock-"));
  function release(): void {
    removeOwnerMarker(join(directory, owner));
    removeEmptyLock(directory);
  }
  try {
    writeFileSync(join(directory, owner), "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    release();
    throw error;
  }
  // Windows access errors can also mean a permanent permissions failure.
  // Extend the terminal writer's wait only while a live holder is observed.
  let deadline = performance.now() + LOCK_WAIT_MS;
  function tryAcquire(waitForLiveOwner = false): boolean {
    try {
      renameSync(directory, lock);
      directory = lock;
      return true;
    } catch (error) {
      if (!hasCode(error, "EEXIST", "ENOTEMPTY") && !isWindowsContention(error)) throw error;
      const liveOwner = clearAbandonedLock(lock);
      if (waitForLiveOwner && liveOwner) deadline = performance.now() + LOCK_WAIT_MS;
      if (performance.now() >= deadline) {
        throw new Error(`Ya task store is busy at "${file}". Retry the operation.`, { cause: error });
      }
      return false;
    }
  }
  return { tryAcquire, release };
}

export function withTaskStoreLock<T>(file: string, action: () => T): T {
  const lock = prepareTaskStoreLock(file);
  try {
    while (!lock.tryAcquire()) {
      Atomics.wait(sleeper, 0, 0, RETRY_INTERVAL_MS);
    }
    return action();
  } finally {
    lock.release();
  }
}

// A finished execution can wait for persistence without blocking the desktop event loop.
export async function withTaskStoreLockAsync<T>(file: string, action: () => T): Promise<T> {
  const lock = prepareTaskStoreLock(file);
  try {
    while (!lock.tryAcquire(true)) {
      await delay(RETRY_INTERVAL_MS);
    }
    return action();
  } finally {
    lock.release();
  }
}
