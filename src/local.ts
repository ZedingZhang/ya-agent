import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createTwoFilesPatch } from "diff";
import { appendAuditRecord } from "./audit-log";
import { abortable } from "./cancellation";
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  runCommand,
  validateCommand,
  type CommandResult,
} from "./commands";
import { BOT_PERMISSIONS_DIR, dataHome } from "./config";
import { applyTextEdits, textRevision } from "./edits";
import { createFileChange } from "./file-diff";
import { expandHome } from "./fs-utils";
import { errorMessage } from "./guards";
import {
  MAX_TEXT_BYTES,
  isSensitive,
  listDirectory,
  outsideWorkspace,
  physicalWorkspacePath,
  readText,
  searchFiles,
} from "./local-files";
import {
  LOCAL_RUN_TOOL,
  LOCAL_TOOLS,
  type ConfirmEdit,
  type EditResult,
  type LocalAction,
  type LocalActivity,
  type LocalActivityObserver,
  type LocalConfirmation,
  type LocalWorkspaceOptions,
  type ScopedFolderIO,
} from "./local-tools";
import { publishEdit } from "./publish-edit";
import type { ToolArguments, ToolDefinition, ToolHandler } from "./types";

export {
  AUDIT_LOG_MAX_BYTES,
  MAX_AUDIT_ARCHIVES,
  appendAuditRecord,
  auditHistoryEntries,
  auditLogFiles,
  auditLogPath,
  auditLogTotalBytes,
  clearAuditLogs,
  deleteAuditHistory,
  setAuditLogMaxBytesForTesting,
} from "./audit-log";
export {
  MAX_LIST_ENTRIES,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_BYTES,
  isSensitive,
  listDirectory,
  openRegularFile,
  physicalWorkspacePath,
  readOpenedText,
  readRegularText,
  searchFiles,
} from "./local-files";
export { LOCAL_RUN_TOOL, LOCAL_TOOLS } from "./local-tools";
export type {
  ConfirmEdit,
  EditResult,
  LocalAction,
  LocalActivity,
  LocalActivityObserver,
  LocalConfirmation,
  LocalWorkspaceOptions,
  ScopedFolderIO,
} from "./local-tools";

export const MAX_DIFF_LINES = 200;

// Task runners accept both the synchronous CLI workspace and desktop folder tools.
export type TaskWorkspace = LocalWorkspace<ScopedFolderIO | undefined>;

export class LocalWorkspace<Scope extends ScopedFolderIO | undefined = undefined> {
  readonly root: string;
  confirm: LocalConfirmation;
  readonly onActivity?: LocalActivityObserver;
  readonly commandResults: CommandResult[] = [];

  constructor(root: string, confirm: LocalConfirmation, onActivity?: LocalActivityObserver, private readonly options: LocalWorkspaceOptions<Scope> = {}) {
    const expanded = resolve(expandHome(root));
    if (options.scopedFolder) {
      // Desktop workers verify the picker’s canonical root before touching it.
      this.root = expanded;
    } else {
      if (!existsSync(expanded)) throw new Error(`Workspace does not exist: ${expanded}`);
      this.root = realpathSync(expanded);
      if (!statSync(this.root).isDirectory()) throw new Error(`Workspace is not a directory: ${this.root}`);
    }
    this.confirm = confirm;
    this.onActivity = onActivity;
  }

  get folderScoped(): boolean { return Boolean(this.options.scopedFolder); }

  get commandsEnabled(): boolean { return this.options.commandsEnabled === true; }

  /** Bind cancellation without changing the workspace supplied by the caller. */
  withSignal(signal?: AbortSignal): LocalWorkspace<Scope> {
    if (!signal || signal === this.options.signal) return this;
    return new LocalWorkspace(this.root, this.confirm, this.onActivity, {
      ...this.options,
      signal: this.options.signal ? AbortSignal.any([this.options.signal, signal]) : signal,
    });
  }

  get tools(): ToolDefinition[] { return this.commandsEnabled ? [...LOCAL_TOOLS, LOCAL_RUN_TOOL] : [...LOCAL_TOOLS]; }

