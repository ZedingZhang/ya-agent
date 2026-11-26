import { randomUUID } from "node:crypto";
import { dialog, ipcMain, shell } from "electron";
import { loginDeepSeek, logoutDeepSeek } from "../../account";
import { isVisionModel, ModelConfig, VALID_MODELS } from "../../config";
import { isRecord } from "../../guards";
import { deleteStoredHistory, listStoredHistory } from "../../history";
import { imageContentPartsFromFiles, inspectImageFiles } from "../../images";
import { DuplicateMemoryError, MemoryLimitError, type MemoryKind } from "../../memory";
import { FolderAccessChangedError } from "../folder-grants";
import { installApplicationMenu } from "../menu";
import type { SelectedImage, TaskEvent, TaskTransportEvent } from "../shared";
import { DesktopRuntime, LOCAL_ACTION_TIMEOUT_MS } from "./runtime";
import {
  validateSettings,
  validateTaskOptions,
  validateWorkspaceModelSelection,
  validBotId,
} from "./validators";

function registerWorkspaceIpc(runtime: DesktopRuntime): void {
  ipcMain.handle("state:get", async (event) => {
    runtime.assertTrustedSender(event);
    // A replacement renderer must not accept tasks or navigation while cancellation is settling.
    if (runtime.activeTaskController?.signal.aborted) await runtime.activeTaskPromise?.catch(() => undefined);
    return runtime.appState();
  });

  ipcMain.handle("workspace:choose", async (event, botId: unknown) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("Folders cannot be changed while a task is running.");
    runtime.controller.assertActiveBot(botId);
    if (!runtime.mainWindow) return undefined;
    const revision = ++runtime.folderSelectionRevision;
    const expected = runtime.controller.folderSelectionSnapshot(botId);
    const chinese = runtime.controller.language === "zh-CN";
    const selection = await dialog.showOpenDialog(runtime.mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: chinese ? "授权此 Bot 访问所选文件夹及其子目录" : "Allow this bot to access a folder and its subfolders",
      buttonLabel: chinese ? "授予访问权限" : "Grant access",
    });
    const path = selection.filePaths[0];
    if (runtime.taskRunning) throw new Error("Folders cannot be changed while a task is running.");
    if (selection.canceled || !path) return undefined;
    return runtime.controller.grantFolder(botId, path, () => {
      if (runtime.taskRunning || revision !== runtime.folderSelectionRevision) {
        throw new Error("Folder selection is no longer current.");
      }
    }, expected);
  });

  ipcMain.handle("bot:select", (event, botId: unknown) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("Bots cannot be changed while a task is running.");
    if (!validBotId(botId)) throw new Error("Invalid bot ID.");
    ++runtime.folderSelectionRevision;
    runtime.folderBrowserRequest?.abort();
    runtime.controller.activeBotId = botId;
    return runtime.controller.folderState();
  });

  ipcMain.handle("bot:restore-ids", (event, ids: unknown) => {
    runtime.assertTrustedSender(event);
    if (!Array.isArray(ids)) throw new Error("Invalid bot history.");
    const counts = new Map<string, number>();
    for (const id of ids) {
      if (validBotId(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return ids.map((id: unknown) => validBotId(id) && counts.get(id) === 1 ? id : randomUUID());
  });

  ipcMain.handle("workspace:revoke", (event, botId: unknown) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("Folders cannot be changed while a task is running.");
    runtime.controller.assertActiveBot(botId);
    ++runtime.folderSelectionRevision;
    return runtime.controller.revokeFolder(botId);
  });

  ipcMain.handle("workspace:check", (event, botId: unknown) => {
    runtime.assertTrustedSender(event);
    return runtime.readFolderForDisplay(botId, (_id, signal) => runtime.controller.folderAccess(signal));
  });

  ipcMain.handle("workspace:entries", (event, botId: unknown, path: unknown, version: unknown) => {
    runtime.assertTrustedSender(event);
    return runtime.readFolderForDisplay(botId, (id, signal) => runtime.controller.workspaceEntries(id,
      typeof path === "string" ? path : ".", typeof version === "string" ? version : undefined, signal));
  });

  ipcMain.handle("workspace:model-selection", (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("The model cannot be changed while a task is running.");
    const selection = validateWorkspaceModelSelection(raw);
    runtime.controller.saveWorkspaceModelSelection(selection.model, selection.reasoningEffort);
    return runtime.appState();
  });

  ipcMain.handle("images:choose", async (event) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("Images cannot be changed while a task is running.");
    if (!runtime.mainWindow) return undefined;
    const selection = await dialog.showOpenDialog(runtime.mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (selection.canceled) return undefined;
    const files = inspectImageFiles([...new Set(selection.filePaths)]);
    runtime.selectedImages.clear();
    return files.map((file): SelectedImage => {
      const id = randomUUID();
      runtime.selectedImages.set(id, file);
      return { id, name: file.name, size: file.size, mimeType: file.mimeType };
    });
  });

  ipcMain.handle("images:clear", (event) => {
    runtime.assertTrustedSender(event);
    runtime.selectedImages.clear();
  });
}

function registerSettingsAndAccountIpc(runtime: DesktopRuntime): void {
  ipcMain.handle("settings:save", (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    const settings = validateSettings(raw);
    const config = new ModelConfig({
      model: runtime.controller.config.model,
      reasoningEffort: runtime.controller.config.reasoningEffort,
      thinkingEnabled: settings.thinkingEnabled,
      toaTokenBudget: settings.toaTokenBudget,
      toaTimeout: settings.toaTimeout,
    });
    runtime.controller.saveModelConfig(config);
    runtime.controller.setLanguage(settings.language);
    installApplicationMenu(runtime.controller.language);
    runtime.controller.setStream(settings.stream);
    if (settings.apiKey?.trim()) {
      if (settings.keyStorage === "keychain") runtime.controller.saveMacosApiKey(settings.apiKey);
      else runtime.controller.setSessionApiKey(settings.apiKey);
    }
    return runtime.appState();
  });

  ipcMain.handle("account:login", async (event) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning || runtime.activeLoginPromise) throw new Error("Finish the current task or sign-in attempt first.");
    const cancellation = new AbortController();
    runtime.activeLoginController = cancellation;
    runtime.activeLoginPromise = loginDeepSeek({
      openBrowser: (url) => shell.openExternal(url), fetcher: runtime.electronFetch,
      locale: runtime.controller.language, signal: cancellation.signal,
    });
    try {
      await runtime.activeLoginPromise;
      runtime.mainWindow?.focus();
      return runtime.appState();
    } finally {
      runtime.activeLoginController = undefined;
      runtime.activeLoginPromise = undefined;
    }
  });

  ipcMain.handle("account:cancel", (event) => {
    runtime.assertTrustedSender(event);
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled."));
  });

  ipcMain.handle("account:logout", async (event) => {
    runtime.assertTrustedSender(event);
    if (runtime.taskRunning) throw new Error("Finish the current task before signing out.");
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled."));
    await runtime.activeLoginPromise?.catch(() => undefined);
    const revoked = await logoutDeepSeek(runtime.electronFetch, runtime.controller.language);
    return { state: runtime.appState(), revoked };
  });
}

