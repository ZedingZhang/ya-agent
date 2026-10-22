import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  screen,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { isVisionModel, ModelConfig, VALID_MODELS, type ReasoningEffort } from "../config";
import { DeepSeekClient, type FetchLike } from "../deepseek";
import {
  imageContentPartsFromFiles,
  inspectImageFiles,
  isImageDetail,
  MAX_IMAGES_PER_REQUEST,
  type ImageFileInfo,
} from "../images";
import { DuplicateMemoryError, MemoryLimitError, type MemoryKind } from "../memory";
import type { RunResult } from "../orchestrator";
import { runTask } from "../service";
import { VERSION } from "../version";
import { createFileChange } from "../file-diff";
import { search } from "../web";
import { loginDeepSeek, logoutDeepSeek } from "../account";
import { loadAccountCredential } from "../credentials";
import { GuiController, LANGUAGES, type Language } from "./controller";
import { initialWindowGeometry } from "./layout";
import { installApplicationMenu } from "./menu";
import type {
  AppState,
  RendererTaskOptions,
  SelectedImage,
  SettingsUpdate,
  TaskEvent,
  TaskTransportEvent,
  WorkspaceModelSelection,
} from "./shared";

app.setName("Ya");

let mainWindow: BrowserWindow | undefined;
let taskRunning = false;
let activeTaskController: AbortController | undefined;
let activeTaskPromise: Promise<RunResult> | undefined;
let activeLoginController: AbortController | undefined;
let activeLoginPromise: Promise<void> | undefined;
const LOCAL_ACTION_TIMEOUT_MS = 120_000;
const pendingActions = new Map<string, {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
const selectedImages = new Map<string, ImageFileInfo>();
const rendererFile = join(__dirname, "index.html");
const rendererUrl = pathToFileURL(rendererFile).toString();
const electronFetch: FetchLike = (input, init) =>
  net.fetch(input instanceof URL ? input.toString() : input, init);
let controller: GuiController;

function createController(): GuiController {
  return new GuiController((apiKey, task, config, options = {}) => runTask(apiKey, task, config, {
    ...options,
    // Electron's network stack follows the operating system proxy and trust
    // configuration while the CLI continues to use Node's native fetch.
    clientFactory: (key, signal) => new DeepSeekClient(key, electronFetch, undefined, signal),
    webSearch: (arguments_) => search(arguments_, electronFetch, undefined, options.signal),
  }));
}

function appState(): AppState {
  const logs = controller.auditLogs();
  const validWorkspace = controller.validWorkspace();
  return {
    version: VERSION,
    platform: process.platform,
    language: controller.language,
    ...(controller.workspace ? { workspace: controller.workspace } : {}),
    ...(validWorkspace ? { validWorkspace } : {}),
    workspaces: controller.workspaces,
    stream: controller.stream,
    hasApiKey: Boolean(controller.apiKey()),
    accountSignedIn: Boolean(loadAccountCredential()),
    config: {
      model: controller.config.model,
      thinkingEnabled: controller.config.thinkingEnabled,
      reasoningEffort: controller.config.reasoningEffort,
      toaTokenBudget: controller.config.toaTokenBudget,
      toaTimeout: controller.config.toaTimeout,
    },
    cards: controller.cards(),
    auditLogCount: logs.length,
    auditLogBytes: controller.auditLogTotalBytes(),
  };
}

function sendTaskEvent(event: TaskEvent): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send("task:event", event);
  }
}

function rejectPendingActions(error: Error): void {
  for (const pending of pendingActions.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  pendingActions.clear();
}

function cancelTask(error: Error): void {
  activeTaskController?.abort(error);
  rejectPendingActions(error);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedRendererUrl(url)) throw new Error("Untrusted renderer request.");
}

function isTrustedRendererUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString() === rendererUrl;
  } catch {
    return false;
  }
}

function validateTaskOptions(value: unknown): RendererTaskOptions {
  if (!isRecord(value) || typeof value.task !== "string" || !value.task.trim()) throw new Error("Enter a task first.");
  const webMode = value.webMode;
  if (webMode !== "auto" && webMode !== "on" && webMode !== "off") throw new Error("Invalid web mode.");
  const workers = value.toaWorkers;
  if (workers !== 1 && workers !== 2) throw new Error("ToA workers must be 1 or 2.");
  const imageIds = value.imageIds ?? [];
  if (!Array.isArray(imageIds) || imageIds.length > MAX_IMAGES_PER_REQUEST || imageIds.some((id) => typeof id !== "string")) {
    throw new Error("Invalid image selection.");
  }
  if (new Set(imageIds).size !== imageIds.length) throw new Error("Duplicate image selection.");
  const imageDetail = value.imageDetail ?? "auto";
  if (!isImageDetail(imageDetail)) throw new Error("Invalid image detail.");
  if (value.exec !== undefined && typeof value.exec !== "boolean") throw new Error("Invalid command execution setting.");
  if (value.exec && !value.local) throw new Error("Command execution requires local workspace mode.");
  return {
    task: value.task.trim(),
    webMode,
    toa: Boolean(value.toa),
    toaWorkers: workers,
    stream: Boolean(value.stream),
    local: Boolean(value.local),
    exec: value.exec === true,
    imageIds,
    imageDetail,
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
  };
}

function validateSettings(value: unknown): SettingsUpdate {
  if (!isRecord(value)) throw new Error("Invalid settings payload.");
  if (!LANGUAGES.includes(value.language as Language)) throw new Error("Invalid language.");
  return {
    language: value.language as Language,
    stream: Boolean(value.stream),
    thinkingEnabled: Boolean(value.thinkingEnabled),
    toaTokenBudget: Number(value.toaTokenBudget),
    toaTimeout: Number(value.toaTimeout),
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(value.keyStorage === "session" || value.keyStorage === "keychain" ? { keyStorage: value.keyStorage } : {}),
  };
}

