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
import {
  assertTextSize as nativeAssertTextSize,
  decodeTextFile as nativeDecodeTextFile,
  isSensitiveFile as nativeIsSensitiveFile,
  localLimits,
  localToolDefinitions,
  tailCompleteLines as nativeTailCompleteLines,
} from "ya-core";
import { dataHome } from "./config";
import type { ToolArguments, ToolDefinition, ToolHandler } from "./types";

/** The limits and the tool contracts live in the Rust core. */
const LIMITS = localLimits();

export const MAX_TEXT_BYTES = LIMITS.maxTextBytes;
export const MAX_LIST_ENTRIES = LIMITS.maxListEntries;
export const MAX_SEARCH_RESULTS = LIMITS.maxSearchResults;
export const MAX_DIFF_LINES = LIMITS.maxDiffLines;
export const MAX_AUDIT_ARCHIVES = LIMITS.maxAuditArchives;
export let AUDIT_LOG_MAX_BYTES = LIMITS.auditLogMaxBytes;

export interface LocalAction {
  operation: "mkdir" | "write" | "move";
  paths: string[];
  summary: string;
  diff?: string;
}

export interface LocalActivity {
  operation: "list" | "read" | "search" | "mkdir" | "write" | "move";
  paths: string[];
  status: "success" | "denied" | "error";
}

export type LocalConfirmation = (action: LocalAction) => boolean | Promise<boolean>;
export type LocalActivityObserver = (activity: LocalActivity) => void;

export const LOCAL_TOOLS: ToolDefinition[] = JSON.parse(localToolDefinitions()) as ToolDefinition[];

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
  return nativeTailCompleteLines(data, limit);
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

  constructor(root: string, confirm: LocalConfirmation, onActivity?: LocalActivityObserver) {
    const expanded = resolve(expandHome(root));
    if (!existsSync(expanded)) throw new Error(`Workspace does not exist: ${expanded}`);
    const resolved = realpathSync(expanded);
    if (!statSync(resolved).isDirectory()) throw new Error(`Workspace is not a directory: ${resolved}`);
    this.root = resolved;
    this.confirm = confirm;
    this.onActivity = onActivity;
  }

  get toolHandlers(): Record<string, ToolHandler> {
    return {
      local_list: (arguments_) => this.list(arguments_),
      local_read: (arguments_) => this.read(arguments_),
      local_search: (arguments_) => this.search(arguments_),
      local_mkdir: (arguments_) => this.mkdir(arguments_),
      local_write: (arguments_) => this.write(arguments_),
      local_move: (arguments_) => this.move(arguments_),
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
    // Splitting the path is Node path semantics; the policy itself is in Rust.
    return nativeIsSensitiveFile(basename(path).toLocaleLowerCase("und"), path.split(sep));
  }

  private readText(path: string, allowSensitive = false): string {
    if (this.isSensitive(path) && !allowSensitive) throw new Error("Reading sensitive files is blocked in local mode.");
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Not a file: ${path}`);
    nativeAssertTextSize(statSync(path).size);
    return nativeDecodeTextFile(readFileSync(path));
  }

  private audit(operation: string, paths: string[], status: string, error?: string): void {
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      workspace: this.root,
      operation,
      paths: paths.map((path) => this.relativePath(path)),
      status,
    };
    if (error) record.error = error;
    appendAuditRecord(record);
  }

  private async confirmed(action: LocalAction): Promise<boolean> {
    if (await this.confirm(action)) return true;
    this.audit(action.operation, action.paths, "denied");
    this.activity(action.operation, action.paths, "denied");
    return false;
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
