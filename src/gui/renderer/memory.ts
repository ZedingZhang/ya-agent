import { element, errorText, getBridge } from "./dom";
import { interpolate } from "./i18n";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import type { MemoryKind, MemoryStatus, MemoryView } from "./types";

function cell(value: string, className = ""): HTMLTableCellElement {
  const result = document.createElement("td");
  result.textContent = value;
  if (className) result.className = className;
  return result;
}

function actionButton(label: string, action: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = label;
  button.addEventListener("click", () => void action());
  return button;
}

export function renderMemory(store: RendererStore): void {
  const cards = store.memoryView && "cards" in store.memoryView ? store.memoryView.cards : undefined;
  const error = store.memoryView && "error" in store.memoryView ? store.memoryView.error : undefined;
  const status = element<HTMLDivElement>("memory-status");
  status.textContent = error === undefined ? t(store, "memoryLoading") : `${t(store, "memoryUnavailable")} ${error}`;
  status.hidden = cards !== undefined;
  element<HTMLButtonElement>("memory-retry").hidden = error === undefined;
  element<HTMLButtonElement>("memory-create").disabled = cards === undefined;
  element<HTMLButtonElement>("memory-prune").disabled = cards === undefined;
  element<HTMLDivElement>("memory-empty").hidden = cards?.length !== 0;

  const body = element<HTMLTableSectionElement>("memory-body");
  body.replaceChildren();
  for (const card of cards ?? []) {
    const row = document.createElement("tr");
    row.append(cell(card.id), cell(card.status), cell(card.kind), cell(card.text, "wide"), cell(card.evidence, "wide"));
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (card.status === "candidate") {
      actions.append(
        actionButton(t(store, "approve"), () => updateMemory(store, card.id, "approved")),
        actionButton(t(store, "reject"), () => updateMemory(store, card.id, "rejected")),
      );
    } else if (card.status === "approved") {
      actions.append(actionButton(t(store, "revoke"), () => updateMemory(store, card.id, "revoked")));
    }
    row.append(actions);
    body.append(row);
  }
}

export async function refreshMemory(store: RendererStore): Promise<void> {
  const request = ++store.memoryRequest;
  store.memoryView = undefined;
  renderMemory(store);
  let next: MemoryView;
  try {
    next = { cards: await getBridge().memoryCards() };
  } catch (error) {
    next = { error: errorText(error) };
  }
  if (request !== store.memoryRequest) return;
  store.memoryView = next;
  renderMemory(store);
}

export async function updateMemory(store: RendererStore, cardId: string, status: Exclude<MemoryStatus, "candidate">): Promise<void> {
  try {
    await getBridge().setMemoryStatus(cardId, status);
    await refreshMemory(store);
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  }
}

export async function createMemory(store: RendererStore): Promise<void> {
  const text = element<HTMLTextAreaElement>("candidate-text").value.trim();
  const evidenceInput = element<HTMLInputElement>("candidate-evidence");
  const evidence = evidenceInput.value.trim() || t(store, "explicitFeedback");
  const kind = element<HTMLSelectElement>("candidate-kind").value as MemoryKind;
  if (!text) return;
  try {
    await getBridge().createMemory(text, evidence, kind);
    element<HTMLTextAreaElement>("candidate-text").value = "";
    evidenceInput.value = "";
    await refreshMemory(store);
    setStatus(store, t(store, "saved"));
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  }
}

export async function pruneMemory(store: RendererStore): Promise<void> {
  const includeCandidates = element<HTMLInputElement>("include-candidates").checked;
  try {
    const preview = await getBridge().prunePreview(includeCandidates);
    if (preview.length === 0) return;
    if (!window.confirm(interpolate(t(store, "confirmPrune"), { count: preview.length }))) return;
    await getBridge().pruneMemory(includeCandidates);
    await refreshMemory(store);
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  }
}

export async function refreshActivityMemory(store: RendererStore): Promise<void> {
  if (store.drawerPage !== "activity" || !element("page-workspace").classList.contains("active")) return;
  const task = store.currentBot.turns.at(-1)?.task;
  if (!task) return;
  const panel = element<HTMLDivElement>("relevant-list");
  panel.replaceChildren();
  const request = ++store.relevantMemoryRequest;
  try {
    const matches = await getBridge().relevantCards(task);
    if (request !== store.relevantMemoryRequest) return;
    if (matches.length === 0) {
      panel.textContent = t(store, "noRelevant");
      panel.className = "compact-list empty";
      return;
    }
    panel.className = "compact-list";
    for (const match of matches) {
      const item = document.createElement("div");
      item.className = "memory-chip";
      item.textContent = `${match.card.kind}\n${match.card.text}`;
      panel.append(item);
    }
  } catch (error) {
    if (request === store.relevantMemoryRequest) panel.textContent = errorText(error);
  }
}