function validateWorkspaceModelSelection(value: unknown): WorkspaceModelSelection {
  if (!isRecord(value)) throw new Error("Invalid workspace model selection.");
  if (!Object.values(VALID_MODELS).includes(value.model as never)) throw new Error("Invalid model.");
  if (value.reasoningEffort !== "high" && value.reasoningEffort !== "max") throw new Error("Invalid reasoning effort.");
  return {
    model: value.model as (typeof VALID_MODELS)[keyof typeof VALID_MODELS],
    reasoningEffort: value.reasoningEffort as ReasoningEffort,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registerIpc(): void {
  ipcMain.handle("state:get", async (event) => {
    assertTrustedSender(event);
    // A replacement renderer must not accept tasks or navigation while cancellation is settling.
    if (activeTaskController?.signal.aborted) await activeTaskPromise?.catch(() => undefined);
    return appState();
  });

  ipcMain.handle("workspace:choose", async (event) => {
    assertTrustedSender(event);
    if (taskRunning) throw new Error("Projects cannot be changed while a task is running.");
    if (!mainWindow) return undefined;
    const selection = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    const path = selection.filePaths[0];
    if (taskRunning) throw new Error("Projects cannot be changed while a task is running.");
    return selection.canceled || !path ? undefined : controller.setWorkspace(path);
  });

  ipcMain.handle("workspace:activate", (event, workspace: unknown) => {
    assertTrustedSender(event);
    if (taskRunning) throw new Error("Projects cannot be changed while a task is running.");
    if (workspace !== undefined && typeof workspace !== "string") throw new Error("Invalid project selection.");
    controller.activateWorkspace(workspace);
    return appState();
  });

  ipcMain.handle("workspace:entries", (event, path: unknown) => {
    assertTrustedSender(event);
    return controller.workspaceEntries(typeof path === "string" ? path : ".");
  });

  ipcMain.handle("workspace:model-selection", (event, raw: unknown) => {
    assertTrustedSender(event);
    if (taskRunning) throw new Error("The model cannot be changed while a task is running.");
    const selection = validateWorkspaceModelSelection(raw);
    controller.saveWorkspaceModelSelection(selection.model, selection.reasoningEffort);
    return appState();
  });

  ipcMain.handle("images:choose", async (event) => {
    assertTrustedSender(event);
    if (taskRunning) throw new Error("Images cannot be changed while a task is running.");
    if (!mainWindow) return undefined;
    const selection = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "webp"] }],
    });
    if (selection.canceled) return undefined;
    const files = inspectImageFiles([...new Set(selection.filePaths)]);
    selectedImages.clear();
    return files.map((file): SelectedImage => {
      const id = randomUUID();
      selectedImages.set(id, file);
      return { id, name: file.name, size: file.size, mimeType: file.mimeType };
    });
  });

  ipcMain.handle("images:clear", (event) => {
    assertTrustedSender(event);
    selectedImages.clear();
  });

  ipcMain.handle("settings:save", (event, raw: unknown) => {
    assertTrustedSender(event);
    const settings = validateSettings(raw);
    const config = new ModelConfig({
      model: controller.config.model,
      reasoningEffort: controller.config.reasoningEffort,
      thinkingEnabled: settings.thinkingEnabled,
      toaTokenBudget: settings.toaTokenBudget,
      toaTimeout: settings.toaTimeout,
    });
    controller.saveModelConfig(config);
    controller.setLanguage(settings.language);
    installApplicationMenu(controller.language);
    controller.setStream(settings.stream);
    if (settings.apiKey?.trim()) {
      if (settings.keyStorage === "keychain") controller.saveMacosApiKey(settings.apiKey);
      else controller.setSessionApiKey(settings.apiKey);
    }
    return appState();
  });

  ipcMain.handle("account:login", async (event) => {
    assertTrustedSender(event);
    if (taskRunning || activeLoginPromise) throw new Error("Finish the current task or sign-in attempt first.");
    const cancellation = new AbortController();
    activeLoginController = cancellation;
    activeLoginPromise = loginDeepSeek({
      openBrowser: (url) => shell.openExternal(url), fetcher: electronFetch,
      locale: controller.language, signal: cancellation.signal,
    });
    try {
      await activeLoginPromise;
      mainWindow?.focus();
      return appState();
    } finally {
      activeLoginController = undefined;
      activeLoginPromise = undefined;
    }
  });

  ipcMain.handle("account:cancel", (event) => {
    assertTrustedSender(event);
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled."));
  });

  ipcMain.handle("account:logout", async (event) => {
    assertTrustedSender(event);
    if (taskRunning) throw new Error("Finish the current task before signing out.");
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled."));
    await activeLoginPromise?.catch(() => undefined);
    const revoked = await logoutDeepSeek(electronFetch, controller.language);
    return { state: appState(), revoked };
  });

  ipcMain.handle("task:run", async (event, raw: unknown) => {
    assertTrustedSender(event);
    if (activeLoginPromise) throw new Error("Finish or cancel DeepSeek sign-in before starting a task.");
    if (taskRunning) throw new Error("A task is already running.");
    const options = validateTaskOptions(raw);
    if (options.imageIds.length > 0 && !isVisionModel(controller.config.model)) {
      throw new Error(`Image input requires model ${VALID_MODELS.flash}.`);
    }
    const files = options.imageIds.map((id) => {
      const file = selectedImages.get(id);
      if (!file) throw new Error("An image selection is no longer available. Choose the image again.");
      return file;
    });
    const images = imageContentPartsFromFiles(files, options.imageDetail);
    taskRunning = true;
    const taskController = new AbortController();
    activeTaskController = taskController;
    const send = (value: TaskEvent): void => {
      if (!taskController.signal.aborted) sendTaskEvent(value);
    };
    try {
      activeTaskPromise = controller.run({ ...options, images }, {
        signal: taskController.signal,
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
            pendingActions.delete(id);
            reject(new Error("Local action approval timed out after 120 seconds."));
          }, LOCAL_ACTION_TIMEOUT_MS);
          pendingActions.set(id, { resolve: resolvePromise, reject, timer });
          try {
            event.sender.send("task:event", { type: "local-action", id, action });
          } catch (error) {
            clearTimeout(timer);
            pendingActions.delete(id);
            reject(error);
          }
        }),
      });
      return await activeTaskPromise;
    } finally {
      activeTaskPromise = undefined;
      activeTaskController = undefined;
      rejectPendingActions(new Error("Task ended."));
      taskRunning = false;
      for (const id of options.imageIds) selectedImages.delete(id);
    }
  });

  ipcMain.handle("task:flush", (event, id: unknown) => {
    assertTrustedSender(event);
    if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new Error("Invalid task flush ID.");
    const marker: TaskTransportEvent = { type: "flush", id };
    event.sender.send("task:event", marker);
  });

  ipcMain.handle("task:cancel", (event) => {
    assertTrustedSender(event);
    cancelTask(new Error("Task cancelled by the user."));
  });

  ipcMain.on("local-action:response", (event, raw: unknown) => {
    const url = event.senderFrame?.url ?? event.sender.getURL();
    if (!isTrustedRendererUrl(url) || !isRecord(raw) || typeof raw.id !== "string") return;
    const pending = pendingActions.get(raw.id);
    if (!pending) return;
    pendingActions.delete(raw.id);
    clearTimeout(pending.timer);
    pending.resolve(Boolean(raw.approved));
  });

  ipcMain.handle("memory:relevant", (event, task: unknown) => {
    assertTrustedSender(event);
    return controller.relevantCards(typeof task === "string" ? task : "");
  });
  ipcMain.handle("memory:create", (event, raw: unknown) => {
    assertTrustedSender(event);
    if (!isRecord(raw) || typeof raw.text !== "string" || typeof raw.evidence !== "string") throw new Error("Invalid memory candidate.");
    try {
      return controller.createMemory(raw.text, raw.evidence, raw.kind as MemoryKind);
    } catch (error) {
      if (error instanceof DuplicateMemoryError || error instanceof MemoryLimitError) throw new Error(error.message);
      throw error;
    }
  });
  ipcMain.handle("memory:status", (event, raw: unknown) => {
    assertTrustedSender(event);
    if (!isRecord(raw) || typeof raw.cardId !== "string") throw new Error("Invalid memory action.");
    if (raw.status !== "approved" && raw.status !== "rejected" && raw.status !== "revoked") throw new Error("Invalid memory status.");
    return controller.setMemoryStatus(raw.cardId, raw.status);
  });
  ipcMain.handle("memory:prune-preview", (event, includeCandidates: unknown) => {
    assertTrustedSender(event);
    return controller.prunePreview(Boolean(includeCandidates));
  });
  ipcMain.handle("memory:prune", (event, includeCandidates: unknown) => {
    assertTrustedSender(event);
    return controller.prune(Boolean(includeCandidates));
  });
  ipcMain.handle("audit:clear", (event) => {
    assertTrustedSender(event);
    return controller.clearAuditLogs().length;
  });
  ipcMain.handle("external:open", async (event, raw: unknown) => {
    assertTrustedSender(event);
    if (typeof raw !== "string") throw new Error("Invalid URL.");
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP links can be opened.");
    await shell.openExternal(url.toString());
  });
}

