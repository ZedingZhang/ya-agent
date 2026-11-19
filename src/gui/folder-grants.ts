import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from "node:path";
import type { FolderAccess } from "./shared";
import { BOT_PERMISSIONS_DIR, dataHome } from "../config";

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

export class FolderGrants {
  private readonly pins = new Map<string, { fd: number; identity: string }>();

  constructor(private readonly identify = nativeIdentity) {}

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
    const held = fstatSync(pin.fd, { bigint: true });
    return { dev: String(held.dev), ino: String(held.ino) };
  }

  matches(botId: string, grant: FolderGrant): boolean {
    try {
      if (realpathSync(grant.path) !== grant.path) return false;
      if (!grant.identity.startsWith("session:")) {
        return this.identify(grant.path, false) === grant.identity;
      }
      const pin = this.pins.get(botId);
      if (pin?.identity !== grant.identity) return false;
      // The open directory retains its inode for the lifetime of this grant.
      const held = fstatSync(pin.fd, { bigint: true });
      const current = statSync(grant.path, { bigint: true });
      return held.isDirectory() && held.nlink > 0n && held.ino !== 0n && held.ino === current.ino && held.dev === current.dev;
    } catch {
      return false;
    }
  }

  grant(botId: string, folder: string): FolderGrant {
    const path = realpathSync(folder);
    const record = this.recordPath(botId);
    const temp = record + "." + randomUUID();
    let fd: number | undefined;
    try {
      let identity = this.identify(path, true);
      if (!identity) {
        fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
        const held = fstatSync(fd, { bigint: true });
        const current = statSync(path, { bigint: true });
        if (!held.isDirectory() || held.ino === 0n || held.ino !== current.ino || held.dev !== current.dev || realpathSync(path) !== path) {
          throw new Error("Choose a folder with a verifiable filesystem identity.");
        }
        identity = "session:" + randomUUID();
      }
      const grant = { path, identity, version: randomUUID() };
      mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(grant), { mode: 0o600, flag: "wx" });
      renameSync(temp, record);
      this.release(botId);
      if (fd !== undefined) this.pins.set(botId, { fd, identity });
      return grant;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
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
    if (pin) closeSync(pin.fd);
    this.pins.delete(botId);
  }
}
