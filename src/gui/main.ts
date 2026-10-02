import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
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
import { runTask } from "../service";
import { VERSION } from "../version";
import { search } from "../web";
import { GuiController, LANGUAGES, type Language } from "./controller";
import { initialWindowGeometry } from "./layout";
import type {
  AppState,
  RendererTaskOptions,
  SelectedImage,
  SettingsUpdate,
  TaskEvent,
  WorkspaceModelSelection,
} from "./shared";

let mainWindow: BrowserWindow | undefined;
let taskRunning = false;
let activeTaskController: AbortController | undefined;
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
    stream: controller.stream,
    hasApiKey: Boolean(controller.apiKey()),
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
  ipcMain.handle("state:get", (event) => {
    assertTrustedSender(event);
    return appState();
  });

  ipcMain.handle("workspace:choose", async (event) => {
    assertTrustedSender(event);
    if (!mainWindow) return undefined;
    const selection = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
    const path = selection.filePaths[0];
    return selection.canceled || !path ? undefined : controller.setWorkspace(path);
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
    controller.setStream(settings.stream);
    if (settings.apiKey?.trim()) {
      if (settings.keyStorage === "keychain") controller.saveMacosApiKey(settings.apiKey);
      else controller.setSessionApiKey(settings.apiKey);
    }
    return appState();
  });

  ipcMain.handle("task:run", async (event, raw: unknown) => {
    assertTrustedSender(event);
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
    try {
      return await controller.run({ ...options, images }, {
        signal: taskController.signal,
        onContent: (content) => sendTaskEvent({ type: "content", content }),
        onLocalActivity: (activity) => sendTaskEvent({ type: "activity", activity }),
        onCommandEvent: (commandEvent) => sendTaskEvent({ type: "command", event: commandEvent }),
        onLocalAction: (action) => new Promise<boolean>((resolvePromise, reject) => {
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
    } finally {
      activeTaskController = undefined;
      rejectPendingActions(new Error("Task ended."));
      taskRunning = false;
      for (const id of options.imageIds) selectedImages.delete(id);
    }
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
    minWidth: 1_020,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
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
  mainWindow.webContents.on("destroyed", () => {
    cancelTask(new Error("The renderer was destroyed while running a task."));
  });
  mainWindow.webContents.on("render-process-gone", () => {
    cancelTask(new Error("The renderer exited while running a task."));
  });
  mainWindow.on("closed", () => {
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
    const ribbon = document.querySelector('.workspace-ribbon');
    const ribbonOrder = ribbon ? Array.from(ribbon.children).map((child) => (child.id || child.querySelector('input')?.id) ?? '') : [];
    const workspaceRibbon = ribbonOrder.join(',') === 'local-enabled,refresh-files,choose-workspace,workspace-path';
    // A long path must stay inside the ribbon instead of widening the page, so probe it before capture.
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
      workspaceControls, commandControls, workspaceRibbon, workspaceOverflow, formOverflow, keychainVisible,
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
    workspaceRibbon?: boolean;
    workspaceOverflow?: number;
    formOverflow?: number;
    keychainVisible?: boolean;
  };
  if (!pages.memoryActive || !pages.settingsActive || !pages.workspaceActive || pages.legacySettingsModelControls
    || !pages.visionOption || !pages.imagePicker || !pages.workspaceControls || !pages.commandControls) {
    throw new Error("Renderer navigation, vision or command controls failed.");
  }
  if (!pages.workspaceRibbon) {
    throw new Error("Workspace ribbon controls must be ordered as local tools, refresh, choose, and path.");
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

/** YA_SMOKE_CAPTURE=<file> writes a PNG of one page (YA_SMOKE_CAPTURE_PAGE=workspace|memory|settings) during the smoke test. */
async function captureGuiPage(window: BrowserWindow, target: string): Promise<void> {
  const page = process.env.YA_SMOKE_CAPTURE_PAGE ?? "memory";
  if (!["workspace", "memory", "settings"].includes(page)) {
    throw new Error("YA_SMOKE_CAPTURE_PAGE must be workspace, memory, or settings.");
  }
  await window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.page').forEach((node) => node.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((node) => node.classList.remove('active'));
    document.querySelector('[data-page="${page}"]')?.classList.add('active');
    document.querySelector('#page-${page}')?.classList.add('active');
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  writeFileSync(target, (await window.webContents.capturePage()).toPNG());
}

const smokeTest = process.argv.includes("--smoke-test");
app.whenReady().then(async () => {
  controller = createController();
  registerIpc();
  if (smokeTest) {
    const window = await createWindow(false);
    await verifyRenderer(window);
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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