async function createWindow(show = true): Promise<BrowserWindow> {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const geometry = initialWindowGeometry(display.width, display.height);
  mainWindow = new BrowserWindow({
    ...geometry,
    title: "Ya",
    minWidth: 860,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform !== "darwin") mainWindow.removeMenu();
  if (show) mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    } catch {
      // Ignore malformed window-open requests.
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.on("did-start-loading", () => {
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window reload."));
    cancelTask(new Error("The renderer was reloaded while running a task."));
  });
  mainWindow.webContents.on("destroyed", () => {
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window close."));
    cancelTask(new Error("The renderer was destroyed while running a task."));
  });
  mainWindow.webContents.on("render-process-gone", () => {
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by renderer exit."));
    cancelTask(new Error("The renderer exited while running a task."));
  });
  mainWindow.on("closed", () => {
    activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window close."));
    mainWindow = undefined;
    cancelTask(new Error("The window was closed while running a task."));
    selectedImages.clear();
  });
  await mainWindow.loadFile(rendererFile);
  return mainWindow;
}

async function verifyRenderer(window: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 5_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    ready = await window.webContents.executeJavaScript("document.body.dataset.ready === 'true'") as boolean;
    if (!ready) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!ready) throw new Error("Renderer did not become ready within 5 seconds.");

  const pages = await window.webContents.executeJavaScript(`(() => {
    const memoryTab = document.querySelector('[data-page="memory"]');
    const settingsTab = document.querySelector('[data-page="settings"]');
    const workspaceTab = document.querySelector('[data-page="workspace"]');
    memoryTab?.click();
    const memoryActive = document.querySelector('#page-memory')?.classList.contains('active') === true;
    const formCard = document.querySelector('#page-memory .form-card');
    const cardBottom = formCard instanceof HTMLElement ? formCard.getBoundingClientRect().bottom : 0;
    const evidenceInput = document.querySelector('#candidate-evidence');
    const createButton = document.querySelector('#memory-create');
    const evidenceOverflow = evidenceInput instanceof HTMLElement
      ? Math.round(evidenceInput.getBoundingClientRect().bottom - cardBottom) : 0;
    const createOverflow = createButton instanceof HTMLElement
      ? Math.round(createButton.getBoundingClientRect().bottom - cardBottom) : 0;
    const formOverflow = Math.max(evidenceOverflow, createOverflow);
    settingsTab?.click();
    const settingsActive = document.querySelector('#page-settings')?.classList.contains('active') === true;
    const keychainLabel = document.querySelector('#setting-keychain-label');
    const keychainVisible = keychainLabel instanceof HTMLElement && keychainLabel.getClientRects().length > 0;
    const legacySettingsModelControls = document.querySelector('#setting-model, #setting-reasoning') !== null;
    workspaceTab?.click();
    const workspaceActive = document.querySelector('#page-workspace')?.classList.contains('active') === true;
    const model = document.querySelector('#task-model');
    const reasoning = document.querySelector('#task-reasoning');
    const visionOption = document.querySelector('#task-model option[value="deepseek-flash"]') !== null;
    const imagePicker = document.querySelector('#choose-images') !== null;
    const workspaceControls = model instanceof HTMLSelectElement && !model.disabled && model.value !== ''
      && reasoning instanceof HTMLSelectElement && !reasoning.disabled && reasoning.value !== '';
    const commands = document.querySelector('#commands-enabled');
    const stop = document.querySelector('#stop-button');
    const commandControls = commands instanceof HTMLInputElement && !commands.checked
      && stop instanceof HTMLButtonElement && stop.hidden && typeof window.ya.cancelTask === 'function';
    const sidebar = document.querySelector('.app-sidebar');
    const settingsButton = document.querySelector('#settings-tab');
    const timeline = document.querySelector('#timeline');
    const composer = document.querySelector('.composer');
    const leftNavigation = sidebar instanceof HTMLElement && timeline instanceof HTMLElement
      && sidebar.getBoundingClientRect().right <= timeline.getBoundingClientRect().left;
    const bottomSettings = sidebar instanceof HTMLElement && settingsButton instanceof HTMLElement
      && sidebar.getBoundingClientRect().bottom - settingsButton.getBoundingClientRect().bottom < 32;
    const rightComposer = composer instanceof HTMLElement && timeline instanceof HTMLElement
      && composer.getBoundingClientRect().top + 1 >= timeline.getBoundingClientRect().bottom;
    // A long project path must stay inside the header instead of widening the page.
    const pathLabel = document.querySelector('#workspace-path');
    const main = document.querySelector('main');
    const probeText = 'C:\\\\' + 'workspace-folder\\\\'.repeat(24) + 'final-folder';
    const restoreText = pathLabel ? pathLabel.textContent : null;
    if (pathLabel) pathLabel.textContent = probeText;
    void document.documentElement.offsetWidth; // Force a reflow so the probe is measured.
    const workspaceOverflow = main instanceof HTMLElement ? Math.round(main.getBoundingClientRect().width - window.innerWidth) : 0;
    if (pathLabel && restoreText !== null) pathLabel.textContent = restoreText;
    return {
      memoryActive, settingsActive, workspaceActive, legacySettingsModelControls, visionOption, imagePicker,
      workspaceControls, commandControls, leftNavigation, bottomSettings, rightComposer, workspaceOverflow, formOverflow, keychainVisible,
    };
  })()`) as {
    memoryActive?: boolean;
    settingsActive?: boolean;
    workspaceActive?: boolean;
    legacySettingsModelControls?: boolean;
    visionOption?: boolean;
    imagePicker?: boolean;
    workspaceControls?: boolean;
    commandControls?: boolean;
    leftNavigation?: boolean;
    bottomSettings?: boolean;
    rightComposer?: boolean;
    workspaceOverflow?: number;
    formOverflow?: number;
    keychainVisible?: boolean;
  };
  if (!pages.memoryActive || !pages.settingsActive || !pages.workspaceActive || pages.legacySettingsModelControls
    || !pages.visionOption || !pages.imagePicker || !pages.workspaceControls || !pages.commandControls) {
    throw new Error("Renderer navigation, vision or command controls failed.");
  }
  if (!pages.leftNavigation || !pages.bottomSettings || !pages.rightComposer) {
    throw new Error(`Desktop layout geometry failed: ${JSON.stringify({ leftNavigation: pages.leftNavigation,
      bottomSettings: pages.bottomSettings, rightComposer: pages.rightComposer })}.`);
  }
  if ((pages.workspaceOverflow ?? 0) > 0) {
    throw new Error(`A long workspace path overflows the window by ${pages.workspaceOverflow}px.`);
  }
  if ((pages.formOverflow ?? 0) > 0) {
    throw new Error(`The memory candidate form overflows its card by ${pages.formOverflow}px.`);
  }
  if ((pages.keychainVisible ?? false) !== (process.platform === "darwin")) {
    throw new Error(`The keychain setting must be visible only on macOS (visible=${pages.keychainVisible} on ${process.platform}).`);
  }

  const commandRendering = await window.webContents.executeJavaScript(`(() => {
    const turn = document.createElement('div');
    const priorAnswer = activeAnswer;
    activeAnswer = document.createElement('div');
    turn.append(activeAnswer);
    document.querySelector('#timeline').append(turn);
    try {
      setRunning(true);
      const stopVisible = !document.querySelector('#stop-button').hidden;
      const commandDisabled = document.querySelector('#commands-enabled').disabled;
      renderCommand({ type: 'start', id: 'smoke-command', command: 'npm test', cwd: '.' });
      renderCommand({ type: 'output', id: 'smoke-command', stream: 'stdout', text: 'checking...' });
      const liveOutput = turn.querySelector('.command-run pre').textContent === 'checking...';
      const text = '<img src=x onerror=alert(1)> test failure';
      renderCommand({ type: 'finish', id: 'smoke-command', result: {
        status: 'failed', exitCode: 7, durationMs: 1234, stdout: text, stderr: 'expected true',
        stdoutTruncated: true, stderrTruncated: false,
      } });
      const plainOutput = turn.querySelector('.command-run pre').textContent.includes(text)
        && turn.querySelector('.command-run img') === null;
      const finalStatus = turn.querySelector('.command-run summary').textContent.includes('exit 7, 1.2s');
      const stderr = turn.querySelector('.command-stderr').textContent === 'expected true';
      setRunning(false);
      const stopHidden = document.querySelector('#stop-button').hidden;
      return stopVisible && commandDisabled && liveOutput && plainOutput && finalStatus && stderr && stopHidden;
    } finally {
      setRunning(false);
      activeAnswer = priorAnswer;
      commandLogs.clear();
      turn.remove();
      document.querySelector('#timeline').scrollTop = 0;
      setStatus(t('ready'));
    }
  })()`) as boolean;
  if (!commandRendering) throw new Error("Command output, exit status or stop controls failed to render.");
}

