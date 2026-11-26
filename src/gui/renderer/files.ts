import { element, errorText, formatBytes, getBridge } from "./dom";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import type { FolderAccess } from "./types";

const VISION_MODEL = "deepseek-flash";

export function visionEnabled(store: RendererStore): boolean {
  return store.state?.config.model === VISION_MODEL;
}

export function renderWorkspaceLabel(store: RendererStore): void {
  store.displayedGrantVersion = store.state.folderGrantVersion;
  const label = element<HTMLDivElement>("workspace-path");
  label.textContent = store.state.workspace ?? "";
  label.title = label.textContent;
  label.hidden = !store.state.workspace;
  element<HTMLDivElement>("folder-scope").textContent = store.state.workspace && store.state.folderSessionOnly
    ? `${store.state.workspace} · ${t(store, "sessionFolder")}` : store.state.workspace ?? t(store, "noWorkspace");
  element<HTMLDivElement>("file-toolbar").hidden = !store.state.workspace;
  element<HTMLButtonElement>("revoke-folder").hidden = !store.state.workspace;
}

export function renderImages(store: RendererStore): void {
  const list = element<HTMLDivElement>("image-list");
  const running = document.body.classList.contains("task-running");
  const vision = visionEnabled(store);
  element<HTMLButtonElement>("choose-images").disabled = running || store.workspaceModelSaving || store.navigationPending || !vision;
  element<HTMLButtonElement>("choose-images").title = t(store, vision ? "attachImages" : "visionOnly");
  element<HTMLButtonElement>("clear-images").disabled = running || store.workspaceModelSaving || store.selectedImages.length === 0;
  element<HTMLSelectElement>("image-detail").disabled = running || store.workspaceModelSaving || !vision || store.selectedImages.length === 0;
  const lowDetail = element<HTMLOptionElement>("image-detail-low");
  lowDetail.disabled = store.state.accountSignedIn;
  lowDetail.textContent = store.state.accountSignedIn ? t(store, "lowApiKeyOnly") : "low";
  list.replaceChildren();
  element<HTMLDivElement>("image-controls").hidden = store.selectedImages.length === 0;
  if (!vision) {
    list.textContent = t(store, "visionOnly");
    list.className = "image-list muted";
    return;
  }
  if (store.selectedImages.length === 0) {
    list.textContent = t(store, "noImages");
    list.className = "image-list muted";
    return;
  }
  list.className = "image-list";
  for (const image of store.selectedImages) {
    const chip = document.createElement("span");
    chip.className = "image-chip";
    const name = document.createElement("span");
    name.textContent = image.name;
    name.title = `${image.mimeType} · ${formatBytes(image.size)}`;
    const size = document.createElement("span");
    size.textContent = formatBytes(image.size);
    chip.append(name, size);
    list.append(chip);
  }
}

export async function chooseImages(store: RendererStore): Promise<void> {
  try {
    const images = await getBridge().chooseImages();
    if (!images) return;
    store.selectedImages = images;
    renderImages(store);
    setStatus(store, t(store, "ready"));
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  }
}

export async function clearImages(store: RendererStore): Promise<void> {
  store.selectedImages = [];
  renderImages(store);
  await getBridge().clearImages();
}

export function applyFolderAvailability(store: RendererStore, access: FolderAccess, onSyncControls: () => void): void {
  if (!store.state.validWorkspace && access.validWorkspace && !element<HTMLInputElement>("toa-enabled").checked) {
    element<HTMLInputElement>("local-enabled").checked = true;
  }
  Object.assign(store.state, access);
  onSyncControls();
}

export async function checkSelectedFolder(store: RendererStore, onSyncControls: () => void): Promise<void> {
  const request = ++store.fileRequest;
  const botId = store.currentBot.id;
  element<HTMLDivElement>("file-list").replaceChildren();
  if (!store.state.workspace) return;
  try {
    const access = await getBridge().checkFolder(botId);
    if (request !== store.fileRequest || store.currentBot.id !== botId) return;
    applyFolderAvailability(store, access, onSyncControls);
  } catch (error) {
    if (request === store.fileRequest && store.currentBot.id === botId) setStatus(store, errorText(error), "error");
  }
}

function fileRow(name: string, type: string): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "file-row";
  row.disabled = type !== "directory";
  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.textContent = type === "directory" ? "▸" : type === "symlink" ? "↗" : "·";
  const label = document.createElement("span");
  label.textContent = name;
  row.append(icon, label);
  return row;
}

export async function renderFiles(store: RendererStore, onSyncControls: () => void): Promise<void> {
  const request = ++store.fileRequest;
  const botId = store.currentBot.id;
  const directory = store.currentDirectory;
  const expectedVersion = directory === "." ? store.state.folderGrantVersion : store.directoryGrantVersion;
  const list = element<HTMLDivElement>("file-list");
  const breadcrumb = element<HTMLDivElement>("file-location");
  list.replaceChildren();
  breadcrumb.textContent = store.currentDirectory;
  try {
    const { access, entries } = await getBridge().workspaceEntries(botId, directory, expectedVersion);
    if (request !== store.fileRequest || botId !== store.currentBot.id || directory !== store.currentDirectory) return;
    applyFolderAvailability(store, access, onSyncControls);
    if (!access.validWorkspace) return;
    store.directoryGrantVersion = access.folderGrantVersion;
    if (expectedVersion !== access.folderGrantVersion) {
      store.currentDirectory = ".";
      return renderFiles(store, onSyncControls);
    }
    list.replaceChildren();
    if (store.currentDirectory !== ".") {
      const up = fileRow("..", "directory");
      up.addEventListener("click", () => {
        const pieces = store.currentDirectory.split(/[\\/]/u);
        pieces.pop();
        store.currentDirectory = pieces.join("/") || ".";
        void renderFiles(store, onSyncControls);
      });
      list.append(up);
    }
    for (const entry of entries) {
      const row = fileRow(entry.path.split(/[\\/]/u).at(-1) ?? entry.path, entry.type);
      if (entry.type === "directory") row.addEventListener("click", () => {
        store.currentDirectory = entry.path;
        void renderFiles(store, onSyncControls);
      });
      list.append(row);
    }
  } catch (error) {
    if (request !== store.fileRequest || botId !== store.currentBot.id || directory !== store.currentDirectory) return;
    const empty = document.createElement("p");
    empty.className = "error-copy";
    empty.textContent = errorText(error);
    list.append(empty);
  }
}

export async function updateFolderAccess(
  store: RendererStore,
  revoke: boolean,
  setNavigationPending: (pending: boolean) => void,
  onSyncControls: () => void,
): Promise<void> {
  if (store.navigationPending || document.body.classList.contains("task-running")) return;
  setNavigationPending(true);
  try {
    const access = revoke ? await getBridge().revokeFolder(store.currentBot.id) : await getBridge().chooseWorkspace(store.currentBot.id);
    if (!access) return;
    Object.assign(store.state, access);
    store.currentDirectory = ".";
    element<HTMLInputElement>("local-enabled").checked = Boolean(store.state.validWorkspace) && !element<HTMLInputElement>("toa-enabled").checked;
    renderWorkspaceLabel(store);
    void renderFiles(store, onSyncControls);
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  } finally {
    setNavigationPending(false);
  }
}
