import { element, errorText, getBridge } from "./dom";
import { clearImages, renderImages, renderWorkspaceLabel, visionEnabled } from "./files";
import { interpolate, translate } from "./i18n";
import { renderMemory } from "./memory";
import { t, type RendererStore } from "./state";
import { setStatus } from "./status";
import { refreshStorage, renderStorage } from "./storage";
import type { AppState, Language, SettingsSearchItem, SettingsTab } from "./types";

export function parseBoundedInteger(input: HTMLInputElement, min: number, max: number): number | undefined {
  const raw = input.value.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export function setFieldError(inputId: string, errorId: string, message?: string): void {
  const input = element<HTMLInputElement>(inputId);
  const error = element<HTMLParagraphElement>(errorId);
  const invalid = Boolean(message);
  input.setAttribute("aria-invalid", String(invalid));
  error.textContent = message ?? "";
  error.hidden = !invalid;
}

export function validateNumericField(store: RendererStore, field: "budget" | "timeout"): number | undefined {
  if (field === "budget") {
    const input = element<HTMLInputElement>("setting-budget");
    const value = parseBoundedInteger(input, 1_000, 16_000);
    setFieldError("setting-budget", "setting-budget-error", value === undefined ? t(store, "budgetError") : undefined);
    return value;
  }
  const input = element<HTMLInputElement>("setting-timeout");
  const value = parseBoundedInteger(input, 30, 180);
  setFieldError("setting-timeout", "setting-timeout-error", value === undefined ? t(store, "timeoutError") : undefined);
  return value;
}

export function updateAboutVersionLabel(store: RendererStore, copied = false): void {
  const button = element<HTMLButtonElement>("about-version");
  button.textContent = copied ? `Ya ${store.state.version} · ${t(store, "copiedVersion")}` : `Ya ${store.state.version}`;
}

export function renderShortcutsPlatform(store: RendererStore): void {
  const mod = store.state.platform === "darwin" ? "⌘" : "Ctrl";
  document.querySelectorAll<HTMLElement>("[data-shortcut-mod]").forEach((node) => {
    node.textContent = mod;
  });
  element<HTMLSpanElement>("settings-search-shortcut").textContent = store.state.platform === "darwin" ? "⌘F" : "Ctrl+F";
  const osName = store.state.platform === "darwin" ? "macOS" : store.state.platform === "win32" ? "Windows" : store.state.platform;
  element<HTMLSpanElement>("about-platform").textContent = `Electron · ${osName}`;
}

export function trackSettingsHeader(store: RendererStore, panel: HTMLElement): void {
  store.settingsHeaderObserver?.disconnect();
  store.settingsHeaderObserver = undefined;
  const screen = document.querySelector<HTMLElement>(".settings-screen");
  const header = panel.querySelector<HTMLElement>(".settings-tab-header");
  if (!screen || !header) {
    screen?.style.setProperty("--settings-tab-header-height", "0px");
    return;
  }
  const update = () => screen.style.setProperty("--settings-tab-header-height", `${header.offsetHeight}px`);
  update();
  if (typeof ResizeObserver === "function") {
    store.settingsHeaderObserver = new ResizeObserver(update);
    store.settingsHeaderObserver.observe(header);
  }
}

export function clearSearchReveal(store: RendererStore): void {
  if (store.searchRevealTimer !== undefined) window.clearTimeout(store.searchRevealTimer);
  store.searchRevealTimer = undefined;
  if (store.activeSearchTarget) {
    store.activeSearchTarget.removeAttribute("data-search-target");
    store.activeSearchTarget = undefined;
  }
}

export function selectSettingsTab(
  store: RendererStore,
  tab: SettingsTab,
  options: { preserveSearch?: boolean; focusTab?: boolean } = {},
): void {
  store.activeSettingsTab = tab;
  if (!options.preserveSearch) clearSearchReveal(store);
  document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && options.focusTab) button.focus({ preventScroll: true });
  });
  let activePanel: HTMLElement | undefined;
  document.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
    const active = panel.dataset.settingsPanel === tab;
    panel.hidden = !active;
    if (active) activePanel = panel;
  });
  element<HTMLSelectElement>("settings-mobile-select").value = tab;
  const shell = document.querySelector<HTMLElement>(".settings-shell");
  if (shell) shell.scrollTop = 0;
  if (activePanel) {
    activePanel.scrollTop = 0;
    trackSettingsHeader(store, activePanel);
  }
  if (tab === "storage" && element("page-settings").classList.contains("active")) void refreshStorage(store);
}

