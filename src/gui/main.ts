import { randomUUID } from "node:crypto";
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
const pendingActions = new Map<string, (approved: boolean) => void>();
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
    clientFactory: (key) => new DeepSeekClient(key, electronFetch),
    webSearch: (arguments_) => search(arguments_, electronFetch),
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
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("task:event", event);
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
  return {
    task: value.task.trim(),
    webMode,
    toa: Boolean(value.toa),
    toaWorkers: workers,
    stream: Boolean(value.stream),
    local: Boolean(value.local),
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
      throw new Error(`Image input requires model ${VALID_MODELS.vision}.`);
    }
    const files = options.imageIds.map((id) => {
      const file = selectedImages.get(id);
      if (!file) throw new Error("An image selection is no longer available. Choose the image again.");
      return file;
    });
    const images = imageContentPartsFromFiles(files, options.imageDetail);
    taskRunning = true;
    try {
      return await controller.run({ ...options, images }, {
        onContent: (content) => sendTaskEvent({ type: "content", content }),
        onLocalActivity: (activity) => sendTaskEvent({ type: "activity", activity }),
        onLocalAction: (action) => new Promise<boolean>((resolvePromise) => {
          const id = randomUUID();
          pendingActions.set(id, resolvePromise);
          sendTaskEvent({ type: "local-action", id, action });
        }),
      });
    } finally {
      taskRunning = false;
      for (const id of options.imageIds) selectedImages.delete(id);
    }
  });

  ipcMain.on("local-action:response", (event, raw: unknown) => {
    const url = event.senderFrame?.url ?? event.sender.getURL();
    if (!isTrustedRendererUrl(url) || !isRecord(raw) || typeof raw.id !== "string") return;
    const resolver = pendingActions.get(raw.id);
    if (!resolver) return;
    pendingActions.delete(raw.id);
    resolver(Boolean(raw.approved));
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
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    for (const resolvePromise of pendingActions.values()) resolvePromise(false);
    pendingActions.clear();
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
    settingsTab?.click();
    const settingsActive = document.querySelector('#page-settings')?.classList.contains('active') === true;
    const legacySettingsModelControls = document.querySelector('#setting-model, #setting-reasoning') !== null;
    workspaceTab?.click();
    const workspaceActive = document.querySelector('#page-workspace')?.classList.contains('active') === true;
    const model = document.querySelector('#task-model');
    const reasoning = document.querySelector('#task-reasoning');
    const visionOption = document.querySelector('#task-model option[value="deepseek-v4-flash-vision-exp"]') !== null;
    const imagePicker = document.querySelector('#choose-images') !== null;
    const workspaceControls = model instanceof HTMLSelectElement && !model.disabled && model.value !== ''
      && reasoning instanceof HTMLSelectElement && !reasoning.disabled && reasoning.value !== '';
    return { memoryActive, settingsActive, workspaceActive, legacySettingsModelControls, visionOption, imagePicker, workspaceControls };
  })()`) as {
    memoryActive?: boolean;
    settingsActive?: boolean;
    workspaceActive?: boolean;
    legacySettingsModelControls?: boolean;
    visionOption?: boolean;
    imagePicker?: boolean;
    workspaceControls?: boolean;
  };
  if (!pages.memoryActive || !pages.settingsActive || !pages.workspaceActive || pages.legacySettingsModelControls
    || !pages.visionOption || !pages.imagePicker || !pages.workspaceControls) {
    throw new Error("Renderer navigation or vision controls failed.");
  }
}

const smokeTest = process.argv.includes("--smoke-test");
app.whenReady().then(async () => {
  controller = createController();
  registerIpc();
  if (smokeTest) {
    const window = await createWindow(false);
    await verifyRenderer(window);
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
