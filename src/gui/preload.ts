import { contextBridge, ipcRenderer } from "electron";
import type { SettingsUpdate, RendererTaskOptions, TaskEvent, YaBridge } from "./shared";

const bridge: YaBridge = {
  state: () => ipcRenderer.invoke("state:get"),
  chooseWorkspace: () => ipcRenderer.invoke("workspace:choose"),
  workspaceEntries: (path = ".") => ipcRenderer.invoke("workspace:entries", path),
  saveSettings: (settings: SettingsUpdate) => ipcRenderer.invoke("settings:save", settings),
  runTask: (options: RendererTaskOptions) => ipcRenderer.invoke("task:run", options),
  relevantCards: (task: string) => ipcRenderer.invoke("memory:relevant", task),
  createMemory: (text, evidence, kind) => ipcRenderer.invoke("memory:create", { text, evidence, kind }),
  setMemoryStatus: (cardId, status) => ipcRenderer.invoke("memory:status", { cardId, status }),
  prunePreview: (includeCandidates) => ipcRenderer.invoke("memory:prune-preview", includeCandidates),
  pruneMemory: (includeCandidates) => ipcRenderer.invoke("memory:prune", includeCandidates),
  clearAudit: () => ipcRenderer.invoke("audit:clear"),
  respondLocalAction: (id, approved) => ipcRenderer.send("local-action:response", { id, approved }),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  onTaskEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TaskEvent): void => listener(value);
    ipcRenderer.on("task:event", handler);
    return () => ipcRenderer.off("task:event", handler);
  },
};

contextBridge.exposeInMainWorld("ya", bridge);
