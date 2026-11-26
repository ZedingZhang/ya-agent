import { element, errorText, formatBytes, getBridge } from "./dom";
import { interpolate } from "./i18n";
import { persistSessions, restoreTurnDates } from "./sessions";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import type { StorageItem, StoredHistoryKind } from "./types";

export interface StorageCallbacks {
  renderBot: () => void;
  renderNavigation: () => void;
}

export function storageKind(): StoredHistoryKind | "chats" {
  return element<HTMLSelectElement>("storage-kind").value as StoredHistoryKind | "chats";
}

export function historySize(items: StorageItem[]): string {
  return formatBytes(items.reduce((total, item) => total + item.bytes, 0));
}

export function storageSelection(store: RendererStore): StorageItem[] | undefined {
  const period = element<HTMLSelectElement>("storage-period").value;
  if (period === "all") return store.storageItems;
  if (period === "undated") return store.storageItems?.filter((item) => item.timestamp === null);
  let start = -Infinity;
  let end: Date;
  if (period === "custom") {
    // Date inputs contain calendar days. Construct both midnights in the local timezone, including across DST.
    start = new Date(element<HTMLInputElement>("storage-from").value + "T00:00:00").getTime();
    end = new Date(element<HTMLInputElement>("storage-to").value + "T00:00:00");
    if (!Number.isFinite(start) || !Number.isFinite(end.getTime()) || start > end.getTime()) return undefined;
    end.setDate(end.getDate() + 1);
  } else {
    end = new Date();
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() - Number(period));
  }
  return store.storageItems?.filter(({ timestamp }) => timestamp !== null && timestamp >= start && timestamp < end.getTime());
}

export function renderStorage(store: RendererStore): void {
  const kind = storageKind();
  const custom = element<HTMLSelectElement>("storage-period").value === "custom";
  element("storage-custom-dates-row").hidden = !custom;
  element("storage-from-field").hidden = !custom;
  element("storage-to-field").hidden = !custom;
  const scope = t(store, kind === "chats" ? "chatScope" : kind === "tasks" ? "taskScope" : "auditScope");
  const undated = store.storageItems?.filter((item) => item.timestamp === null).length;
  element("storage-scope").textContent = undated ? scope + " " + interpolate(t(store, "undatedHint"), { count: undated }) : scope;
  const selected = storageSelection(store);
  const busy = kind === "chats" && document.body.classList.contains("task-running");
  const summary = element("storage-summary");
  if (store.storageError) summary.textContent = store.storageError;
  else if (busy) summary.textContent = t(store, "storageBusy");
  else if (!store.storageItems) summary.textContent = t(store, "storageLoading");
  else if (!selected) summary.textContent = t(store, "invalidDates");
  else summary.textContent = interpolate(t(store, "storageSummary"), {
    count: selected.length,
    bytes: historySize(selected),
    total: store.storageItems.length,
    size: historySize(store.storageItems),
  });
  element<HTMLButtonElement>("storage-delete").disabled = store.deletingHistory || busy || !selected?.length;
}

export async function refreshStorage(store: RendererStore): Promise<void> {
  const request = ++store.storageRequest;
  const kind = storageKind();
  store.storageItems = undefined;
  store.storageError = "";
  renderStorage(store);
  try {
    let items: StorageItem[];
    if (kind === "chats") {
      if (store.bots.some((bot) => bot.turns.some((turn) => turn.taskId && turn.createdAt === undefined))) {
        // Chat history is still manageable if the separate task store is unavailable.
        restoreTurnDates(store, await getBridge().historyEntries("tasks").catch(() => []));
      }
      const encoder = new TextEncoder();
      items = store.bots.flatMap((bot) => bot.turns.filter((turn) => turn.status !== "running").map((turn) => ({
        id: turn,
        timestamp: turn.createdAt ?? null,
        bytes: encoder.encode(JSON.stringify(turn)).length
          + (turn === bot.turns.at(-1) ? encoder.encode(JSON.stringify(bot.activities)).length - 2 : 0),
      })));
    } else {
      const entries = await getBridge().historyEntries(kind);
      if (kind === "tasks") restoreTurnDates(store, entries);
      items = entries;
    }
    if (request === store.storageRequest) store.storageItems = items;
  } catch (error) {
    if (request === store.storageRequest) store.storageError = errorText(error);
  }
  if (request === store.storageRequest) renderStorage(store);
}

export function deleteConversationTurns(
  store: RendererStore,
  selected: StorageItem[],
  callbacks: StorageCallbacks,
): number {
  const turns = new Set(selected.map((item) => item.id));
  const next = store.bots.map((bot) => {
    const kept = bot.turns.filter((turn) => !turns.has(turn));
    if (kept.length === bot.turns.length) return bot;
    return { ...bot, turns: kept, activities: kept.at(-1) === bot.turns.at(-1) ? bot.activities : [] };
  });
  if (!persistSessions(store, next)) throw new Error(t(store, "historySaveError"));
  // Keep bot references used by navigation and any open editor.
  const currentChanged = next[store.bots.indexOf(store.currentBot)] !== store.currentBot;
  next.forEach((bot, index) => Object.assign(store.bots[index]!, bot));
  if (currentChanged) {
    const local = element<HTMLInputElement>("local-enabled").checked;
    callbacks.renderBot();
    element<HTMLInputElement>("local-enabled").checked = local;
  }
  callbacks.renderNavigation();
  return turns.size;
}

export async function deleteSelectedHistory(store: RendererStore, callbacks: StorageCallbacks): Promise<void> {
  if (element<HTMLButtonElement>("storage-delete").disabled) return;
  const kind = storageKind();
  const selected = storageSelection(store);
  if (!selected?.length) return;
  const period = element<HTMLSelectElement>("storage-period");
  const range = period.value === "custom"
    ? `${element<HTMLInputElement>("storage-from").value} – ${element<HTMLInputElement>("storage-to").value}`
    : period.selectedOptions[0]!.text;
  if (!window.confirm(interpolate(t(store, "confirmHistory"), {
    kind: element<HTMLSelectElement>("storage-kind").selectedOptions[0]!.text,
    range,
    count: selected.length,
    bytes: historySize(selected),
  }))) return;
  store.deletingHistory = true;
  renderStorage(store);
  try {
    const count = kind === "chats" ? deleteConversationTurns(store, selected, callbacks)
      : await getBridge().deleteHistory(kind, selected.flatMap(({ id }) => typeof id === "string" ? [id] : []));
    setStatus(store, interpolate(t(store, "historyDeleted"), { count }));
  } catch (error) {
    setStatus(store, errorText(error), "error");
  } finally {
    store.deletingHistory = false;
    if (element("page-settings").classList.contains("active")) await refreshStorage(store);
  }
}
