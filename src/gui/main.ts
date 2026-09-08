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
import { ModelConfig, VALID_MODELS, type ReasoningEffort } from "../config";
import { DeepSeekClient, type FetchLike } from "../deepseek";
import { DuplicateMemoryError, MemoryLimitError, type MemoryKind } from "../memory";
import { runTask } from "../service";
import { VERSION } from "../version";
import { search } from "../web";
import { GuiController, LANGUAGES, type Language } from "./controller";
import { initialWindowGeometry } from "./layout";
import type { AppState, RendererTaskOptions, SettingsUpdate, TaskEvent } from "./shared";

let mainWindow: BrowserWindow | undefined;
let taskRunning = false;
const pendingActions = new Map<string, (approved: boolean) => void>();
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
  return {
    task: value.task.trim(),
    webMode,
    toa: Boolean(value.toa),
    toaWorkers: workers,
    stream: Boolean(value.stream),
    local: Boolean(value.local),
    ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
  };
}

function validateSettings(value: unknown): SettingsUpdate {
  if (!isRecord(value)) throw new Error("Invalid settings payload.");
  if (!LANGUAGES.includes(value.language as Language)) throw new Error("Invalid language.");
  if (!Object.values(VALID_MODELS).includes(value.model as never)) throw new Error("Invalid model.");
  if (value.reasoningEffort !== "high" && value.reasoningEffort !== "max") throw new Error("Invalid reasoning effort.");
  return {
    language: value.language as Language,
    stream: Boolean(value.stream),
    model: value.model as (typeof VALID_MODELS)[keyof typeof VALID_MODELS],
    thinkingEnabled: Boolean(value.thinkingEnabled),
    reasoningEffort: value.reasoningEffort as ReasoningEffort,
    toaTokenBudget: Number(value.toaTokenBudget),
    toaTimeout: Number(value.toaTimeout),
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(value.keyStorage === "session" || value.keyStorage === "keychain" ? { keyStorage: value.keyStorage } : {}),
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

  ipcMain.handle("settings:save", (event, raw: unknown) => {
    assertTrustedSender(event);
    const settings = validateSettings(raw);
    const config = new ModelConfig(settings);
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
    taskRunning = true;
    try {
      return await controller.run(options, {
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
    memoryTab?.click();
    const memoryActive = document.querySelector('#page-memory')?.classList.contains('active') === true;
    settingsTab?.click();
    const settingsActive = document.querySelector('#page-settings')?.classList.contains('active') === true;
    return { memoryActive, settingsActive };
  })()`) as { memoryActive?: boolean; settingsActive?: boolean };
  if (!pages.memoryActive || !pages.settingsActive) throw new Error("Renderer page navigation failed.");
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
