import { renderMarkdown, StreamingAnswerPreview } from "./answer-view";
import { clearPendingAction, decideLocalAction, renderActivities, renderPendingAction, renderPendingMutation } from "./approvals";
import { botChanges, fileChangeCard, renderChanges } from "./diff-view";
import { element, errorText, getBridge, localDay } from "./dom";
import { checkSelectedFolder, chooseImages, clearImages, renderFiles, renderImages, renderWorkspaceLabel, updateFolderAccess, visionEnabled } from "./files";
import { interpolate } from "./i18n";
import { createMemory, pruneMemory, refreshActivityMemory, refreshMemory, renderMemory } from "./memory";
import { createBot, loadSessionHistory, persistSessions, scheduleSessionSave } from "./sessions";
import {
  clearSearchReveal,
  clearSettingsSearch,
  fillSettings,
  parseBoundedInteger,
  renderSettingsSearch,
  renderShortcutsPlatform,
  resetApiKeyVisibility,
  revealSettingTarget,
  saveSettings,
  saveWorkspaceModelSelection,
  selectSettingsTab,
  setFieldError,
  setHighlightedSearchResult,
  signInDeepSeek,
  signOutDeepSeek,
  syncWorkspaceControls,
  updateAboutVersionLabel,
  updateApiKeyToggleLabel,
  validateNumericField,
} from "./settings";
import { t, type RendererStore } from "./state";
import { hideSettingsFeedback, setStatus } from "./status";
import { deleteSelectedHistory, refreshStorage, renderStorage, storageSelection } from "./storage";
import {
  SETTINGS_TABS,
  type AppPage,
  type CommittedOutcome,
  type ConversationMessage,
  type DesktopBot,
  type DrawerPage,
  type ImageDetail,
  type RendererTaskOptions,
  type SelectedImage,
  type SettingsTab,
  type ShellCommandEvent,
  type WebMode,
} from "./types";

export interface WorkspaceActions {
  applyLanguage: () => void;
  botChanges: () => ReturnType<typeof botChanges>;
  chooseImages: () => Promise<void>;
  clearPendingAction: (expired?: boolean) => void;
  closeSettings: () => void;
  decideLocalAction: (approved: boolean) => void;
  deleteSelectedHistory: () => Promise<void>;
  fillSettings: () => void;
  persistSessions: (sessions?: DesktopBot[]) => boolean;
  refreshStorage: () => Promise<void>;
  renderBot: () => void;
  renderCommand: (event: ShellCommandEvent) => void;
  renderFiles: () => Promise<void>;
  renderNavigation: () => void;
  renderPendingAction: () => void;
  renderStorage: () => void;
  runTask: () => Promise<void>;
  saveWorkspaceModelSelection: () => Promise<void>;
  selectBot: (bot: DesktopBot) => Promise<void>;
  selectSettingsTab: (tab: SettingsTab, options?: { preserveSearch?: boolean; focusTab?: boolean }) => void;
  setDrawer: (page: DrawerPage | undefined) => void;
  setRunning: (running: boolean) => void;
  setStatus: (text: string, tone?: "normal" | "busy" | "error") => void;
  showBotEditor: (bot?: DesktopBot) => Promise<void>;
  storageSelection: () => ReturnType<typeof storageSelection>;
  switchPage: (page: AppPage) => void;
  syncWorkspaceControls: () => void;
  updateFolderAccess: (revoke: boolean) => Promise<void>;
  applyCommittedOutcome: (outcome: CommittedOutcome) => void;
}

function scrollTimelineToEnd(): void {
  const timeline = element<HTMLDivElement>("timeline");
  timeline.scrollTop = timeline.scrollHeight;
}

