import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createTwoFilesPatch } from "diff";
import { BOT_PERMISSIONS_DIR, dataHome } from "./config";
import { abortable } from "./cancellation";
import { applyTextEdits, MAX_EDITS, textRevision } from "./edits";
import { publishEdit } from "./publish-edit";
import { createFileChange, type FileChange } from "./file-diff";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_LINES, MAX_COMMAND_TIMEOUT_SECONDS, runCommand, validateCommand, type CommandEvent, type CommandResult } from "./commands";
import type { ToolArguments, ToolDefinition, ToolHandler } from "./types";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_DIFF_LINES = 200;
export let AUDIT_LOG_MAX_BYTES = 1024 * 1024;
export const MAX_AUDIT_ARCHIVES = 3;

const EXCLUDED_SEARCH_DIRECTORIES = new Set(["node_modules", "dist", ".next"]);

export interface LocalAction {
  operation: "mkdir" | "write" | "edit" | "move" | "run";
  paths: string[];
  summary: string;
  diff?: string;
}

export interface LocalActivity {
  operation: "list" | "read" | "search" | "mkdir" | "write" | "edit" | "move" | "run";
  paths: string[];
  status: "success" | "denied" | "error";
}

export type LocalConfirmation = (action: LocalAction) => boolean | Promise<boolean>;
export type LocalActivityObserver = (activity: LocalActivity) => void;

export interface EditResult {
  approved: boolean;
  previous: string;
  content: string;
  count: number;
}

export type ConfirmEdit = (previous: string, content: string, count: number, path: string) => Promise<boolean>;

export interface ScopedFolderIO {
  list(directory: string, signal?: AbortSignal): Promise<string>;
  read(file: string, signal?: AbortSignal): Promise<string>;
  search(directory: string, query: string, signal?: AbortSignal): Promise<string>;
  write(file: string, content: string, confirm: (previous: string | undefined, path: string) => Promise<boolean>, signal?: AbortSignal): Promise<{ approved: boolean; previous?: string }>;
  mkdir(path: string, confirm: (path: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean>;
  edit(path: string, revision: string, edits: unknown, confirm: ConfirmEdit, signal?: AbortSignal): Promise<EditResult>;
  move(source: string, destination: string, confirm: (source: string, destination: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean>;
}

export interface LocalWorkspaceOptions<Scope extends ScopedFolderIO | undefined = undefined> {
  scopedFolder?: Scope;
  assertAccess?: () => void;
  searchFolder?: (relativeDirectory: string, query: string) => string;
  commandsEnabled?: boolean;
  signal?: AbortSignal;
  onCommandEvent?: (event: CommandEvent) => void;
  onFileChange?: (change: FileChange) => void;
}

export const LOCAL_RUN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "local_run",
    description: "Run an approved shell command to check, test, or build the project. On Windows use cmd.exe syntax; on macOS/Linux use /bin/sh syntax. stdin is closed: use non-interactive, one-shot commands, not watch modes. Returns status, exit code, stdout and stderr tails (64 KiB each), truncation flags and duration. cwd must be inside the workspace; this is not a sandbox. Commands run with the user's permissions after separate approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 8_192, description: `At most ${MAX_COMMAND_LINES} lines. Consecutive blank or whitespace-only lines are refused.` },
        cwd: { type: "string", description: "Working directory relative to the workspace (default: .)." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_COMMAND_TIMEOUT_SECONDS, description: "Timeout in seconds (default: 120, max: 600)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

export const LOCAL_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "local_list",
      description: "List up to 200 entries in a directory inside the authorized workspace.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "local_read",
      description: "Read a UTF-8 text file up to 1 MiB inside the authorized workspace. Returns exact content and its revision for local_edit. Sensitive files are blocked.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "local_search",
      description: "Search file names and non-sensitive UTF-8 text files inside the authorized workspace, skipping node_modules, dist, and .next directories unless selected as the search root.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, path: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "local_mkdir",
      description: "Create one directory inside the workspace. Its parent must already exist. The client asks the user before writing.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "local_write",
      description: "Create a non-sensitive UTF-8 text file, or replace an entire non-sensitive file only when explicitly needed. Prefer local_edit for changes to existing files. Its parent must already exist. The client shows a diff and asks before writing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "local_edit",
      description: "Edit an existing non-sensitive writable UTF-8 file using the revision from local_read and exact old_text/new_text replacements. Each old_text must occur exactly once in the original file, with enough context to disambiguate; ranges cannot overlap. No fuzzy matching or newline normalization. A batch is approved and applied as a whole; stale and read-only files are rejected. On conflict, read again and rebuild the edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          expected_revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          edits: {
            type: "array", minItems: 1, maxItems: MAX_EDITS,
            items: {
              type: "object",
              properties: { old_text: { type: "string", minLength: 1 }, new_text: { type: "string" } },
              required: ["old_text", "new_text"], additionalProperties: false,
            },
          },
        },
        required: ["path", "expected_revision", "edits"], additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "local_move",
      description: "Move or rename a non-sensitive file or directory between non-sensitive paths inside the workspace without replacing a destination. The client asks before writing.",
      parameters: {
        type: "object",
        properties: { source: { type: "string" }, destination: { type: "string" } },
        required: ["source", "destination"],
      },
    },
  },
];

