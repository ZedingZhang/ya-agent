import { join } from "node:path";
import { BrowserWindow, screen, shell } from "electron";
import { initialWindowGeometry } from "../layout";
import type { DesktopRuntime } from "./runtime";

export interface DesktopWindowOptions {
  show?: boolean;
  smokeTest?: boolean;
}

export async function createDesktopWindow(
  runtime: DesktopRuntime,
  options: DesktopWindowOptions = {},
): Promise<BrowserWindow> {
  const show = options.show ?? true;
  const display = screen.getPrimaryDisplay().workAreaSize;
  const geometry = initialWindowGeometry(display.width, display.height);
  const window = new BrowserWindow({
    ...geometry,
    title: "Ya",
    minWidth: 860,
    minHeight: 680,
    show: false,
    webPreferences: {
      preload: join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(options.smokeTest ? { additionalArguments: ["--ya-smoke-test"] } : {}),
    },
  });
  runtime.mainWindow = window;
  if (process.platform !== "darwin") window.removeMenu();
  if (show) window.once("ready-to-show", () => runtime.mainWindow?.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
    } catch {
      // Ignore malformed window-open requests.
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!runtime.isTrustedRendererUrl(url)) event.preventDefault();
  });
  window.webContents.on("did-start-loading", () => {
    ++runtime.folderSelectionRevision;
    runtime.folderBrowserRequest?.abort();
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window reload."));
    runtime.detachTaskRenderer(new Error("The renderer was reloaded while running a task."));
  });
  window.webContents.on("destroyed", () => {
    ++runtime.folderSelectionRevision;
    runtime.folderBrowserRequest?.abort();
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window close."));
    runtime.detachTaskRenderer(new Error("The renderer was destroyed while running a task."));
  });
  window.webContents.on("render-process-gone", () => {
    ++runtime.folderSelectionRevision;
    runtime.folderBrowserRequest?.abort();
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by renderer exit."));
    runtime.detachTaskRenderer(new Error("The renderer exited while running a task."));
  });
  window.on("closed", () => {
    runtime.activeLoginController?.abort(new Error("DeepSeek sign-in cancelled by window close."));
    runtime.mainWindow = undefined;
    runtime.detachTaskRenderer(new Error("The window was closed while running a task."));
    runtime.selectedImages.clear();
  });
  await window.loadFile(runtime.rendererFile);
  return window;
}
