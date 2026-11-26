import { isRecord } from "../../guards";
import { element, getBridge } from "./dom";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import type {
  BotFields,
  CommittedActivity,
  ConversationCommand,
  ConversationTurn,
  DesktopBot,
  FileChange,
  HistoryEntry,
  SelectedImage,
} from "./types";

// Keep the original key, IDs and session envelope so upgrades work in place, even near the storage quota.
export const SESSION_STORAGE_KEY = "ya.desktop.sessions.v1";

export function persistSessions(store: RendererStore, sessions = store.bots): boolean {
  if (store.sessionSaveTimer !== undefined) window.clearTimeout(store.sessionSaveTimer);
  store.sessionSaveTimer = undefined;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
      activeId: store.currentBot.id,
      sessions,
      sidebarCollapsed: document.body.classList.contains("sidebar-collapsed"),
    }));
    return true;
  } catch {
    setStatus(store, t(store, "historySaveError"), "error");
    return false;
  }
}

export function scheduleSessionSave(store: RendererStore): void {
  if (store.sessionSaveTimer !== undefined) window.clearTimeout(store.sessionSaveTimer);
  store.sessionSaveTimer = window.setTimeout(() => persistSessions(store), 250);
}

export function validSavedCommand(value: unknown): value is ConversationCommand {
  if (!isRecord(value) || ![value.id, value.command, value.cwd, value.stdout, value.stderr].every((part) => typeof part === "string")) return false;
  if (value.result === undefined) return true;
  const result = value.result;
  return isRecord(result) && ["success", "failed", "timed_out", "cancelled", "error"].includes(String(result.status))
    && (result.exitCode === null || typeof result.exitCode === "number") && typeof result.durationMs === "number"
    && typeof result.stdout === "string" && typeof result.stderr === "string"
    && typeof result.stdoutTruncated === "boolean" && typeof result.stderrTruncated === "boolean"
    && (result.error === undefined || typeof result.error === "string");
}

export function validSavedFileChange(value: unknown): value is FileChange {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string"
    || !["create", "write", "edit"].includes(String(value.operation)) || typeof value.truncated !== "boolean"
    || ![value.additions, value.deletions].every((count) => count === null || (Number.isSafeInteger(count) && Number(count) >= 0))
    || !Array.isArray(value.hunks)) return false;
  let lines = 0;
  let characters = 0;
  for (const hunk of value.hunks) {
    if (!isRecord(hunk) || ![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)
      || !Array.isArray(hunk.lines) || hunk.lines.length === 0) return false;
    for (const line of hunk.lines) {
      if (typeof line !== "string" || !/^[ +\-\\]/u.test(line)) return false;
      lines += 1;
      characters += line.length;
    }
  }
  return lines <= 2_000 && characters <= 128 * 1_024;
}

export function savedActivities(value: unknown): CommittedActivity[] {
  return Array.isArray(value) ? value.filter((activity): activity is CommittedActivity =>
    isRecord(activity) && typeof activity.operation === "string" && typeof activity.status === "string"
    && Array.isArray(activity.paths) && activity.paths.every((path) => typeof path === "string")) : [];
}

export async function loadSessionHistory(store: RendererStore): Promise<string | undefined> {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "null");
  } catch {
    return undefined;
  }
  if (!isRecord(saved) || !Array.isArray(saved.sessions)) return undefined;
  document.body.classList.toggle("sidebar-collapsed", saved.sidebarCollapsed === true);
  element<HTMLButtonElement>("sidebar-toggle").setAttribute("aria-expanded", String(saved.sidebarCollapsed !== true));
  // A damaged profile can still own a grant under its saved ID.
  const savedIds = saved.sessions.map((value: unknown) => isRecord(value) && typeof value.id === "string" ? value.id : "");
  const ids = await getBridge().restoreBotIds(savedIds);
  let activeId: string | undefined;
  for (const [index, value] of saved.sessions.entries()) {
    if (!isRecord(value) || typeof value.title !== "string"
      || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || typeof value.draft !== "string"
      || !Array.isArray(value.turns)) continue;
    const turns: ConversationTurn[] = [];
    for (const turn of value.turns) {
      if (!isRecord(turn) || typeof turn.task !== "string" || typeof turn.answer !== "string"
        || !["running", "complete", "error", "interrupted"].includes(String(turn.status))) continue;
      const images = Array.isArray(turn.images) ? turn.images.filter((image): image is SelectedImage =>
        isRecord(image) && typeof image.id === "string" && typeof image.name === "string"
        && typeof image.size === "number" && typeof image.mimeType === "string") : [];
      turns.push({
        ...(typeof turn.createdAt === "number" && Number.isFinite(new Date(turn.createdAt).getTime()) ? { createdAt: turn.createdAt } : {}),
        ...(typeof turn.turnId === "string" ? { turnId: turn.turnId } : {}),
        ...(Array.isArray(turn.committedActivities) ? { committedActivities: savedActivities(turn.committedActivities) } : {}),
        ...(typeof turn.taskId === "string" && turn.taskId.trim() ? { taskId: turn.taskId.trim() } : {}),
        task: turn.task,
        answer: turn.answer,
        images,
        status: turn.status === "running" ? "interrupted" : turn.status as ConversationTurn["status"],
        partial: turn.partial === true,
        commands: Array.isArray(turn.commands) ? turn.commands.filter(validSavedCommand) : [],
        changes: Array.isArray(turn.changes) ? turn.changes.filter(validSavedFileChange) : [],
      });
    }
    const id = ids[index]!;
    if (activeId === undefined && savedIds[index] === saved.activeId) activeId = id;
    store.bots.push({
      id,
      title: value.title.trim() || "Ya",
      instructions: typeof value.instructions === "string" ? value.instructions : "",
      updatedAt: value.updatedAt,
      draft: value.draft,
      turns,
      activities: savedActivities(value.activities),
    });
  }
  return activeId;
}

export function createBot(store: RendererStore, profile: BotFields = { title: "Ya", instructions: "" }): DesktopBot {
  const bot: DesktopBot = {
    id: crypto.randomUUID(),
    ...profile,
    updatedAt: Date.now(),
    draft: "",
    turns: [],
    activities: [],
  };
  store.bots.unshift(bot);
  return bot;
}

export function restoreTurnDates(store: RendererStore, tasks: HistoryEntry[]): void {
  const dates = new Map(tasks.map((entry) => [entry.id, entry.timestamp]));
  let changed = false;
  for (const bot of store.bots) {
    for (const turn of bot.turns) {
      if (turn.createdAt !== undefined || !turn.taskId) continue;
      const timestamp = dates.get(turn.taskId);
      if (timestamp != null) {
        turn.createdAt = timestamp;
        changed = true;
      }
    }
  }
  if (changed) persistSessions(store);
}