export function setAuditLogMaxBytesForTesting(value: number): void {
  AUDIT_LOG_MAX_BYTES = value;
}

export function auditLogPath(index = 0): string {
  return join(dataHome(), `actions${index === 0 ? "" : `.${index}`}.jsonl`);
}

export function auditLogFiles(): string[] {
  const paths: string[] = [];
  for (let index = 0; index <= MAX_AUDIT_ARCHIVES; index += 1) {
    const path = auditLogPath(index);
    if (existsSync(path) && statSync(path).isFile()) paths.push(path);
  }
  return paths;
}

export function auditLogTotalBytes(): number {
  return auditLogFiles().reduce((total, path) => total + statSync(path).size, 0);
}

export function clearAuditLogs(): string[] {
  const removed = auditLogFiles();
  for (const path of removed) unlinkSync(path);
  return removed;
}

function tailCompleteLines(data: Buffer, limit: number): Buffer {
  if (data.byteLength <= limit) return data;
  const tail = data.subarray(data.byteLength - limit);
  const newline = tail.indexOf(0x0a);
  return newline >= 0 ? tail.subarray(newline + 1) : Buffer.alloc(0);
}

function rotateAuditLogs(): void {
  for (let index = MAX_AUDIT_ARCHIVES; index >= 1; index -= 1) {
    const source = auditLogPath(index - 1);
    const destination = auditLogPath(index);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    if (existsSync(destination)) unlinkSync(destination);
    if (index === 1 && statSync(source).size > AUDIT_LOG_MAX_BYTES) {
      const data = tailCompleteLines(readFileSync(source), AUDIT_LOG_MAX_BYTES);
      const temporary = `${destination}.${process.pid}.tmp`;
      writeFileSync(temporary, data);
      renameSync(temporary, destination);
      unlinkSync(source);
    } else {
      renameSync(source, destination);
    }
  }
}