async function verifyFileDiffRendering(window: BrowserWindow): Promise<void> {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}${index === 4 ? ` ${"wide ".repeat(250)}` : ""}\n`).join("");
  const after = before.replace("line 8\n", "<img src=x onerror=alert(1)>\n").replace("line 30\n", "updated 30\n");
  const change = createFileChange("src/example.ts", before, after, "edit");
  const limited = createFileChange("large.txt", undefined, "added\n".repeat(2_100), "write");
  const checks = await window.webContents.executeJavaScript(`(async () => {
    const change = ${JSON.stringify(change)};
    const limited = ${JSON.stringify(limited)};
    const priorTurns = currentSession.turns;
    const language = state.language;
    try {
      currentSession.turns = [{ task: 'Review file changes', images: [], answer: 'Updated two lines.',
        status: 'complete', commands: [], changes: [change] }];
      renderSession();
      setDrawer('changes');
      const card = document.querySelector('#timeline .file-change');
      const expand = card.querySelector('.diff-expand');
      const collapsed = card.querySelectorAll('.diff-row').length === 16 && expand.getAttribute('aria-expanded') === 'false';
      expand.click();
      const expanded = card.querySelectorAll('.diff-row').length === 18
        && card.querySelector('.diff-expand').getAttribute('aria-expanded') === 'true';
      const removed = Array.from(card.querySelectorAll('.deletion')).find((row) => row.querySelector('.diff-code').textContent === 'line 8');
      const added = Array.from(card.querySelectorAll('.addition')).find((row) => row.querySelector('.diff-code').textContent.includes('<img'));
      const lineNumbers = removed.querySelectorAll('.diff-number')[0].textContent === '8'
        && removed.querySelectorAll('.diff-number')[1].textContent === ''
        && added.querySelectorAll('.diff-number')[0].textContent === ''
        && added.querySelectorAll('.diff-number')[1].textContent === '8';
      const context = card.querySelectorAll('.context').length === 12
        && card.querySelectorAll('.addition').length === 2 && card.querySelectorAll('.deletion').length === 2
        && card.querySelector('.change-stats').textContent === '+2−2';
      const safeText = card.querySelector('img, script') === null && added.querySelector('.diff-code').textContent === '<img src=x onerror=alert(1)>';
      const copiedText = fileChangeText(change).includes('--- src/example.ts')
        && fileChangeText(change).includes('-line 8\\n+<img src=x onerror=alert(1)>');
      const clipboard = navigator.clipboard;
      const writeText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
      let copied = '';
      let copyAction = false;
      try {
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async (text) => { copied = text; } });
        card.querySelector('.diff-copy').click();
        await Promise.resolve();
        copyAction = copied === fileChangeText(change) && card.querySelector('.diff-copy').textContent === t('copiedDiff');
        Object.defineProperty(clipboard, 'writeText', { configurable: true, value: async () => { throw new Error('Clipboard unavailable'); } });
        card.querySelector('.diff-copy').click();
        await Promise.resolve();
        copyAction = copyAction && card.querySelector('.diff-copy').textContent === t('copyDiffFailed');
      } finally {
        if (writeText) Object.defineProperty(clipboard, 'writeText', writeText);
        else delete clipboard.writeText;
      }
      const scroll = card.querySelector('.diff-lines');
      const scrollable = scroll.scrollWidth > scroll.clientWidth && document.documentElement.scrollWidth <= innerWidth;
      card.querySelector('.diff-expand').click();
      const recollapsed = card.querySelectorAll('.diff-row').length === 16;
      const drawerCard = document.querySelector('#change-list .file-change');
      drawerCard.querySelector('summary').click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const drawer = !document.querySelector('#drawer-changes').hidden && drawerCard.open
        && drawerCard.querySelector('.diff-body') !== null && !document.querySelector('#changes-count').hidden;
      const truncatedCard = fileChangeCard(limited, true);
      const truncated = truncatedCard.querySelector('.diff-notice').textContent === t('diffTruncated')
        && truncatedCard.querySelector('.diff-additions').textContent === '+2100';
      const compatible = validSavedFileChange(change) && !validSavedFileChange({ ...change, hunks: [{ ...change.hunks[0], lines: [42] }] })
        && !validSavedFileChange({ ...change, additions: -1 });
      state.language = 'zh-CN';
      applyLanguage();
      const localized = document.querySelector('#drawer-changes-tab').textContent === '变更'
        && document.querySelector('#timeline .change-operation').textContent === '编辑'
        && document.querySelector('#change-list .file-change').open;
      return { collapsed, expanded, recollapsed, lineNumbers, context, safeText, copiedText, copyAction, scrollable, drawer, truncated, compatible, localized };
    } finally {
      state.language = language;
      currentSession.turns = priorTurns;
      renderSession();
      applyLanguage();
      setDrawer(undefined);
    }
  })()`) as Record<string, boolean>;
  for (const [name, passed] of Object.entries(checks)) {
    if (!passed) throw new Error(`File diff rendering check failed: ${name}.`);
  }
}

async function verifySessionNavigation(window: BrowserWindow, root: string): Promise<void> {
  const first = join(root, "ya-agent");
  const second = join(root, "notes");
  mkdirSync(first);
  mkdirSync(second);
  controller.setWorkspace(first);
  controller.setWorkspace(second);
  const historyChange = createFileChange("src/gui/layout.ts", "const width = 860;\n", "const width = 920;\n", "edit");
  const navigation = await window.webContents.executeJavaScript(`(async () => {
    state = await bridge.state();
    const [second, first] = state.workspaces;
    await selectSession(undefined, first);
    const firstId = currentSession.id;
    const input = document.querySelector('#task-input');
    input.value = 'A draft for the first project';
    input.dispatchEvent(new Event('input'));
    await selectSession(undefined, second);
    const draftsIsolated = input.value === '';
    await selectSession(sessions.find((session) => session.id === firstId));
    const draftRestored = input.value === 'A draft for the first project';
    const projectRestored = (await bridge.state()).validWorkspace === first;
    const attachmentsAvailable = !document.querySelector('#choose-images').disabled;
    await selectSession(undefined, first, true);
    const newSession = currentSession.id !== firstId && input.value === '';
    const source = sessions.find((session) => session.id === firstId);
    source.turns.push({ task: 'Summarize the YA desktop layout', images: [],
      answer: '## Desktop workspace\\nProject and session navigation stays on the left.\\n\\n- Conversations and the composer fill the right side.\\n- Settings stays at the bottom of the sidebar.',
      status: 'complete', changes: [${JSON.stringify(historyChange)}], commands: [{ id: 'history-command', command: 'npm run check', cwd: first,
        stdout: 'Checks passed', stderr: '', result: { status: 'success', exitCode: 0, durationMs: 500,
          stdout: 'Checks passed', stderr: '', stdoutTruncated: false, stderrTruncated: false } }] });
    source.title = 'Desktop layout';
    source.draft = '';
    source.activities = [{ operation: 'read', paths: ['src/gui/index.html'], status: 'success' }];
    await selectSession(source);
    const transcriptRestored = document.querySelector('#timeline').textContent.includes('Project and session navigation')
      && document.querySelector('#timeline .command-run').textContent.includes('Checks passed')
      && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'const width = 920;';
    setRunning(true);
    const locked = document.querySelector('#new-session').disabled && document.querySelector('#choose-workspace').disabled
      && Array.from(document.querySelectorAll('.session-button')).every((button) => button.disabled);
    const runningId = currentSession.id;
    await selectSession(undefined, second);
    const runningSessionStable = currentSession.id === runningId;
    setRunning(false);
    pendingAction = { id: 'approval-preview', action: { operation: 'edit', paths: ['README.md'], summary: 'Update desktop documentation', diff: '+ New desktop layout' } };
    renderPendingAction();
    switchPage('workspace');
    setDrawer('activity');
    const approvalVisible = !document.querySelector('#details-drawer').hidden && !document.querySelector('#action-content').hidden
      && document.querySelector('#toggle-activity').classList.contains('has-pending');
    pendingAction = undefined;
    renderPendingAction();
    setDrawer(undefined);
    document.querySelector('#sidebar-toggle').click();
    const collapsed = document.body.classList.contains('sidebar-collapsed')
      && document.querySelector('#settings-tab').getBoundingClientRect().width > 0;
    document.querySelector('#sidebar-toggle').click();
    input.value = 'A draft that survives reload';
    input.dispatchEvent(new Event('input'));
    persistSessions();
    return { draftsIsolated, draftRestored, projectRestored, attachmentsAvailable, newSession, transcriptRestored,
      locked, runningSessionStable, approvalVisible, collapsed, activeId: currentSession.id };
  })()`) as Record<string, boolean | string>;
  for (const [name, value] of Object.entries(navigation)) {
    if (name !== "activeId" && value !== true) throw new Error(`Desktop navigation check failed: ${name}.`);
  }
  await window.loadFile(rendererFile);
  await verifyRenderer(window);
  const restored = await window.webContents.executeJavaScript(`(() => ({
    id: currentSession.id, draft: document.querySelector('#task-input').value,
    transcript: document.querySelector('#timeline').textContent.includes('Project and session navigation'),
    commands: document.querySelector('#timeline .command-run').textContent.includes('Checks passed'),
    changes: document.querySelector('#timeline .file-change .addition .diff-code')?.textContent === 'const width = 920;'
      && currentSession.turns[0].changes[0].hunks[0].lines.includes('-const width = 860;')
      && document.querySelector('#changes-count').textContent === '1',
  }))()`) as { id: string; draft: string; transcript: boolean; commands: boolean; changes: boolean };
  if (restored.id !== navigation.activeId || restored.draft !== "A draft that survives reload" || !restored.transcript || !restored.commands || !restored.changes) {
    throw new Error("Session transcripts, commands, file changes or drafts did not survive renderer reload.");
  }
  await window.webContents.executeJavaScript("document.querySelector('#task-input').value = ''; currentSession.draft = ''; persistSessions(); setStatus(t('ready'));");
}

async function verifyResponsiveLayout(window: BrowserWindow): Promise<void> {
  const originalSize = window.getBounds();
  const originalTheme = nativeTheme.themeSource;
  const originalLanguage = controller.language;
  for (const language of ["en", "zh-CN"]) {
    for (const theme of ["light", "dark"] as const) {
      nativeTheme.themeSource = theme;
      for (const [width, height] of [[920, 680], [1440, 900]] as const) {
        window.setSize(width, height);
        await window.webContents.executeJavaScript(`state.language = '${language}'; applyLanguage(); switchPage('workspace'); setDrawer(undefined);`);
        await new Promise((resolve) => setTimeout(resolve, 60));
        const fits = await window.webContents.executeJavaScript(`(() => {
          const sidebar = document.querySelector('.app-sidebar').getBoundingClientRect();
          const settings = document.querySelector('#settings-tab').getBoundingClientRect();
          const composer = document.querySelector('.composer').getBoundingClientRect();
          const options = document.querySelector('#task-options');
          options.open = true;
          const popup = options.querySelector('.task-controls').getBoundingClientRect();
          options.open = false;
          setDrawer('changes');
          const drawer = document.querySelector('#details-drawer').getBoundingClientRect();
          const tabs = document.querySelector('.drawer-tabs').getBoundingClientRect();
          const close = document.querySelector('#close-drawer').getBoundingClientRect();
          const changesFit = drawer.right <= innerWidth && drawer.left >= sidebar.right
            && tabs.right <= close.left && document.documentElement.scrollWidth <= innerWidth;
          setDrawer(undefined);
          return changesFit && document.documentElement.scrollWidth <= innerWidth && composer.right <= innerWidth
            && composer.left >= sidebar.right && composer.bottom <= innerHeight
            && sidebar.bottom - settings.bottom < 32 && popup.left >= sidebar.right
            && popup.right <= innerWidth && popup.top >= 0;
        })()`) as boolean;
        if (!fits) throw new Error(`Desktop layout overflows at ${width}x${height}, ${language}, ${theme}.`);
        const settingsFit = await window.webContents.executeJavaScript(`(() => {
          switchPage('settings');
          const container = document.querySelector('.settings-layout');
          const cards = Array.from(container.querySelectorAll('.form-card'));
          const fieldsInside = cards.every((card) => Array.from(card.querySelectorAll('input, select, button, .check'))
            .filter((field) => !field.hidden && field.getClientRects().length > 0)
            .every((field) => field.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom - 8));
          const cardsApart = innerWidth > 1100 || cards.every((card, index) => index === 0
            || card.getBoundingClientRect().top >= cards[index - 1].getBoundingClientRect().bottom);
          container.scrollTop = container.scrollHeight;
          const save = document.querySelector('#settings-save').getBoundingClientRect();
          const reachableSave = save.bottom <= container.getBoundingClientRect().bottom + 1;
          container.scrollTop = 0;
          switchPage('workspace');
          return fieldsInside && cardsApart && reachableSave;
        })()`) as boolean;
        if (!settingsFit) throw new Error(`Settings fields are clipped at ${width}x${height}, ${language}, ${theme}.`);
      }
    }
  }
  nativeTheme.themeSource = originalTheme;
  window.setSize(originalSize.width, originalSize.height);
  await window.webContents.executeJavaScript(`state.language = '${originalLanguage}'; applyLanguage(); fillSettings();`);
}

async function verifyTaskHistory(window: BrowserWindow): Promise<void> {
  const originalController = controller;
  controller = new GuiController(async (_apiKey, task, _config, options = {}) => {
    if (task === "smoke-error") throw new Error("Expected smoke failure");
    options.onContent?.("A streamed ");
    if (task === "smoke-stream") {
      const delivered = await window.webContents.executeJavaScript(`(async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          if (document.body.classList.contains('task-running') && activeTurn?.status === 'running'
            && activeTurn.answer === 'A streamed ' && activeAnswer?.textContent.includes('A streamed')) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return false;
      })()`) as boolean;
      if (!delivered) throw new Error("The live streaming chunk did not reach the running conversation.");
    }
    options.onContent?.("reply.");
    if (options.localWorkspace) await options.localWorkspace.write({ path: "smoke.txt", content: "Approved smoke task" });
    return { content: "A streamed reply.", mode: "single", usage: {} };
  });
  controller.setSessionApiKey("smoke-only-key");
  try {
    const results = await window.webContents.executeJavaScript(`(async () => {
      try {
      const originalSession = currentSession;
      state = await bridge.state();
      await selectSession(undefined, state.workspace, true);
      const testSession = currentSession;
      const input = document.querySelector('#task-input');
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#web-mode').value = 'off';
      syncWorkspaceControls();
      input.value = 'smoke-stream';
      await runTask();
      const streamed = currentSession.turns[0].answer === 'A streamed reply.'
        && currentSession.turns[0].status === 'complete'
        && document.querySelector('#timeline').textContent.includes('A streamed reply.');
      document.querySelector('#local-enabled').checked = true;
      syncWorkspaceControls();
      input.value = 'smoke-approval';
      const running = runTask();
      const deadline = Date.now() + 3000;
      while (!pendingAction && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!pendingAction) {
        await bridge.cancelTask();
        await running;
        throw new Error('The live task did not request approval.');
      }
      const automaticApproval = !document.querySelector('#details-drawer').hidden && drawerPage === 'activity'
        && !document.querySelector('#action-content').hidden;
      const originalProject = state.workspace;
      let projectLocked = false;
      try { await bridge.activateWorkspace(); } catch (error) { projectLocked = errorText(error).includes('running'); }
      const navigationLocked = document.querySelector('#new-session').disabled
        && document.querySelector('#choose-workspace').disabled;
      document.querySelector('#action-approve').click();
      await running;
      const approvalCompleted = currentSession.turns.at(-1).status === 'complete'
        && currentSession.activities.some((activity) => activity.operation === 'write' && activity.status === 'success')
        && state.workspace === originalProject;
      const changeDelivered = currentSession.turns.at(-1).changes.length === 1
        && currentSession.turns.at(-1).changes[0].operation === 'create'
        && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'Approved smoke task';
      document.querySelector('#toggle-changes').click();
      const changesPanel = drawerPage === 'changes' && !document.querySelector('#drawer-changes').hidden
        && document.querySelectorAll('#change-list .file-change').length === 1;
      input.value = 'smoke-denied';
      const deniedRun = runTask();
      const deniedDeadline = Date.now() + 3000;
      while (!pendingAction && Date.now() < deniedDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!pendingAction) { await bridge.cancelTask(); await deniedRun; throw new Error('Denied task did not request approval.'); }
      document.querySelector('#action-deny').click();
      await deniedRun;
      const deniedChanges = currentSession.turns.at(-1).changes.length === 0
        && sessionChanges().length === 1 && document.querySelectorAll('#timeline .file-change').length === 1;
      input.value = 'smoke-error';
      await runTask();
      const failureSaved = currentSession.turns.at(-1).status === 'error'
        && currentSession.turns.at(-1).answer.includes('Expected smoke failure')
        && !document.body.classList.contains('task-running') && !document.querySelector('#send-button').disabled;
      await selectSession(originalSession);
      await selectSession(testSession);
      const historyRestored = document.querySelector('#timeline').textContent.includes('A streamed reply.')
        && document.querySelector('#timeline').textContent.includes('Expected smoke failure')
        && document.querySelector('#timeline .file-change .addition .diff-code').textContent === 'Approved smoke task';
      sessions = sessions.filter((session) => session.id !== testSession.id);
      await selectSession(originalSession);
      return { streamed, automaticApproval, projectLocked, navigationLocked, approvalCompleted, changeDelivered,
        changesPanel, deniedChanges, failureSaved, historyRestored };
      } catch (error) { return { failure: errorText(error) }; }
    })()`) as Record<string, boolean | string>;
    for (const [name, value] of Object.entries(results)) {
      if (value !== true) throw new Error(`Desktop task history check failed: ${name} (${value}).`);
    }
  } finally {
    controller = originalController;
    await window.webContents.executeJavaScript("(async () => { state = await bridge.state(); fillSettings(); renderNavigation(); })()");
  }
}

async function verifyReloadDuringTask(window: BrowserWindow): Promise<void> {
  const originalController = controller;
  let signal: AbortSignal | undefined;
  let taskStarted = false;
  let release!: () => void;
  let finished!: () => void;
  const stopping = new Promise<void>((resolve) => { release = resolve; });
  const stopped = new Promise<void>((resolve) => { finished = resolve; });
  controller = new GuiController(async (_apiKey, task, _config, options = {}) => {
    if (task === "smoke-reload") {
      taskStarted = true;
      signal = options.signal;
      options.onContent?.("Reply before reload");
      try {
        await stopping;
        options.onContent?.(" late reply from the old task");
        signal?.throwIfAborted();
      } finally {
        finished();
      }
    }
    return { content: "Reply after reload", mode: "single", usage: {} };
  });
  controller.setSessionApiKey("smoke-only-key");
  const fixture = await window.webContents.executeJavaScript(`(async () => {
    const originalId = currentSession.id;
    state = await bridge.state();
    await selectSession(undefined, state.workspace, true);
    const source = currentSession;
    document.querySelector('#task-input').value = 'smoke-reload';
    document.querySelector('#task-input').dispatchEvent(new Event('input'));
    await selectSession(undefined, source.workspace, true);
    const nextId = currentSession.id;
    await selectSession(source);
    document.querySelector('#local-enabled').checked = false;
    document.querySelector('#web-mode').value = 'off';
    syncWorkspaceControls();
    void runTask();
    return { originalId, sourceId: source.id, nextId };
  })()`) as { originalId: string; sourceId: string; nextId: string };
  try {
    const live = await window.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (activeTurn?.answer === 'Reply before reload' && document.querySelector('#new-session').disabled) return true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return false;
    })()`) as boolean;
    if (!live) throw new Error("The reload fixture did not start a live task.");
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The renderer reload did not finish.")), 5000);
      window.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
    });
    window.webContents.reload();
    await loaded;
    if (!signal?.aborted) throw new Error("Reload did not cancel the previous task.");
    const waiting = await window.webContents.executeJavaScript("document.body.inert && document.body.dataset.ready !== 'true'") as boolean;
    if (!waiting) throw new Error("The reloaded renderer became interactive before the previous task stopped.");
    release();
    await stopped;
    await verifyRenderer(window);
    const recovered = await window.webContents.executeJavaScript(`(async () => {
      const source = sessions.find((session) => session.id === '${fixture.sourceId}');
      const interrupted = currentSession.id === source.id && source.turns.at(-1).status === 'interrupted'
        && source.turns.at(-1).answer === 'Reply before reload';
      await selectSession(sessions.find((session) => session.id === '${fixture.nextId}'));
      const isolated = currentSession.id === '${fixture.nextId}' && currentSession.activities.length === 0
        && currentSession.turns.length === 0 && pendingAction === undefined && document.querySelector('#stop-button').hidden;
      document.querySelector('#local-enabled').checked = false;
      document.querySelector('#task-input').value = 'smoke-reload-next';
      await runTask();
      return interrupted && isolated && currentSession.turns.at(-1).status === 'complete'
        && currentSession.turns.at(-1).answer === 'Reply after reload';
    })()`) as boolean;
    if (!recovered) throw new Error("Reload lost task ownership, mixed session history, or blocked the next task.");
  } finally {
    release();
    if (taskStarted) await stopped;
    controller = originalController;
    await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      sessions = sessions.filter((session) => !['${fixture.sourceId}', '${fixture.nextId}'].includes(session.id));
      await selectSession(sessions.find((session) => session.id === '${fixture.originalId}'));
    })()`);
  }
}

async function verifyUnavailableHistory(window: BrowserWindow, root: string): Promise<void> {
  const directory = join(root, "archived-project");
  const originalWorkspace = controller.workspace;
  mkdirSync(directory);
  const unavailable = controller.setWorkspace(directory);
  const fixture = await window.webContents.executeJavaScript(`(async () => {
    const originalId = currentSession.id;
    state = await bridge.state();
    await selectSession(undefined, state.workspace, true);
    currentSession.title = 'Archived history';
    currentSession.turns.push({ task: 'Saved task', images: [], answer: 'Saved answer', status: 'complete', commands: [] });
    renderSession();
    document.querySelector('#task-input').value = 'Saved draft';
    document.querySelector('#task-input').dispatchEvent(new Event('input'));
    persistSessions();
    return { originalId, archivedId: currentSession.id };
  })()`) as { originalId: string; archivedId: string };
  rmdirSync(directory);
  try {
    await window.loadFile(rendererFile);
    await verifyRenderer(window);
    const startup = await window.webContents.executeJavaScript(`currentSession.id === '${fixture.archivedId}'
      && document.querySelector('#timeline').textContent.includes('Saved answer')
      && document.querySelector('#task-input').value === 'Saved draft'`) as boolean;
    if (!startup) throw new Error("Unavailable-project history did not restore at startup.");
    const restored = await window.webContents.executeJavaScript(`(async () => {
      const archived = sessions.find((session) => session.id === '${fixture.archivedId}');
      await selectSession(sessions.find((session) => session.id === '${fixture.originalId}'));
      await selectSession(archived);
      const main = await bridge.state();
      return currentSession.id === archived.id && document.querySelector('#timeline').textContent.includes('Saved answer')
        && document.querySelector('#task-input').value === 'Saved draft'
        && main.workspace === undefined && main.validWorkspace === undefined
        && !document.querySelector('#local-enabled').checked && document.querySelector('#local-enabled').disabled
        && !document.querySelector('#commands-enabled').checked && document.querySelector('#commands-enabled').disabled
        && document.querySelectorAll('#file-list .file-row').length === 0;
    })()`) as boolean;
    if (!restored) throw new Error("Unavailable-project history cannot open independently of the previous project's files.");
    await window.loadFile(rendererFile);
    await verifyRenderer(window);
    const reopened = await window.webContents.executeJavaScript(`currentSession.id === '${fixture.archivedId}'
      && currentSession.draft === 'Saved draft' && !state.validWorkspace`) as boolean;
    if (!reopened) throw new Error("Unavailable-project selection or draft was lost after reload.");
  } finally {
    controller.workspaces = controller.workspaces.filter((path) => path !== unavailable);
    controller.activateWorkspace(originalWorkspace);
    await window.webContents.executeJavaScript(`(async () => {
      state = await bridge.state();
      sessions = sessions.filter((session) => session.id !== '${fixture.archivedId}');
      await selectSession(sessions.find((session) => session.id === '${fixture.originalId}'));
    })()`);
  }
}

async function verifyAccountLogin(window: BrowserWindow): Promise<void> {
  const originalFetch = net.fetch;
  const originalOpen = shell.openExternal;
  let initialization: { redirect_uri: string; state: string } | undefined;
  let approve = true;
  let callback: Promise<Response> | undefined;
  const envelope = (value: unknown): Response => Response.json({ code: 0, data: { biz_code: 0, biz_data: value } });
  net.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://platform.deepseek.com") throw new Error("Unexpected account smoke-test destination.");
    if (url.pathname.endsWith("auth_init")) {
      initialization = JSON.parse(String(init?.body)) as typeof initialization;
      return envelope({ authorize_id: "smoke-attempt", authorize_url: "https://platform.deepseek.com/dsh/authorize", expires_in: 600 });
    }
    if (url.pathname.endsWith("auth_exchange")) return envelope({ token: "smoke-account-token", authorized_url: "https://platform.deepseek.com/dsh/authorized" });
    return envelope({});
  };
  shell.openExternal = async () => {
    if (approve && initialization) {
      callback = fetch(`${initialization.redirect_uri}?state=${initialization.state}&code=smoke-code`, { redirect: "manual" });
    }
  };
  try {
    const signedIn = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-page="settings"]').click();
      document.querySelector('#account-login').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return state.accountSignedIn && document.querySelector('#account-login').hidden
        && !document.querySelector('#account-logout').hidden && !document.body.textContent.includes('smoke-account-token')
        && !JSON.stringify(localStorage).includes('smoke-account-token');
    })()`) as boolean;
    if (!signedIn || (await callback)?.status !== 302) throw new Error("Desktop account login did not settle safely.");
    const signedOut = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#account-logout').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return !state.accountSignedIn && !document.querySelector('#account-login').hidden
        && document.querySelector('#account-logout').hidden;
    })()`) as boolean;
    if (!signedOut || loadAccountCredential()) throw new Error("Desktop account sign-out did not remove the local grant.");
    approve = false;
    const cancelled = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#account-login').click();
      const waiting = !document.querySelector('#account-cancel').hidden && document.querySelector('#account-login').hidden;
      document.querySelector('#account-cancel').click();
      const deadline = Date.now() + 5000;
      while (accountPending && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      return waiting && !accountPending && !state.accountSignedIn && document.querySelector('#account-cancel').hidden;
    })()`) as boolean;
    if (!cancelled || loadAccountCredential()) throw new Error("Desktop account sign-in cancellation failed.");
    await window.webContents.executeJavaScript(`document.querySelector('[data-page="workspace"]').click(); setStatus(t('ready'));`);
  } finally {
    activeLoginController?.abort(new Error("Account smoke test finished."));
    await activeLoginPromise?.catch(() => undefined);
    net.fetch = originalFetch;
    shell.openExternal = originalOpen;
  }
}