export function clearSettingsSearch(store: RendererStore, focusInput = false): void {
  const input = element<HTMLInputElement>("settings-search");
  input.value = "";
  renderSettingsSearch(store);
  if (focusInput) input.focus({ preventScroll: true });
}

export function updateApiKeyToggleLabel(store: RendererStore): void {
  const input = element<HTMLInputElement>("setting-api-key");
  const toggle = element<HTMLButtonElement>("toggle-api-key-visibility");
  const shown = input.type === "text";
  toggle.setAttribute("aria-pressed", String(shown));
  const label = t(store, shown ? "hideApiKey" : "showApiKey");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  toggle.querySelector<SVGElement>(".icon-eye-open")?.toggleAttribute("hidden", shown);
  toggle.querySelector<SVGElement>(".icon-eye-closed")?.toggleAttribute("hidden", !shown);
}

export function resetApiKeyVisibility(store: RendererStore): void {
  const input = element<HTMLInputElement>("setting-api-key");
  input.type = "password";
  updateApiKeyToggleLabel(store);
}

export function renderAccount(store: RendererStore): void {
  const running = document.body.classList.contains("task-running");
  const badge = element<HTMLElement>("account-state");
  badge.textContent = store.accountPending === "login" ? t(store, "accountWaiting")
    : store.accountPending === "logout" ? t(store, "accountLoggingOut") : store.state.accountError ? t(store, "accountInvalid")
    : store.state.accountSignedIn ? t(store, "accountSignedIn") : t(store, "accountSignedOut");
  badge.dataset.tone = store.accountPending ? "busy"
    : store.state.accountError ? "error" : store.state.accountSignedIn ? "success" : "muted";
  element<HTMLButtonElement>("account-login").hidden = store.state.accountSignedIn || store.accountPending === "login";
  element<HTMLButtonElement>("account-login").disabled = running || Boolean(store.accountPending);
  element<HTMLButtonElement>("account-cancel").hidden = store.accountPending !== "login";
  element<HTMLButtonElement>("account-logout").hidden = (!store.state.accountSignedIn && !store.state.accountError) || store.accountPending === "login";
  element<HTMLButtonElement>("account-logout").disabled = running || Boolean(store.accountPending);
  element<HTMLButtonElement>("account-logout").textContent = t(store, store.state.accountError ? "accountClear" : "accountLogout");
}

export function syncWorkspaceControls(store: RendererStore): void {
  const running = document.body.classList.contains("task-running");
  element<HTMLButtonElement>("send-button").disabled = running || store.workspaceModelSaving || store.navigationPending;
  element<HTMLSelectElement>("task-model").disabled = running || store.workspaceModelSaving || store.navigationPending;
  element<HTMLSelectElement>("task-reasoning").disabled = running || store.workspaceModelSaving || store.navigationPending;
  const local = element<HTMLInputElement>("local-enabled");
  renderWorkspaceLabel(store);
  if (!store.state.validWorkspace) {
    local.checked = false;
    store.currentDirectory = ".";
    element<HTMLElement>("file-location").textContent = ".";
    element<HTMLElement>("file-list").textContent = store.state.workspace ? t(store, "folderMissing") : "";
  }
  local.disabled = running || store.navigationPending || !store.state.validWorkspace;
  element<HTMLSelectElement>("web-mode").disabled = running;
  element<HTMLInputElement>("toa-enabled").disabled = running;
  element<HTMLSelectElement>("toa-workers").disabled = running || !element<HTMLInputElement>("toa-enabled").checked;
  renderAccount(store);
}

export function fillWorkspaceModelSelection(store: RendererStore): void {
  element<HTMLSelectElement>("task-model").value = store.state.config.model;
  element<HTMLSelectElement>("task-reasoning").value = store.state.config.reasoningEffort;
  syncWorkspaceControls(store);
}

