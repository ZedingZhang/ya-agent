import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { dataHome } from "./config";
import { abortable } from "./cancellation";
import { DEFAULT_COMMAND_TIMEOUT_SECONDS, MAX_COMMAND_TIMEOUT_SECONDS, runCommand, type CommandEvent, type CommandResult } from "./commands";
import type { ToolArguments, ToolDefinition, ToolHandler } from "./types";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_DIFF_LINES = 200;
export let AUDIT_LOG_MAX_BYTES = 1024 * 1024;
export const MAX_AUDIT_ARCHIVES = 3;

export interface LocalAction {
  operation: "mkdir" | "write" | "move" | "run";
  paths: string[];
  summary: string;
  diff?: string;
}

export interface LocalActivity {
  operation: "list" | "read" | "search" | "mkdir" | "write" | "move" | "run";
  paths: string[];
  status: "success" | "denied" | "error";
}

export type LocalConfirmation = (action: LocalAction) => boolean | Promise<boolean>;
export type LocalActivityObserver = (activity: LocalActivity) => void;

export interface LocalWorkspaceOptions {
  commandsEnabled?: boolean;
  signal?: AbortSignal;
  onCommandEvent?: (event: CommandEvent) => void;
}

export const LOCAL_RUN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "local_run",
    description: "Run an approved shell command to check, test, or build the project. On Windows use cmd.exe syntax; on macOS/Linux use /bin/sh syntax. stdin is closed: use non-interactive, one-shot commands, not watch modes. Returns status, exit code, stdout and stderr tails (64 KiB each), truncation flags and duration. cwd must be inside the workspace; this is not a sandbox. Commands run with the user's permissions after separate approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", minLength: 1, maxLength: 8_192 },
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
      description: "Read a UTF-8 text file up to 1 MiB inside the authorized workspace. Sensitive files are blocked.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "local_search",
      description: "Search file names and non-sensitive UTF-8 text files inside the authorized workspace.",
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
      description: "Create or replace a UTF-8 text file inside the workspace. Its parent must already exist. The client shows a diff and asks before writing.",
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
      name: "local_move",
      description: "Move or rename a file or directory inside the workspace without replacing a destination. The client asks before writing.",
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

export class LocalWorkspace {
  readonly root: string;
  confirm: LocalConfirmation;
  readonly onActivity?: LocalActivityObserver;
  readonly commandResults: CommandResult[] = [];

