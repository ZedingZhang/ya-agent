import type { CommandEvent, CommandResult } from "../../commands";
import type { FileChange } from "../../file-diff";
import type { HistoryEntry, StoredHistoryKind } from "../../history";
import type { LocalAction, LocalActivity } from "../../local-tools";
import type { MemoryCard, MemoryKind, MemoryMatch, MemoryStatus } from "../../memory";
import type { ConversationMessage, ImageDetail, WebMode } from "../../types";
import type { Language } from "../controller";
import type {
  AppState,
  CommittedOutcome,
  FolderAccess,
  RendererTaskOptions,
  SelectedImage,
  YaBridge,
} from "../shared";

export type {
  AppState,
  CommandEvent,
  CommandResult,
  CommittedOutcome,
  ConversationMessage,
  FileChange,
  FolderAccess,
  HistoryEntry,
  ImageDetail,
  Language,
  LocalAction,
  LocalActivity,
  MemoryCard,
  MemoryKind,
  MemoryMatch,
  MemoryStatus,
  RendererTaskOptions,
  SelectedImage,
  StoredHistoryKind,
  WebMode,
  YaBridge,
};

export type ShellCommandEvent = CommandEvent;

export type CommittedActivity = LocalActivity & { id?: string };

export type MemoryView = { cards: MemoryCard[] } | { error: string };

export interface ConversationCommand {
  id: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  result?: CommandResult;
}

export interface ConversationTurn {
  createdAt?: number;
  turnId?: string;
  committedActivities?: CommittedActivity[];
  taskId?: string;
  task: string;
  images: SelectedImage[];
  answer: string;
  status: "running" | "complete" | "error" | "interrupted";
  partial?: boolean;
  commands: ConversationCommand[];
  changes: FileChange[];
}

export interface DesktopBot {
  id: string;
  title: string;
  instructions: string;
  updatedAt: number;
  draft: string;
  turns: ConversationTurn[];
  activities: CommittedActivity[];
}

export type BotFields = Pick<DesktopBot, "title" | "instructions">;

export type AppPage = "workspace" | "memory" | "settings";
export type DrawerPage = "files" | "changes" | "activity";
export type SettingsTab = "general" | "providers" | "storage" | "shortcuts" | "about";
export const SETTINGS_TABS: readonly SettingsTab[] = ["general", "providers", "storage", "shortcuts", "about"];

export interface PendingActionState {
  id: string;
  action: LocalAction;
  responding?: boolean;
}

export interface CommandLogEntry {
  summary: HTMLElement;
  stdout: HTMLElement;
  stderr: HTMLElement;
  command: string;
  cwd: string;
}

export interface SettingsSearchItem {
  id: string;
  kind: "page" | "setting";
  tab: SettingsTab;
  target?: string;
  title: string;
  pageLabel: string;
  keywords: string;
}

export type StorageItem = Omit<HistoryEntry, "id"> & { id: string | ConversationTurn };

export interface DiffDisplayLine {
  kind: "hunk" | "addition" | "deletion" | "context" | "note";
  oldLine?: number;
  newLine?: number;
  marker?: string;
  text: string;
}
