import { element } from "./dom";
import { t, type RendererStore } from "./state";

export type StatusTone = "normal" | "busy" | "error";

export function showSettingsFeedback(store: RendererStore, text: string, tone: StatusTone = "normal"): void {
  const feedback = element<HTMLDivElement>("settings-feedback");
  if (store.settingsFeedbackTimer !== undefined) window.clearTimeout(store.settingsFeedbackTimer);
  store.settingsFeedbackTimer = undefined;
  feedback.textContent = text;
  feedback.dataset.tone = tone;
  feedback.hidden = false;
  if (tone === "normal") {
    store.settingsFeedbackTimer = window.setTimeout(() => {
      feedback.hidden = true;
      store.settingsFeedbackTimer = undefined;
    }, 2400);
  }
}

export function hideSettingsFeedback(store: RendererStore): void {
  if (store.settingsFeedbackTimer !== undefined) window.clearTimeout(store.settingsFeedbackTimer);
  store.settingsFeedbackTimer = undefined;
  element<HTMLDivElement>("settings-feedback").hidden = true;
}

export function setStatus(store: RendererStore, text: string, tone: StatusTone = "normal"): void {
  const status = element<HTMLDivElement>("app-status");
  status.textContent = text;
  status.dataset.tone = tone;
  if (element("page-settings").classList.contains("active") && text !== t(store, "ready")) {
    showSettingsFeedback(store, text, tone);
  }
}