  constructor(root: string, confirm: LocalConfirmation, onActivity?: LocalActivityObserver, private readonly options: LocalWorkspaceOptions = {}) {
    const expanded = resolve(expandHome(root));
    if (!existsSync(expanded)) throw new Error(`Workspace does not exist: ${expanded}`);
    const resolved = realpathSync(expanded);
    if (!statSync(resolved).isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    this.root = resolved;
    this.confirm = confirm;
    this.onActivity = onActivity;
  }

  get commandsEnabled(): boolean { return this.options.commandsEnabled === true; }

  get tools(): ToolDefinition[] { return this.commandsEnabled ? [...LOCAL_TOOLS, LOCAL_RUN_TOOL] : [...LOCAL_TOOLS]; }

  get toolHandlers(): Record<string, ToolHandler> {
    return {
      local_list: (arguments_) => this.list(arguments_),
      local_read: (arguments_) => this.read(arguments_),
      local_search: (arguments_) => this.search(arguments_),
      local_mkdir: (arguments_) => this.mkdir(arguments_),
      local_write: (arguments_) => this.write(arguments_),
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

  private resolveInput(value: unknown): string {
    this.options.signal?.throwIfAborted();
    if (typeof value !== "string" || !value.trim()) throw new Error("A non-empty path is required.");
    const expanded = expandHome(value);
    const candidate = resolve(isAbsolute(expanded) ? expanded : join(this.root, expanded));
    let ancestor = candidate;
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const physicalAncestor = existsSync(ancestor) ? realpathSync(ancestor) : ancestor;
    const physical = resolve(physicalAncestor, relative(ancestor, candidate));
    const fromRoot = relative(this.root, physical);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Path must remain inside the authorized workspace.");
    }
    return physical;
  }

  private relativePath(path: string): string {
    return relative(this.root, path) || ".";
  }

  private isSensitive(path: string): boolean {
    const lowered = basename(path).toLocaleLowerCase("und");
    const extension = lowered.includes(".") ? lowered.slice(lowered.lastIndexOf(".")) : "";
    if (path.split(sep).some((part) => part === ".git")) return true;
    if (lowered === ".env" || lowered.startsWith(".env.")) return true;
    if (["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json"].includes(lowered)) return true;
    return [".pem", ".key", ".p12", ".pfx", ".kdbx", ".der", ".token"].includes(extension) || lowered.includes("secret");
  }

  private readText(path: string, allowSensitive = false): string {
    if (this.isSensitive(path) && !allowSensitive) throw new Error("Reading sensitive files is blocked in local mode.");
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
    if (statSync(path).size > MAX_TEXT_BYTES) throw new Error("Text files larger than 1 MiB cannot be read or replaced.");
    const data = readFileSync(path);
    if (data.includes(0)) throw new Error("Binary files cannot be read in local mode.");
    try {
      // Preserve the BOM as content so reads, approval diffs, and writes agree.
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw new Error("Only UTF-8 text files can be read in local mode.");
    }
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
    const approved = await abortable(Promise.resolve(this.confirm(action)), this.options.signal);
    this.options.signal?.throwIfAborted();
    if (approved) return true;
    this.audit(action.operation, action.paths, "denied");
    this.activity(action.operation, action.paths, "denied");
    return false;
  }

  async run(arguments_: ToolArguments): Promise<string> {
    if (!this.commandsEnabled) throw new Error("Command execution is not enabled for this task.");
    const command = arguments_.command;
    if (typeof command !== "string" || !command.trim() || command.includes("\0") || command.length > 8_192) {
      throw new Error("Command must be non-empty, contain no NUL bytes, and be at most 8192 characters.");
    }
    const timeout = arguments_.timeout_seconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_COMMAND_TIMEOUT_SECONDS) {
      throw new Error(`Command timeout must be an integer from 1 to ${MAX_COMMAND_TIMEOUT_SECONDS} seconds.`);
    }
    const cwdInput = arguments_.cwd ?? ".";
    const cwd = this.resolveInput(cwdInput);
    try {
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
      const action: LocalAction = {
        operation: "run", paths: [cwd],
        summary: `Run command:\n${command}\nDirectory: ${cwd}\nTimeout: ${timeout}s\nRuns with your account permissions and can modify files or access the network.`,
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

  list(arguments_: ToolArguments): string {
    const path = this.resolveInput(arguments_.path ?? ".");
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Not a directory: ${path}`);
    const allEntries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    const entries = allEntries.slice(0, MAX_LIST_ENTRIES).map((entry) => {
      const child = join(path, entry.name);
      const type = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file";
      return { path: this.relativePath(child), type };
    });
    this.activity("list", [path], "success");
    return JSON.stringify({ path: this.relativePath(path), entries, limited: allEntries.length > MAX_LIST_ENTRIES });
  }

  read(arguments_: ToolArguments): string {
    const path = this.resolveInput(arguments_.path);
    const content = this.readText(path);
    this.activity("read", [path], "success");
    return JSON.stringify({ path: this.relativePath(path), content });
  }

  search(arguments_: ToolArguments): string {
    const query = arguments_.query;
    if (typeof query !== "string" || !query.trim()) throw new Error("A non-empty search query is required.");
    const root = this.resolveInput(arguments_.path ?? ".");
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Not a directory: ${root}`);
    const needle = query.toLocaleLowerCase("und");
    const results: Array<Record<string, unknown>> = [];
    const paths = this.walkFiles(root);
    for (const path of paths) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      const relativePath = this.relativePath(path);
      if (basename(path).toLocaleLowerCase("und").includes(needle)) {
        results.push({ path: relativePath, match: "filename" });
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
      try {
        const text = this.readText(path);
        const lines = text.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.toLocaleLowerCase("und").includes(needle)) {
            results.push({ path: relativePath, match: "text", line: index + 1, text: line.slice(0, 400) });
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }
        }
      } catch {
        // Binary, oversized, and sensitive files are intentionally skipped.
      }
    }
    this.activity("search", [root], "success");
    return JSON.stringify({ query, results, limited: results.length >= MAX_SEARCH_RESULTS });
  }

  private walkFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink() || this.isSensitive(path)) continue;
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) files.push(path);
      }
    };
    visit(root);
    return files;
  }

  async mkdir(arguments_: ToolArguments): Promise<string> {
    const path = this.resolveInput(arguments_.path);
    const action: LocalAction = { operation: "mkdir", paths: [path], summary: `Create directory: ${path}` };
    try {
      if (existsSync(path)) throw new Error(`Path already exists: ${path}`);
      if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new Error("Parent directory does not exist; create it first.");
      if (!(await this.confirmed(action))) {
        return JSON.stringify({ status: "denied", operation: "mkdir", path: this.relativePath(path), reason: "User declined this action." });
      }
      mkdirSync(path);
      this.audit("mkdir", [path], "success");
      this.activity("mkdir", [path], "success");
      return JSON.stringify({ status: "ok", operation: "mkdir", path: this.relativePath(path) });
    } catch (error) {
      this.audit("mkdir", [path], "error", errorMessage(error));
      this.activity("mkdir", [path], "error");
      throw error;
    }
  }

  async write(arguments_: ToolArguments): Promise<string> {
    const path = this.resolveInput(arguments_.path);
    const content = arguments_.content;
    if (typeof content !== "string") throw new Error("Text content is required.");
    try {
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_BYTES) throw new Error("Text content larger than 1 MiB cannot be written.");
      if (existsSync(path) && statSync(path).isDirectory()) throw new Error(`Path is a directory: ${path}`);
      if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new Error("Parent directory does not exist; create it first.");
      const previous = existsSync(path) ? this.readText(path, true) : undefined;
      const action: LocalAction = previous === undefined
        ? { operation: "write", paths: [path], summary: `Create text file: ${path}` }
        : { operation: "write", paths: [path], summary: `Replace text file: ${path}`, diff: limitedDiff(path, previous, content) };
      if (!(await this.confirmed(action))) {
        return JSON.stringify({ status: "denied", operation: "write", path: this.relativePath(path), reason: "User declined this action." });
      }
      writeFileSync(path, content, "utf8");
      this.audit("write", [path], "success");
      this.activity("write", [path], "success");
      return JSON.stringify({ status: "ok", operation: "write", path: this.relativePath(path) });
    } catch (error) {
      this.audit("write", [path], "error", errorMessage(error));
      this.activity("write", [path], "error");
      throw error;
    }
  }

  async move(arguments_: ToolArguments): Promise<string> {
    const source = this.resolveInput(arguments_.source);
    const destination = this.resolveInput(arguments_.destination);
    const action: LocalAction = { operation: "move", paths: [source, destination], summary: `Move: ${source} -> ${destination}` };
    try {
      if (source === this.root || !existsSync(source)) throw new Error(`Source does not exist: ${source}`);
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
      if (!(await this.confirmed(action))) {
        return JSON.stringify({ status: "denied", operation: "move", path: this.relativePath(source), reason: "User declined this action." });
      }
      renameSync(source, destination);
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
}

function limitedDiff(path: string, previous: string, next: string): string {
  const patch = createTwoFilesPatch(path, path, previous, next, "", "", { context: 3 });
  const lines = patch.split(/(?<=\n)/u);
  if (lines.length <= MAX_DIFF_LINES) return patch;
  return `${lines.slice(0, MAX_DIFF_LINES).join("")}... diff truncated ...\n`;
}
