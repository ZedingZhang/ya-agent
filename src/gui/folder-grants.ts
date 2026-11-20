import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, realpath, rmSync, writeFileSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from "node:path";
import type { FolderAccess } from "./shared";
import { abortable } from "../cancellation";
import { BOT_PERMISSIONS_DIR, dataHome } from "../config";

export const FOLDER_CHECK_TIMEOUT_MS = 5_000;

// Keep the spelling used by existing grants, including Windows short paths.
const resolveGrantPath = promisify(realpath);

export class FolderAccessChangedError extends Error {
  constructor(readonly access: FolderAccess) {
    super("Folder access has changed.");
  }
}

export interface FolderGrant {
  version: string;
  path: string;
  identity: string;
  selectedPath?: string;
}

function nativeExecutable(name: string): string {
  const packaged = process.resourcesPath && __dirname.startsWith(join(process.resourcesPath, "app.asar") + sep);
  const dist = basename(dirname(__dirname)) === "src" ? resolve(__dirname, "../../dist") : resolve(__dirname, "../..");
  return join(packaged ? process.resourcesPath : dist, "gui-native",
    process.platform === "win32" ? name + ".exe" : name);
}

export function folderIdentityExecutable(): string { return nativeExecutable("ya-folder-identity"); }

export function nativeIdentity(path: string, create: boolean, binary = folderIdentityExecutable()): string | undefined {
  try {
    return execFileSync(binary, [create ? "grant" : "check", path === "." ? "." : toNamespacedPath(path)], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 3_000,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function identifyPickedFolder(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)(folderIdentityExecutable(), ["grant", toNamespacedPath(path)], {
      encoding: "utf8", windowsHide: true, timeout: 3_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class FolderGrants {
  private readonly pins = new Map<string, { handle: FileHandle; identity: string; directoryId: { dev: string; ino: string } }>();

  constructor(private readonly identify: (path: string) => string | undefined | Promise<string | undefined> = identifyPickedFolder) {}

  private recordPath(botId: string): string {
    return join(dataHome(), BOT_PERMISSIONS_DIR, createHash("sha256").update(botId).digest("hex"));
  }

  read(botId: string): FolderGrant | undefined {
    let record: FolderGrant | undefined;
    try {
      const grant: unknown = JSON.parse(readFileSync(this.recordPath(botId), "utf8"));
      if (typeof grant === "object" && grant !== null && "path" in grant && "identity" in grant
        && typeof grant.path === "string" && isAbsolute(grant.path) && typeof grant.identity === "string") {
        // Existing identity-bound grants predate per-selection versions.
        const version = "version" in grant ? grant.version
          : createHash("sha256").update(JSON.stringify([grant.path, grant.identity])).digest("hex");
        if (typeof version === "string" && version) record = { path: grant.path, identity: grant.identity, version,
          ...("selectedPath" in grant && typeof grant.selectedPath === "string" && isAbsolute(grant.selectedPath)
            ? { selectedPath: grant.selectedPath } : {}) };
      }
    } catch {
      // Missing, malformed and legacy path-only records carry no authority.
    }
    if (this.pins.has(botId) && this.pins.get(botId)?.identity !== record?.identity) this.release(botId);
    return record;
  }

  sessionDirectoryId(botId: string, grant: FolderGrant): { dev: string; ino: string } | undefined {
    const pin = this.pins.get(botId);
    if (pin?.identity !== grant.identity) return undefined;
    // The open descriptor pins this directory until the grant is released.
    return pin.directoryId;
  }

  snapshot(botId: string): Buffer | null {
    try {
      const record = readFileSync(this.recordPath(botId));
      if (record.length) return record;
      // A truncated record means revoked. A new picker needs a unique baseline
      // so that another revoke during selection cannot recreate that baseline.
      const baseline = { version: randomUUID() };
      this.commit(botId, baseline, record);
      return Buffer.from(JSON.stringify(baseline));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private changeRecord(record: string, mode: string, temp: string, expected?: Buffer): void {
    const result = spawnSync(nativeExecutable("ya-grant-commit"), [mode, toNamespacedPath(record),
      temp && toNamespacedPath(temp), toNamespacedPath(record + ".lock"), toNamespacedPath(dirname(record))], {
      input: expected, timeout: 3_000, windowsHide: true,
    });
    if (result.status === 2) throw new Error("Folder selection is no longer current.");
    if (result.status !== 0) throw new Error("Could not save folder access.");
  }

  private commit(botId: string, value: { version: string }, expected: Buffer | null): void {
    const record = this.recordPath(botId);
    const temp = record + "." + randomUUID();
    mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      const mode = expected === null ? "missing" : "compare";
      this.changeRecord(record, mode, temp, expected ?? undefined);
    } finally { rmSync(temp, { force: true }); }
  }

  grant(botId: string, folder: string, checkSelection?: () => void, expected = this.snapshot(botId)): Promise<FolderGrant> {
    const deadline = AbortSignal.timeout(FOLDER_CHECK_TIMEOUT_MS);
    // A mount can stall even before identification, or while opening a fallback handle.
    return abortable(this.verifyAndGrant(botId, folder, expected, deadline, checkSelection), deadline);
  }

  private async verifyAndGrant(botId: string, folder: string, expected: Buffer | null, deadline: AbortSignal, checkSelection?: () => void): Promise<FolderGrant> {
    const path = await resolveGrantPath(folder);
    deadline.throwIfAborted();
    let handle: FileHandle | undefined;
    let directoryId: { dev: string; ino: string } | undefined;
    try {
      let identity = await this.identify(path);
      if (!identity) {
        deadline.throwIfAborted();
        handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        deadline.throwIfAborted();
        const held = await abortable(handle.stat({ bigint: true }), deadline);
        const current = await abortable(stat(path, { bigint: true }), deadline);
        if (!held.isDirectory() || held.ino === 0n || held.ino !== current.ino || held.dev !== current.dev || await abortable(resolveGrantPath(path), deadline) !== path) {
          throw new Error("Choose a folder with a verifiable filesystem identity.");
        }
        identity = "session:" + randomUUID();
        directoryId = { dev: String(held.dev), ino: String(held.ino) };
      }
      deadline.throwIfAborted();
      checkSelection?.();
      const selectedPath = resolve(folder);
      const grant = { path, identity, version: randomUUID(), ...(selectedPath !== path ? { selectedPath } : {}) };
      this.commit(botId, grant, expected);
      this.release(botId);
      if (handle && directoryId) this.pins.set(botId, { handle, identity, directoryId });
      return grant;
    } catch (error) {
      await handle?.close();
      throw error;
    }
  }

  revoke(botId: string): void {
    const record = this.recordPath(botId);
    mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
    this.changeRecord(record, "revoke", "");
    this.release(botId);
  }

  private release(botId: string): void {
    const pin = this.pins.get(botId);
    if (pin) void pin.handle.close();
    this.pins.delete(botId);
  }
}
