type Language = "en" | "zh-CN";
type MemoryStatus = "candidate" | "approved" | "rejected" | "revoked";
type MemoryKind = "preference" | "procedure" | "knowledge";
type ImageDetail = "low" | "high" | "original" | "auto";

interface SelectedImage {
  id: string;
  name: string;
  size: number;
  mimeType: string;
}

interface MemoryCard {
  id: string;
  kind: MemoryKind;
  text: string;
  evidence: string;
  status: MemoryStatus;
  createdAt: string;
  version: number;
}

interface AppState {
  version: string;
  platform: string;
  language: Language;
  workspace?: string;
  validWorkspace?: string;
  stream: boolean;
  hasApiKey: boolean;
  config: {
    model: "deepseek-v4-flash" | "deepseek-v4-pro" | "deepseek-v4-flash-vision-exp";
    thinkingEnabled: boolean;
    reasoningEffort: "high" | "max";
    toaTokenBudget: number;
    toaTimeout: number;
  };
  cards: MemoryCard[];
  auditLogCount: number;
  auditLogBytes: number;
}

interface LocalAction {
  operation: "mkdir" | "write" | "move";
  paths: string[];
  summary: string;
  diff?: string;
}

interface LocalActivity {
  operation: string;
  paths: string[];
  status: string;
}

type TaskEvent =
  | { type: "content"; content: string }
  | { type: "activity"; activity: LocalActivity }
  | { type: "local-action"; id: string; action: LocalAction };

interface RunResult {
  content: string;
  mode: "single" | "toa";
  usage: Record<string, unknown>;
  partial?: boolean;
}

interface YaRendererBridge {
  state(): Promise<AppState>;
  chooseWorkspace(): Promise<string | undefined>;
  chooseImages(): Promise<SelectedImage[] | undefined>;
  clearImages(): Promise<void>;
  workspaceEntries(path?: string): Promise<Array<{ path: string; type: string }>>;
  saveWorkspaceModelSelection(selection: {
    model: AppState["config"]["model"];
    reasoningEffort: AppState["config"]["reasoningEffort"];
  }): Promise<AppState>;
  saveSettings(settings: Record<string, unknown>): Promise<AppState>;
  runTask(options: Record<string, unknown>): Promise<RunResult>;
  relevantCards(task: string): Promise<Array<{ card: MemoryCard; score: number }>>;
  createMemory(text: string, evidence: string, kind: MemoryKind): Promise<MemoryCard>;
  setMemoryStatus(cardId: string, status: Exclude<MemoryStatus, "candidate">): Promise<MemoryCard>;
  prunePreview(includeCandidates: boolean): Promise<MemoryCard[]>;
  pruneMemory(includeCandidates: boolean): Promise<MemoryCard[]>;
  clearAudit(): Promise<number>;
  respondLocalAction(id: string, approved: boolean): void;
  openExternal(url: string): Promise<void>;
  onTaskEvent(listener: (event: TaskEvent) => void): () => void;
}

const bridge = (window as typeof window & { ya: YaRendererBridge }).ya;