function registerTaskIpc(runtime: DesktopRuntime): void {
  ipcMain.handle("task:pending-outcomes", (event) => {
    runtime.assertTrustedSender(event);
    return Array.from(runtime.pendingOutcomes.values());
  });

  ipcMain.handle("task:ack-outcome", (event, id: string) => {
    runtime.assertTrustedSender(event);
    runtime.pendingOutcomes.delete(id);
  });

  ipcMain.handle("task:run", async (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    if (runtime.activeLoginPromise) throw new Error("Finish or cancel DeepSeek sign-in before starting a task.");
    if (runtime.taskRunning) throw new Error("A task is already running.");
    const options = validateTaskOptions(raw);
    ++runtime.folderSelectionRevision;
    runtime.taskRunning = true;
    const taskController = new AbortController();
    runtime.activeTaskController = taskController;
    const taskRendererGeneration = runtime.rendererGeneration;
    const send = (value: TaskEvent): void => {
      // Stop lets an already approved mutation finish. Its outcome still belongs to this turn.
      const committed = value.type === "file-change" || (value.type === "activity"
        && (value.activity.status === "success" || (taskController.signal.aborted && value.activity.status !== "denied"))
        && ["write", "edit", "mkdir", "move"].includes(value.activity.operation));
      if (committed && options.turnId && options.sessionId) {
        const outcome = { id: randomUUID(), botId: options.sessionId, turnId: options.turnId, event: value };
        runtime.pendingOutcomes.set(outcome.id, outcome);
        runtime.sendTaskEvent({ type: "committed", outcome });
        return;
      }
      if (runtime.activeTaskController === taskController && runtime.rendererGeneration === taskRendererGeneration
        && (!taskController.signal.aborted || committed)) runtime.sendTaskEvent(value);
    };
    try {
      runtime.activeTaskPromise = runtime.controller.run(options, {
        signal: taskController.signal,
        loadImages: () => {
          if (options.imageIds.length && !isVisionModel(runtime.controller.config.model)) {
            throw new Error(`Image input requires model ${VALID_MODELS.flash}.`);
          }
          const files = options.imageIds.map((id) => {
            const file = runtime.selectedImages.get(id);
            if (!file) throw new Error("An image selection is no longer available. Choose the image again.");
            return file;
          });
          return imageContentPartsFromFiles(files, options.imageDetail);
        },
        onStarted: () => {
          for (const id of options.imageIds) runtime.selectedImages.delete(id);
          send({ type: "started" });
        },
        onContent: (content) => send({ type: "content", content }),
        onLocalActivity: (activity) => send({ type: "activity", activity }),
        onCommandEvent: (commandEvent) => send({ type: "command", event: commandEvent }),
        onFileChange: (change) => send({ type: "file-change", change }),
        onLocalAction: (action) => new Promise<boolean>((resolvePromise, reject) => {
          taskController.signal.throwIfAborted();
          if (event.sender.isDestroyed()) {
            reject(new Error("The renderer is no longer available."));
            return;
          }
          const id = randomUUID();
          const timer = setTimeout(() => {
            runtime.pendingActions.delete(id);
            try { send({ type: "local-action-expired", id }); }
            catch { /* A disconnected renderer cannot keep the approval alive. */ }
            reject(new Error("Local action approval timed out after 120 seconds."));
          }, LOCAL_ACTION_TIMEOUT_MS);
          runtime.pendingActions.set(id, { resolve: resolvePromise, reject, timer });
          try {
            event.sender.send("task:event", { type: "local-action", id, action });
          } catch (error) {
            clearTimeout(timer);
            runtime.pendingActions.delete(id);
            reject(error);
          }
        }),
      });
      return await runtime.activeTaskPromise;
    } catch (error) {
      if (error instanceof FolderAccessChangedError) return { folderAccessChanged: error.access };
      throw error;
    } finally {
      runtime.activeTaskPromise = undefined;
      runtime.activeTaskController = undefined;
      runtime.rejectPendingActions(new Error("Task ended."));
      runtime.taskRunning = false;
    }
  });

  ipcMain.handle("task:flush", (event, id: unknown) => {
    runtime.assertTrustedSender(event);
    if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new Error("Invalid task flush ID.");
    const marker: TaskTransportEvent = { type: "flush", id };
    event.sender.send("task:event", marker);
  });

  ipcMain.handle("task:cancel", (event) => {
    runtime.assertTrustedSender(event);
    runtime.cancelTask(new Error("Task cancelled by the user."));
  });

  ipcMain.on("local-action:response", (event, raw: unknown) => {
    const url = event.senderFrame?.url ?? event.sender.getURL();
    if (!runtime.isTrustedRendererUrl(url) || !isRecord(raw) || typeof raw.id !== "string") return;
    const pending = runtime.pendingActions.get(raw.id);
    if (!pending) return;
    runtime.pendingActions.delete(raw.id);
    clearTimeout(pending.timer);
    try { runtime.sendTaskEvent({ type: "local-action-resolved", id: raw.id }); }
    catch { /* Approval was accepted; renderer lifecycle handling owns disconnection. */ }
    pending.resolve(Boolean(raw.approved));
  });
}