export function fillSettings(store: RendererStore): void {
  fillWorkspaceModelSelection(store);
  element<HTMLSelectElement>("setting-language").value = store.state.language;
  element<HTMLInputElement>("setting-thinking").checked = store.state.config.thinkingEnabled;
  element<HTMLInputElement>("setting-budget").value = String(store.state.config.toaTokenBudget);
  element<HTMLInputElement>("setting-timeout").value = String(store.state.config.toaTimeout);
  setFieldError("setting-budget", "setting-budget-error");
  setFieldError("setting-timeout", "setting-timeout-error");
  element<HTMLInputElement>("setting-stream").checked = store.state.stream;
  const hideKeychain = store.state.platform !== "darwin";
  element<HTMLElement>("setting-keychain-row").hidden = hideKeychain;
  element<HTMLInputElement>("setting-keychain").hidden = hideKeychain;
  element<HTMLElement>("setting-keychain-label").hidden = hideKeychain;
  element<HTMLButtonElement>("settings-save").disabled = !element<HTMLInputElement>("setting-api-key").value.trim();
  const apiState = element<HTMLSpanElement>("api-state");
  apiState.textContent = store.state.accountError ? t(store, "accountInvalid")
    : store.state.accountSignedIn ? t(store, "accountActive") : store.state.hasApiKey ? t(store, "apiReady") : t(store, "apiMissing");
  apiState.dataset.tone = store.state.accountError ? "error"
    : store.state.accountSignedIn || store.state.hasApiKey ? "success" : "muted";
  renderAccount(store);
  renderShortcutsPlatform(store);
  if (element("page-settings").classList.contains("active")) renderStorage(store);
  renderImages(store);
}

export async function signInDeepSeek(store: RendererStore): Promise<void> {
  store.accountPending = "login";
  renderAccount(store);
  try {
    store.state = await getBridge().loginDeepSeek();
    setStatus(store, t(store, "accountSignedIn"));
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  } finally {
    try { store.state = await getBridge().state(); }
    catch { /* Release the sign-in controls even if the state refresh fails. */ }
    store.accountPending = undefined;
    fillSettings(store);
  }
}

export async function signOutDeepSeek(store: RendererStore): Promise<void> {
  store.accountPending = "logout";
  renderAccount(store);
  try {
    const result = await getBridge().logoutDeepSeek();
    store.state = result.state;
    setStatus(store, t(store, result.revoked ? "accountSignedOut" : "accountRevokeFailed"));
  } catch (error) {
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  } finally {
    store.accountPending = undefined;
    fillSettings(store);
  }
}

export async function saveWorkspaceModelSelection(store: RendererStore): Promise<void> {
  const model = element<HTMLSelectElement>("task-model").value as AppState["config"]["model"];
  const reasoningEffort = element<HTMLSelectElement>("task-reasoning").value as AppState["config"]["reasoningEffort"];
  store.workspaceModelSaving = true;
  syncWorkspaceControls(store);
  renderImages(store);
  try {
    store.state = await getBridge().saveWorkspaceModelSelection({ model, reasoningEffort });
    fillWorkspaceModelSelection(store);
    if (!visionEnabled(store) && store.selectedImages.length > 0) await clearImages(store);
    renderImages(store);
    setStatus(store, t(store, "saved"));
  } catch (error) {
    fillWorkspaceModelSelection(store);
    renderImages(store);
    setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
  } finally {
    store.workspaceModelSaving = false;
    syncWorkspaceControls(store);
    renderImages(store);
  }
}

