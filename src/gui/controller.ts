import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { FolderAccessChangedError, FolderGrants, type FolderGrant } from "./folder-grants";
import { dirname, join } from "node:path";
import { ModelConfig, dataHome, loadConfig, saveConfig, type ModelId, type ReasoningEffort } from "../config";
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
import type { FolderAccess, WorkspaceListing } from "./shared";
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
  folderGrantVersion?: string;
  exec?: boolean;
  images?: UserImageContentPart[];
}

export interface GuiRunCallbacks {
  loadImages?: () => UserImageContentPart[];
  onStarted?: () => void;
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

function describeFolderAccess(grant?: FolderGrant, validWorkspace?: string): FolderAccess {
  return {
    workspace: grant?.path,
    validWorkspace,
    folderGrantVersion: grant?.version,
    folderSessionOnly: grant?.identity.startsWith("session:") ?? false,
  };
}

export class GuiController {
  private readonly grants = new FolderGrants();
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

  assertActiveBot(botId: unknown): asserts botId is string {
    if (typeof botId !== "string" || !botId || botId !== this.activeBotId) throw new Error("Select this bot first.");
  }

  folderAccess(): FolderAccess {
    const grant = this.activeBotId ? this.grants.read(this.activeBotId) : undefined;
    const valid = this.activeBotId && grant && this.grants.matches(this.activeBotId, grant);
    return describeFolderAccess(grant, valid ? grant.path : undefined);
  }

  grantFolder(botId: string, folder: string): FolderAccess {
    this.assertActiveBot(botId);
    const grant = this.grants.grant(botId, folder);
    return describeFolderAccess(grant, grant.path);
  }

  revokeFolder(botId: string): FolderAccess {
    this.assertActiveBot(botId);
    this.grants.revoke(botId);
    return describeFolderAccess();
  }

  setStream(enabled: boolean): void {
    this.stream = Boolean(enabled);
    this.persistPreferences();
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
    if (options.local && options.toa) throw new Error("Local workspace mode cannot be used with Tree of Agents.");
    if (options.exec) throw new Error("Shell commands are unavailable for folder-scoped bots.");
    let localWorkspace: LocalWorkspace | undefined;
    if (options.local) {
      this.assertActiveBot(options.sessionId);
      const grant = this.grants.read(options.sessionId);
      if (grant && grant.version === options.folderGrantVersion) {
        localWorkspace = this.workspaceForBot(options.sessionId, grant, callbacks);
      }
      if (!localWorkspace) throw new FolderAccessChangedError(this.folderAccess());
    }
    const images = callbacks.loadImages ? callbacks.loadImages() : options.images;
    callbacks.onStarted?.();
    const apiKey = this.apiKey();
    if (!apiKey) throw new Error("Sign in to DeepSeek or add an API key in Settings.");
    return this.taskRunner(apiKey, options.task, this.config, {
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      botProfile: options.botProfile,
      history: options.history,
      webMode: options.webMode ?? "auto",
      toa: options.toa ?? false,
      toaWorkers: options.toaWorkers ?? 2,
      onContent: this.canStream(options) ? callbacks.onContent : undefined,
      localWorkspace,
      images,
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

  private workspaceForBot(botId: string, grant: FolderGrant, callbacks: GuiRunCallbacks = {}): LocalWorkspace | undefined {
    if (!this.grants.matches(botId, grant)) return undefined;
    const workspace = new LocalWorkspace(grant.path, callbacks.onLocalAction ?? (() => false), callbacks.onLocalActivity, {
      signal: callbacks.signal,
      onFileChange: callbacks.onFileChange,
      assertAccess: () => {
        this.assertActiveBot(botId);
        const current = this.grants.read(botId);
        if (current?.version !== grant.version || current.path !== grant.path || current.identity !== grant.identity || !this.grants.matches(botId, grant)) {
          throw new Error("Folder access has changed.");
        }
      },
    });
    return workspace.root === grant.path ? workspace : undefined;
  }

  workspaceEntries(botId: string, path = ".", folderGrantVersion?: string): WorkspaceListing {
    this.assertActiveBot(botId);
    const grant = this.grants.read(botId);
    const workspace = grant && this.workspaceForBot(botId, grant);
    const access = describeFolderAccess(grant, workspace?.root);
    if (!workspace || (path !== "." && grant?.version !== folderGrantVersion)) return { access, entries: [] };
    try {
      const payload = JSON.parse(workspace.list({ path })) as { entries: Array<{ path: string; type: string }> };
      return { access, entries: payload.entries };
    } catch (error) {
      const access = this.folderAccess();
      if (!access.validWorkspace || access.folderGrantVersion !== grant?.version) return { access, entries: [] };
      throw error;
    }
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
