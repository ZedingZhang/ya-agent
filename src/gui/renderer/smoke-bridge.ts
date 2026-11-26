import { getMarkdownRenderer, setMarkdownRenderer } from "./answer-view";
import { diffDisplayLines, fileChangeCard, fileChangeText } from "./diff-view";
import { element, errorText, getBridge } from "./dom";
import { createBot, SESSION_STORAGE_KEY, validSavedFileChange } from "./sessions";
import { t, type RendererStore } from "./state";
import type { FileChange } from "./types";
import type { WorkspaceActions } from "./workspace";

function defineGlobal(name: string, descriptor: PropertyDescriptor): void {
  Object.defineProperty(window, name, { ...descriptor, configurable: true });
}

function exposeValue(name: string, value: unknown): void {
  defineGlobal(name, { value, writable: true });
}

function exposeState<K extends keyof RendererStore>(store: RendererStore, key: K, name: string = String(key)): void {
  defineGlobal(name, {
    get: () => store[key],
    set: (value: RendererStore[K]) => { store[key] = value; },
  });
}

/** Exposes renderer test hooks onto `window` exclusively during `--ya-smoke-test` runs. */
export function installSmokeBridge(store: RendererStore, actions: WorkspaceActions): void {
  exposeValue("SESSION_STORAGE_KEY", SESSION_STORAGE_KEY);
  exposeValue("bridge", getBridge());
  exposeValue("commandLogs", store.commandLogs);
  exposeState(store, "state");
  exposeState(store, "currentDirectory");
  exposeState(store, "activeAnswer");
  exposeState(store, "pendingAction");
  exposeState(store, "actionExpired");
  exposeState(store, "accountPending");
  exposeState(store, "bots");
  exposeState(store, "currentBot");
  exposeState(store, "activeTurn");
  exposeState(store, "navigationPending");
  exposeState(store, "drawerPage");
  exposeState(store, "selectedImages");
  exposeState(store, "activeSettingsTab");
  exposeState(store, "settingsSaveQueue");

  defineGlobal("renderMarkdown", {
    get: getMarkdownRenderer,
    set: setMarkdownRenderer,
  });

  exposeValue("element", element);
  exposeValue("errorText", errorText);
  exposeValue("t", (key: Parameters<typeof t>[1]) => t(store, key));
  exposeValue("createBot", (profile?: Parameters<typeof createBot>[1]) => createBot(store, profile));
  exposeValue("diffDisplayLines", (change: FileChange) => diffDisplayLines(change, store.state?.language));
  exposeValue("fileChangeText", (change: FileChange) => fileChangeText(change, store.state?.language));
  exposeValue("fileChangeCard", (change: FileChange, open?: boolean) => fileChangeCard(store, change, open));
  exposeValue("validSavedFileChange", validSavedFileChange);

  exposeValue("applyLanguage", actions.applyLanguage);
  exposeValue("applyCommittedOutcome", actions.applyCommittedOutcome);
  exposeValue("botChanges", actions.botChanges);
  exposeValue("chooseImages", actions.chooseImages);
  exposeValue("clearPendingAction", actions.clearPendingAction);
  exposeValue("decideLocalAction", actions.decideLocalAction);
  exposeValue("deleteSelectedHistory", actions.deleteSelectedHistory);
  exposeValue("fillSettings", actions.fillSettings);
  exposeValue("persistSessions", actions.persistSessions);
  exposeValue("refreshStorage", actions.refreshStorage);
  exposeValue("renderBot", actions.renderBot);
  exposeValue("renderCommand", actions.renderCommand);
  exposeValue("renderFiles", actions.renderFiles);
  exposeValue("renderNavigation", actions.renderNavigation);
  exposeValue("renderPendingAction", actions.renderPendingAction);
  exposeValue("renderStorage", actions.renderStorage);
  exposeValue("runTask", actions.runTask);
  exposeValue("saveWorkspaceModelSelection", actions.saveWorkspaceModelSelection);
  exposeValue("selectBot", actions.selectBot);
  exposeValue("selectSettingsTab", actions.selectSettingsTab);
  exposeValue("setDrawer", actions.setDrawer);
  exposeValue("setRunning", actions.setRunning);
  exposeValue("setStatus", actions.setStatus);
  exposeValue("showBotEditor", actions.showBotEditor);
  exposeValue("storageSelection", actions.storageSelection);
  exposeValue("switchPage", actions.switchPage);
  exposeValue("syncWorkspaceControls", actions.syncWorkspaceControls);
  exposeValue("updateFolderAccess", actions.updateFolderAccess);
}