const TEXT = {
  en: {
    workspace: "Workspace", memory: "Memory", settings: "Settings", files: "Files", choose: "Choose…", refresh: "Refresh",
    local: "Enable local tools", task: "Task", taskPlaceholder: "Ask Ya a question or describe a workspace task…", send: "Send",
    model: "Model", thinking: "Thinking", web: "Web", toa: "Tree of Agents", workers: "Workers", auto: "Auto", on: "On", off: "Off",
    ready: "Ready", working: "Ya is working…", waiting: "Waiting for file-change confirmation…", done: "Done", relevant: "Relevant memory",
    noRelevant: "No approved memory meets the relevance threshold.", activity: "Activity", noActivity: "No local activity for this task.",
    pendingAction: "Pending file action", noAction: "No file change is waiting for approval.", approve: "Approve", deny: "Deny",
    noTasks: "Ask a question to begin.", answer: "Ya", learn: "Learn from this answer", noWorkspace: "Choose a workspace folder",
    status: "Status", kind: "Kind", text: "Text", evidence: "Evidence", actions: "Actions", candidateText: "What should Ya learn?",
    createCandidate: "Create candidate", prune: "Prune", includeCandidates: "Include candidates", reject: "Reject", revoke: "Revoke",
    language: "Language", stream: "Stream simple answers", reasoning: "Reasoning effort", budget: "ToA token budget",
    timeout: "ToA timeout (seconds)", apiKey: "DeepSeek API key", apiPlaceholder: "Leave blank to keep the current key",
    keychain: "Save in macOS Keychain", saveSettings: "Save settings", clearAudit: "Clear audit history", apiReady: "API key available",
    apiMissing: "No API key configured", saved: "Saved.", about: "About Ya", partial: "Some ToA worker results were unavailable.",
    taskError: "Ya error", confirmToa: "Start Tree of Agents?", confirmPrune: "Permanently delete {count} memory card(s)?",
    confirmAudit: "Permanently delete {count} audit log file(s) ({bytes} bytes)?", auditEmpty: "No audit logs to delete.",
    explicitFeedback: "Explicit user feedback after Ya task", sourceHint: "For knowledge, include a source URL in the evidence.",
    attachImages: "Attach images…", clearImages: "Clear", imageDetail: "Image detail", images: "Images",
    visionOnly: "Select the vision model in the workspace to attach images.", noImages: "No images attached.",
    defaultVisionTask: "Describe and analyze the attached image(s).", imagesToa: "re-sent to every worker, the root synthesis, and follow-up requests",
  },
  "zh-CN": {
    workspace: "工作区", memory: "记忆", settings: "设置", files: "文件", choose: "选择…", refresh: "刷新",
    local: "启用本地工具", task: "任务", taskPlaceholder: "向 Ya 提问，或描述一个工作区任务…", send: "发送",
    model: "模型", thinking: "思考", web: "网页", toa: "Tree of Agents", workers: "工作 Agent", auto: "自动", on: "开启", off: "关闭",
    ready: "就绪", working: "Ya 正在处理…", waiting: "等待文件变更确认…", done: "完成", relevant: "相关记忆",
    noRelevant: "没有达到相关性阈值的已批准记忆。", activity: "活动", noActivity: "本次任务还没有本地活动。",
    pendingAction: "待确认文件操作", noAction: "当前没有等待确认的文件变更。", approve: "批准", deny: "拒绝",
    noTasks: "输入问题即可开始。", answer: "Ya", learn: "从此回答中学习", noWorkspace: "请选择工作区文件夹",
    status: "状态", kind: "类别", text: "内容", evidence: "依据", actions: "操作", candidateText: "Ya 应该学到什么？",
    createCandidate: "创建候选记忆", prune: "清理", includeCandidates: "包括候选项", reject: "拒绝", revoke: "撤销",
    language: "语言", stream: "简单回答使用流式输出", reasoning: "推理强度", budget: "ToA Token 预算",
    timeout: "ToA 超时（秒）", apiKey: "DeepSeek API 密钥", apiPlaceholder: "留空以保留当前密钥",
    keychain: "保存到 macOS 钥匙串", saveSettings: "保存设置", clearAudit: "清除操作审计", apiReady: "API 密钥可用",
    apiMissing: "尚未配置 API 密钥", saved: "已保存。", about: "关于 Ya", partial: "部分 ToA 工作 Agent 未返回结果。",
    taskError: "Ya 错误", confirmToa: "启动 Tree of Agents？", confirmPrune: "永久删除 {count} 条记忆？",
    confirmAudit: "永久删除 {count} 个操作审计日志（{bytes} 字节）？", auditEmpty: "没有可删除的操作审计日志。",
    explicitFeedback: "Ya 任务后的显式用户反馈", sourceHint: "知识类记忆请在依据中附上来源 URL。",
    attachImages: "添加图片…", clearImages: "清除", imageDetail: "图片细节", images: "图片",
    visionOnly: "请先在工作区选择视觉模型再添加图片。", noImages: "尚未添加图片",
    defaultVisionTask: "描述并分析所附图片。", imagesToa: "将重复发送给每个工作 Agent、根协调 Agent 和后续请求",
  },
} as const;

