import type { ModelId, ReasoningEffort } from "../config";
import type { CommandEvent } from "../commands";
import type { FileChange } from "../file-diff";
import type { LocalAction, LocalActivity } from "../local";
import type { MemoryCard, MemoryKind, MemoryMatch, MemoryStatus } from "../memory";
import type { RunResult } from "../orchestrator";
import type { ConversationMessage, ImageDetail, WebMode } from "../types";
import type { Language } from "./controller";

export interface SerializedConfig {
  model: ModelId;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  toaTokenBudget: number;
  toaTimeout: number;
}

export interface AppState {
  version: string;
  platform: NodeJS.Platform;
  language: Language;
  workspace?: string;
  validWorkspace?: string;
  workspaces: string[];
  stream: boolean;
  hasApiKey: boolean;
  accountSignedIn: boolean;
  config: SerializedConfig;
  cards: MemoryCard[];
  auditLogCount: number;
  auditLogBytes: number;
}

export interface WorkspaceModelSelection {
  model: ModelId;
  reasoningEffort: ReasoningEffort;
}

export interface SettingsUpdate {
  language: Language;
  stream: boolean;
  thinkingEnabled: boolean;
  toaTokenBudget: number;
  toaTimeout: number;
  apiKey?: string;
  keyStorage?: "session" | "keychain";
}

export interface RendererTaskOptions {
  task: string;
  history?: ConversationMessage[];
  webMode: WebMode;
  toa: boolean;
  toaWorkers: 1 | 2;
  stream: boolean;
  local: boolean;
  exec?: boolean;
  workspace?: string;
  imageIds: string[];
  imageDetail: ImageDetail;
}

export interface SelectedImage {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

export type TaskEvent =
  | { type: "content"; content: string }
  | { type: "activity"; activity: LocalActivity }
  | { type: "command"; event: CommandEvent }
  | { type: "file-change"; change: FileChange }
  | { type: "local-action"; id: string; action: LocalAction };

/** Private transport marker; never forwarded to the renderer's task event listener. */
export type TaskTransportEvent = TaskEvent | { type: "flush"; id: string };

export interface YaBridge {
  state(): Promise<AppState>;
  chooseWorkspace(): Promise<string | undefined>;
  activateWorkspace(workspace?: string): Promise<AppState>;
  chooseImages(): Promise<SelectedImage[] | undefined>;
  clearImages(): Promise<void>;
  workspaceEntries(path?: string): Promise<Array<{ path: string; type: string }>>;
  saveWorkspaceModelSelection(selection: WorkspaceModelSelection): Promise<AppState>;
  saveSettings(settings: SettingsUpdate): Promise<AppState>;
  loginDeepSeek(): Promise<AppState>;
  cancelDeepSeekLogin(): Promise<void>;
  logoutDeepSeek(): Promise<{ state: AppState; revoked: boolean }>;
  runTask(options: RendererTaskOptions): Promise<RunResult>;
  cancelTask(): Promise<void>;
  relevantCards(task: string): Promise<MemoryMatch[]>;
  createMemory(text: string, evidence: string, kind: MemoryKind): Promise<MemoryCard>;
  setMemoryStatus(cardId: string, status: Exclude<MemoryStatus, "candidate">): Promise<MemoryCard>;
  prunePreview(includeCandidates: boolean): Promise<MemoryCard[]>;
  pruneMemory(includeCandidates: boolean): Promise<MemoryCard[]>;
  clearAudit(): Promise<number>;
  respondLocalAction(id: string, approved: boolean): void;
  openExternal(url: string): Promise<void>;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}