  get toolHandlers(): Record<string, ToolHandler> {
    return {
      local_list: (arguments_, signal) => this.list(arguments_, signal),
      local_read: (arguments_, signal) => this.read(arguments_, signal),
      local_search: (arguments_, signal) => this.search(arguments_, signal),
      local_mkdir: (arguments_) => this.mkdir(arguments_),
      local_write: (arguments_) => this.write(arguments_),
      local_edit: (arguments_) => this.edit(arguments_),
      local_move: (arguments_) => this.move(arguments_),
      ...(this.commandsEnabled ? { local_run: (arguments_: ToolArguments) => this.run(arguments_) } : {}),
    };
  }

  private activity(operation: LocalActivity["operation"], paths: string[], status: LocalActivity["status"]): void {
    if (!this.onActivity) return;
    try {
      this.onActivity({ operation, paths: paths.map((path) => this.relativePath(path)), status });
    } catch {
      // Presentation observers cannot affect the agent operation.
    }
  }

  private fileChanged(path: string, before: string | undefined, after: string, operation: "write" | "edit"): void {
    if (!this.options.onFileChange || isSensitive(path) || after.includes("\0")
      || Buffer.from(after, "utf8").toString("utf8") !== after) return;
    try {
      (this.options.assertPreviewAccess ?? this.options.assertAccess)?.();
      this.options.onFileChange(createFileChange(this.relativePath(path), before, after, operation));
    } catch {
      // A failed preview or presentation observer must not turn a committed write into an error.
    }
  }

  private resolveInput(value: unknown): string {
    this.options.assertAccess?.();
    this.options.signal?.throwIfAborted();
    if (typeof value !== "string" || !value.trim()) throw new Error("A non-empty path is required.");
    const expanded = expandHome(value);
    const candidate = resolve(isAbsolute(expanded) ? expanded : join(this.root, expanded));
    if (!this.options.scopedFolder) return physicalWorkspacePath(this.root, candidate);
    if (isAbsolute(expanded)) return candidate; // The worker checks the physical root, including filesystem aliases.
    const fromRoot = relative(this.root, candidate);
    if (outsideWorkspace(fromRoot)) {
      throw new Error("Path must remain inside the authorized workspace.");
    }
    return candidate;
  }

  private scopedPath(path: string): string {
    const rel = this.relativePath(path);
    return resolve(this.root, rel) === path && !outsideWorkspace(rel) ? rel : path;
  }

  private relativePath(path: string): string {
    return relative(this.root, path) || ".";
  }

  private approvalPath(resolved: string): string {
    return this.resolveInput(resolve(this.root, resolved));
  }

