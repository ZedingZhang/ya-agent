import { fork } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { dataHome } from "../config";
import { applyTextEdits, textRevision } from "../edits";
import { isSensitive, listDirectory, MAX_TEXT_BYTES, openRegularFile, physicalWorkspacePath, readOpenedText, readRegularText, searchFiles, type ConfirmEdit, type EditResult, type ScopedFolderIO } from "../local";
import { publishEdit } from "../publish-edit";
import { moveInGrantedFolder } from "./folder-move";
import { FOLDER_CHECK_TIMEOUT_MS, FolderGrants, folderIdentityExecutable, nativeIdentity, type FolderGrant } from "./folder-grants";

type Operation =
  | { kind: "probe" | "list" | "read"; path: string }
  | { kind: "search"; path: string; query: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "mkdir"; path: string }
  | { kind: "edit"; path: string; expectedRevision: string; edits: unknown }
  | { kind: "move"; path: string; destination: string };

interface FolderRequest {
  botId: string;
  grant: FolderGrant;
  sessionDirectoryId?: { dev: string; ino: string };
  operation: Operation;
  identityExecutable: string;
}
type EditPreview = Pick<EditResult, "content" | "count">;
type PreviewPaths = [path: string, destination?: string];
type ConfirmWorker = (paths: PreviewPaths, previous?: string, edit?: EditPreview) => Promise<boolean>;
type WorkerMessage = { type: "preview"; paths: PreviewPaths; previous?: string; edit?: EditPreview } | { type: "result"; value: string } | { type: "error"; message: string };

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

  async available(signal?: AbortSignal): Promise<boolean> {
    // A stalled mount must allow the task to offer ordinary chat.
    const timeout = AbortSignal.timeout(FOLDER_CHECK_TIMEOUT_MS);
    const probe = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await runWorker(this.request({ kind: "probe", path: "." }), probe) === "valid";
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  }

  list(path: string, signal?: AbortSignal): Promise<string> {
    return runWorker(this.request({ kind: "list", path }), signal);
  }

  read(path: string, signal?: AbortSignal): Promise<string> {
    return runWorker(this.request({ kind: "read", path }), signal);
  }

  search(path: string, query: string, signal?: AbortSignal): Promise<string> {
    return runWorker(this.request({ kind: "search", path, query }), signal);
  }

  async write(path: string, content: string, confirm: (previous: string | undefined, path: string) => Promise<boolean>, signal?: AbortSignal): Promise<{ approved: boolean; previous?: string }> {
    let previous: string | undefined;
    const result = await runWorker(this.request({ kind: "write", path, content }), signal, ([target], text) => {
      previous = text;
      return confirm(text, target);
    });
    return { approved: result === "written", previous };
  }

  async mkdir(path: string, confirm: (path: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    return await runWorker(this.request({ kind: "mkdir", path }), signal, ([target]) => confirm(target)) === "created";
  }

  async edit(path: string, expectedRevision: string, edits: unknown, confirm: ConfirmEdit, signal?: AbortSignal): Promise<EditResult> {
    let preview: (EditPreview & { previous: string }) | undefined;
    const result = await runWorker(this.request({ kind: "edit", path, expectedRevision, edits }), signal, ([target], previous, edit) => {
      if (previous === undefined || !edit) throw new Error("Missing edit preview.");
      preview = { previous, ...edit };
      return confirm(previous, edit.content, edit.count, target);
    });
    if (!preview) throw new Error("Missing edit preview.");
    return { approved: result === "edited", ...preview };
  }

  async move(source: string, destination: string, confirm: (from: string, to: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
    const result = await runWorker(this.request({ kind: "move", path: source, destination }), signal, ([from, to]) => {
      if (!to) throw new Error("Missing move destination.");
      return confirm(from, to);
    });
    return result === "moved";
  }
}

async function runWorker(request: FolderRequest, signal?: AbortSignal, confirm?: ConfirmWorker): Promise<string> {
  signal?.throwIfAborted();
  const child = fork(worker, [], { env: workerEnv(), execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
  return new Promise((resolveResult, reject) => {
    let result: string | undefined;
    let error: unknown;
    // Once the approved mutation starts, let the worker finish and record its
    // outcome. Searches and writes still waiting for approval can stop at once.
    let committing = false;
    const stop = () => {
      if (committing) return;
      child.kill();
      // A stalled filesystem call can delay exit. No approval has been sent.
      reject(signal?.reason);
    };
    const failed = (reason: unknown) => { error = reason; child.kill(); };
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (reason) => { error = reason; });
    child.on("message", async (message: WorkerMessage) => {
      try {
        if (message.type === "preview") {
          signal?.throwIfAborted();
          if (!confirm) throw new Error("Unexpected file approval request.");
          const approved = await confirm(message.paths, message.previous, message.edit);
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
async function writeInDirectory(name: string, content: string, check: () => void, confirm: (previous?: string) => Promise<boolean>): Promise<string> {
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

async function editInDirectory(name: string, operation: Extract<Operation, { kind: "edit" }>, check: () => void, confirm: (previous: string, edit: EditPreview) => Promise<boolean>): Promise<string> {
  const fd = openRegularFile(name);
  let closed = false;
  try {
    const original = fstatSync(fd, { bigint: true });
    const metadata = { uid: Number(original.uid), gid: Number(original.gid), mode: Number(original.mode) };
    const previous = readOpenedText(fd);
    if (textRevision(previous) !== operation.expectedRevision) throw new Error("File revision changed. Read again before editing.");
    try { accessSync(name, constants.W_OK); }
    catch { throw new Error(`Read-only files cannot be edited: ${name}. Ask the user to change its permissions.`); }
    const edit = applyTextEdits(previous, operation.edits, MAX_TEXT_BYTES);
    const checkUnchanged = (): void => {
      const current = lstatSync(name, { bigint: true, throwIfNoEntry: false });
      if (!original.ino || !current?.isFile() || current.dev !== original.dev || current.ino !== original.ino ||
          current.mode !== original.mode || current.uid !== original.uid || current.gid !== original.gid || readOpenedText(fd) !== previous) {
        throw new Error("File changed during approval. Read again before editing.");
      }
      check();
    };
    checkUnchanged();
    if (!await confirm(previous, edit)) return "denied";
    checkUnchanged();
    publishEdit(name, edit.content, metadata, () => {
      checkUnchanged();
      // Windows requires the destination handle to close before replacing it.
      // Its parent stays pinned as the worker's cwd through the rename.
      if (process.platform === "win32") {
        closeSync(fd);
        closed = true;
      }
    });
    return "edited";
  } finally { if (!closed) closeSync(fd); }
}

type Mutation = Extract<Operation, { kind: "write" | "mkdir" | "edit" | "move" }>;

async function mutate(operation: Mutation, root: string, identityExecutable: string, verifyCwd: (directory: string) => void, checkAccess: () => void, confirm: ConfirmWorker): Promise<string> {
  // Preserve in-scope aliases, binding their original spelling to the physical
  // path used for approval. Mutations can never operate on the granted root.
  const resolvePath = (submitted: string): string => {
    if (!submitted || parse(submitted).root || normalize(submitted).split(sep).includes("..")) throw new Error("Invalid workspace path.");
    const physical = physicalWorkspacePath(root, submitted, realpathSync.native);
    if (isSensitive(join(root, submitted)) || isSensitive(physical)) throw new Error("Access to sensitive paths is blocked.");
    const path = relative(root, physical);
    if (!path) throw new Error("Cannot change the granted root directory.");
    return path;
  };
  const path = resolvePath(operation.path);
  const directory = dirname(path);
  if (operation.kind === "move") {
    const destination = resolvePath(operation.destination);
    const check = (): void => {
      if (resolvePath(operation.path) !== path || resolvePath(operation.destination) !== destination) {
        throw new Error("Move paths changed during approval. Request approval again.");
      }
      verifyCwd(".");
      checkAccess();
    };
    return await moveInGrantedFolder(identityExecutable, path, destination, check, () => confirm([path, destination])) ? "moved" : "denied";
  }
  process.chdir(directory);
  const check = (): void => {
    if (resolvePath(operation.path) !== path) throw new Error("File path changed during approval.");
    verifyCwd(directory);
    checkAccess();
  };
  check();
  const name = basename(path);
  switch (operation.kind) {
    case "write": return writeInDirectory(name, operation.content, check, (previous) => confirm([path], previous));
    case "edit": return editInDirectory(name, operation, check, (previous, edit) => confirm([path], previous, edit));
    case "mkdir": {
      if (lstatSync(name, { throwIfNoEntry: false })) throw new Error(`Path already exists: ${path}`);
      if (!await confirm([path])) return "denied";
      check();
      mkdirSync(name);
      return "created";
    }
  }
}

async function execute(request: FolderRequest, confirm?: ConfirmWorker): Promise<string> {
  const { botId, grant, operation, sessionDirectoryId, identityExecutable } = request;
  const displayPath = normalize(operation.path);
  let path = displayPath;
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
    if (operation.kind === "probe") {
      checkAccess();
      return "valid";
    }
    const root = realpathSync.native(".");
    if (operation.kind === "list" || operation.kind === "read" || operation.kind === "search") {
      path = relative(root, physicalWorkspacePath(root, path, realpathSync.native)) || ".";
    }
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
    if (operation.kind === "write" || operation.kind === "edit" || operation.kind === "mkdir" || operation.kind === "move") {
      if (!confirm) throw new Error("File approval is required.");
      return await mutate(operation, root, identityExecutable, verifyCwd, checkAccess, confirm);
    }
    const file = operation.kind === "read";
    const directory = file ? dirname(path) : path;
    process.chdir(directory);
    const check = (): void => { verifyCwd(directory); checkAccess(); };
    check();
    if (isSensitive(file ? join(realpathSync.native("."), basename(path)) : realpathSync.native("."))) throw new Error("Access to sensitive paths is blocked.");
    switch (operation.kind) {
      case "search": return searchFiles(path, operation.query, (entry) => join(displayPath, relative(path, entry)), checkAccess, verifyCwd);
      default: {
        const result = file ? readRegularText(basename(path)) : listDirectory(".", displayPath);
        check();
        return result;
      }
    }
  } finally { closeSync(fd); }
}

if (require.main === module && process.send) {
  // Load application modules first, then treat workspace archives as files.
  if (process.versions.electron) process.noAsar = true;
  process.once("message", async (request: FolderRequest) => {
    const confirm: ConfirmWorker = (paths, previous, edit) => new Promise((resolveApproval) => {
      if (!process.connected) { resolveApproval(false); return; }
      const finish = (approved: boolean): void => {
        process.off("message", decision);
        process.off("disconnect", disconnected);
        resolveApproval(approved);
      };
      const decision = (approved: unknown): void => finish(approved === true);
      const disconnected = (): void => finish(false);
      process.once("message", decision);
      process.once("disconnect", disconnected);
      process.send!({ type: "preview", paths, previous, edit }, (error: Error | null) => { if (error) disconnected(); });
    });
    let reply: WorkerMessage;
    try { reply = { type: "result", value: await execute(request, confirm) }; }
    catch (error) { reply = { type: "error", message: error instanceof Error ? error.message : String(error) }; }
    if (process.connected) {
      process.send!(reply, () => { if (process.connected) process.disconnect(); });
    }
  });
}
