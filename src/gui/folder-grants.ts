import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, realpath, renameSync, rmSync, writeFileSync } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from "node:path";
import type { FolderAccess } from "./shared";
import { BOT_PERMISSIONS_DIR, dataHome } from "../config";

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
}

export function folderIdentityExecutable(): string {
  const packaged = process.resourcesPath && __dirname.startsWith(join(process.resourcesPath, "app.asar") + sep);
  const dist = basename(dirname(__dirname)) === "src" ? resolve(__dirname, "../../dist") : resolve(__dirname, "../..");
  return join(packaged ? process.resourcesPath : dist, "gui-native",
    process.platform === "win32" ? "ya-folder-identity.exe" : "ya-folder-identity");
}

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
        if (typeof version === "string" && version) record = { path: grant.path, identity: grant.identity, version };
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

  async grant(botId: string, folder: string, checkSelection?: () => void): Promise<FolderGrant> {
    const path = await resolveGrantPath(folder);
    const record = this.recordPath(botId);
    const temp = record + "." + randomUUID();
    let handle: FileHandle | undefined;
    let directoryId: { dev: string; ino: string } | undefined;
    try {
      let identity = await this.identify(path);
      if (!identity) {
        handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const held = await handle.stat({ bigint: true });
        const current = await stat(path, { bigint: true });
        if (!held.isDirectory() || held.ino === 0n || held.ino !== current.ino || held.dev !== current.dev || await resolveGrantPath(path) !== path) {
          throw new Error("Choose a folder with a verifiable filesystem identity.");
        }
        identity = "session:" + randomUUID();
        directoryId = { dev: String(held.dev), ino: String(held.ino) };
      }
      checkSelection?.();
      const grant = { path, identity, version: randomUUID() };
      mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(grant), { mode: 0o600, flag: "wx" });
      renameSync(temp, record);
      this.release(botId);
      if (handle && directoryId) this.pins.set(botId, { handle, identity, directoryId });
      return grant;
    } catch (error) {
      await handle?.close();
      rmSync(temp, { force: true });
      throw error;
    }
  }

  revoke(botId: string): void {
    rmSync(this.recordPath(botId), { force: true });
    this.release(botId);
  }

  private release(botId: string): void {
    const pin = this.pins.get(botId);
    if (pin) void pin.handle.close();
    this.pins.delete(botId);
  }
}