export function appendAuditRecord(record: Record<string, unknown>): void {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const active = auditLogPath();
  mkdirSync(dirname(active), { recursive: true });
  if (existsSync(active) && statSync(active).size + encoded.byteLength > AUDIT_LOG_MAX_BYTES) rotateAuditLogs();
  appendFileSync(active, encoded);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function isSensitive(path: string): boolean {
  const lowered = basename(path).toLocaleLowerCase("und");
  const extension = lowered.includes(".") ? lowered.slice(lowered.lastIndexOf(".")) : "";
  const parts = path.toLocaleLowerCase("und").split(sep);
  if (parts.includes(".git") || parts.includes(BOT_PERMISSIONS_DIR)) return true;
  if (lowered === ".env" || lowered.startsWith(".env.")) return true;
  if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json", ".git-credentials", ".netrc", ".npmrc"].includes(lowered)) return true;
  return [".pem", ".key", ".p12", ".pfx", ".kdbx", ".der", ".token"].includes(extension) || lowered.includes("secret");
}

function readText(path: string): string {
  if (isSensitive(path)) throw new Error("Reading sensitive files is blocked in local mode.");
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
  if (statSync(path).size > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
  return decodeText(readFileSync(path));
}

function decodeText(data: Buffer): string {
  if (data.includes(0)) throw new Error("Binary files cannot be read in local mode.");
  try {
    // Preserve the BOM as content so reads, approval diffs, and writes agree.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw new Error("Only UTF-8 text files can be read in local mode.");
  }
}

// Open the leaf without truncating or following it. Check the handle against
// its directory entry before reading data or publishing an approved change.
export function openRegularFile(name: string, flags = constants.O_RDONLY): number {
  if (!lstatSync(name).isFile()) throw new Error("Not a regular file.");
  const fd = openSync(name, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const file = fstatSync(fd, { bigint: true });
    const entry = lstatSync(name, { bigint: true });
    if (!file.isFile() || !entry.isFile() || file.dev !== entry.dev || file.ino !== entry.ino) {
      throw new Error("Not a regular file.");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function readOpenedText(fd: number): string {
  const size = fstatSync(fd).size;
  if (size > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
  // Positioned reads keep the descriptor usable across approval. Some virtual
  // files report a size of zero, so enforce the limit on bytes actually read.
  const chunkSize = Math.min(64 * 1024, Math.max(4096, size + 1));
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(chunkSize, MAX_TEXT_BYTES - offset + 1));
    const count = readSync(fd, chunk, 0, chunk.length, offset);
    if (!count) break;
    offset += count;
    if (offset > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
    chunks.push(chunk.subarray(0, count));
  }
  return decodeText(Buffer.concat(chunks, offset));
}

export function readRegularText(name: string): string {
  const fd = openRegularFile(name);
  try { return readOpenedText(fd); } finally { closeSync(fd); }
}

export function searchFiles(root: string, query: string, displayPath: (path: string) => string, checkAccess?: () => void, verifyCwd?: (directory: string) => void): string {
  const needle = query.toLocaleLowerCase("und");
  const results: Array<Record<string, unknown>> = [];
  for (const path of walkFiles(root, checkAccess, verifyCwd)) {
    const relativePath = displayPath(path);
    if (basename(path).toLocaleLowerCase("und").includes(needle)) {
      results.push({ path: relativePath, match: "filename" });
      if (results.length >= MAX_SEARCH_RESULTS) break;
    }
    let text: string;
    try {
      text = verifyCwd ? readRegularText(basename(path)) : readText(path);
    } catch {
      // Binary, oversized, and unreadable files are intentionally skipped.
      continue;
    }
    verifyCwd?.(dirname(path));
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.toLocaleLowerCase("und").includes(needle)) {
        results.push({ path: relativePath, match: "text", line: index + 1, text: line.slice(0, 400) });
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
    if (results.length >= MAX_SEARCH_RESULTS) break;
  }
  verifyCwd?.(root);
  checkAccess?.();
  return JSON.stringify({ query, results, limited: results.length >= MAX_SEARCH_RESULTS });
}

function* walkFiles(root: string, checkAccess?: () => void, verifyCwd?: (directory: string) => void): Generator<string> {
  checkAccess?.();
  verifyCwd?.(root);
  const entries = readdirSync(verifyCwd ? "." : root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  for (const entry of entries) {
    checkAccess?.();
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() || isSensitive(path)) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_SEARCH_DIRECTORIES.has(entry.name)) continue;
      if (verifyCwd) process.chdir(entry.name);
      try {
        yield* walkFiles(path, checkAccess, verifyCwd);
      } finally {
        if (verifyCwd) {
          process.chdir("..");
          verifyCwd(root);
        }
      }
    } else if (entry.isFile()) {
      verifyCwd?.(root);
      yield path;
    }
  }
}

export function listDirectory(path: string, displayPath: string): string {
  const allEntries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
  const entries = allEntries.slice(0, MAX_LIST_ENTRIES).map((entry) => {
    const child = join(displayPath, entry.name);
    const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
    return { path: child, type };
  });
  return JSON.stringify({ path: displayPath, entries, limited: allEntries.length > MAX_LIST_ENTRIES });
}

export function physicalWorkspacePath(root: string, input: string): string {
  const candidate = resolve(root, input);
  let ancestor = candidate;
  // lstat sees dangling links; realpath below must reject them rather than
  // treating the link itself as a new file inside the workspace.
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const physicalAncestor = realpathSync(ancestor);
  const physical = resolve(physicalAncestor, relative(ancestor, candidate));
  const fromRoot = relative(root, physical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Path must remain inside the authorized workspace.");
  }
  return physical;
}

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
      this.options.assertAccess?.();
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
    const fromRoot = relative(this.root, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Path must remain inside the authorized workspace.");
    }
    return candidate;
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
    const path = this.resolveInput(arguments_.path ?? ".");
    if (isSensitive(path)) throw new Error("Listing sensitive directories is blocked in local mode.");
    const relative = this.relativePath(path);
    const finish = (result: string): string => {
      this.activity("list", [path], "success");
      this.options.assertAccess?.();
      return result;
    };
    if (this.options.scopedFolder) return this.options.scopedFolder.list(relative, this.operationSignal(signal)).then(finish);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
    return finish(listDirectory(path, relative));
  }

  read(this: LocalWorkspace<undefined>, arguments_: ToolArguments, signal?: AbortSignal): string;
  read(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string>;
  read(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string> {
    const path = this.resolveInput(arguments_.path);
    if (isSensitive(path)) throw new Error("Reading sensitive files is blocked in local mode.");
    const finish = (content: string): string => {
      this.activity("read", [path], "success");
      this.options.assertAccess?.();
      return JSON.stringify({ path: this.relativePath(path), content, revision: textRevision(content) });
    };
    return this.options.scopedFolder
      ? this.options.scopedFolder.read(this.relativePath(path), this.operationSignal(signal)).then(finish)
      : finish(readText(path));
  }

  search(this: LocalWorkspace<undefined>, arguments_: ToolArguments, signal?: AbortSignal): string;
  search(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string>;
  search(arguments_: ToolArguments, signal?: AbortSignal): string | Promise<string> {
    const query = arguments_.query;
    if (typeof query !== "string" || !query.trim()) throw new Error("A non-empty search query is required.");
    const root = this.resolveInput(arguments_.path ?? ".");
    if (isSensitive(root)) throw new Error("Searching sensitive directories is blocked in local mode.");
    if (this.options.scopedFolder) {
      const active = this.operationSignal(signal);
      return this.options.scopedFolder.search(this.relativePath(root), query, active).then((result) => {
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

  async mkdir(arguments_: ToolArguments): Promise<string> {
    let path = this.resolveInput(arguments_.path);
    try {
      if (isSensitive(path)) throw new Error("Creating sensitive directories is blocked in local mode.");
      const confirm = (resolved?: string): Promise<boolean> => {
        if (resolved !== undefined) path = this.approvalPath(resolved);
        return this.confirmed({ operation: "mkdir", paths: [path], summary: `Create directory: ${path}` });
      };
      const approved = this.options.scopedFolder
        ? await this.options.scopedFolder.mkdir(this.relativePath(path), confirm, this.options.signal)
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

  async write(arguments_: ToolArguments): Promise<string> {
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
        ({ approved, previous } = await this.options.scopedFolder.write(this.relativePath(path), content, confirm, this.options.signal));
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

  async edit(arguments_: ToolArguments): Promise<string> {
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
        ? await this.options.scopedFolder.edit(this.relativePath(path), revision, arguments_.edits, confirm, this.options.signal)
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
    const identity = statSync(path);
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
      const current = statSync(path);
      if (current.dev !== identity.dev || current.ino !== identity.ino || current.mode !== identity.mode || readText(path) !== previous) {
        throw new Error("File changed during approval. Read again before editing.");
      }
    };
    checkUnchanged();
    publishEdit(path, content, identity, checkUnchanged);
    return { approved, previous, content, count };
  }

  async move(arguments_: ToolArguments): Promise<string> {
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
        ? await this.options.scopedFolder.move(this.relativePath(source), this.relativePath(destination), confirm, this.options.signal)
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