function registerMemoryAndHistoryIpc(runtime: DesktopRuntime): void {
  ipcMain.handle("memory:cards", (event) => {
    runtime.assertTrustedSender(event);
    return runtime.controller.cards();
  });
  ipcMain.handle("memory:relevant", (event, task: unknown) => {
    runtime.assertTrustedSender(event);
    return runtime.controller.relevantCards(typeof task === "string" ? task : "");
  });
  ipcMain.handle("memory:create", (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    if (!isRecord(raw) || typeof raw.text !== "string" || typeof raw.evidence !== "string") throw new Error("Invalid memory candidate.");
    try {
      return runtime.controller.createMemory(raw.text, raw.evidence, raw.kind as MemoryKind);
    } catch (error) {
      if (error instanceof DuplicateMemoryError || error instanceof MemoryLimitError) throw new Error(error.message);
      throw error;
    }
  });
  ipcMain.handle("memory:status", (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    if (!isRecord(raw) || typeof raw.cardId !== "string") throw new Error("Invalid memory action.");
    if (raw.status !== "approved" && raw.status !== "rejected" && raw.status !== "revoked") throw new Error("Invalid memory status.");
    return runtime.controller.setMemoryStatus(raw.cardId, raw.status);
  });
  ipcMain.handle("memory:prune-preview", (event, includeCandidates: unknown) => {
    runtime.assertTrustedSender(event);
    return runtime.controller.prunePreview(Boolean(includeCandidates));
  });
  ipcMain.handle("memory:prune", (event, includeCandidates: unknown) => {
    runtime.assertTrustedSender(event);
    return runtime.controller.prune(Boolean(includeCandidates));
  });
  ipcMain.handle("audit:clear", (event) => {
    runtime.assertTrustedSender(event);
    return runtime.controller.clearAuditLogs().length;
  });
  ipcMain.handle("history:list", (event, kind: unknown) => {
    runtime.assertTrustedSender(event);
    if (kind !== "tasks" && kind !== "audit") throw new Error("Invalid history category.");
    return listStoredHistory(kind);
  });
  ipcMain.handle("history:delete", (event, kind: unknown, ids: unknown) => {
    runtime.assertTrustedSender(event);
    if (kind !== "tasks" && kind !== "audit") throw new Error("Invalid history category.");
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) {
      throw new Error("Invalid history selection.");
    }
    return deleteStoredHistory(kind, ids);
  });
  ipcMain.handle("external:open", async (event, raw: unknown) => {
    runtime.assertTrustedSender(event);
    if (typeof raw !== "string") throw new Error("Invalid URL.");
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP links can be opened.");
    await shell.openExternal(url.toString());
  });
}

export function registerDesktopIpc(runtime: DesktopRuntime): void {
  registerWorkspaceIpc(runtime);
  registerSettingsAndAccountIpc(runtime);
  registerTaskIpc(runtime);
  registerMemoryAndHistoryIpc(runtime);
}
