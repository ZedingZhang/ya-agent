import { app, BrowserWindow } from "electron";
import { installApplicationMenu } from "./menu";
import { registerDesktopIpc } from "./main/ipc";
import { DesktopRuntime } from "./main/runtime";
import { createDesktopWindow } from "./main/window";

app.setName("Ya");

const runtime = new DesktopRuntime();

app.whenReady().then(async () => {
  installApplicationMenu(runtime.controller.language);
  registerDesktopIpc(runtime);
  await createDesktopWindow(runtime);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createDesktopWindow(runtime);
  });
}).catch((error: unknown) => {
  process.stderr.write(`Ya GUI error: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(2);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
