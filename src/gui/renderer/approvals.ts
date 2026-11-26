import { element, errorText, getBridge } from "./dom";
import { persistSessions } from "./sessions";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import type { ConversationTurn } from "./types";

export function renderActivities(store: RendererStore): void {
  const list = element<HTMLDivElement>("activity-list");
  list.replaceChildren();
  if (store.activities.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t(store, "noActivity");
    list.append(empty);
    return;
  }
  for (const activity of store.activities) {
    const item = document.createElement("div");
    item.className = `activity-row ${activity.status}`;
    const label = document.createElement("strong");
    label.textContent = `${activity.operation} · ${activity.status}`;
    const paths = document.createElement("span");
    paths.textContent = activity.paths.join(" → ");
    item.append(label, paths);
    list.append(item);
  }
}

export function renderPendingAction(store: RendererStore): void {
  const empty = element<HTMLParagraphElement>("action-empty");
  const content = element<HTMLDivElement>("action-content");
  element<HTMLButtonElement>("action-approve").disabled = Boolean(store.pendingAction?.responding);
  element<HTMLButtonElement>("action-deny").disabled = Boolean(store.pendingAction?.responding);
  const toggle = element<HTMLButtonElement>("toggle-activity");
  toggle.classList.toggle("has-pending", Boolean(store.pendingAction));
  const label = t(store, store.pendingAction ? "activityPending" : "activity");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  const announcement = element<HTMLParagraphElement>("approval-announcement");
  const message = store.pendingAction ? t(store, "approvalAnnouncement") : store.actionExpired ? t(store, "approvalExpired") : "";
  if (announcement.textContent !== message) announcement.textContent = message;
  if (!store.pendingAction) {
    empty.hidden = false;
    empty.textContent = t(store, store.actionExpired ? "approvalExpired" : "noAction");
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  element<HTMLDivElement>("action-summary").textContent = store.pendingAction.action.summary;
  element<HTMLDivElement>("action-paths").textContent = store.pendingAction.action.paths.join("\n");
  element<HTMLPreElement>("action-diff").textContent = store.pendingAction.action.diff ?? "";
  element<HTMLPreElement>("action-diff").hidden = !store.pendingAction.action.diff;
}

export function clearPendingAction(store: RendererStore, expired = store.actionExpired): void {
  const restore = Boolean(store.pendingAction) && (element<HTMLElement>("approval-panel").contains(document.activeElement)
    || document.activeElement === document.body);
  const target = store.approvalReturnFocus;
  store.pendingAction = undefined;
  store.approvalReturnFocus = undefined;
  store.actionExpired = expired;
  renderPendingAction(store);
  if (restore) {
    if (target && target !== document.body && target.isConnected && !target.matches(":disabled") && target.getClientRects().length > 0) {
      target.focus({ preventScroll: true });
      if (document.activeElement === target) return;
    }
    element<HTMLButtonElement>("toggle-activity").focus({ preventScroll: true });
  }
}

export function decideLocalAction(store: RendererStore, approved: boolean): void {
  if (!store.pendingAction || store.pendingAction.responding) return;
  // A committed operation must have a recoverable owner before approval.
  if (approved && (!store.activeTurn?.turnId || !store.currentBot.turns.includes(store.activeTurn) || !persistSessions(store))) return;
  store.pendingAction.responding = true;
  renderPendingAction(store);
  try { getBridge().respondLocalAction(store.pendingAction.id, approved); }
  catch (error) {
    store.pendingAction.responding = false;
    renderPendingAction(store);
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  }
}

export function renderPendingMutation(store: RendererStore, turn: ConversationTurn, container: HTMLElement): void {
  const history = turn.committedActivities ?? [];
  if (!history.some((item) => item.status === "pending")) return;
  let label = container.querySelector<HTMLElement>(".mutation-status");
  if (!label) {
    label = document.createElement("p");
    label.className = "mutation-status";
    container.append(label);
  }
  const outcome = history.at(-1)!;
  const status = outcome.status === "pending"
    ? t(store, "mutationPending")
    : outcome.status === "success"
      ? t(store, "mutationDone")
      : t(store, "mutationFailed");
  label.textContent = [status, outcome.operation, outcome.paths.join(" → ")].join(" · ");
}
