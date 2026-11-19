import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { ModelConfig, dataHome, BOT_PERMISSIONS_DIR, loadConfig, saveConfig, type ModelId, type ReasoningEffort } from "../config";
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
import {
  getTask,
  listTasks,
  reconcileInterruptedTasks,
  runTask,
  type ListTasksOptions,
  type RunTaskOptions,
  type TaskRecord,
} from "../service";
import type { BotProfile, ConversationMessage, UserImageContentPart, WebMode } from "../types";
import type { CommandEvent } from "../commands";
import type { FileChange } from "../file-diff";
import { loadAccountCredential, type DeepSeekCredential } from "../credentials";

export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface GuiPreferences {
  language: Language;
  stream: boolean;
}

export interface GuiTaskOptions {
  sessionId?: string;
  botProfile?: BotProfile;
  task: string;
  history?: ConversationMessage[];
  webMode?: WebMode;
  toa?: boolean;
  toaWorkers?: number;
  stream?: boolean;
  local?: boolean;
  exec?: boolean;
  images?: UserImageContentPart[];
}

export interface GuiRunCallbacks {
  onContent?: (content: string) => void;
  onLocalAction?: LocalConfirmation;
  onLocalActivity?: (activity: LocalActivity) => void;
  onCommandEvent?: (event: CommandEvent) => void;
  onFileChange?: (change: FileChange) => void;
  signal?: AbortSignal;
}

export type TaskRunner = (
  apiKey: DeepSeekCredential,
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
    const stream = typeof value.stream === "boolean" ? value.stream : true;
    return { language, stream };
  } catch {
    return { language: "en", stream: true };
  }
}

