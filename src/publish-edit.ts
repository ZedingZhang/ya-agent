import { randomUUID } from "node:crypto";
import { closeSync, fchmodSync, fchownSync, fstatSync, fsyncSync, lstatSync, openSync, renameSync, rmSync, writeFileSync, type BigIntStats, type Stats } from "node:fs";
import { dirname, join } from "node:path";

/** Stage next to the original so that publication replaces the whole file atomically. */
export function publishEdit(path: string, content: string, identity: Pick<Stats, "uid" | "gid" | "mode"> | undefined, checkUnchanged: () => void,
  publish: (stage: string, destination: string) => void = renameSync): void {
  const temporary = join(dirname(path), `.ya-edit-${randomUUID()}.tmp`);
  let descriptor: number | undefined = openSync(temporary, "wx", identity ? 0o600 : 0o666);
  let staged: BigIntStats | undefined;
  let published = false;
  const closeStage = (): void => {
    if (descriptor === undefined) return;
    closeSync(descriptor);
    descriptor = undefined;
  };
  const isStagedEntry = (): boolean => {
    if (!staged) return false;
    const entry = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
    return Boolean(entry?.isFile() && entry.dev === staged.dev && entry.ino === staged.ino);
  };
  try {
    staged = fstatSync(descriptor, { bigint: true });
    writeFileSync(descriptor, content, "utf8");
    // A rename publishes a new inode. Restore the original owner and group
    // only when they differ, since even an unnecessary chown can be denied.
    if (identity && (Number(staged.uid) !== identity.uid || Number(staged.gid) !== identity.gid)) {
      try {
        fchownSync(descriptor, identity.uid, identity.gid);
      } catch {
        throw new Error(`Cannot preserve the owner of ${path}. The edit was not applied; ask the user to change its owner.`);
      }
    }
    if (identity) fchmodSync(descriptor, identity.mode & 0o777);
    fsyncSync(descriptor);
    checkUnchanged();
    // Windows can refuse a rename while the source handle is open.
    if (process.platform === "win32") closeStage();
    if (!isStagedEntry()) throw new Error("The staged edit changed before publication.");
    publish(temporary, path);
    published = true;
  } finally {
    try {
      if (process.platform === "win32") closeStage();
      if (!published && isStagedEntry()) rmSync(temporary, { force: true });
    } finally { closeStage(); }
  }
}
