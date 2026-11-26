import { existsSync, readFileSync } from "node:fs";
import { FolderAccessChangedError, FolderGrants, type FolderGrant } from "./folder-grants";
import { GrantedFolderIO } from "./folder-io";
import { join } from "node:path";
import { auditLogFiles, auditLogTotalBytes, clearAuditLogs } from "../audit-log";
import { ModelConfig, dataHome, loadConfig, saveConfig, type ModelId, type ReasoningEffort } from "../config";
import { atomicWriteFileSync } from "../fs-utils";
import { isRecord } from "../guards";
import { loadApiKey, saveApiKey } from "../keychain";
import { LocalWorkspace, type TaskWorkspace } from "../local";
import type { LocalActivity, LocalConfirmation } from "../local-tools";
import {
  cardsToPrune,
  createCandidate,
  listCardsAsync,
  pruneCards,
  selectRelevantCardsAsync,
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
  atomicWriteFileSync(preferencesPath(), `${JSON.stringify({ language, stream }, null, 2)}\n`);
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
  private readonly verifiedGrants = new Map<string, string>();
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

  // Display state only. A task and each operation independently verify the grant.
  folderState(): FolderAccess {
    const botId = this.activeBotId;
    const grant = botId ? this.grants.read(botId) : undefined;
    return describeFolderAccess(grant, botId && grant && this.verifiedGrants.get(botId) === grant.version ? grant.path : undefined);
  }

  async folderAccess(signal?: AbortSignal): Promise<FolderAccess> {
    const botId = this.activeBotId;
    if (!botId) return describeFolderAccess();
    const grant = this.grants.read(botId);
    if (!grant) return describeFolderAccess();
    const valid = await new GrantedFolderIO(this.grants, botId, grant).available(signal);
    this.assertActiveBot(botId);
    if (this.grants.read(botId)?.version !== grant.version) return this.folderState();
    if (valid) this.verifiedGrants.set(botId, grant.version);
    else this.verifiedGrants.delete(botId);
    return describeFolderAccess(grant, valid ? grant.path : undefined);
  }

  folderSelectionSnapshot(botId: string): Buffer | null {
    this.assertActiveBot(botId);
    return this.grants.snapshot(botId);
  }

  async grantFolder(botId: string, folder: string, beforeCommit?: () => void, expected = this.folderSelectionSnapshot(botId)): Promise<FolderAccess> {
    this.assertActiveBot(botId);
    const grant = await this.grants.grant(botId, folder, () => {
      this.assertActiveBot(botId);
      beforeCommit?.();
    }, expected);
    this.verifiedGrants.set(botId, grant.version);
    return describeFolderAccess(grant, grant.path);
  }

  revokeFolder(botId: string): FolderAccess {
    this.assertActiveBot(botId);
    this.grants.revoke(botId);
    this.verifiedGrants.delete(botId);
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
    let localWorkspace: TaskWorkspace | undefined;
    if (options.local) {
      this.assertActiveBot(options.sessionId);
      const access = await this.folderAccess(callbacks.signal);
      const grant = this.grants.read(options.sessionId);
      if (!access.validWorkspace || !grant || grant.version !== options.folderGrantVersion || grant.version !== access.folderGrantVersion) {
        throw new FolderAccessChangedError(access);
      }
      localWorkspace = this.workspaceForBot(options.sessionId, grant, callbacks);
    }
    callbacks.signal?.throwIfAborted();
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

  cards(): Promise<MemoryCard[]> {
    return listCardsAsync();
  }

  relevantCards(task: string): Promise<MemoryMatch[]> {
    return selectRelevantCardsAsync(task);
  }

  private workspaceForBot(botId: string, grant: FolderGrant, callbacks: GuiRunCallbacks = {}): TaskWorkspace {
    const assertGrant = (): void => {
      const current = this.grants.read(botId);
      if (current?.version !== grant.version || current.path !== grant.path || current.identity !== grant.identity) {
        throw new Error("Folder access has changed.");
      }
    };
    return new LocalWorkspace(grant.path, callbacks.onLocalAction ?? (() => false), callbacks.onLocalActivity, {
      signal: callbacks.signal,
      onFileChange: callbacks.onFileChange,
      scopedFolder: new GrantedFolderIO(this.grants, botId, grant),
      assertPreviewAccess: assertGrant,
      assertAccess: () => {
        this.assertActiveBot(botId);
        assertGrant();
      },
    });
  }

  async workspaceEntries(botId: string, path = ".", folderGrantVersion?: string, signal?: AbortSignal): Promise<WorkspaceListing> {
    this.assertActiveBot(botId);
    const grant = this.grants.read(botId);
    if (!grant || (path !== "." && grant.version !== folderGrantVersion)) return { access: await this.folderAccess(signal), entries: [] };
    try {
      const workspace = this.workspaceForBot(botId, grant, { signal });
      const payload = JSON.parse(await workspace.list({ path })) as { entries: Array<{ path: string; type: string }> };
      this.verifiedGrants.set(botId, grant.version);
      return { access: describeFolderAccess(grant, grant.path), entries: payload.entries };
    } catch (error) {
      signal?.throwIfAborted();
      const access = await this.folderAccess(signal);
      if (!access.validWorkspace || access.folderGrantVersion !== grant.version) return { access, entries: [] };
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