/** YA_SMOKE_CAPTURE=<file> writes a PNG; YA_SMOKE_CAPTURE_PAGE=changes also opens the diff drawer. */
async function captureGuiPage(window: BrowserWindow, target: string): Promise<void> {
  const page = process.env.YA_SMOKE_CAPTURE_PAGE ?? "memory";
  if (!["workspace", "changes", "memory", "settings"].includes(page)) {
    throw new Error("YA_SMOKE_CAPTURE_PAGE must be workspace, changes, memory, or settings.");
  }
  const language = process.env.YA_SMOKE_LANGUAGE;
  if (language && LANGUAGES.includes(language as Language)) {
    await window.webContents.executeJavaScript(`state.language = '${language}'; applyLanguage(); fillSettings(); renderSession();`);
  }
  const theme = process.env.YA_SMOKE_THEME;
  if (theme === "light" || theme === "dark") nativeTheme.themeSource = theme;
  const size = process.env.YA_SMOKE_SIZE?.match(/^(\d+)x(\d+)$/u);
  if (size) window.setSize(Number(size[1]), Number(size[2]));
  await window.webContents.executeJavaScript(`switchPage('${page === "changes" ? "workspace" : page}');
    ${page === "changes" ? "setDrawer('changes'); document.querySelector('#change-list .file-change')?.setAttribute('open', '');" : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(target, (await window.webContents.capturePage()).toPNG());
}

async function verifyApplicationMenu(window: BrowserWindow): Promise<void> {
  if (app.getName() !== "Ya") throw new Error(`Unexpected application name: ${app.getName()}`);
  if (process.platform !== "darwin") return;
  if (basename(app.getPath("exe")) !== "Ya") throw new Error("The macOS executable must be named Ya.");

  const originalLanguage = controller.language;
  const saveLanguage = (language: Language): Promise<unknown> => window.webContents.executeJavaScript(`(async () => {
    const current = await window.ya.state();
    return window.ya.saveSettings({ ...current.config, language: '${language}', stream: current.stream });
  })()`);
  const verifyLabels = (language: Language): void => {
    const menu = Menu.getApplicationMenu();
    const labels = menu?.items.map((item) => item.label).join("|");
    const expected = language === "zh-CN" ? "Ya|文件|编辑|视图|窗口" : "Ya|File|Edit|View|Window";
    const appLabels = menu?.items[0]?.submenu?.items.map((item) => item.label) ?? [];
    const editLabels = menu?.items[2]?.submenu?.items.map((item) => item.label) ?? [];
    const quit = language === "zh-CN" ? "退出 Ya" : "Quit Ya";
    const paste = language === "zh-CN" ? "粘贴" : "Paste";
    if (labels !== expected || !appLabels.includes(quit) || !editLabels.includes(paste)) {
      throw new Error(`Native menu localization failed for ${language}: ${JSON.stringify({ labels, appLabels, editLabels })}`);
    }
  };
  verifyLabels(originalLanguage);
  try {
    for (const language of ["zh-CN", "en"] as const) {
      await saveLanguage(language);
      verifyLabels(language);
    }
  } finally {
    await saveLanguage(originalLanguage);
  }
}

const smokeTest = process.argv.includes("--smoke-test");
const smokeRoot = smokeTest ? mkdtempSync(join(tmpdir(), "ya-desktop-smoke-")) : undefined;
if (smokeRoot) {
  process.env.YA_HOME = join(smokeRoot, "home");
  const profile = join(smokeRoot, "electron");
  mkdirSync(profile);
  app.setPath("userData", profile);
}
app.whenReady().then(async () => {
  controller = createController();
  installApplicationMenu(controller.language);
  registerIpc();
  if (smokeTest) {
    const window = await createWindow(false);
    await verifyRenderer(window);
    await verifyFileDiffRendering(window);
    await verifyApplicationMenu(window);
    await verifySessionNavigation(window, smokeRoot!);
    await verifyUnavailableHistory(window, smokeRoot!);
    await verifyTaskHistory(window);
    await verifyReloadDuringTask(window);
    await verifyResponsiveLayout(window);
    await verifyAccountLogin(window);
    if (process.env.YA_SMOKE_CAPTURE) await captureGuiPage(window, process.env.YA_SMOKE_CAPTURE);
    process.stdout.write(`Ya ${VERSION} GUI smoke test passed.\n`);
    window.destroy();
    app.quit();
    return;
  }
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}).catch((error: unknown) => {
  process.stderr.write(`Ya GUI error: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(2);
});

app.on("quit", () => {
  if (smokeRoot) {
    try { rmSync(smokeRoot, { recursive: true, force: true }); }
    catch {
      // Chromium can still hold its temporary profile open during quit on Windows.
      // Cleanup must not turn a successful smoke run into a blocking native error dialog.
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
