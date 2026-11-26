import { contextBridge, ipcRenderer } from "electron";
import type { RendererTaskOptions, SettingsUpdate, TaskTransportEvent, WorkspaceModelSelection, YaBridge } from "./shared";

async function flushTaskEvents(): Promise<void> {
  const id = crypto.randomUUID();
  let release!: () => void;
  const flushed = new Promise<void>((resolve) => { release = resolve; });
  const handler = (_event: Electron.IpcRendererEvent, value: TaskTransportEvent): void => {
    if (value.type === "flush" && value.id === id) release();
  };
  ipcRenderer.on("task:event", handler);
  try {
    // Invoke replies can overtake task events. A marker on the event channel waits for
    // earlier content, commands, file changes and activity to reach their listeners.
    await ipcRenderer.invoke("task:flush", id);
    await flushed;
  } finally {
    ipcRenderer.off("task:event", handler);
  }
}

const bridge: YaBridge = {
  state: () => ipcRenderer.invoke("state:get"),
  chooseWorkspace: (botId) => ipcRenderer.invoke("workspace:choose", botId),
  revokeFolder: (botId) => ipcRenderer.invoke("workspace:revoke", botId),
  selectBot: (botId) => ipcRenderer.invoke("bot:select", botId),
  restoreBotIds: (ids) => ipcRenderer.invoke("bot:restore-ids", ids),
  chooseImages: () => ipcRenderer.invoke("images:choose"),
  clearImages: () => ipcRenderer.invoke("images:clear"),
  checkFolder: (botId) => ipcRenderer.invoke("workspace:check", botId),
  workspaceEntries: (botId, path, folderGrantVersion) => ipcRenderer.invoke("workspace:entries", botId, path, folderGrantVersion),
  saveWorkspaceModelSelection: (selection: WorkspaceModelSelection) => ipcRenderer.invoke("workspace:model-selection", selection),
  saveSettings: (settings: SettingsUpdate) => ipcRenderer.invoke("settings:save", settings),
  loginDeepSeek: () => ipcRenderer.invoke("account:login"),
  cancelDeepSeekLogin: () => ipcRenderer.invoke("account:cancel"),
  logoutDeepSeek: () => ipcRenderer.invoke("account:logout"),
  runTask: async (options: RendererTaskOptions) => {
    try {
      return await ipcRenderer.invoke("task:run", options);
    } finally {
      await flushTaskEvents();
    }
  },
  pendingOutcomes: () => ipcRenderer.invoke("task:pending-outcomes"),
  acknowledgeOutcome: (id) => ipcRenderer.invoke("task:ack-outcome", id),
  cancelTask: () => ipcRenderer.invoke("task:cancel"),
  memoryCards: () => ipcRenderer.invoke("memory:cards"),
  relevantCards: (task: string) => ipcRenderer.invoke("memory:relevant", task),
  createMemory: (text, evidence, kind) => ipcRenderer.invoke("memory:create", { text, evidence, kind }),
  setMemoryStatus: (cardId, status) => ipcRenderer.invoke("memory:status", { cardId, status }),
  prunePreview: (includeCandidates) => ipcRenderer.invoke("memory:prune-preview", includeCandidates),
  pruneMemory: (includeCandidates) => ipcRenderer.invoke("memory:prune", includeCandidates),
  clearAudit: () => ipcRenderer.invoke("audit:clear"),
  historyEntries: (kind) => ipcRenderer.invoke("history:list", kind),
  deleteHistory: (kind, ids) => ipcRenderer.invoke("history:delete", kind, ids),
  respondLocalAction: (id, approved) => ipcRenderer.send("local-action:response", { id, approved }),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  onTaskEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TaskTransportEvent): void => {
      if (value.type !== "flush") listener(value);
    };
    ipcRenderer.on("task:event", handler);
    return () => ipcRenderer.off("task:event", handler);
  },
};

contextBridge.exposeInMainWorld("ya", bridge);
if (process.argv.includes("--ya-smoke-test")) {
  contextBridge.exposeInMainWorld("__yaSmokeEnabled", true);
}
