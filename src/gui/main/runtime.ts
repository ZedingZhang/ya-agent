import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { net, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { DeepSeekCredential } from "../../credentials";
import { DeepSeekClient, type FetchLike } from "../../deepseek";
import type { ImageFileInfo } from "../../images";
import type { RunResult } from "../../orchestrator";
import { runTask } from "../../service";
import { search } from "../../web";
import { VERSION } from "../../version";
import { GuiController } from "../controller";
import type { AppState, CommittedOutcome, TaskEvent } from "../shared";
import { assertTrustedSender, isTrustedRendererUrl } from "./validators";

export const LOCAL_ACTION_TIMEOUT_MS = 120_000;

export interface PendingActionEntry {
  resolve: (approved: boolean) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createElectronFetch(): FetchLike {
  return (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init);
}

export function createDesktopController(fetcher: FetchLike = createElectronFetch()): GuiController {
  return new GuiController((apiKey, task, config, options = {}) => runTask(apiKey, task, config, {
    ...options,
    // Electron's network stack follows the operating system proxy and trust
    // configuration while the CLI continues to use Node's native fetch.
    clientFactory: (key, signal) => new DeepSeekClient(key, fetcher, undefined, signal),
    webSearch: (arguments_) => search(arguments_, fetcher, undefined, options.signal),
  }));
}

/** Explicit main-process state container shared across IPC handlers, windows, and tests. */
export class DesktopRuntime {
  readonly electronFetch: FetchLike;
  readonly rendererFile = join(__dirname, "..", "index.html");
  readonly rendererUrl = pathToFileURL(this.rendererFile).toString();
  // Survives renderer replacement until the owning turn is saved to its history.
  readonly pendingOutcomes = new Map<string, CommittedOutcome>();
  readonly pendingActions = new Map<string, PendingActionEntry>();
  readonly selectedImages = new Map<string, ImageFileInfo>();

  controller: GuiController;
  mainWindow?: BrowserWindow;
  taskRunning = false;
  activeTaskController?: AbortController;
  activeTaskPromise?: Promise<RunResult>;
  rendererGeneration = 0;
  folderBrowserRequest?: AbortController;
  folderSelectionRevision = 0;
  activeLoginController?: AbortController;
  activeLoginPromise?: Promise<void>;

  constructor(createController: (fetcher: FetchLike) => GuiController = createDesktopController) {
    this.electronFetch = createElectronFetch();
    this.controller = createController(this.electronFetch);
  }

  appState(): AppState {
    const logs = this.controller.auditLogs();
    let credential: DeepSeekCredential | undefined;
    let accountError = false;
    try { credential = this.controller.apiKey(); }
    catch { accountError = true; }
    return {
      version: VERSION,
      platform: process.platform,
      language: this.controller.language,
      ...this.controller.folderState(),
      stream: this.controller.stream,
      hasApiKey: Boolean(credential),
      accountSignedIn: typeof credential === "object" && credential.kind === "account",
      accountError,
      config: {
        model: this.controller.config.model,
        thinkingEnabled: this.controller.config.thinkingEnabled,
        reasoningEffort: this.controller.config.reasoningEffort,
        toaTokenBudget: this.controller.config.toaTokenBudget,
        toaTimeout: this.controller.config.toaTimeout,
      },
      auditLogCount: logs.length,
      auditLogBytes: this.controller.auditLogTotalBytes(),
    };
  }

  sendTaskEvent(event: TaskEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send("task:event", event);
    }
  }

  rejectPendingActions(error: Error): void {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingActions.clear();
  }

  cancelTask(error: Error): void {
    this.activeTaskController?.abort(error);
    this.rejectPendingActions(error);
  }

  detachTaskRenderer(error: Error): void {
    ++this.rendererGeneration;
    this.cancelTask(error);
  }

  isTrustedRendererUrl(value: string): boolean {
    return isTrustedRendererUrl(value, this.rendererUrl);
  }

  assertTrustedSender(event: IpcMainInvokeEvent): void {
    assertTrustedSender(event, this.rendererUrl);
  }

  async readFolderForDisplay<T>(botId: unknown, read: (botId: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.controller.assertActiveBot(botId);
    this.folderBrowserRequest?.abort();
    const request = new AbortController();
    this.folderBrowserRequest = request;
    try {
      return await read(botId, request.signal);
    } finally {
      if (this.folderBrowserRequest === request) this.folderBrowserRequest = undefined;
    }
  }
}
