import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { registerDesktopIpc } from "../../dist/typescript/gui/main/ipc";
import { DesktopRuntime } from "../../dist/typescript/gui/main/runtime";
import { createDesktopWindow } from "../../dist/typescript/gui/main/window";
import { installApplicationMenu } from "../../dist/typescript/gui/menu";
import { VERSION } from "../../dist/typescript/version";
import { verifyMemory } from "./verify-memory";
import { verifyAccountLogin, verifyApplicationMenu, verifySettingsExperience } from "./verify-settings";
import {
  verifyApprovalAccessibility,
  verifyApprovalLifecycle,
  verifyConversationContext,
  verifyIcmHistory,
  verifyReloadDuringTask,
  verifyStorageManagement,
  verifyTaskHistory,
} from "./verify-tasks";
import {
  captureGuiPage,
  verifyBotIdRecovery,
  verifyBotNavigation,
  verifyFileDiffRendering,
  verifyPendingFolderChat,
  verifyRenderer,
  verifyResponsiveLayout,
  verifyUnavailableHistory,
} from "./verify-workspace";

app.setName("Ya");

const smokeRoot = mkdtempSync(join(tmpdir(), "ya-desktop-smoke-"));
process.env.YA_HOME = join(smokeRoot, "home");
const profile = join(smokeRoot, "electron");
mkdirSync(profile);
app.setPath("userData", profile);

const runtime = new DesktopRuntime();

app.whenReady().then(async () => {
  installApplicationMenu(runtime.controller.language);
  registerDesktopIpc(runtime);
  const window = await createDesktopWindow(runtime, { show: false, smokeTest: true });
  await verifyRenderer(window);
  await verifyFileDiffRendering(window);
  await verifyApplicationMenu(runtime, window);
  await verifyBotNavigation(runtime, window, smokeRoot);
  await verifyUnavailableHistory(runtime, window, smokeRoot);
  await verifyPendingFolderChat(runtime, window, smokeRoot);
  await verifyBotIdRecovery(runtime, window, smokeRoot);
  await verifyTaskHistory(runtime, window);
  await verifyStorageManagement(window);
  await verifyApprovalLifecycle(runtime, window);
  await verifyApprovalAccessibility(runtime, window);
  await verifyConversationContext(runtime, window);
  await verifyIcmHistory(runtime, window);
  await verifyReloadDuringTask(runtime, window);
  await verifyResponsiveLayout(runtime, window);
  await verifySettingsExperience(runtime, window);
  await verifyAccountLogin(runtime, window);
  await verifyMemory(runtime, window, smokeRoot);
  if (process.env.YA_SMOKE_CAPTURE) await captureGuiPage(window, process.env.YA_SMOKE_CAPTURE);
  process.stdout.write(`Ya ${VERSION} GUI smoke test passed.\n`);
  window.destroy();
  app.quit();
}).catch((error: unknown) => {
  process.stderr.write(`Ya GUI error: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(2);
});

app.on("quit", () => {
  try { rmSync(smokeRoot, { recursive: true, force: true }); }
  catch {
    // Chromium can still hold its temporary profile open during quit on Windows.
    // Cleanup must not turn a successful smoke run into a blocking native error dialog.
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