  private audit(operation: string, paths: string[], status: string, error?: string, metadata: Record<string, unknown> = {}): void {
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      workspace: this.root,
      operation,
      paths: paths.map((path) => this.relativePath(path)),
      status,
      ...metadata,
    };
    if (error) record.error = error;
    appendAuditRecord(record);
  }

  private async confirmed(action: LocalAction): Promise<boolean> {
    this.options.signal?.throwIfAborted();
    this.options.assertAccess?.();
    const approved = await abortable(Promise.resolve(this.confirm(action)), this.options.signal);
    this.options.signal?.throwIfAborted();
    this.options.assertAccess?.();
    if (approved) return true;
    this.audit(action.operation, action.paths, "denied");
    this.activity(action.operation, action.paths, "denied");
    return false;
  }

  async run(arguments_: ToolArguments): Promise<string> {
    if (!this.commandsEnabled) throw new Error("Command execution is not enabled for this task.");
    const command = arguments_.command;
    validateCommand(command);
    const timeout = arguments_.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT_SECONDS) {
      throw new Error(`Command timeout must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_SECONDS} seconds.`);
    }
    const cwdInput = arguments_.cwd ?? ".";
    const cwd = this.resolveInput(cwdInput);
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      const lineCount = command.split("\n").length;
      const action: LocalAction = {
        operation: "run", paths: [cwd],
        summary: `Run command (${lineCount} ${lineCount === 1 ? "line" : "lines"}):\n${command}\nDirectory: ${cwd}\nTimeout: ${timeout}s\nRuns with your account permissions and can modify files or access the network.`,
      };
      if (!(await this.confirmed(action))) {
        return JSON.stringify({ status: "denied", command, cwd: this.relativePath(cwd), reason: "User declined this command. It was not executed." });
      }
      // Approval may take minutes; resolve the original path again before spawning.
      if (this.resolveInput(cwdInput) !== cwd || this.resolveInput(cwd) !== cwd || !statSync(cwd).isDirectory()) {
        throw new Error("Command directory changed while awaiting approval. Request approval again.");
      }
      const result = await runCommand({
        command, cwd, displayCwd: this.relativePath(cwd), timeoutSeconds: timeout,
        signal: this.options.signal, onEvent: this.options.onCommandEvent,
      });
      this.commandResults.push(result);
      const status = result.status === "success" ? "success" : "error";
      this.audit("run", [cwd], result.status, undefined, { exitCode: result.exitCode, durationMs: result.durationMs });
      this.activity("run", [cwd], status);
      return JSON.stringify(result);
    } catch (error) {
      this.audit("run", [cwd], "error", errorMessage(error));
      this.activity("run", [cwd], "error");
      throw error;
    }
  }

  private operationSignal(signal?: AbortSignal): AbortSignal | undefined {
    return this.options.signal && signal ? AbortSignal.any([this.options.signal, signal]) : this.options.signal ?? signal;
  }

  list(this: LocalWorkspace<undefined>, arguments_: ToolArguments, signal?: AbortSignal): string;
  list(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string>;
  list(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string> {
    let path = this.resolveInput(arguments_.path ?? ".");
    if (isSensitive(path)) throw new Error("Listing sensitive directories is blocked in local mode.");
    const relative = this.relativePath(path);
    const finish = (result: string): string => {
      this.activity("list", [path], "success");
      this.options.assertAccess?.();
      return result;
    };
    if (this.options.scopedFolder) return this.options.scopedFolder.list(this.scopedPath(path), this.operationSignal(signal),
      (resolved) => { path = join(this.root, resolved); }).then(finish);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
    return finish(listDirectory(path, relative));
  }

  read(this: LocalWorkspace<undefined>, arguments_: ToolArguments, signal?: AbortSignal): string;
  read(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string>;
  read(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string> {
    let path = this.resolveInput(arguments_.path);
    if (isSensitive(path)) throw new Error("Reading sensitive files is blocked in local mode.");
    const finish = (content: string): string => {
      this.activity("read", [path], "success");
      this.options.assertAccess?.();
      return JSON.stringify({ path: this.relativePath(path), content, revision: textRevision(content) });
    };
    return this.options.scopedFolder
      ? this.options.scopedFolder.read(this.scopedPath(path), this.operationSignal(signal),
        (resolved) => { path = join(this.root, resolved); }).then(finish)
      : finish(readText(path));
  }

  search(this: LocalWorkspace<undefined>, arguments_: ToolArguments, signal?: AbortSignal): string;
  search(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string>;
  search(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string> {
    const query = arguments_.query;
    if (typeof query !== "string" || !query.trim()) throw new Error("A non-empty search query is required.");
    let root = this.resolveInput(arguments_.path ?? ".");
    if (isSensitive(root)) throw new Error("Searching sensitive directories is blocked in local mode.");
    if (this.options.scopedFolder) {
      const active = this.operationSignal(signal);
      return this.options.scopedFolder.search(this.scopedPath(root), query, active,
        (resolved) => { root = join(this.root, resolved); }).then((result) => {
        active?.throwIfAborted();
        return this.finishSearch(root, result);
      });
    }
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    const result = this.options.searchFolder
      ? this.options.searchFolder(this.relativePath(root), query)
      : searchFiles(root, query, (path) => this.relativePath(path), this.options.assertAccess);
    return this.finishSearch(root, result);
  }

  private finishSearch(root: string, result: string): string {
    this.activity("search", [root], "success");
    this.options.assertAccess?.();
    return result;
  }

  // Keep observing the approved operation after a slow mount has outlived
  // cancellation. Its own callbacks still report the actual outcome.
  private waitForMutation(work: Promise<string>, operation: LocalActivity["operation"], inputs: unknown[]): Promise<string> {
    const signal = this.options.signal;
    if (!this.options.scopedFolder || !signal) return work;
    return new Promise((resolveWork, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        timer = setTimeout(() => {
          const paths = inputs.filter((value): value is string => typeof value === "string")
            .map((value) => resolve(this.root, expandHome(value)));
          this.activity(operation, paths, "pending");
          reject(new Error("Stopped waiting for an approved file operation. Its outcome is pending."));
        }, 1_000);
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      };
      work.then((value) => { cleanup(); resolveWork(value); }, (error: unknown) => { cleanup(); reject(error); });
    });
  }

  mkdir(arguments_: ToolArguments): Promise<string> {
    return this.waitForMutation(this.applyMkdir(arguments_), "mkdir", [arguments_.path]);
  }

  private async applyMkdir(arguments_: ToolArguments): Promise<string> {
    let path = this.resolveInput(arguments_.path);
    try {
      if (isSensitive(path)) throw new Error("Creating sensitive directories is blocked in local mode.");
      const confirm = (resolved?: string): Promise<boolean> => {
        if (resolved !== undefined) path = this.approvalPath(resolved);
        return this.confirmed({ operation: "mkdir", paths: [path], summary: `Create directory: ${path}` });
      };
      const approved = this.options.scopedFolder
        ? await this.options.scopedFolder.mkdir(this.scopedPath(path), confirm, this.options.signal)
        : await this.mkdirUnscoped(path, confirm);
      if (!approved) return JSON.stringify({ status: "denied", operation: "mkdir", path: this.relativePath(path), reason: "User declined this action." });
      this.audit("mkdir", [path], "success");
      this.activity("mkdir", [path], "success");
      return JSON.stringify({ status: "ok", operation: "mkdir", path: this.relativePath(path) });
    } catch (error) {
      this.audit("mkdir", [path], "error", errorMessage(error));
      this.activity("mkdir", [path], "error");
      throw error;
    }
  }

  private async mkdirUnscoped(path: string, confirm: () => Promise<boolean>): Promise<boolean> {
    if (existsSync(path)) throw new Error(`Path already exists: ${path}`);
    if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new Error("Parent directory does not exist; create it first.");
    if (!await confirm()) return false;
    if (this.resolveInput(path) !== path) throw new Error("Folder changed during approval.");
    mkdirSync(path);
    return true;
  }

  write(arguments_: ToolArguments): Promise<string> {
    return this.waitForMutation(this.applyWrite(arguments_), "write", [arguments_.path]);
  }

  private async applyWrite(arguments_: ToolArguments): Promise<string> {
    let path = this.resolveInput(arguments_.path);
    const content = arguments_.content;
    if (typeof content !== "string") throw new Error("Text content is required.");
    try {
      if (isSensitive(path)) throw new Error("Writing sensitive files is blocked in local mode.");
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error("Text content larger than 1 MiB cannot be written.");
      const confirm = async (previous?: string, resolved?: string): Promise<boolean> => {
        if (resolved !== undefined) path = this.approvalPath(resolved);
        const action: LocalAction = previous === undefined
          ? { operation: "write", paths: [path], summary: `Create text file: ${path}` }
          : { operation: "write", paths: [path], summary: `Replace text file: ${path}`, diff: limitedDiff(path, previous, content) };
        const approved = await this.confirmed(action);
        if (approved && !this.options.scopedFolder && (this.resolveInput(arguments_.path) !== path || this.resolveInput(path) !== path)) {
          throw new Error("File changed during approval. Read again before writing.");
        }
        return approved;
      };
      let previous: string | undefined;
      let approved: boolean;
      if (this.options.scopedFolder) {
        ({ approved, previous } = await this.options.scopedFolder.write(this.scopedPath(path), content, confirm, this.options.signal));
      } else {
        if (existsSync(path) && statSync(path).isDirectory()) throw new Error(`Path is a directory: ${path}`);
        if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new Error("Parent directory does not exist; create it first.");
        previous = existsSync(path) ? readText(path) : undefined;
        approved = await confirm(previous);
        if (approved) {
          if ((existsSync(path) ? readText(path) : undefined) !== previous) throw new Error("File changed during approval. Read again before writing.");
          if (previous !== undefined && this.options.assertAccess && statSync(path).nlink > 1) {
            throw new Error("Use local_edit to replace a hard-linked file without altering its other links.");
          }
          writeFileSync(path, content, { encoding: "utf8", flag: previous === undefined ? "wx" : "w" });
        }
      }
      if (!approved) return JSON.stringify({ status: "denied", operation: "write", path: this.relativePath(path), reason: "User declined this action." });
      this.fileChanged(path, previous, content, "write");
      this.audit("write", [path], "success");
      this.activity("write", [path], "success");
      return JSON.stringify({ status: "ok", operation: "write", path: this.relativePath(path) });
    } catch (error) {
      this.audit("write", [path], "error", errorMessage(error));
      this.activity("write", [path], "error");
      throw error;
    }
  }

  edit(arguments_: ToolArguments): Promise<string> {
    return this.waitForMutation(this.applyEdit(arguments_), "edit", [arguments_.path]);
  }

  private async applyEdit(arguments_: ToolArguments): Promise<string> {
    let path = this.resolveInput(arguments_.path);
    try {
      const revision = arguments_.expected_revision;
      if (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision)) {
        throw new Error("expected_revision must be the revision returned by local_read.");
      }
      const confirm: ConfirmEdit = (previous, content, count, resolved) => {
        path = this.approvalPath(resolved);
        return this.confirmed({
          operation: "edit", paths: [path], summary: `Edit text file: ${path} (${count} replacements)`,
          diff: limitedDiff(path, previous, content),
        });
      };
      const { approved, previous, content, count } = this.options.scopedFolder
        ? await this.options.scopedFolder.edit(this.scopedPath(path), revision, arguments_.edits, confirm, this.options.signal)
        : await this.editUnscoped(path, arguments_.path, revision, arguments_.edits, confirm);
      if (!approved) {
        return JSON.stringify({ status: "denied", operation: "edit", path: this.relativePath(path), reason: "User declined this action." });
      }
      this.fileChanged(path, previous, content, "edit");
      this.audit("edit", [path], "success", undefined, { replacements: count });
      this.activity("edit", [path], "success");
      return JSON.stringify({ status: "ok", operation: "edit", path: this.relativePath(path), applied_edits: count, revision: textRevision(content) });
    } catch (error) {
      this.audit("edit", [path], "error", errorMessage(error));
      this.activity("edit", [path], "error");
      throw error;
    }
  }

  private async editUnscoped(path: string, input: unknown, revision: string, edits: unknown, confirm: ConfirmEdit): Promise<EditResult> {
    const previous = readText(path);
    // Filesystem IDs can exceed Number.MAX_SAFE_INTEGER on Windows.
    const identity = statSync(path, { bigint: true });
    if (identity.ino === 0n) throw new Error(`Cannot verify file identity before editing: ${path}`);
    if (textRevision(previous) !== revision) throw new Error("File revision changed. Read again before editing.");
    // Publishing replaces the file, and a rename needs only directory write permission, so without
    // this check Ya would silently rewrite files the user marked read-only.
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw new Error(`Read-only files cannot be edited: ${path}. Ask the user to change its permissions.`);
    }
    const { content, count } = applyTextEdits(previous, edits, MAX_TEXT_BYTES);
    const approved = await confirm(previous, content, count, path);
    if (!approved) return { approved, previous, content, count };
    const checkUnchanged = (): void => {
      if (this.resolveInput(input) !== path || this.resolveInput(path) !== path) {
        throw new Error("File path changed during approval. Read again before editing.");
      }
      const current = statSync(path, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.mode !== identity.mode || readText(path) !== previous) {
        throw new Error("File changed during approval. Read again before editing.");
      }
    };
    checkUnchanged();
    const metadata = { uid: Number(identity.uid), gid: Number(identity.gid), mode: Number(identity.mode) };
    publishEdit(path, content, metadata, checkUnchanged);
    return { approved, previous, content, count };
  }

  move(arguments_: ToolArguments): Promise<string> {
    return this.waitForMutation(this.applyMove(arguments_), "move", [arguments_.source, arguments_.destination]);
  }

  private async applyMove(arguments_: ToolArguments): Promise<string> {
    let source = this.resolveInput(arguments_.source);
    let destination = this.resolveInput(arguments_.destination);
    try {
      if (isSensitive(source) || isSensitive(destination)) {
        throw new Error("Moving sensitive files or directories is blocked in local mode.");
      }
      const confirm = (resolvedSource?: string, resolvedDestination?: string): Promise<boolean> => {
        if (resolvedSource !== undefined && resolvedDestination !== undefined) {
          source = this.approvalPath(resolvedSource);
          destination = this.approvalPath(resolvedDestination);
        }
        return this.confirmed({ operation: "move", paths: [source, destination], summary: `Move: ${source} -> ${destination}` });
      };
      const approved = this.options.scopedFolder
        ? await this.options.scopedFolder.move(this.scopedPath(source), this.scopedPath(destination), confirm, this.options.signal)
        : await this.moveUnscoped(arguments_, source, destination, confirm);
      if (!approved) {
        return JSON.stringify({ status: "denied", operation: "move", path: this.relativePath(source), reason: "User declined this action." });
      }
      this.audit("move", [source, destination], "success");
      this.activity("move", [source, destination], "success");
      return JSON.stringify({
        status: "ok",
        operation: "move",
        source: this.relativePath(source),
        destination: this.relativePath(destination),
      });
    } catch (error) {
      this.audit("move", [source, destination], "error", errorMessage(error));
      this.activity("move", [source, destination], "error");
      throw error;
    }
  }

  private async moveUnscoped(arguments_: ToolArguments, source: string, destination: string, confirm: () => Promise<boolean>): Promise<boolean> {
    if (source === this.root || !existsSync(source)) throw new Error(`Source does not exist: ${source}`);
    // Moving a parent of the grant store would also move the authority for future tasks.
    if (existsSync(join(dataHome(), BOT_PERMISSIONS_DIR))) {
      const grants = realpathSync(join(dataHome(), BOT_PERMISSIONS_DIR));
      const fromSource = relative(source, grants);
      if (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource)) {
        throw new Error("Moving a directory containing bot folder permissions is blocked.");
      }
    }
    if (existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
    if (!existsSync(dirname(destination)) || !statSync(dirname(destination)).isDirectory()) {
      throw new Error("Destination parent directory does not exist.");
    }
    if (lstatSync(source).isDirectory()) {
      const fromSource = relative(source, destination);
      if (fromSource === "" || (!fromSource.startsWith(`..${sep}`) && fromSource !== ".." && !isAbsolute(fromSource))) {
        throw new Error("Cannot move a directory into itself.");
      }
    }
    if (!await confirm()) return false;
    if (this.resolveInput(arguments_.source) !== source || this.resolveInput(arguments_.destination) !== destination
      || this.resolveInput(source) !== source || this.resolveInput(destination) !== destination) {
      throw new Error("Move paths changed during approval. Request approval again.");
    }
    renameSync(source, destination);
    return true;
  }
}

function limitedDiff(path: string, previous: string, next: string): string {
  const patch = createTwoFilesPatch(path, path, previous, next, "", "", { context: 3 });
  const lines = patch.split(/(?<=\n)/u);
  if (lines.length <= MAX_DIFF_LINES) return patch;
  return `${lines.slice(0, MAX_DIFF_LINES).join("")}... diff truncated ...\n`;
}
