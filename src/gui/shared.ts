import type { ModelId, ReasoningEffort } from "../config";
import type { LocalAction, LocalActivity } from "../local";
import type { MemoryCard, MemoryKind, MemoryMatch, MemoryStatus } from "../memory";
import type { RunResult } from "../orchestrator";
import type { WebMode } from "../types";
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
  stream: boolean;
  hasApiKey: boolean;
  config: SerializedConfig;
  cards: MemoryCard[];
  auditLogCount: number;
  auditLogBytes: number;
}

export interface SettingsUpdate extends SerializedConfig {
  language: Language;
  stream: boolean;
  apiKey?: string;
  keyStorage?: "session" | "keychain";
}

export interface RendererTaskOptions {
  task: string;
  webMode: WebMode;
  toa: boolean;
  toaWorkers: 1 | 2;
  stream: boolean;
  local: boolean;
  workspace?: string;
}

export type TaskEvent =
  | { type: "content"; content: string }
  | { type: "activity"; activity: LocalActivity }
  | { type: "local-action"; id: string; action: LocalAction };

export interface YaBridge {
  state(): Promise<AppState>;
  chooseWorkspace(): Promise<string | undefined>;
  workspaceEntries(path?: string): Promise<Array<{ path: string; type: string }>>;
  saveSettings(settings: SettingsUpdate): Promise<AppState>;
  runTask(options: RendererTaskOptions): Promise<RunResult>;
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
