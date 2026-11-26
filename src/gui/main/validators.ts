import type { IpcMainInvokeEvent } from "electron";
import { isReasoningEffort, VALID_MODELS } from "../../config";
import { isRecord } from "../../guards";
import { isImageDetail, MAX_IMAGES_PER_REQUEST } from "../../images";
import type { ConversationMessage } from "../../types";
import { LANGUAGES, type Language } from "../controller";
import type { RendererTaskOptions, SettingsUpdate, WorkspaceModelSelection } from "../shared";

export function isTrustedRendererUrl(value: string, expectedUrl: string): boolean {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    return parsed.toString() === expectedUrl;
  } catch {
    return false;
  }
}

export function assertTrustedSender(event: IpcMainInvokeEvent, expectedUrl: string): void {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  if (!isTrustedRendererUrl(url, expectedUrl)) throw new Error("Untrusted renderer request.");
}

export function validBotId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0
    && value.length <= 128 && !/[\x00-\x1f\x7f]/u.test(value);
}

export function validateTaskOptions(value: unknown): RendererTaskOptions {
  if (!isRecord(value) || typeof value.task !== "string" || !value.task.trim()) throw new Error("Enter a task first.");
  let sessionId: string | undefined;
  if (value.sessionId !== undefined) {
    if (
      typeof value.sessionId !== "string"
      || !value.sessionId.trim()
      || value.sessionId.trim().length > 128
      || /[\x00-\x1F\x7F]/u.test(value.sessionId)
    ) {
      throw new Error("Invalid session ID.");
    }
    sessionId = value.sessionId.trim();
  }
  if (value.turnId !== undefined && !validBotId(value.turnId)) throw new Error("Invalid turn ID.");
  let botProfile: RendererTaskOptions["botProfile"];
  if (value.botProfile !== undefined) {
    const profile = value.botProfile;
    if (!isRecord(profile) || typeof profile.name !== "string" || !profile.name.trim() || profile.name.length > 64
      || typeof profile.instructions !== "string" || profile.instructions.length > 4000) throw new Error("Invalid bot profile.");
    botProfile = { name: profile.name.trim(), instructions: profile.instructions.trim() };
  }
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
  if (value.exec) throw new Error("Shell commands are unavailable for folder-scoped bots.");
  const history = value.history === undefined ? [] : value.history;
  if (!Array.isArray(history)) throw new Error("Invalid conversation history.");
  const messages = history.map((message): ConversationMessage => {
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") {
      throw new Error("Invalid conversation history.");
    }
    return { role: message.role, content: message.content };
  });
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
    ...(botProfile ? { botProfile } : {}),
    task: value.task.trim(),
    history: messages,
    webMode,
    toa: Boolean(value.toa),
    toaWorkers: workers,
    stream: Boolean(value.stream),
    local: Boolean(value.local),
    folderGrantVersion: typeof value.folderGrantVersion === "string" ? value.folderGrantVersion : undefined,
    imageIds,
    imageDetail,
  };
}

export function validateSettings(value: unknown): SettingsUpdate {
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

export function validateWorkspaceModelSelection(value: unknown): WorkspaceModelSelection {
  if (!isRecord(value)) throw new Error("Invalid workspace model selection.");
  if (!Object.values(VALID_MODELS).includes(value.model as never)) throw new Error("Invalid model.");
  if (!isReasoningEffort(value.reasoningEffort)) throw new Error("Invalid reasoning effort.");
  return {
    model: value.model as (typeof VALID_MODELS)[keyof typeof VALID_MODELS],
    reasoningEffort: value.reasoningEffort,
  };
}