export async function saveSettings(
  store: RendererStore,
  applyLanguage: () => void,
  options: { includeApiKey?: boolean; validateField?: "budget" | "timeout" } = {},
): Promise<void> {
  if (options.validateField && validateNumericField(store, options.validateField) === undefined) return;
  const run = store.settingsSaveQueue.then(async () => {
    const budgetInput = element<HTMLInputElement>("setting-budget");
    const timeoutInput = element<HTMLInputElement>("setting-timeout");
    const validBudget = parseBoundedInteger(budgetInput, 1_000, 16_000);
    const validTimeout = parseBoundedInteger(timeoutInput, 30, 180);
    const preserveBudget = validBudget === undefined && budgetInput.getAttribute("aria-invalid") === "true";
    const preserveTimeout = validTimeout === undefined && timeoutInput.getAttribute("aria-invalid") === "true";
    const preserveBudgetValue = budgetInput.value;
    const preserveTimeoutValue = timeoutInput.value;
    const apiKeyInput = element<HTMLInputElement>("setting-api-key");
    const apiKey = options.includeApiKey ? apiKeyInput.value : "";
    try {
      store.state = await getBridge().saveSettings({
        language: element<HTMLSelectElement>("setting-language").value as Language,
        thinkingEnabled: element<HTMLInputElement>("setting-thinking").checked,
        toaTokenBudget: validBudget ?? store.state.config.toaTokenBudget,
        toaTimeout: validTimeout ?? store.state.config.toaTimeout,
        stream: element<HTMLInputElement>("setting-stream").checked,
        ...(apiKey.trim()
          ? {
              apiKey,
              keyStorage: store.state.platform === "darwin" && element<HTMLInputElement>("setting-keychain").checked
                ? "keychain"
                : "session",
            }
          : {}),
      });
      if (options.includeApiKey && apiKey.trim()) {
        apiKeyInput.value = "";
        resetApiKeyVisibility(store);
      }
      if (!visionEnabled(store) && store.selectedImages.length > 0) await clearImages(store);
      applyLanguage();
      fillSettings(store);
      if (preserveBudget) {
        budgetInput.value = preserveBudgetValue;
        validateNumericField(store, "budget");
      }
      if (preserveTimeout) {
        timeoutInput.value = preserveTimeoutValue;
        validateNumericField(store, "timeout");
      }
      renderMemory(store);
      setStatus(store, t(store, "saved"));
    } catch (error) {
      fillSettings(store);
      setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
    }
  });
  store.settingsSaveQueue = run.catch(() => undefined);
  return run;
}

