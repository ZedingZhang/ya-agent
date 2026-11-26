import type { StreamingAnswerPreview } from "./answer-view";
import { translate, type TextKey } from "./i18n";
import type {
  AppState,
  CommandLogEntry,
  CommittedActivity,
  ConversationTurn,
  DesktopBot,
  DrawerPage,
  MemoryView,
  PendingActionState,
  SelectedImage,
  SettingsTab,
  StorageItem,
} from "./types";

export interface RendererStore {
  state: AppState;
  displayedGrantVersion: string | undefined;
  currentDirectory: string;
  directoryGrantVersion: string | undefined;
  onTaskStarted: (() => void) | undefined;
  activeAnswer: HTMLElement | undefined;
  activePreview: StreamingAnswerPreview | undefined;
  pendingAction: PendingActionState | undefined;
  approvalReturnFocus: HTMLElement | undefined;
  actionExpired: boolean;
  activities: CommittedActivity[];
  lastAnswer: string;
  selectedImages: SelectedImage[];
  workspaceModelSaving: boolean;
  accountPending: "login" | "logout" | undefined;
  memoryView: MemoryView | undefined;
  memoryRequest: number;
  relevantMemoryRequest: number;
  bots: DesktopBot[];
  currentBot: DesktopBot;
  activeTurn: ConversationTurn | undefined;
  navigationPending: boolean;
  sessionSaveTimer: number | undefined;
  drawerPage: DrawerPage | undefined;
  commandLogs: Map<string, CommandLogEntry>;
  activeSettingsTab: SettingsTab;
  lastNonSettingsPage: "workspace" | "memory";
  settingsSaveQueue: Promise<void>;
  settingsFeedbackTimer: number | undefined;
  aboutCopyTimer: number | undefined;
  settingsHeaderObserver: ResizeObserver | undefined;
  searchRevealTimer: number | undefined;
  activeSearchTarget: HTMLElement | undefined;
  highlightedSearchIndex: number;
  renderedSearchItems: Array<{ tab: SettingsTab; target?: string }>;
  fileRequest: number;
  storageItems: StorageItem[] | undefined;
  storageRequest: number;
  storageError: string;
  deletingHistory: boolean;
}

export function createRendererStore(): RendererStore {
  return {
    state: undefined as unknown as AppState,
    displayedGrantVersion: undefined,
    currentDirectory: ".",
    directoryGrantVersion: undefined,
    onTaskStarted: undefined,
    activeAnswer: undefined,
    activePreview: undefined,
    pendingAction: undefined,
    approvalReturnFocus: undefined,
    actionExpired: false,
    activities: [],
    lastAnswer: "",
    selectedImages: [],
    workspaceModelSaving: false,
    accountPending: undefined,
    memoryView: undefined,
    memoryRequest: 0,
    relevantMemoryRequest: 0,
    bots: [],
    currentBot: undefined as unknown as DesktopBot,
    activeTurn: undefined,
    navigationPending: false,
    sessionSaveTimer: undefined,
    drawerPage: undefined,
    commandLogs: new Map(),
    activeSettingsTab: "general",
    lastNonSettingsPage: "workspace",
    settingsSaveQueue: Promise.resolve(),
    settingsFeedbackTimer: undefined,
    aboutCopyTimer: undefined,
    settingsHeaderObserver: undefined,
    searchRevealTimer: undefined,
    activeSearchTarget: undefined,
    highlightedSearchIndex: -1,
    renderedSearchItems: [],
    fileRequest: 0,
    storageItems: undefined,
    storageRequest: 0,
    storageError: "",
    deletingHistory: false,
  };
}

export function t(store: RendererStore, key: TextKey): string {
  return translate(store.state?.language, key);
}
