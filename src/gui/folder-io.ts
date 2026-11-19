import { fork, spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { dataHome } from "../config";
import { isSensitive, listDirectory, openRegularFile, readOpenedText, readRegularText, searchFiles, type ScopedFolderIO } from "../local";
import { FolderGrants, folderIdentityExecutable, nativeIdentity, type FolderGrant } from "./folder-grants";

type Operation =
  | { kind: "list" | "read"; path: string }
  | { kind: "search"; path: string; query: string }
  | { kind: "write"; path: string; content: string };

interface FolderRequest {
  botId: string;
  grant: FolderGrant;
  sessionDirectoryId?: { dev: string; ino: string };
  operation: Operation;
  identityExecutable: string;
}
type ConfirmWrite = (previous?: string) => Promise<boolean>;
type WorkerMessage = { type: "preview"; previous?: string } | { type: "result"; value: string } | { type: "error"; message: string };

const worker = __filename.endsWith(".js") ? __filename : resolve(__dirname, "../../dist/typescript/gui/folder-io.js");
function workerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, YA_HOME: dataHome(), ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" };
}

export class GrantedFolderIO implements ScopedFolderIO {
  constructor(private readonly grants: FolderGrants, private readonly botId: string, private readonly grant: FolderGrant) {}

  private request(operation: Operation): FolderRequest {
    return { operation, botId: this.botId, grant: this.grant, sessionDirectoryId: this.grants.sessionDirectoryId(this.botId, this.grant),
      identityExecutable: folderIdentityExecutable() };
  }