export function settingsSearchCatalog(language: Language = "en", platform: string = "linux"): SettingsSearchItem[] {
  const label = (key: Parameters<typeof translate>[1]) => translate(language, key);
  const items: SettingsSearchItem[] = [
    {
      id: "page.general",
      kind: "page",
      tab: "general",
      title: label("settingsTabGeneral"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "general interface reasoning toa preferences 常规 界面 推理",
    },
    {
      id: "page.providers",
      kind: "page",
      tab: "providers",
      title: label("settingsTabProviders"),
      pageLabel: label("settingsTabProviders"),
      keywords: "account api key deepseek login auth credentials 账号 密钥 开放平台 登录",
    },
    {
      id: "page.storage",
      kind: "page",
      tab: "storage",
      title: label("settingsTabStorage"),
      pageLabel: label("settingsTabStorage"),
      keywords: "storage history cleanup delete conversations tasks audit 存储 管理 清理 历史",
    },
    {
      id: "page.shortcuts",
      kind: "page",
      tab: "shortcuts",
      title: label("settingsTabShortcuts"),
      pageLabel: label("settingsTabShortcuts"),
      keywords: "shortcuts keybinds keyboard hotkeys 快捷键 键盘",
    },
    {
      id: "page.about",
      kind: "page",
      tab: "about",
      title: label("settingsTabAbout"),
      pageLabel: label("settingsTabAbout"),
      keywords: "about version license electron platform github 关于 版本 协议",
    },
    {
      id: "setting.language",
      kind: "setting",
      tab: "general",
      target: "language",
      title: label("language"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "language locale english chinese zh-cn menu 语言 英文 中文 菜单",
    },
    {
      id: "setting.stream",
      kind: "setting",
      tab: "general",
      target: "stream",
      title: label("stream"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "stream streaming answers simple chat replies 流式 输出 简单回答",
    },
    {
      id: "setting.thinking",
      kind: "setting",
      tab: "general",
      target: "thinking",
      title: label("thinking"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "thinking reasoning extended deepseek 思考 推理",
    },
    {
      id: "setting.budget",
      kind: "setting",
      tab: "general",
      target: "budget",
      title: label("budget"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "toa token budget limit workers 预算 限制 工作",
    },
    {
      id: "setting.timeout",
      kind: "setting",
      tab: "general",
      target: "timeout",
      title: label("timeout"),
      pageLabel: label("settingsTabGeneral"),
      keywords: "toa timeout seconds duration abort 超时 秒",
    },
    {
      id: "setting.account",
      kind: "setting",
      tab: "providers",
      target: "account",
      title: label("deepseekAccount"),
      pageLabel: label("settingsTabProviders"),
      keywords: "deepseek platform account oauth login sign in out 开放平台 账号 登录 退出",
    },
    {
      id: "setting.api-key",
      kind: "setting",
      tab: "providers",
      target: "api-key",
      title: label("apiKey"),
      pageLabel: label("settingsTabProviders"),
      keywords: "api key secret token deepseek_api_key password 密钥",
    },
    {
      id: "setting.storage-kind",
      kind: "setting",
      tab: "storage",
      target: "storage-kind",
      title: label("storageCategory"),
      pageLabel: label("settingsTabStorage"),
      keywords: "storage category chats conversations tasks audit logs 记录 类型 对话 任务 审计",
    },
    {
      id: "setting.storage-period",
      kind: "setting",
      tab: "storage",
      target: "storage-period",
      title: label("dateRange"),
      pageLabel: label("settingsTabStorage"),
      keywords: "date range 30 90 days custom undated all delete cleanup 日期 范围 自定义 删除 清理",
    },
    {
      id: "setting.shortcuts",
      kind: "setting",
      tab: "shortcuts",
      target: "shortcut-open-settings",
      title: label("shortcutOpenSettings"),
      pageLabel: label("settingsTabShortcuts"),
      keywords: "shortcut open settings cmd ctrl comma 快捷键 打开 设置",
    },
    {
      id: "setting.version",
      kind: "setting",
      tab: "about",
      title: label("about"),
      pageLabel: label("settingsTabAbout"),
      keywords: "version copy license github docs issues 版本 复制 开源协议 文档",
    },
  ];
  if (platform === "darwin") {
    items.splice(12, 0, {
      id: "setting.keychain",
      kind: "setting",
      tab: "providers",
      target: "keychain",
      title: label("keychain"),
      pageLabel: label("settingsTabProviders"),
      keywords: "macos keychain key storage persist restart 钥匙串 保存",
    });
  }
  return items;
}

export function rankSettingsSearch(query: string, items: SettingsSearchItem[]): SettingsSearchItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const scored: Array<{ item: SettingsSearchItem; score: number }> = [];
  for (const item of items) {
    const title = item.title.toLowerCase();
    const haystack = `${title} ${item.pageLabel.toLowerCase()} ${item.keywords.toLowerCase()}`;
    if (!tokens.every((token) => haystack.includes(token))) continue;
    let score = 0;
    if (title === normalized) score += 100;
    else if (title.startsWith(normalized)) score += 60;
    else if (title.includes(normalized)) score += 40;
    else if (tokens.every((token) => title.includes(token))) score += 25;
    if (item.kind === "page" && title.includes(normalized)) score += 10;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

function appendHighlightedText(parent: HTMLElement, text: string, query: string): void {
  const needle = query.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!needle) {
    parent.append(document.createTextNode(text));
    return;
  }
  const lower = text.toLowerCase();
  let position = 0;
  while (position < text.length) {
    const index = lower.indexOf(needle, position);
    if (index === -1) {
      parent.append(document.createTextNode(text.slice(position)));
      break;
    }
    if (index > position) parent.append(document.createTextNode(text.slice(position, index)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(index, index + needle.length);
    parent.append(mark);
    position = index + needle.length;
  }
}

function settingsIconClone(tab: SettingsTab): SVGSVGElement | undefined {
  const button = document.querySelector<HTMLButtonElement>(`[data-settings-tab="${tab}"]`);
  const svg = button?.querySelector("svg");
  if (!svg) return undefined;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.classList.add("settings-search-result-icon");
  return clone;
}

export function setHighlightedSearchResult(store: RendererStore, index: number): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("#settings-search-results .settings-search-result"));
  if (buttons.length === 0) {
    store.highlightedSearchIndex = -1;
    return;
  }
  store.highlightedSearchIndex = ((index % buttons.length) + buttons.length) % buttons.length;
  buttons.forEach((button, idx) => {
    const active = idx === store.highlightedSearchIndex;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    if (active) button.scrollIntoView({ block: "nearest" });
  });
}

export function revealSettingTarget(store: RendererStore, tab: SettingsTab, target?: string): void {
  const narrow = (document.querySelector<HTMLElement>(".settings-screen")?.clientWidth ?? 1000) < 800;
  selectSettingsTab(store, tab, { preserveSearch: !narrow });
  if (narrow) clearSettingsSearch(store, false);
  const panel = document.querySelector<HTMLElement>(`[data-settings-panel="${tab}"]`);
  if (!panel) return;
  const control = target
    ? panel.querySelector<HTMLElement>(`[data-setting-id="${CSS.escape(target)}"]`)
    : panel.querySelector<HTMLElement>(".settings-tab-header-row, .settings-about-intro");
  if (!control) return;
  clearSearchReveal(store);
  control.scrollIntoView({ block: "center", inline: "nearest" });
  control.setAttribute("data-search-target", target ? "row" : "header");
  store.activeSearchTarget = control;
  const finish = () => {
    if (store.activeSearchTarget === control) clearSearchReveal(store);
  };
  control.addEventListener("animationend", (event) => {
    if (event.target === control && event.animationName === "settings-search-reveal") finish();
  }, { once: true });
  store.searchRevealTimer = window.setTimeout(finish, 1900);
}

export function renderSettingsSearch(store: RendererStore): void {
  const input = element<HTMLInputElement>("settings-search");
  const container = input.closest<HTMLElement>(".settings-search");
  const resultsEl = element<HTMLDivElement>("settings-search-results");
  const clearBtn = element<HTMLButtonElement>("settings-search-clear");
  const rawQuery = input.value;
  const hasQuery = rawQuery.trim().length > 0;
  if (container) container.dataset.hasQuery = String(hasQuery);
  clearBtn.hidden = !hasQuery;
  resultsEl.replaceChildren();
  store.renderedSearchItems = [];
  store.highlightedSearchIndex = -1;
  if (!hasQuery) {
    resultsEl.hidden = true;
    return;
  }
  resultsEl.hidden = false;
  const matches = rankSettingsSearch(rawQuery, settingsSearchCatalog(store.state?.language ?? "en", store.state?.platform));
  if (matches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-search-empty";
    empty.textContent = interpolate(t(store, "searchEmpty"), { query: rawQuery.trim() });
    resultsEl.append(empty);
    return;
  }
  const pages = matches.filter((item) => item.kind === "page");
  const settings = matches.filter((item) => item.kind === "setting");
  const groups: Array<{ label: string; items: SettingsSearchItem[] }> = [];
  if (pages.length > 0) groups.push({ label: t(store, "searchGroupPages"), items: pages });
  if (settings.length > 0) groups.push({ label: t(store, "searchGroupSettings"), items: settings });
  for (const group of groups) {
    const heading = document.createElement("div");
    heading.className = "settings-search-group-label";
    heading.textContent = group.label;
    resultsEl.append(heading);
    for (const item of group.items) {
      const index = store.renderedSearchItems.length;
      store.renderedSearchItems.push({ tab: item.tab, target: item.target });
      const button = document.createElement("button");
      button.type = "button";
      button.className = "settings-search-result";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", "false");
      button.dataset.searchResultTab = item.tab;
      if (item.target) button.dataset.searchResultTarget = item.target;
      const icon = settingsIconClone(item.tab);
      if (icon) button.append(icon);
      const title = document.createElement("span");
      title.className = "settings-search-result-title";
      appendHighlightedText(title, item.title, rawQuery);
      button.append(title);
      if (item.kind === "setting") {
        const page = document.createElement("span");
        page.className = "settings-search-result-page";
        page.textContent = item.pageLabel;
        button.append(page);
      }
      button.addEventListener("click", () => {
        setHighlightedSearchResult(store, index);
        revealSettingTarget(store, item.tab, item.target);
      });
      resultsEl.append(button);
    }
  }
  setHighlightedSearchResult(store, 0);
}
