import { MAX_COMMAND_LINES, MAX_COMMAND_TIMEOUT_SECONDS, type CommandEvent } from "./commands";
import { MAX_EDITS } from "./edits";
import type { FileChange } from "./file-diff";
import type { ToolDefinition } from "./types";

export interface LocalAction {
  operation: "mkdir" | "write" | "edit" | "move" | "run";
  paths: string[];
  summary: string;
  diff?: string;
}

export interface LocalActivity {
  operation: "list" | "read" | "search" | "mkdir" | "write" | "edit" | "move" | "run";
  paths: string[];
  status: "success" | "denied" | "error" | "pending";
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
  list(directory: string, signal?: AbortSignal, onResolved?: (path: string) => void): Promise<string>;
  read(file: string, signal?: AbortSignal, onResolved?: (path: string) => void): Promise<string>;
  search(directory: string, query: string, signal?: AbortSignal, onResolved?: (path: string) => void): Promise<string>;
  write(file: string, content: string, confirm: (previous: string | undefined, path: string) => Promise<boolean>, signal?: AbortSignal): Promise<{ approved: boolean; previous?: string }>;
  mkdir(path: string, confirm: (path: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean>;
  edit(path: string, revision: string, edits: unknown, confirm: ConfirmEdit, signal?: AbortSignal): Promise<EditResult>;
  move(source: string, destination: string, confirm: (source: string, destination: string) => Promise<boolean>, signal?: AbortSignal): Promise<boolean>;
}

export interface LocalWorkspaceOptions<Scope extends ScopedFolderIO | undefined = undefined> {
  scopedFolder?: Scope;
  assertAccess?: () => void;
  assertPreviewAccess?: () => void;
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