export function savePreferences(language: Language, stream = true): void {
  if (!LANGUAGES.includes(language)) throw new Error("GUI language must be en or zh-CN.");
  const path = preferencesPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ language, stream }, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export class GuiController {
  private pendingPrune?: { ids: string[]; includeCandidates: boolean };
  config: ModelConfig;
  language: Language;
  activeBotId?: string;
  stream: boolean;
  private sessionApiKey?: string;
  private readonly taskRunner: TaskRunner;

  constructor(taskRunner: TaskRunner = runTask) {
    this.config = loadConfig();
    const preferences = loadPreferences();
    this.language = preferences.language;
    this.stream = preferences.stream;
    this.taskRunner = taskRunner;
    reconcileInterruptedTasks();
  }

  private persistPreferences(): void {
    savePreferences(this.language, this.stream);
  }

  setLanguage(language: Language): void {
    if (!LANGUAGES.includes(language)) throw new Error("GUI language must be en or zh-CN.");
    this.language = language;
    this.persistPreferences();
  }

  private grantPath(botId: string): string {
    return join(dataHome(), BOT_PERMISSIONS_DIR, createHash("sha256").update(botId).digest("hex"));
  }

  assertActiveBot(botId: unknown): asserts botId is string {
    if (typeof botId !== "string" || !botId || botId !== this.activeBotId) throw new Error("Select this bot first.");
  }

  get workspace(): string | undefined {
    if (!this.activeBotId) return undefined;
    try {
      const folder = readFileSync(this.grantPath(this.activeBotId), "utf8");
      return isAbsolute(folder) ? folder : undefined;
    } catch {
      return undefined;
    }
  }

  grantFolder(botId: string, folder: string): void {
    this.assertActiveBot(botId);
    const physical = realpathSync(folder);
    if (!statSync(physical).isDirectory()) throw new Error("Choose an existing folder.");
    const path = this.grantPath(botId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = path + "." + randomUUID();
    try {
      writeFileSync(temp, physical, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  revokeFolder(botId: string): void {
    this.assertActiveBot(botId);
    rmSync(this.grantPath(botId), { force: true });
  }

  setStream(enabled: boolean): void {
    this.stream = Boolean(enabled);
    this.persistPreferences();
  }

  validWorkspace(): string | undefined {
    const workspace = this.workspace;
    if (!workspace) return undefined;
    try {
      return realpathSync(workspace) === workspace && statSync(workspace).isDirectory() ? workspace : undefined;
    } catch {
      return undefined;
    }
  }

  saveModelConfig(config: ModelConfig): void {
    config.validate();
    saveConfig(config);
    this.config = config;
  }

  saveWorkspaceModelSelection(model: ModelId, reasoningEffort: ReasoningEffort): void {
    this.saveModelConfig(new ModelConfig({
      model,
      reasoningEffort,
      thinkingEnabled: this.config.thinkingEnabled,
      toaTokenBudget: this.config.toaTokenBudget,
      toaTimeout: this.config.toaTimeout,
    }));
  }

  setSessionApiKey(apiKey: string): void {
    if (!apiKey.trim()) throw new Error("API key cannot be empty.");
    this.sessionApiKey = apiKey.trim();
  }

  saveMacosApiKey(apiKey: string): void {
    saveApiKey(apiKey);
    this.sessionApiKey = apiKey.trim();
  }

  apiKey(): DeepSeekCredential | undefined {
    return loadAccountCredential() ?? this.sessionApiKey ?? loadApiKey();
  }

  canStream(options: GuiTaskOptions): boolean {
    return (options.stream ?? true)
      && !options.toa
      && !options.local
      && !shouldUseWeb(options.task, options.webMode ?? "auto");
  }

  async run(options: GuiTaskOptions, callbacks: GuiRunCallbacks = {}): Promise<RunResult> {
    callbacks.signal?.throwIfAborted();
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error("Sign in to DeepSeek or add an API key in Settings.");
    if (options.local && options.toa) throw new Error("Local workspace mode cannot be used with Tree of Agents.");
    if (options.exec) throw new Error("Shell commands are unavailable for folder-scoped bots.");
    const localWorkspace = options.local ? this.workspaceForBot(options.sessionId, callbacks) : undefined;
    if (options.local && !localWorkspace) throw new Error("Grant this bot access to an existing folder first.");
    return this.taskRunner(apiKey, options.task, this.config, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      botProfile: options.botProfile,
      history: options.history,
      webMode: options.webMode ?? "auto",
      toa: options.toa ?? false,
      toaWorkers: options.toaWorkers ?? 2,
      onContent: this.canStream(options) ? callbacks.onContent : undefined,
      localWorkspace,
      images: options.images,
      signal: callbacks.signal,
    });
  }

  task(id: string): TaskRecord | undefined {
    return getTask(id);
  }

  tasks(options?: ListTasksOptions): TaskRecord[] {
    return listTasks(options);
  }

  cards(): MemoryCard[] {
    return listCards();
  }

  relevantCards(task: string): MemoryMatch[] {
    return selectRelevantCards(task);
  }

  private workspaceForBot(botId: string | undefined, callbacks: GuiRunCallbacks = {}): LocalWorkspace | undefined {
    this.assertActiveBot(botId);
    const folder = this.validWorkspace();
    if (!folder) return undefined;
    const workspace = new LocalWorkspace(folder, callbacks.onLocalAction ?? (() => false), callbacks.onLocalActivity, {
      signal: callbacks.signal,
      onFileChange: callbacks.onFileChange,
      assertAccess: () => {
        this.assertActiveBot(botId);
        if (this.validWorkspace() !== folder) throw new Error("Folder access has changed.");
      },
    });
    return workspace.root === folder ? workspace : undefined;
  }

  workspaceEntries(botId: string, path = "."): Array<{ path: string; type: string }> {
    const workspace = this.workspaceForBot(botId);
    if (!workspace) return [];
    const payload = JSON.parse(workspace.list({ path })) as unknown;
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
    const cards = cardsToPrune(includeCandidates);
    this.pendingPrune = { ids: cards.map((card) => card.id), includeCandidates };
    return cards;
  }

  prune(includeCandidates = false): MemoryCard[] {
    const preview = this.pendingPrune;
    this.pendingPrune = undefined;
    if (!preview || preview.includeCandidates !== includeCandidates) throw new Error("Preview memory cards before confirming prune.");
    return pruneCards(preview.ids, includeCandidates);
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