type TextKey = keyof typeof TEXT.en;
let state: AppState;
let currentDirectory = ".";
let activeAnswer: HTMLElement | undefined;
let activeAnswerText = "";
let pendingAction: { id: string; action: LocalAction } | undefined;
let activities: LocalActivity[] = [];
let lastAnswer = "";
let selectedImages: SelectedImage[] = [];
let workspaceModelSaving = false;
const VISION_MODEL = "deepseek-v4-flash-vision-exp";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing UI element: ${id}`);
  return value as T;
}

function t(key: TextKey): string {
  return TEXT[state?.language ?? "en"][key];
}

function interpolate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (_match, key: string) => String(values[key] ?? ""));
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message.replace(/^Error invoking remote method '[^']+': Error:\s*/u, "");
}

function setStatus(text: string, tone: "normal" | "busy" | "error" = "normal"): void {
  const status = element<HTMLDivElement>("app-status");
  status.textContent = text;
  status.dataset.tone = tone;
}

function applyLanguage(): void {
  document.documentElement.lang = state.language;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => {
    const key = node.dataset.i18n as TextKey | undefined;
    if (key) node.textContent = t(key);
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((node) => {
    const key = node.dataset.i18nPlaceholder as TextKey | undefined;
    if (key) node.placeholder = t(key);
  });
  element<HTMLSelectElement>("web-mode").options[0]!.text = t("auto");
  element<HTMLSelectElement>("web-mode").options[1]!.text = t("on");
  element<HTMLSelectElement>("web-mode").options[2]!.text = t("off");
  element<HTMLSpanElement>("about-version").textContent = `Ya ${state.version}`;
  renderWorkspaceLabel();
  renderActivities();
  renderPendingAction();
  renderImages();
  if (!activeAnswer) setStatus(t("ready"));
}

function switchPage(page: "workspace" | "memory" | "settings"): void {
  document.querySelectorAll<HTMLElement>(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((node) => {
    const active = node.dataset.page === page;
    node.classList.toggle("active", active);
    node.setAttribute("aria-selected", String(active));
  });
  if (page === "memory") renderMemory();
}

function renderWorkspaceLabel(): void {
  const path = state.validWorkspace ?? state.workspace;
  const label = element<HTMLDivElement>("workspace-path");
  label.textContent = path ?? t("noWorkspace");
  label.title = path ?? "";
  label.classList.toggle("missing", !state.validWorkspace);
}

async function chooseWorkspace(): Promise<void> {
  try {
    const selected = await bridge.chooseWorkspace();
    if (!selected) return;
    state = await bridge.state();
    currentDirectory = ".";
    renderWorkspaceLabel();
    await renderFiles();
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

function visionEnabled(): boolean {
  return element<HTMLSelectElement>("task-model").value === VISION_MODEL;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function renderImages(): void {
  const list = element<HTMLDivElement>("image-list");
  const running = document.body.classList.contains("task-running");
  element<HTMLButtonElement>("choose-images").disabled = running || workspaceModelSaving || !visionEnabled();
  element<HTMLButtonElement>("clear-images").disabled = running || workspaceModelSaving || selectedImages.length === 0;
  element<HTMLSelectElement>("image-detail").disabled = running || workspaceModelSaving || !visionEnabled() || selectedImages.length === 0;
  list.replaceChildren();
  if (!visionEnabled()) {
    list.textContent = t("visionOnly");
    list.className = "image-list muted";
    return;
  }
  if (selectedImages.length === 0) {
    list.textContent = t("noImages");
    list.className = "image-list muted";
    return;
  }
  list.className = "image-list";
  for (const image of selectedImages) {
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

async function chooseImages(): Promise<void> {
  try {
    const images = await bridge.chooseImages();
    if (!images) return;
    selectedImages = images;
    renderImages();
    setStatus(t("ready"));
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

async function clearImages(): Promise<void> {
  selectedImages = [];
  renderImages();
  await bridge.clearImages();
}

async function renderFiles(): Promise<void> {
  const list = element<HTMLDivElement>("file-list");
  const breadcrumb = element<HTMLDivElement>("file-location");
  list.replaceChildren();
  breadcrumb.textContent = currentDirectory;
  if (!state.validWorkspace) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("noWorkspace");
    list.append(empty);
    return;
  }
  try {
    const entries = await bridge.workspaceEntries(currentDirectory);
    if (currentDirectory !== ".") {
      const up = fileRow("..", "directory");
      up.addEventListener("click", () => {
        const pieces = currentDirectory.split(/[\\/]/u);
        pieces.pop();
        currentDirectory = pieces.join("/") || ".";
        void renderFiles();
      });
      list.append(up);
    }
    for (const entry of entries) {
      const row = fileRow(entry.path.split(/[\\/]/u).at(-1) ?? entry.path, entry.type);
      if (entry.type === "directory") row.addEventListener("click", () => {
        currentDirectory = entry.path;
        void renderFiles();
      });
      list.append(row);
    }
  } catch (error) {
    const empty = document.createElement("p");
    empty.className = "error-copy";
    empty.textContent = errorText(error);
    list.append(empty);
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

function appendTask(task: string, images: SelectedImage[]): HTMLElement {
  const timeline = element<HTMLDivElement>("timeline");
  element<HTMLDivElement>("timeline-empty").hidden = true;
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
  answer.textContent = t("working");
  turn.append(prompt, answer);
  timeline.append(turn);
  timeline.scrollTop = timeline.scrollHeight;
  return answer;
}

async function runTask(): Promise<void> {
  const input = element<HTMLTextAreaElement>("task-input");
  const taskImages = [...selectedImages];
  const task = input.value.trim() || (taskImages.length > 0 ? t("defaultVisionTask") : "");
  if (!task) {
    input.focus();
    return;
  }
  const local = element<HTMLInputElement>("local-enabled").checked;
  const toa = element<HTMLInputElement>("toa-enabled").checked;
  if (local && !state.validWorkspace) {
    setStatus(t("noWorkspace"), "error");
    return;
  }
  if (local && toa) {
    setStatus(`${t("taskError")}: Local workspace mode cannot be used with Tree of Agents.`, "error");
    return;
  }
  if (taskImages.length > 0 && !visionEnabled()) {
    setStatus(`${t("taskError")}: ${t("visionOnly")}`, "error");
    return;
  }
  if (toa) {
    const config = state.config;
    const thinking = config.thinkingEnabled ? t("on") : t("off");
    const imageLine = taskImages.length > 0 ? `\n${t("images")}: ${taskImages.length} (${t("imagesToa")})` : "";
    const message = `${t("confirmToa")}\n\n${config.model}\n${t("thinking")}: ${thinking} (${config.reasoningEffort})\n${t("workers")}: ${element<HTMLSelectElement>("toa-workers").value}\n${t("budget")}: ${config.toaTokenBudget}\n${t("timeout")}: ${config.toaTimeout}s${imageLine}`;
    if (!window.confirm(message)) return;
  }

  input.value = "";
  activeAnswer = appendTask(task, taskImages);
  activeAnswerText = "";
  lastAnswer = "";
  activities = [];
  renderActivities();
  await renderRelevant(task);
  setRunning(true);
  setStatus(t("working"), "busy");
  try {
    const result = await bridge.runTask({
      task,
      webMode: element<HTMLSelectElement>("web-mode").value,
      toa,
      toaWorkers: Number(element<HTMLSelectElement>("toa-workers").value),
      stream: state.stream,
      local,
      workspace: state.validWorkspace,
      imageIds: taskImages.map((image) => image.id),
      imageDetail: element<HTMLSelectElement>("image-detail").value as ImageDetail,
    });
    activeAnswerText = result.content;
    lastAnswer = result.content;
    activeAnswer.classList.remove("busy-answer");
    renderMarkdown(activeAnswer, result.content);
    if (result.partial) {
      const warning = document.createElement("p");
      warning.className = "warning";
      warning.textContent = t("partial");
      activeAnswer.append(warning);
    }
    element<HTMLButtonElement>("learn-button").disabled = false;
    setStatus(t("done"));
  } catch (error) {
    activeAnswer.classList.remove("busy-answer");
    activeAnswer.classList.add("error-copy");
    activeAnswer.textContent = `${t("taskError")}: ${errorText(error)}`;
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    activeAnswer = undefined;
    selectedImages = [];
    void bridge.clearImages().catch(() => undefined);
    setRunning(false);
  }
}

function setRunning(running: boolean): void {
  element<HTMLTextAreaElement>("task-input").disabled = running;
  document.body.classList.toggle("task-running", running);
  syncWorkspaceControls();
  renderImages();
}

async function renderRelevant(task: string): Promise<void> {
  const panel = element<HTMLDivElement>("relevant-list");
  panel.replaceChildren();
  try {
    const matches = await bridge.relevantCards(task);
    if (matches.length === 0) {
      panel.textContent = t("noRelevant");
      panel.className = "compact-list empty";
      return;
    }
    panel.className = "compact-list";
    for (const match of matches) {
      const item = document.createElement("div");
      item.className = "memory-chip";
      item.textContent = `${match.card.kind} · ${match.score}\n${match.card.text}`;
      panel.append(item);
    }
  } catch (error) {
    panel.textContent = errorText(error);
  }
}

function renderActivities(): void {
  const list = element<HTMLDivElement>("activity-list");
  list.replaceChildren();
  if (activities.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("noActivity");
    list.append(empty);
    return;
  }
  for (const activity of activities) {
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

function renderPendingAction(): void {
  const empty = element<HTMLParagraphElement>("action-empty");
  const content = element<HTMLDivElement>("action-content");
  if (!pendingAction) {
    empty.hidden = false;
    empty.textContent = t("noAction");
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  element<HTMLDivElement>("action-summary").textContent = pendingAction.action.summary;
  element<HTMLDivElement>("action-paths").textContent = pendingAction.action.paths.join("\n");
  element<HTMLPreElement>("action-diff").textContent = pendingAction.action.diff ?? "";
  element<HTMLPreElement>("action-diff").hidden = !pendingAction.action.diff;
}

function decideLocalAction(approved: boolean): void {
  if (!pendingAction) return;
  bridge.respondLocalAction(pendingAction.id, approved);
  pendingAction = undefined;
  renderPendingAction();
  setStatus(t("working"), "busy");
}

function renderMemory(): void {
  const body = element<HTMLTableSectionElement>("memory-body");
  body.replaceChildren();
  for (const card of state.cards) {
    const row = document.createElement("tr");
    row.append(cell(card.id), cell(card.status), cell(card.kind), cell(card.text, "wide"), cell(card.evidence, "wide"));
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (card.status === "candidate") {
      actions.append(actionButton(t("approve"), () => updateMemory(card.id, "approved")), actionButton(t("reject"), () => updateMemory(card.id, "rejected")));
    } else if (card.status === "approved") {
      actions.append(actionButton(t("revoke"), () => updateMemory(card.id, "revoked")));
    }
    row.append(actions);
    body.append(row);
  }
  element<HTMLDivElement>("memory-empty").hidden = state.cards.length > 0;
}

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

async function updateMemory(cardId: string, status: Exclude<MemoryStatus, "candidate">): Promise<void> {
  try {
    await bridge.setMemoryStatus(cardId, status);
    state = await bridge.state();
    renderMemory();
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

async function createMemory(): Promise<void> {
  const text = element<HTMLTextAreaElement>("candidate-text").value.trim();
  const evidenceInput = element<HTMLInputElement>("candidate-evidence");
  const evidence = evidenceInput.value.trim() || t("explicitFeedback");
  const kind = element<HTMLSelectElement>("candidate-kind").value as MemoryKind;
  if (!text) return;
  try {
    await bridge.createMemory(text, evidence, kind);
    element<HTMLTextAreaElement>("candidate-text").value = "";
    evidenceInput.value = "";
    state = await bridge.state();
    renderMemory();
    setStatus(t("saved"));
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

async function pruneMemory(): Promise<void> {
  const includeCandidates = element<HTMLInputElement>("include-candidates").checked;
  try {
    const preview = await bridge.prunePreview(includeCandidates);
    if (preview.length === 0) return;
    if (!window.confirm(interpolate(t("confirmPrune"), { count: preview.length }))) return;
    await bridge.pruneMemory(includeCandidates);
    state = await bridge.state();
    renderMemory();
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

function fillSettings(): void {
  fillWorkspaceModelSelection();
  element<HTMLSelectElement>("setting-language").value = state.language;
  element<HTMLInputElement>("setting-thinking").checked = state.config.thinkingEnabled;
  element<HTMLInputElement>("setting-budget").value = String(state.config.toaTokenBudget);
  element<HTMLInputElement>("setting-timeout").value = String(state.config.toaTimeout);
  element<HTMLInputElement>("setting-stream").checked = state.stream;
  element<HTMLInputElement>("setting-keychain").hidden = state.platform !== "darwin";
  element<HTMLElement>("setting-keychain-label").hidden = state.platform !== "darwin";
  element<HTMLSpanElement>("api-state").textContent = state.hasApiKey ? t("apiReady") : t("apiMissing");
  element<HTMLSpanElement>("audit-state").textContent = `${state.auditLogCount} · ${state.auditLogBytes} bytes`;
  renderImages();
}

function fillWorkspaceModelSelection(): void {
  element<HTMLSelectElement>("task-model").value = state.config.model;
  element<HTMLSelectElement>("task-reasoning").value = state.config.reasoningEffort;
  syncWorkspaceControls();
}

function syncWorkspaceControls(): void {
  const running = document.body.classList.contains("task-running");
  element<HTMLButtonElement>("send-button").disabled = running || workspaceModelSaving;
  element<HTMLSelectElement>("task-model").disabled = running || workspaceModelSaving;
  element<HTMLSelectElement>("task-reasoning").disabled = running || workspaceModelSaving;
}

async function saveWorkspaceModelSelection(): Promise<void> {
  const model = element<HTMLSelectElement>("task-model").value as AppState["config"]["model"];
  const reasoningEffort = element<HTMLSelectElement>("task-reasoning").value as AppState["config"]["reasoningEffort"];
  workspaceModelSaving = true;
  syncWorkspaceControls();
  renderImages();
  try {
    state = await bridge.saveWorkspaceModelSelection({ model, reasoningEffort });
    fillWorkspaceModelSelection();
    if (!visionEnabled() && selectedImages.length > 0) await clearImages();
    renderImages();
    setStatus(t("saved"));
  } catch (error) {
    fillWorkspaceModelSelection();
    renderImages();
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    workspaceModelSaving = false;
    syncWorkspaceControls();
    renderImages();
  }
}

async function saveSettings(): Promise<void> {
  const apiKey = element<HTMLInputElement>("setting-api-key").value;
  try {
    state = await bridge.saveSettings({
      language: element<HTMLSelectElement>("setting-language").value,
      thinkingEnabled: element<HTMLInputElement>("setting-thinking").checked,
      toaTokenBudget: Number(element<HTMLInputElement>("setting-budget").value),
      toaTimeout: Number(element<HTMLInputElement>("setting-timeout").value),
      stream: element<HTMLInputElement>("setting-stream").checked,
      ...(apiKey.trim() ? { apiKey, keyStorage: state.platform === "darwin" && element<HTMLInputElement>("setting-keychain").checked ? "keychain" : "session" } : {}),
    });
    element<HTMLInputElement>("setting-api-key").value = "";
    if (!visionEnabled() && selectedImages.length > 0) await clearImages();
    applyLanguage();
    fillSettings();
    renderMemory();
    setStatus(t("saved"));
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

async function clearAudit(): Promise<void> {
  if (state.auditLogCount === 0) {
    window.alert(t("auditEmpty"));
    return;
  }
  if (!window.confirm(interpolate(t("confirmAudit"), { count: state.auditLogCount, bytes: state.auditLogBytes }))) return;
  try {
    await bridge.clearAudit();
    state = await bridge.state();
    fillSettings();
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
}

function learnFromAnswer(): void {
  if (!lastAnswer) return;
  switchPage("memory");
  const input = element<HTMLTextAreaElement>("candidate-text");
  input.focus();
}

function renderMarkdown(container: HTMLElement, markdown: string): void {
  container.replaceChildren();
  const lines = markdown.replace(/[\x00-\x08\x0B-\x1F\x7F]/gu, "").split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        if (/^\s{0,3}#{1,6}\s+/u.test(lines[index] ?? "") && code.length > 0) break;
        code.push(lines[index] ?? "");
        index += 1;
      }
      if ((lines[index] ?? "").trimStart().startsWith("```")) index += 1;
      const pre = document.createElement("pre");
      const codeNode = document.createElement("code");
      codeNode.textContent = code.join("\n");
      pre.append(codeNode);
      container.append(pre);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 2);
      const node = document.createElement(`h${level}`);
      appendInline(node, heading[2] ?? "");
      container.append(node);
      index += 1;
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && tableSeparator(lines[index + 1] ?? "")) {
      const table = document.createElement("table");
      const headers = tableCells(line);
      const head = document.createElement("thead");
      const headerRow = document.createElement("tr");
      headers.forEach((header) => {
        const cell = document.createElement("th");
        appendInline(cell, header);
        headerRow.append(cell);
      });
      head.append(headerRow);
      table.append(head);
      const body = document.createElement("tbody");
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        const row = document.createElement("tr");
        tableCells(lines[index] ?? "").forEach((value) => {
          const cell = document.createElement("td");
          appendInline(cell, value);
          row.append(cell);
        });
        body.append(row);
        index += 1;
      }
      table.append(body);
      container.append(table);
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      container.append(document.createElement("hr"));
      index += 1;
      continue;
    }
    const list = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
    if (list) {
      const ul = document.createElement("ul");
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/u);
        if (!item) break;
        const li = document.createElement("li");
        appendInline(li, item[1] ?? "");
        ul.append(li);
        index += 1;
      }
      container.append(ul);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/u);
    const paragraph = document.createElement(quote ? "blockquote" : "p");
    appendInline(paragraph, quote?.[1] ?? line);
    container.append(paragraph);
    index += 1;
  }
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*]+\*(?!\*)|\[[^\]]+\]\([^\s)]+\))/gu;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > position) parent.append(document.createTextNode(text.slice(position, start)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/u);
      const anchor = document.createElement("a");
      anchor.href = "#";
      anchor.textContent = link?.[1] ?? token;
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        if (link?.[2]) void bridge.openExternal(link[2]);
      });
      parent.append(anchor);
    }
    position = start + token.length;
  }
  if (position < text.length) parent.append(document.createTextNode(text.slice(position)));
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function tableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

