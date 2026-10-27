import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const pause = new Int32Array(new SharedArrayBuffer(4));

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function ownerExited(path: string): boolean {
  try {
    const identity = lstatSync(path);
    const content = readFileSync(path, "utf8");
    let exited = false;
    try {
      const owner = JSON.parse(content) as { pid?: unknown };
      if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (error) { if (code(error) === "ESRCH") exited = true; }
      } else exited = Date.now() - identity.mtimeMs > 30_000;
    } catch { exited = Date.now() - identity.mtimeMs > 30_000; }
    return exited;
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
    return false;
  }
}

function recoverExitedOwner(path: string): void {
  if (!ownerExited(path)) return;
  // Serialize reapers and re-read the owner under that lock: an earlier reaper
  // may already have removed the dead lock and a live writer may now own it.
  // If a reaper itself exited, the same protocol recovers its guard recursively.
  withMemoryLock(`${path}.recovery`, () => {
    if (ownerExited(path)) unlinkSync(path);
  });
}

/** Memory APIs are synchronous; wait without allowing another local mutation to enter. */
export function withMemoryLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  const staging = `${path}.${process.pid}.${randomUUID()}.owner`;
  const descriptor = openSync(staging, "wx", 0o600);
  try { writeFileSync(descriptor, owner); fsyncSync(descriptor); }
  catch (error) { closeSync(descriptor); unlinkSync(staging); throw error; }
  closeSync(descriptor);
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      // Publish a fully written owner atomically. A process that exits before
      // publication cannot leave an empty lock with no identifiable owner.
      try { linkSync(staging, path); }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        recoverExitedOwner(path);
        if (Date.now() >= deadline) throw new Error("Memory storage is busy. Retry after the other memory operation finishes.");
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      break;
    }
    try { return operation(); }
    finally {
      if (readFileSync(path, "utf8") !== owner) throw new Error("Memory lock ownership changed.");
      unlinkSync(path);
    }
  } finally { unlinkSync(staging); }
}
