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
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  activateWorkspace: (workspace) => ipcRenderer.invoke("workspace:activate", workspace),
  chooseImages: () => ipcRenderer.invoke("images:choose"),
  clearImages: () => ipcRenderer.invoke("images:clear"),
  workspaceEntries: (path = ".") => ipcRenderer.invoke("workspace:entries", path),
  saveWorkspaceModelSelection: (selection: WorkspaceModelSelection) => ipcRenderer.invoke("workspace:model-selection", selection),
  saveSettings: (settings: SettingsUpdate) => ipcRenderer.invoke("settings:save", settings),
  runTask: async (options: RendererTaskOptions) => {
    try {
      return await ipcRenderer.invoke("task:run", options);
    } finally {
      await flushTaskEvents();
    }
  },
  cancelTask: () => ipcRenderer.invoke("task:cancel"),
  relevantCards: (task: string) => ipcRenderer.invoke("memory:relevant", task),
  createMemory: (text, evidence, kind) => ipcRenderer.invoke("memory:create", { text, evidence, kind }),
  setMemoryStatus: (cardId, status) => ipcRenderer.invoke("memory:status", { cardId, status }),
  prunePreview: (includeCandidates) => ipcRenderer.invoke("memory:prune-preview", includeCandidates),
  pruneMemory: (includeCandidates) => ipcRenderer.invoke("memory:prune", includeCandidates),
  clearAudit: () => ipcRenderer.invoke("audit:clear"),
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