  private runSync(operation: Extract<Operation, { kind: "list" | "read" }>): string {
    const result = spawnSync(process.execPath, [worker], {
      input: JSON.stringify(this.request(operation)), encoding: "utf8", windowsHide: true, maxBuffer: Infinity, env: workerEnv(),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || "Folder operation stopped.");
    return result.stdout;
  }

  list(path: string): string { return this.runSync({ kind: "list", path }); }
  read(path: string): string { return this.runSync({ kind: "read", path }); }

  search(path: string, query: string, signal?: AbortSignal): Promise<string> {
    return runWorker(this.request({ kind: "search", path, query }), signal);
  }

  async write(path: string, content: string, confirm: ConfirmWrite, signal?: AbortSignal): Promise<{ approved: boolean; previous?: string }> {
    let previous: string | undefined;
    const result = await runWorker(this.request({ kind: "write", path, content }), signal, (text) => {
      previous = text;
      return confirm(text);
    });
    return { approved: result === "written", previous };
  }
}

// Wait for the child to close, including on cancellation, so no scan is left
// running when the desktop settles the task or reloads the renderer.
async function runWorker(request: FolderRequest, signal?: AbortSignal, confirm?: ConfirmWrite): Promise<string> {
  signal?.throwIfAborted();
  const child = fork(worker, [], { env: workerEnv(), execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise((resolveResult, reject) => {
    let result: string | undefined;
    let error: unknown;
    // Once the approved mutation starts, let the worker finish and record its
    // outcome. Searches and writes still waiting for approval can stop at once.
    let committing = false;
    const stop = () => { if (!committing) child.kill(); };
    const failed = (reason: unknown) => { error = reason; child.kill(); };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (reason) => { error = reason; });
    child.on("message", async (message: WorkerMessage) => {
      try {
        if (message.type === "preview") {
          if (!confirm) throw new Error("Unexpected file approval request.");
          const approved = await confirm(message.previous);
          signal?.throwIfAborted();
          if (child.connected) {
            committing = approved;
            child.send(approved, (err) => { if (err) failed(err); });
          }
        } else if (message.type === "error") {
          error = new Error(message.message);
        } else {
          result = message.value;
        }
      } catch (reason) { failed(reason); }
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted && !committing) reject(signal.reason);
      else if (error || code !== 0 || result === undefined) reject(error ?? new Error("Folder operation stopped."));
      else resolveResult(result);
    });
    child.send(request, (err) => { if (err) failed(err); });
  });
}

// The worker holds the actual parent directory as its cwd across the approval.
// Keep the original file open without truncating it until the user approves.
async function writeInDirectory(name: string, content: string, check: () => void, confirm: ConfirmWrite): Promise<string> {
  const entry = lstatSync(name, { throwIfNoEntry: false });
  let fd = entry ? openRegularFile(name, constants.O_RDWR) : undefined;
  try {
    const previous = fd === undefined ? undefined : readOpenedText(fd);
    check();
    if (!await confirm(previous)) return "denied";
    check();
    if (fd === undefined) {
      fd = openSync(name, "wx");
    } else {
      const held = fstatSync(fd, { bigint: true });
      const current = lstatSync(name, { bigint: true, throwIfNoEntry: false });
      if (!current?.isFile() || !held.ino || held.dev !== current.dev || held.ino !== current.ino || readOpenedText(fd) !== previous) {
        throw new Error("File changed during approval. Read again before writing.");
      }
      if (held.nlink !== 1n) throw new Error("Use local_edit to replace a hard-linked file without altering its other links.");
      check();
    }
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!written) throw new Error("File write did not complete.");
      offset += written;
    }
    ftruncateSync(fd, bytes.length);
    return "written";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function execute(request: FolderRequest, confirm?: ConfirmWrite): Promise<string> {
  const { botId, grant, operation, sessionDirectoryId, identityExecutable } = request;
  const path = normalize(operation.path);
  if (!operation.path || parse(path).root || path.split(sep).includes("..")) throw new Error("Invalid workspace path.");

  process.chdir(grant.path);
  const fd = openSync(".", constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    const held = fstatSync(fd, { bigint: true });
    const verified = grant.identity.startsWith("session:")
      ? sessionDirectoryId?.dev === String(held.dev) && sessionDirectoryId.ino === String(held.ino)
      : nativeIdentity(".", false, identityExecutable) === grant.identity;
    if (!verified) throw new Error("Folder access has changed.");

    const grants = new FolderGrants();
    const checkAccess = (): void => {
      const current = grants.read(botId);
      const attached = statSync(grant.path, { bigint: true, throwIfNoEntry: false });
      if (current?.version !== grant.version || current.path !== grant.path || current.identity !== grant.identity
        || !attached || attached.dev !== held.dev || attached.ino !== held.ino || realpathSync(grant.path) !== grant.path
        || (!held.ino && nativeIdentity(grant.path, false, identityExecutable) !== grant.identity)) {
        throw new Error("Folder access has changed.");
      }
    };
    const root = realpathSync.native(".");
    const verifyCwd = (directory: string): void => {
      const actual = realpathSync.native(".");
      const fromRoot = relative(root, actual);
      if (fromRoot === ".." || fromRoot.startsWith(".." + sep) || isAbsolute(fromRoot)) throw new Error("Workspace directory has changed.");
      const expected = join(root, directory);
      const expectedDir = statSync(expected, { bigint: true });
      const actualDir = statSync(".", { bigint: true });
      if (expectedDir.dev !== actualDir.dev || expectedDir.ino !== actualDir.ino) throw new Error("Workspace directory has changed.");
      if (expected === actual) return;
      // A case-insensitive filesystem can give one directory several spellings.
      // Accept the same directory, while rejecting indirection through a link.
      let ancestor = root;
      for (const part of directory.split(sep)) {
        ancestor = join(ancestor, part);
        if (!lstatSync(ancestor).isDirectory()) throw new Error("Workspace directory has changed.");
      }
      if (realpathSync.native(expected) !== actual) throw new Error("Workspace directory has changed.");
    };

    checkAccess();
    const file = operation.kind === "write" || operation.kind === "read";
    const directory = file ? dirname(path) : path;
    process.chdir(directory);
    const check = (): void => { verifyCwd(directory); checkAccess(); };
    check();
    if (isSensitive(file ? join(realpathSync.native("."), basename(path)) : realpathSync.native("."))) throw new Error("Access to sensitive paths is blocked.");
    switch (operation.kind) {
      case "search": return searchFiles(path, operation.query, (entry) => entry, checkAccess, verifyCwd);
      case "write":
        if (!confirm) throw new Error("Write approval is required.");
        return await writeInDirectory(basename(path), operation.content, check, confirm);
      default: {
        const result = file ? readRegularText(basename(path)) : listDirectory(".", path);
        check();
        return result;
      }
    }
  } finally { closeSync(fd); }
}

if (require.main === module) {
  // Load application modules first, then treat workspace archives as files.
  if (process.versions.electron) process.noAsar = true;
  if (process.send) {
    process.once("message", async (request: FolderRequest) => {
      const confirm: ConfirmWrite = (previous) => new Promise((resolveApproval) => {
        process.once("message", (approved) => resolveApproval(approved === true));
        process.send!({ type: "preview", previous });
      });
      try { process.send!({ type: "result", value: await execute(request, confirm) }); }
      catch (error) { process.send!({ type: "error", message: error instanceof Error ? error.message : String(error) }); }
      finally { process.disconnect(); }
    });
  } else {
    execute(JSON.parse(readFileSync(0, "utf8")) as FolderRequest).then((result) => process.stdout.write(result)).catch((error: unknown) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
