import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, readFileSync, realpath, rmSync, writeFileSync } from "node:fs";
import { open, realpath as nativeRealpath, stat, type FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, resolve, sep, toNamespacedPath } from "node:path";
import type { FolderAccess } from "./shared";
import { abortable } from "../cancellation";
import { BOT_PERMISSIONS_DIR, dataHome } from "../config";

export const FOLDER_CHECK_TIMEOUT_MS = 5_000;

// Preserve an existing Windows short spelling only when it names the selection directly.
const windowsSpelling = promisify(realpath);

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
  verifiedSelection?: true;
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

function readFolderIdentity(args: string[], input: number | "ignore"): Promise<string | undefined> {
  return new Promise<string | undefined>((done) => {
    const child = spawn(folderIdentityExecutable(), args, {
      stdio: [input, "pipe", "ignore"], windowsHide: true, timeout: 3_000,
    });
    let identity = "";
    child.stdout!.setEncoding("utf8").on("data", (part: string) => { identity += part; });
    child.once("error", () => done(undefined));
    child.once("close", (code) => done(code === 0 ? identity.trim() || undefined : undefined));
  }).catch(() => undefined);
}

function identifyPickedFolder(handle: FileHandle): Promise<string | undefined> {
  // Derive the persistent identity from the held directory, even across a rename.
  return readFolderIdentity(["grant-open"], handle.fd);
}

export class FolderGrants {
  private readonly pins = new Map<string, { handle: FileHandle; identity: string; directoryId: { dev: string; ino: string } }>();

  constructor(private readonly identify: (handle: FileHandle) => string | undefined | Promise<string | undefined> = identifyPickedFolder) {}

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
            ? { selectedPath: grant.selectedPath } : {}),
          ...("verifiedSelection" in grant && grant.verifiedSelection === true ? { verifiedSelection: true } : {}) };
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
    // Open the picker's spelling first, following links with the OS's path semantics.
    const handle = await open(folder, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    let pinned = false;
    try {
      deadline.throwIfAborted();
      const held = await abortable(handle.stat({ bigint: true }), deadline);
      if (!held.isDirectory()) throw new Error("Choose a directory.");
      const canonical = await abortable(nativeRealpath(folder), deadline);
      let path = canonical;
      if (process.platform === "win32" && canonical !== folder) {
        const spelling = await abortable(windowsSpelling(folder).catch(() => undefined), deadline);
        if (spelling === folder) path = folder;
      }
      const persistent = await abortable(Promise.resolve(this.identify(handle)), deadline);
      const current = await abortable(stat(canonical, { bigint: true }), deadline);
      const sameDirectory = held.ino !== 0n ? held.ino === current.ino
        : !!persistent && await abortable(readFolderIdentity(["check", toNamespacedPath(canonical)], "ignore"), deadline) === persistent;
      if (!sameDirectory || held.dev !== current.dev || await abortable(nativeRealpath(folder), deadline) !== canonical) {
        throw new Error("The selected directory changed or its identity could not be verified.");
      }
      deadline.throwIfAborted();
      checkSelection?.();
      const selectedPath = isAbsolute(folder) ? folder : resolve(folder);
      const identity = persistent || "session:" + randomUUID();
      const grant: FolderGrant = { path, identity, version: randomUUID(), ...(selectedPath !== path ? { selectedPath, verifiedSelection: true } : {}) };
      this.commit(botId, grant, expected);
      this.release(botId);
      if (!persistent) {
        this.pins.set(botId, { handle, identity, directoryId: { dev: String(held.dev), ino: String(held.ino) } });
        pinned = true;
      }
      return grant;
    } finally {
      if (!pinned) await handle.close();
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