function registerEvents(): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => switchPage(button.dataset.page as "workspace" | "memory" | "settings"));
  });
  element<HTMLButtonElement>("choose-workspace").addEventListener("click", () => void chooseWorkspace());
  element<HTMLButtonElement>("refresh-files").addEventListener("click", () => void renderFiles());
  element<HTMLButtonElement>("choose-images").addEventListener("click", () => void chooseImages());
  element<HTMLButtonElement>("clear-images").addEventListener("click", () => void clearImages());
  element<HTMLSelectElement>("task-model").addEventListener("change", () => void saveWorkspaceModelSelection());
  element<HTMLSelectElement>("task-reasoning").addEventListener("change", () => void saveWorkspaceModelSelection());
  element<HTMLButtonElement>("send-button").addEventListener("click", () => void runTask());
  element<HTMLTextAreaElement>("task-input").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runTask();
    }
  });
  element<HTMLInputElement>("toa-enabled").addEventListener("change", (event) => {
    element<HTMLSelectElement>("toa-workers").disabled = !(event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLButtonElement>("action-approve").addEventListener("click", () => decideLocalAction(true));
  element<HTMLButtonElement>("action-deny").addEventListener("click", () => decideLocalAction(false));
  element<HTMLButtonElement>("memory-create").addEventListener("click", () => void createMemory());
  element<HTMLButtonElement>("memory-prune").addEventListener("click", () => void pruneMemory());
  element<HTMLButtonElement>("settings-save").addEventListener("click", () => void saveSettings());
  element<HTMLButtonElement>("audit-clear").addEventListener("click", () => void clearAudit());
  element<HTMLButtonElement>("learn-button").addEventListener("click", learnFromAnswer);

  bridge.onTaskEvent((event) => {
    if (event.type === "content" && activeAnswer) {
      activeAnswerText += event.content;
      activeAnswer.classList.remove("busy-answer");
      renderMarkdown(activeAnswer, activeAnswerText);
      element<HTMLDivElement>("timeline").scrollTop = element<HTMLDivElement>("timeline").scrollHeight;
    } else if (event.type === "activity") {
      activities.push(event.activity);
      renderActivities();
    } else if (event.type === "local-action") {
      pendingAction = { id: event.id, action: event.action };
      renderPendingAction();
      setStatus(t("waiting"), "busy");
    }
  });
}

async function initialize(): Promise<void> {
  state = await bridge.state();
  registerEvents();
  applyLanguage();
  fillSettings();
  renderMemory();
  await renderFiles();
  document.body.dataset.ready = "true";
}

void initialize().catch((error: unknown) => {
  document.body.dataset.startupError = "true";
  document.body.textContent = `Ya failed to start: ${errorText(error)}`;
});
