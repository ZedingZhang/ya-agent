import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ModelConfig, dataHome, loadConfig, saveConfig } from "../config";
import { loadApiKey, saveApiKey } from "../keychain";
import {
  LocalWorkspace,
  auditLogFiles,
  auditLogTotalBytes,
  clearAuditLogs,
  type LocalActivity,
  type LocalConfirmation,
} from "../local";
import {
  cardsToPrune,
  createCandidate,
  listCards,
  pruneCards,
  selectRelevantCards,
  setStatus,
  type MemoryCard,
  type MemoryKind,
  type MemoryMatch,
} from "../memory";
import { shouldUseWeb, type RunResult } from "../orchestrator";
import { runTask, type RunTaskOptions } from "../service";
import type { UserImageContentPart, WebMode } from "../types";

export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface GuiPreferences {
  language: Language;
  workspace?: string;
  stream: boolean;
}

export interface GuiTaskOptions {
  task: string;
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  stream?: boolean;
  local?: boolean;
  workspace?: string;
  images?: UserImageContentPart[];
}

export interface GuiRunCallbacks {
  onContent?: (content: string) => void;
  onLocalAction?: LocalConfirmation;
  onLocalActivity?: (activity: LocalActivity) => void;
}

export type TaskRunner = (
  apiKey: string,
  task: string,
  config: ModelConfig,
  options?: RunTaskOptions,
) => Promise<RunResult>;

export function preferencesPath(): string {
  return join(dataHome(), "gui.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadPreferences(): GuiPreferences {
  const path = preferencesPath();
  if (!existsSync(path)) return { language: "en", stream: true };
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(value)) return { language: "en", stream: true };
    const language = LANGUAGES.includes(value.language as Language) ? value.language as Language : "en";
    const workspace = typeof value.workspace === "string" ? value.workspace : undefined;
    const stream = typeof value.stream === "boolean" ? value.stream : true;
    return { language, ...(workspace ? { workspace } : {}), stream };
  } catch {
    return { language: "en", stream: true };
  }
}

export function savePreferences(language: Language, workspace?: string, stream = true): void {
  if (!LANGUAGES.includes(language)) throw new Error("GUI language must be en or zh-CN.");
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ language, workspace: workspace ?? null, stream }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export class GuiController {
  config: ModelConfig;
  language: Language;
  workspace?: string;
  stream: boolean;
  private sessionApiKey?: string;
  private readonly taskRunner: TaskRunner;

  constructor(taskRunner: TaskRunner = runTask) {
    this.config = loadConfig();
    const preferences = loadPreferences();
    this.language = preferences.language;
    this.workspace = preferences.workspace;
    this.stream = preferences.stream;
    this.taskRunner = taskRunner;
  }

  private persistPreferences(): void {
    savePreferences(this.language, this.workspace, this.stream);
  }

  setLanguage(language: Language): void {
    if (!LANGUAGES.includes(language)) throw new Error("GUI language must be en or zh-CN.");
    this.language = language;
    this.persistPreferences();
  }

  setWorkspace(value: string): string {
    const workspace = resolve(value);
    if (!existsSync(workspace)) throw new Error(`Workspace does not exist: ${value}`);
    const physical = realpathSync(workspace);
    if (!statSync(physical).isDirectory()) throw new Error(`Workspace is not a directory: ${physical}`);
    this.workspace = physical;
    this.persistPreferences();
    return physical;
  }

  setStream(enabled: boolean): void {
    this.stream = Boolean(enabled);
    this.persistPreferences();
  }

  validWorkspace(): string | undefined {
    if (!this.workspace) return undefined;
    try {
      const workspace = realpathSync(resolve(this.workspace));
      return statSync(workspace).isDirectory() ? workspace : undefined;
    } catch {
      return undefined;
    }
  }

  saveModelConfig(config: ModelConfig): void {
    config.validate();
    saveConfig(config);
    this.config = config;
  }

  setSessionApiKey(apiKey: string): void {
    if (!apiKey.trim()) throw new Error("API key cannot be empty.");
    this.sessionApiKey = apiKey.trim();
  }

  saveMacosApiKey(apiKey: string): void {
    saveApiKey(apiKey);
    this.sessionApiKey = apiKey.trim();
  }

  apiKey(): string | undefined {
    return this.sessionApiKey ?? loadApiKey();
  }

  canStream(options: GuiTaskOptions): boolean {
    return (options.stream ?? true)
      && !options.toa
      && !options.local
      && !shouldUseWeb(options.task, options.webMode ?? "auto");
  }

  async run(options: GuiTaskOptions, callbacks: GuiRunCallbacks = {}): Promise<RunResult> {
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error("No DeepSeek API key found. Add one in Settings.");
    if (options.local && options.toa) throw new Error("Local workspace mode cannot be used with Tree of Agents.");
    let localWorkspace: LocalWorkspace | undefined;
    if (options.local) {
      const workspace = options.workspace ?? this.validWorkspace();
      if (!workspace) throw new Error("Choose an existing local workspace before running this task.");
      localWorkspace = new LocalWorkspace(
        workspace,
        callbacks.onLocalAction ?? (() => false),
        callbacks.onLocalActivity,
      );
    }
    return this.taskRunner(apiKey, options.task, this.config, {
      webMode: options.webMode ?? "auto",
      toa: options.toa ?? false,
      toaWorkers: options.toaWorkers ?? 2,
      onContent: this.canStream(options) ? callbacks.onContent : undefined,
      localWorkspace,
      images: options.images,
    });
  }

  cards(): MemoryCard[] {
    return listCards();
  }

  relevantCards(task: string): MemoryMatch[] {
    return selectRelevantCards(task);
  }

  workspaceEntries(path = "."): Array<{ path: string; type: string }> {
    const workspace = this.validWorkspace();
    if (!workspace) return [];
    const payload = JSON.parse(new LocalWorkspace(workspace, () => false).list({ path })) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.entries)) return [];
    return payload.entries.filter(isRecord).map((entry) => ({ path: String(entry.path), type: String(entry.type) }));
  }

  createMemory(text: string, evidence: string, kind: MemoryKind): MemoryCard {
    return createCandidate(text, evidence, kind);
  }

  setMemoryStatus(cardId: string, status: "approved" | "rejected" | "revoked"): MemoryCard {
    return setStatus(cardId, status);
  }

  prunePreview(includeCandidates = false): MemoryCard[] {
    return cardsToPrune(includeCandidates);
  }

  prune(includeCandidates = false): MemoryCard[] {
    return pruneCards(includeCandidates);
  }

  auditLogs(): string[] {
    return auditLogFiles();
  }

  auditLogTotalBytes(): number {
    return auditLogTotalBytes();
  }

  clearAuditLogs(): string[] {
    return clearAuditLogs();
  }
}