function resizeTaskInput(): void {
  const input = element<HTMLTextAreaElement>("task-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

export function createWorkspaceActions(store: RendererStore): WorkspaceActions {
  const syncControls = (): void => syncWorkspaceControls(store);

  const setTimelineEmpty = (empty: boolean): void => {
    const home = element<HTMLDivElement>("timeline-empty");
    home.querySelector(".home-sprout")?.remove();
    home.hidden = !empty;
  };

  const renderPageTitle = (): void => {
    const page = document.querySelector<HTMLButtonElement>(".tab.active")?.dataset.page;
    element<HTMLTextAreaElement>("task-input").placeholder = interpolate(t(store, "taskPlaceholder"), { name: store.currentBot?.title ?? "Ya" });
    element<HTMLElement>("welcome-hint").textContent = store.currentBot?.instructions || t(store, "welcomeHint");
    element<HTMLHeadingElement>("page-title").textContent = page === "settings" ? t(store, "settings")
      : page === "memory" ? t(store, "memory") : store.currentBot?.title ?? "Ya";
  };

  const renderNavigation = (): void => {
    const list = element<HTMLDivElement>("bot-list");
    list.replaceChildren();
    const disabled = store.navigationPending || document.body.classList.contains("task-running");
    for (const bot of [...store.bots].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bot-button";
      button.classList.toggle("active", bot.id === store.currentBot?.id);
      if (bot.id === store.currentBot?.id) button.setAttribute("aria-current", "true");
      button.dataset.botId = bot.id;
      button.disabled = disabled;
      button.title = bot.title;
      const title = document.createElement("span");
      title.textContent = bot.title;
      button.append(title);
      if (bot.turns.length > 0) {
        const count = document.createElement("span");
        count.className = "bot-count";
        count.textContent = String(bot.turns.length);
        button.append(count);
      }
      button.addEventListener("click", () => void selectBot(bot));
      list.append(button);
    }
    element<HTMLButtonElement>("edit-bot").disabled = disabled;
    element<HTMLButtonElement>("new-bot").disabled = disabled;
    element<HTMLButtonElement>("choose-workspace").disabled = disabled;
    element<HTMLButtonElement>("revoke-folder").disabled = disabled;
  };

  const setNavigationPending = (pending: boolean): void => {
    store.navigationPending = pending;
    renderNavigation();
    syncControls();
    renderImages(store);
  };

  const appendTask = (task: string, images: SelectedImage[]): HTMLElement => {
    const timeline = element<HTMLDivElement>("timeline");
    setTimelineEmpty(false);
    const turn = document.createElement("article");
    turn.className = "turn";
    const prompt = document.createElement("div");
    prompt.className = "prompt-bubble";
    const promptText = document.createElement("div");
    promptText.textContent = task;
    prompt.append(promptText);
    if (images.length > 0) {
      const imageList = document.createElement("div");
      imageList.className = "prompt-images";
      for (const image of images) {
        const label = document.createElement("span");
        label.className = "prompt-image";
        label.textContent = `▧ ${image.name}`;
        imageList.append(label);
      }
      prompt.append(imageList);
    }
    const answer = document.createElement("div");
    answer.className = "answer-card prose busy-answer";
    answer.setAttribute("aria-live", "polite");
    answer.textContent = t(store, "working");
    turn.append(prompt, answer);
    timeline.append(turn);
    scrollTimelineToEnd();
    return answer;
  };

  const renderCommand = (event: ShellCommandEvent): void => {
    if (store.activeTurn) {
      if (event.type === "start") store.activeTurn.commands.push({ id: event.id, command: event.command, cwd: event.cwd, stdout: "", stderr: "" });
      else {
        const command = store.activeTurn.commands.find((item) => item.id === event.id);
        if (command && event.type === "output") command[event.stream] = `${command[event.stream]}${event.text}`.slice(-65_536);
        if (command && event.type === "finish") {
          command.result = event.result;
          command.stdout = "";
          command.stderr = "";
        }
      }
      scheduleSessionSave(store);
    }
    if (event.type === "start") {
      if (!store.activeAnswer) return;
      const details = document.createElement("details");
      details.className = "command-run";
      details.open = true;
      const summary = document.createElement("summary");
      summary.textContent = `${event.command} · ${event.cwd} · ${t(store, "working")}`;
      const stdout = document.createElement("pre");
      const stderr = document.createElement("pre");
      stderr.className = "command-stderr";
      details.append(summary, stdout, stderr);
      store.activeAnswer.parentElement?.append(details);
      store.commandLogs.set(event.id, { summary, stdout, stderr, command: event.command, cwd: event.cwd });
      if (store.activeTurn) setStatus(store, t(store, "working"), "busy");
    } else {
      const log = store.commandLogs.get(event.id);
      if (!log) return;
      if (event.type === "output") {
        const output = log[event.stream];
        output.textContent = `${output.textContent ?? ""}${event.text}`.slice(-65_536);
      } else {
        const result = event.result;
        log.summary.textContent = `${log.command} · ${log.cwd} · ${t(store, result.status)} (exit ${result.exitCode ?? "—"}, ${(result.durationMs / 1_000).toFixed(1)}s)`;
        log.summary.classList.toggle("error-copy", result.status !== "success");
        const note = result.stdoutTruncated || result.stderrTruncated ? `${t(store, "truncated")}\n` : "";
        log.stdout.textContent = `${note}${result.stdout}`;
        log.stderr.textContent = [result.stderr, result.error].filter(Boolean).join("\n");
      }
    }
    scrollTimelineToEnd();
  };

  const renderBot = (): void => {
    const timeline = element<HTMLDivElement>("timeline");
    timeline.querySelectorAll(".turn").forEach((turn) => turn.remove());
    store.commandLogs.clear();
    store.lastAnswer = "";
    for (const turn of store.currentBot.turns) {
      const answer = appendTask(turn.task, turn.images);
      if (turn.turnId) answer.parentElement!.dataset.turnId = turn.turnId;
      renderPendingMutation(store, turn, answer.parentElement!);
      answer.classList.remove("busy-answer");
      if (turn.status === "error") {
        answer.textContent = turn.answer;
        answer.classList.add("error-copy");
      } else {
        renderMarkdown(answer, turn.answer);
        if (turn.status === "complete") store.lastAnswer = turn.answer;
      }
      if (turn.partial || turn.status === "interrupted") {
        const warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = t(store, turn.status === "interrupted" ? "interrupted" : "partial");
        answer.append(warning);
      }
      store.activeAnswer = answer;
      for (const command of turn.commands) {
        renderCommand({ type: "start", id: command.id, command: command.command, cwd: command.cwd });
        if (command.result) renderCommand({ type: "finish", id: command.id, result: command.result });
        else {
          renderCommand({ type: "output", id: command.id, stream: "stdout", text: command.stdout });
          renderCommand({ type: "output", id: command.id, stream: "stderr", text: command.stderr });
        }
      }
      for (const change of turn.changes ?? []) answer.parentElement?.append(fileChangeCard(store, change, true));
      store.activeAnswer = undefined;
    }
    setTimelineEmpty(store.currentBot.turns.length === 0);
    element<HTMLTextAreaElement>("task-input").value = store.currentBot.draft;
    resizeTaskInput();
    element<HTMLButtonElement>("learn-button").disabled = !store.lastAnswer;
    element<HTMLInputElement>("local-enabled").checked = Boolean(store.state.validWorkspace);
    store.activities = store.currentBot.activities;
    store.pendingAction = undefined;
    renderActivities(store);
    renderChanges(store);
    renderPendingAction(store);
    renderWorkspaceLabel(store);
    renderPageTitle();
    syncControls();
    store.relevantMemoryRequest++;
    const relevant = element<HTMLDivElement>("relevant-list");
    relevant.className = "compact-list empty";
    relevant.textContent = t(store, "noRelevant");
  };

  const setDrawer = (page: DrawerPage | undefined): void => {
    const openingActivity = page === "activity" && store.drawerPage !== page;
    store.drawerPage = page;
    element<HTMLElement>("details-drawer").hidden = page === undefined;
    document.querySelector(".workbench")?.classList.toggle("drawer-open", page !== undefined);
    document.querySelector(".workbench")?.classList.toggle("changes-open", page === "changes");
    element<HTMLElement>("drawer-files").hidden = page !== "files";
    element<HTMLElement>("drawer-changes").hidden = page !== "changes";
    element<HTMLElement>("drawer-activity").hidden = page !== "activity";
    for (const name of ["files", "changes", "activity"] as const) {
      element<HTMLButtonElement>(`drawer-${name}-tab`).classList.toggle("active", page === name);
      const button = element<HTMLButtonElement>(`toggle-${name}`);
      button.classList.toggle("active", page === name);
      button.setAttribute("aria-expanded", String(page === name));
    }
    if (openingActivity) void refreshActivityMemory(store);
    if (page === "files") void renderFiles(store, syncControls);
  };

  const switchPage = (page: AppPage): void => {
    const currentlySettings = element("page-settings").classList.contains("active");
    if (page === "settings" && !currentlySettings) {
      store.lastNonSettingsPage = element("page-memory").classList.contains("active") ? "memory" : "workspace";
    }
    const returningToWorkspace = page === "workspace" && !element("page-workspace").classList.contains("active");
    document.body.classList.toggle("settings-open", page === "settings");
    document.querySelectorAll<HTMLElement>(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((node) => {
      const active = node.dataset.page === page;
      node.classList.toggle("active", active);
      if (active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
    });
    element<HTMLDivElement>("workspace-actions").hidden = page !== "workspace";
    renderPageTitle();
    if (page === "memory") void refreshMemory(store);
    if (page === "settings") {
      hideSettingsFeedback(store);
      selectSettingsTab(store, store.activeSettingsTab);
      fillSettings(store);
    } else {
      store.settingsHeaderObserver?.disconnect();
      store.settingsHeaderObserver = undefined;
      clearSearchReveal(store);
      clearSettingsSearch(store, false);
      resetApiKeyVisibility(store);
      hideSettingsFeedback(store);
      ++store.storageRequest;
      store.storageItems = undefined;
    }
    if (returningToWorkspace) void refreshActivityMemory(store);
  };

  const closeSettings = (): void => {
    switchPage(store.lastNonSettingsPage);
    element<HTMLButtonElement>("settings-tab").focus({ preventScroll: true });
  };

  const selectBot = async (bot: DesktopBot): Promise<void> => {
    if (store.navigationPending || document.body.classList.contains("task-running")) return;
    store.currentBot.draft = element<HTMLTextAreaElement>("task-input").value;
    persistSessions(store);
    setNavigationPending(true);
    try {
      await clearImages(store);
      Object.assign(store.state, await getBridge().selectBot(bot.id));
      store.currentBot = bot;
      store.currentDirectory = ".";
      setDrawer(undefined);
      switchPage("workspace");
      renderBot();
      void checkSelectedFolder(store, syncControls);
      setStatus(store, t(store, "ready"));
      persistSessions(store);
      element<HTMLTextAreaElement>("task-input").focus();
    } catch (error) {
      setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
    } finally {
      setNavigationPending(false);
    }
  };

  const showBotEditor = async (bot?: DesktopBot): Promise<void> => {
    const dialog = element<HTMLDialogElement>("bot-editor");
    if (dialog.open || store.navigationPending || document.body.classList.contains("task-running")) return;
    const name = element<HTMLInputElement>("bot-name");
    const instructions = element<HTMLTextAreaElement>("bot-instructions");
    element<HTMLElement>("bot-editor-title").textContent = t(store, bot ? "editBot" : "newBot");
    element<HTMLButtonElement>("save-bot").textContent = t(store, bot ? "saveBot" : "createBot");
    name.value = bot?.title ?? "";
    instructions.value = bot?.instructions ?? "";
    name.setCustomValidity("");
    dialog.returnValue = "";
    const closed = new Promise<void>((resolve) => dialog.addEventListener("close", () => resolve(), { once: true }));
    dialog.showModal();
    name.focus();
    await closed;
    if (dialog.returnValue !== "save") return;
    const profile = { title: name.value.trim(), instructions: instructions.value.trim() };
    if (bot) {
      Object.assign(bot, profile);
      renderPageTitle();
      renderNavigation();
      persistSessions(store);
    } else {
      await selectBot(createBot(store, profile));
    }
  };

  const setRunning = (running: boolean): void => {
    element<HTMLTextAreaElement>("task-input").disabled = running;
    document.body.classList.toggle("task-running", running);
    element<HTMLButtonElement>("stop-button").hidden = !running;
    element<HTMLButtonElement>("stop-button").disabled = false;
    syncControls();
    renderImages(store);
    renderNavigation();
    if (element("page-settings").classList.contains("active")) void refreshStorage(store);
  };

  const runTask = async (): Promise<void> => {
    if (document.body.classList.contains("task-running") || store.workspaceModelSaving || store.navigationPending) return;
    const input = element<HTMLTextAreaElement>("task-input");
    const taskImages = [...store.selectedImages];
    const task = input.value.trim() || (taskImages.length > 0 ? t(store, "defaultVisionTask") : "");
    if (!task) {
      input.focus();
      return;
    }
    const local = element<HTMLInputElement>("local-enabled").checked;
    const folderGrantVersion = local ? store.displayedGrantVersion : undefined;
    const toa = element<HTMLInputElement>("toa-enabled").checked;
    if (local && toa) {
      setStatus(store, `${t(store, "taskError")}: Local workspace mode cannot be used with Tree of Agents.`, "error");
      return;
    }
    if (taskImages.length > 0 && !visionEnabled(store)) {
      setStatus(store, `${t(store, "taskError")}: ${t(store, "visionOnly")}`, "error");
      return;
    }
    if (toa) {
      const config = store.state.config;
      const thinking = config.thinkingEnabled ? t(store, "on") : t(store, "off");
      const imageLine = taskImages.length > 0 ? `\n${t(store, "images")}: ${taskImages.length} (${t(store, "imagesToa")})` : "";
      const message = `${t(store, "confirmToa")}\n\n${config.model}\n${t(store, "thinking")}: ${thinking} (${config.reasoningEffort})\n${t(store, "workers")}: ${element<HTMLSelectElement>("toa-workers").value}\n${t(store, "budget")}: ${config.toaTokenBudget}\n${t(store, "timeout")}: ${config.toaTimeout}s${imageLine}`;
      if (!window.confirm(message)) return;
    }

    const history = store.currentBot.turns.flatMap((turn): ConversationMessage[] => {
      const messages: ConversationMessage[] = [{ role: "user", content: turn.task }];
      if (turn.status === "complete" && turn.answer) messages.push({ role: "assistant", content: turn.answer });
      return messages;
    });
    // Commit the draft and its attachments only after the main process accepts the task.
    const turnId = crypto.randomUUID();
    const beginTurn = () => {
      if (store.activeTurn && store.activeAnswer) return { turn: store.activeTurn, answer: store.activeAnswer };
      input.value = "";
      resizeTaskInput();
      store.currentBot.draft = "";
      store.currentBot.updatedAt = Date.now();
      store.activeTurn = { turnId, createdAt: store.currentBot.updatedAt, task, images: taskImages, answer: "", status: "running", commands: [], changes: [] };
      store.currentBot.turns.push(store.activeTurn);
      store.activeAnswer = appendTask(task, taskImages);
      store.activeAnswer.parentElement!.dataset.turnId = turnId;
      store.lastAnswer = "";
      store.actionExpired = false;
      store.activities = [];
      store.currentBot.activities = store.activities;
      store.commandLogs.clear();
      store.pendingAction = undefined;
      renderPendingAction(store);
      renderActivities(store);
      renderPageTitle();
      persistSessions(store);
      element<HTMLDetailsElement>("task-options").open = false;
      void refreshActivityMemory(store);
      setStatus(store, t(store, "working"), "busy");
      return { turn: store.activeTurn, answer: store.activeAnswer };
    };
    store.onTaskStarted = beginTurn;
    setRunning(true);
    try {
      const options: RendererTaskOptions = {
        sessionId: store.currentBot.id,
        turnId,
        task,
        botProfile: { name: store.currentBot.title, instructions: store.currentBot.instructions },
        history,
        webMode: element<HTMLSelectElement>("web-mode").value as WebMode,
        toa,
        toaWorkers: element<HTMLSelectElement>("toa-workers").value === "1" ? 1 : 2,
        stream: store.state.stream,
        local,
        imageIds: taskImages.map((image) => image.id),
        imageDetail: element<HTMLSelectElement>("image-detail").value as ImageDetail,
        folderGrantVersion,
      };
      let result = await getBridge().runTask(options);
      if ("folderAccessChanged" in result) {
        // A replacement grant has its own root, even when Files is closed.
        ++store.fileRequest;
        store.currentDirectory = ".";
        store.directoryGrantVersion = result.folderAccessChanged.folderGrantVersion;
        element<HTMLDivElement>("file-location").textContent = ".";
        element<HTMLDivElement>("file-list").replaceChildren();
        Object.assign(store.state, result.folderAccessChanged);
        syncControls();
        if (store.drawerPage === "files" && store.state.validWorkspace) void renderFiles(store, syncControls);
        if (store.state.validWorkspace) {
          setStatus(store, interpolate(t(store, "folderChanged"), { folder: store.state.validWorkspace }));
          return;
        }
        if (!window.confirm(t(store, "chatWithoutFolder"))) {
          setStatus(store, t(store, "folderMissing"));
          return;
        }
        result = await getBridge().runTask({ ...options, local: false, folderGrantVersion: undefined });
        if ("folderAccessChanged" in result) throw new Error("Unexpected folder check for an ordinary chat.");
      }
      const { turn, answer } = beginTurn();
      if (result.taskId) turn.taskId = result.taskId;
      turn.answer = result.content;
      turn.status = "complete";
      turn.partial = result.partial;
      store.lastAnswer = result.content;
      answer.classList.remove("busy-answer");
      renderMarkdown(answer, result.content);
      if (result.partial) {
        const warning = document.createElement("p");
        warning.className = "warning";
        warning.textContent = t(store, "partial");
        answer.append(warning);
      }
      if (store.activePreview) {
        store.activePreview.cancel();
        scrollTimelineToEnd();
      }
      element<HTMLButtonElement>("learn-button").disabled = false;
      setStatus(store, t(store, "done"));
    } catch (error) {
      if (!store.activeTurn || !store.activeAnswer) {
        setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
        return;
      }
      const turn = store.activeTurn;
      const answer = store.activeAnswer;
      store.activePreview?.cancel();
      answer.classList.remove("busy-answer");
      answer.classList.add("error-copy");
      answer.textContent = `${t(store, "taskError")}: ${errorText(error)}`;
      turn.answer = answer.textContent;
      turn.status = "error";
      setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error");
      if (store.state.accountSignedIn) {
        try { store.state = await getBridge().state(); fillSettings(store); }
        catch { /* Keep the task error visible if refreshing account state also fails. */ }
      }
      if (local && store.drawerPage === "files") void renderFiles(store, syncControls);
    } finally {
      store.activePreview = undefined;
      clearPendingAction(store);
      store.onTaskStarted = undefined;
      if (store.activeTurn) {
        store.selectedImages = [];
        void getBridge().clearImages().catch(() => undefined);
      }
      store.activeAnswer = undefined;
      store.activeTurn = undefined;
      setRunning(false);
      persistSessions(store);
    }
  };

  const applyLanguage = (): void => {
    document.documentElement.lang = store.state.language;
    document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
      const key = node.dataset.i18n as Parameters<typeof t>[1] | undefined;
      if (key) node.textContent = t(store, key);
    });
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((node) => {
      const key = node.dataset.i18nPlaceholder as Parameters<typeof t>[1] | undefined;
      if (key) node.placeholder = t(store, key);
    });
    document.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((node) => {
      const label = t(store, node.dataset.i18nLabel as Parameters<typeof t>[1]);
      node.setAttribute("aria-label", label);
      node.title = label;
    });
    document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((node) => {
      const label = node.querySelector(".nav-label")?.textContent ?? "";
      node.setAttribute("aria-label", label);
      node.title = label;
    });
    element<HTMLSelectElement>("web-mode").options[0]!.text = t(store, "auto");
    element<HTMLSelectElement>("web-mode").options[1]!.text = t(store, "on");
    element<HTMLSelectElement>("web-mode").options[2]!.text = t(store, "off");
    if (store.aboutCopyTimer !== undefined) window.clearTimeout(store.aboutCopyTimer);
    store.aboutCopyTimer = undefined;
    updateAboutVersionLabel(store, false);
    updateApiKeyToggleLabel(store);
    renderShortcutsPlatform(store);
    renderSettingsSearch(store);
    if (element<HTMLInputElement>("setting-budget").getAttribute("aria-invalid") === "true") validateNumericField(store, "budget");
    if (element<HTMLInputElement>("setting-timeout").getAttribute("aria-invalid") === "true") validateNumericField(store, "timeout");
    if (element("page-settings").classList.contains("active")) renderStorage(store);
    renderWorkspaceLabel(store);
    renderActivities(store);
    renderChanges(store);
    // Existing cards are snapshots too; switching language must keep their expanded state.
    const changes = new Map(botChanges(store).map((change) => [change.id, change]));
    document.querySelectorAll<HTMLDetailsElement>(".turn .file-change").forEach((card) => {
      const change = changes.get(card.dataset.changeId ?? "");
      if (change) card.replaceWith(fileChangeCard(store, change, card.open));
    });
    renderPendingAction(store);
    renderImages(store);
    renderNavigation();
    renderPageTitle();
    if (!store.activeAnswer) setStatus(store, t(store, "ready"));
  };

  const applyCommittedOutcome = (outcome: CommittedOutcome): void => {
    const bot = store.bots.find((item) => item.id === outcome.botId);
    const turn = bot?.turns.find((item) => item.turnId === outcome.turnId);
    if (!bot || !turn) return;
    const container = bot === store.currentBot ? Array.from(document.querySelectorAll<HTMLElement>(".turn"))
      .find((item) => item.dataset.turnId === turn.turnId) : undefined;
    const event = outcome.event;
    if (event.type === "file-change") {
      if (!turn.changes.some((change) => change.id === event.change.id)) {
        turn.changes.push(event.change);
        if (container) {
          container.append(fileChangeCard(store, event.change, true));
          renderChanges(store);
          void renderFiles(store, syncControls);
        }
      }
    } else {
      const history = turn.committedActivities ??= [];
      if (!history.some((activity) => activity.id === outcome.id)) {
        const activity = { ...event.activity, id: outcome.id };
        history.push(activity);
        if (container) renderPendingMutation(store, turn, container);
        if (turn === bot.turns.at(-1)) {
          bot.activities.push(activity);
          if (bot === store.currentBot) renderActivities(store);
        }
      }
    }
    if (persistSessions(store)) void getBridge().acknowledgeOutcome(outcome.id).catch(() => undefined);
  };

  return {
    applyLanguage,
    botChanges: () => botChanges(store),
    chooseImages: () => chooseImages(store),
    clearPendingAction: (expired) => clearPendingAction(store, expired),
    closeSettings,
    decideLocalAction: (approved) => decideLocalAction(store, approved),
    deleteSelectedHistory: () => deleteSelectedHistory(store, { renderBot, renderNavigation }),
    fillSettings: () => fillSettings(store),
    persistSessions: (sessions) => persistSessions(store, sessions),
    refreshStorage: () => refreshStorage(store),
    renderBot,
    renderCommand,
    renderFiles: () => renderFiles(store, syncControls),
    renderNavigation,
    renderPendingAction: () => renderPendingAction(store),
    renderStorage: () => renderStorage(store),
    runTask,
    saveWorkspaceModelSelection: () => saveWorkspaceModelSelection(store),
    selectBot,
    selectSettingsTab: (tab, options) => selectSettingsTab(store, tab, options),
    setDrawer,
    setRunning,
    setStatus: (text, tone) => setStatus(store, text, tone),
    showBotEditor,
    storageSelection: () => storageSelection(store),
    switchPage,
    syncWorkspaceControls: syncControls,
    updateFolderAccess: (revoke) => updateFolderAccess(store, revoke, setNavigationPending, syncControls),
    applyCommittedOutcome,
  };
}

function registerHomeSprout(): void {
  const timeline = element<HTMLDivElement>("timeline");
  const home = element<HTMLDivElement>("timeline-empty");
  const template = element<HTMLTemplateElement>("sprout-artwork");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let codeFill = false;

  timeline.addEventListener("click", (event) => {
    if (event.button !== 0 || (event.target !== home && event.target !== timeline)) return;
    if (home.hidden || reducedMotion.matches || home.querySelector(".home-sprout")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && timeline.contains(selection.anchorNode)) return;

    const sprout = template.content.querySelector("svg")!.cloneNode(true) as SVGSVGElement;
    sprout.classList.toggle("code-fill", codeFill);
    codeFill = !codeFill;
    const finish = (animationEvent: AnimationEvent) => {
      if (animationEvent.target === sprout) sprout.remove();
    };
    sprout.addEventListener("animationend", finish);
    sprout.addEventListener("animationcancel", finish);
    home.append(sprout);
  });
}

export function registerEvents(store: RendererStore, actions: WorkspaceActions): void {
  const bridge = getBridge();
  const stopTask = async (): Promise<void> => {
    const button = element<HTMLButtonElement>("stop-button");
    button.disabled = true;
    setStatus(store, t(store, "stopping"), "busy");
    try { await bridge.cancelTask(); }
    catch (error) { button.disabled = false; setStatus(store, errorText(error), "error"); }
  };
  const learnFromAnswer = (): void => {
    if (!store.lastAnswer) return;
    actions.switchPage("memory");
    const input = element<HTMLTextAreaElement>("candidate-text");
    input.focus();
  };

  registerHomeSprout();
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => actions.switchPage(button.dataset.page as AppPage));
  });
  element<HTMLButtonElement>("choose-workspace").addEventListener("click", () => void actions.updateFolderAccess(false));
  element<HTMLButtonElement>("revoke-folder").addEventListener("click", () => void actions.updateFolderAccess(true));
  element<HTMLButtonElement>("edit-bot").addEventListener("click", () => void actions.showBotEditor(store.currentBot));
  element<HTMLButtonElement>("cancel-bot").addEventListener("click", () => element<HTMLDialogElement>("bot-editor").close());
  const name = element<HTMLInputElement>("bot-name");
  name.addEventListener("input", () => name.setCustomValidity(""));
  element<HTMLFormElement>("bot-form").addEventListener("submit", (event) => {
    if (!name.value.trim()) {
      event.preventDefault();
      name.setCustomValidity(t(store, "botNameRequired"));
      name.reportValidity();
    }
  });
  element<HTMLButtonElement>("new-bot").addEventListener("click", () => void actions.showBotEditor());
  element<HTMLButtonElement>("sidebar-toggle").addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    element<HTMLButtonElement>("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    persistSessions(store);
  });
  for (const page of ["files", "changes", "activity"] as const) {
    element<HTMLButtonElement>(`toggle-${page}`).addEventListener("click", () => actions.setDrawer(store.drawerPage === page ? undefined : page));
    element<HTMLButtonElement>(`drawer-${page}-tab`).addEventListener("click", () => actions.setDrawer(page));
  }
  element<HTMLButtonElement>("close-drawer").addEventListener("click", () => {
    const previous = store.drawerPage;
    actions.setDrawer(undefined);
    if (previous) element<HTMLButtonElement>(`toggle-${previous}`).focus();
  });
  element<HTMLButtonElement>("refresh-files").addEventListener("click", () => void actions.renderFiles());
  element<HTMLButtonElement>("choose-images").addEventListener("click", () => void actions.chooseImages());
  element<HTMLButtonElement>("clear-images").addEventListener("click", () => void clearImages(store));
  element<HTMLSelectElement>("task-model").addEventListener("change", () => void actions.saveWorkspaceModelSelection());
  element<HTMLSelectElement>("task-reasoning").addEventListener("change", () => void actions.saveWorkspaceModelSelection());
  element<HTMLButtonElement>("send-button").addEventListener("click", () => void actions.runTask());
  element<HTMLButtonElement>("stop-button").addEventListener("click", () => void stopTask());
  element<HTMLInputElement>("local-enabled").addEventListener("change", actions.syncWorkspaceControls);
  element<HTMLTextAreaElement>("task-input").addEventListener("keydown", (event) => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void actions.runTask();
    }
  });
  element<HTMLTextAreaElement>("task-input").addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    store.currentBot.draft = input.value;
    resizeTaskInput();
    scheduleSessionSave(store);
  });
  document.addEventListener("keydown", (event) => {
    if (element<HTMLDialogElement>("bot-editor").open || event.isComposing) return;
    const settingsActive = element("page-settings").classList.contains("active");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void actions.showBotEditor();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      element<HTMLButtonElement>("sidebar-toggle").click();
    } else if ((event.ctrlKey || event.metaKey) && event.key === ",") {
      event.preventDefault();
      if (settingsActive) actions.closeSettings();
      else actions.switchPage("settings");
    } else if (settingsActive && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      const search = element<HTMLInputElement>("settings-search");
      search.focus({ preventScroll: true });
      search.select();
    } else if (event.key === "Escape") {
      element<HTMLDetailsElement>("task-options").open = false;
      if (store.pendingAction) {
        event.preventDefault();
        actions.switchPage("workspace");
        actions.setDrawer("activity");
        element<HTMLElement>(store.pendingAction.responding ? "action-summary" : "action-deny").focus({ preventScroll: true });
        return;
      }
      if (settingsActive) {
        event.preventDefault();
        const search = element<HTMLInputElement>("settings-search");
        if (search.value.trim()) {
          clearSettingsSearch(store, true);
        } else if (document.activeElement === search) {
          search.blur();
          document.querySelector<HTMLElement>(".settings-screen")?.focus({ preventScroll: true });
        } else {
          actions.closeSettings();
        }
        return;
      }
      const previous = store.drawerPage;
      actions.setDrawer(undefined);
      if (previous) element<HTMLButtonElement>(`toggle-${previous}`).focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !element<HTMLDetailsElement>("task-options").contains(event.target)) {
      element<HTMLDetailsElement>("task-options").open = false;
    }
  });
  window.addEventListener("beforeunload", () => {
    store.currentBot.draft = element<HTMLTextAreaElement>("task-input").value;
    persistSessions(store);
  });
  element<HTMLInputElement>("toa-enabled").addEventListener("change", (event) => {
    element<HTMLSelectElement>("toa-workers").disabled = !(event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLButtonElement>("action-approve").addEventListener("click", () => actions.decideLocalAction(true));
  element<HTMLButtonElement>("action-deny").addEventListener("click", () => actions.decideLocalAction(false));
  element<HTMLButtonElement>("memory-create").addEventListener("click", () => void createMemory(store));
  element<HTMLButtonElement>("memory-prune").addEventListener("click", () => void pruneMemory(store));
  element<HTMLButtonElement>("memory-retry").addEventListener("click", () => void refreshMemory(store));
  element<HTMLButtonElement>("settings-back").addEventListener("click", actions.closeSettings);
  element<HTMLButtonElement>("settings-back-mobile").addEventListener("click", actions.closeSettings);
  element<HTMLSelectElement>("settings-mobile-select").addEventListener("change", (event) => {
    actions.selectSettingsTab((event.currentTarget as HTMLSelectElement).value as SettingsTab);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    button.addEventListener("click", () => actions.selectSettingsTab(button.dataset.settingsTab as SettingsTab));
  });
  document.querySelector(".settings-nav-groups")?.addEventListener("keydown", (event) => {
    const keyEvent = event as KeyboardEvent;
    const currentIndex = SETTINGS_TABS.indexOf(store.activeSettingsTab);
    if (currentIndex === -1) return;
    let nextIndex: number | undefined;
    if (keyEvent.key === "ArrowDown") nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
    else if (keyEvent.key === "ArrowUp") nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (keyEvent.key === "Home") nextIndex = 0;
    else if (keyEvent.key === "End") nextIndex = SETTINGS_TABS.length - 1;
    if (nextIndex === undefined) return;
    keyEvent.preventDefault();
    actions.selectSettingsTab(SETTINGS_TABS[nextIndex]!, { focusTab: true });
  });
  const searchInput = element<HTMLInputElement>("settings-search");
  searchInput.addEventListener("input", () => renderSettingsSearch(store));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedSearchResult(store, store.highlightedSearchIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedSearchResult(store, store.highlightedSearchIndex - 1);
    } else if (event.key === "Enter" && store.renderedSearchItems.length > 0) {
      event.preventDefault();
      const target = store.renderedSearchItems[Math.max(0, store.highlightedSearchIndex)];
      if (target) revealSettingTarget(store, target.tab, target.target);
    }
  });
  element<HTMLButtonElement>("settings-search-clear").addEventListener("click", () => clearSettingsSearch(store, true));
  element<HTMLSelectElement>("setting-language").addEventListener("change", () => void saveSettings(store, actions.applyLanguage));
  element<HTMLInputElement>("setting-stream").addEventListener("change", () => void saveSettings(store, actions.applyLanguage));
  element<HTMLInputElement>("setting-thinking").addEventListener("change", () => void saveSettings(store, actions.applyLanguage));
  const budgetInput = element<HTMLInputElement>("setting-budget");
  budgetInput.addEventListener("input", () => {
    if (budgetInput.getAttribute("aria-invalid") === "true" && parseBoundedInteger(budgetInput, 1_000, 16_000) !== undefined) {
      setFieldError("setting-budget", "setting-budget-error");
    }
  });
  budgetInput.addEventListener("change", () => void saveSettings(store, actions.applyLanguage, { validateField: "budget" }));
  const timeoutInput = element<HTMLInputElement>("setting-timeout");
  timeoutInput.addEventListener("input", () => {
    if (timeoutInput.getAttribute("aria-invalid") === "true" && parseBoundedInteger(timeoutInput, 30, 180) !== undefined) {
      setFieldError("setting-timeout", "setting-timeout-error");
    }
  });
  timeoutInput.addEventListener("change", () => void saveSettings(store, actions.applyLanguage, { validateField: "timeout" }));
  const apiKeyInput = element<HTMLInputElement>("setting-api-key");
  apiKeyInput.addEventListener("input", () => {
    element<HTMLButtonElement>("settings-save").disabled = !apiKeyInput.value.trim();
  });
  apiKeyInput.addEventListener("keydown", (event) => {
    if (!event.isComposing && event.key === "Enter" && apiKeyInput.value.trim()) {
      event.preventDefault();
      void saveSettings(store, actions.applyLanguage, { includeApiKey: true });
    }
  });
  element<HTMLButtonElement>("toggle-api-key-visibility").addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
    updateApiKeyToggleLabel(store);
    apiKeyInput.focus({ preventScroll: true });
  });
  element<HTMLButtonElement>("settings-save").addEventListener("click", () => void saveSettings(store, actions.applyLanguage, { includeApiKey: true }));
  element<HTMLButtonElement>("about-version").addEventListener("click", () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(`Ya ${store.state.version}`);
        if (store.aboutCopyTimer !== undefined) window.clearTimeout(store.aboutCopyTimer);
        updateAboutVersionLabel(store, true);
        store.aboutCopyTimer = window.setTimeout(() => {
          updateAboutVersionLabel(store, false);
          store.aboutCopyTimer = undefined;
        }, 1800);
      } catch {
        setStatus(store, t(store, "copyFailed"), "error");
      }
    })();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-external-url]").forEach((button) => {
    button.addEventListener("click", () => {
      const url = button.dataset.externalUrl;
      if (url) void bridge.openExternal(url);
    });
  });
  element<HTMLButtonElement>("account-login").addEventListener("click", () => void signInDeepSeek(store));
  element<HTMLButtonElement>("account-cancel").addEventListener("click", () => {
    void bridge.cancelDeepSeekLogin().catch((error: unknown) => setStatus(store, `${t(store, "taskError")}: ${errorText(error)}`, "error"));
  });
  element<HTMLButtonElement>("account-logout").addEventListener("click", () => void signOutDeepSeek(store));
  const today = localDay(new Date());
  element("storage-kind").addEventListener("change", () => void actions.refreshStorage());
  element("storage-period").addEventListener("change", actions.renderStorage);
  for (const id of ["storage-from", "storage-to"]) {
    const input = element<HTMLInputElement>(id);
    input.value = today;
    input.addEventListener("input", actions.renderStorage);
  }
  element("storage-delete").addEventListener("click", () => void actions.deleteSelectedHistory());
  element<HTMLButtonElement>("learn-button").addEventListener("click", learnFromAnswer);

  bridge.onTaskEvent((event) => {
    if (event.type === "committed") {
      actions.applyCommittedOutcome(event.outcome);
    } else if (event.type === "started") {
      store.onTaskStarted?.();
    } else if (event.type === "content" && store.activeTurn && store.activeAnswer) {
      store.activeTurn.answer += event.content;
      store.activePreview ??= new StreamingAnswerPreview(store.activeAnswer, scrollTimelineToEnd);
      store.activePreview.append(event.content);
      scheduleSessionSave(store);
    } else if (event.type === "activity") {
      store.activities.push(event.activity);
      renderActivities(store);
      scheduleSessionSave(store);
    } else if (event.type === "command") {
      actions.renderCommand(event.event);
    } else if (event.type === "file-change" && store.activeTurn && store.activeAnswer) {
      store.activeTurn.changes.push(event.change);
      store.activeAnswer.parentElement?.append(fileChangeCard(store, event.change, true));
      renderChanges(store);
      persistSessions(store);
      void actions.renderFiles();
    } else if (event.type === "local-action") {
      if (!store.pendingAction) store.approvalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      store.actionExpired = false;
      store.pendingAction = { id: event.id, action: event.action };
      renderPendingAction(store);
      actions.switchPage("workspace");
      actions.setDrawer("activity");
      setStatus(store, t(store, "waiting"), "busy");
      element<HTMLButtonElement>("action-deny").focus({ preventScroll: true });
    } else if (event.type === "local-action-expired" && store.pendingAction?.id === event.id) {
      clearPendingAction(store, true);
      setStatus(store, t(store, "approvalExpired"), "error");
    } else if (event.type === "local-action-resolved" && store.pendingAction?.id === event.id) {
      clearPendingAction(store, false);
      if (document.body.classList.contains("task-running")) setStatus(store, t(store, "working"), "busy");
    }
  });
}

export async function initializeRenderer(store: RendererStore, actions: WorkspaceActions): Promise<void> {
  const bridge = getBridge();
  document.body.inert = true;
  store.state = await bridge.state();
  const activeId = await loadSessionHistory(store);
  store.currentBot = store.bots.find((bot) => bot.id === activeId) ?? store.bots[0] ?? createBot(store);
  Object.assign(store.state, await bridge.selectBot(store.currentBot.id));
  registerEvents(store, actions);
  for (const outcome of await bridge.pendingOutcomes()) actions.applyCommittedOutcome(outcome);
  actions.applyLanguage();
  fillSettings(store);
  renderMemory(store);
  actions.renderBot();
  persistSessions(store);
  void checkSelectedFolder(store, actions.syncWorkspaceControls);
  document.body.dataset.ready = "true";
  document.body.inert = false;
}
