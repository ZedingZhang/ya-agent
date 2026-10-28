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
  workspaces: string[];
  stream: boolean;
  hasApiKey: boolean;
  accountSignedIn: boolean;
  accountError: boolean;
  config: {
    model: "deepseek-flash" | "deepseek-v4-pro";
    thinkingEnabled: boolean;
    reasoningEffort: "low" | "high" | "max";
    toaTokenBudget: number;
    toaTimeout: number;
  };
  cards: MemoryCard[];
  auditLogCount: number;
  auditLogBytes: number;
}

interface LocalAction {
  operation: "mkdir" | "write" | "edit" | "move" | "run";
  paths: string[];
  summary: string;
  diff?: string;
}

interface LocalActivity {
  operation: string;
  paths: string[];
  status: string;
}

type FileChange = import("../file-diff").FileChange;
type ConversationMessage = import("../types").ConversationMessage;

type TaskEvent =
  | { type: "content"; content: string }
  | { type: "activity"; activity: LocalActivity }
  | { type: "command"; event: ShellCommandEvent }
  | { type: "file-change"; change: FileChange }
  | { type: "local-action"; id: string; action: LocalAction }
  | { type: "local-action-expired"; id: string }
  | { type: "local-action-resolved"; id: string };

type ShellCommandEvent =
  | { type: "start"; id: string; command: string; cwd: string }
  | { type: "output"; id: string; stream: "stdout" | "stderr"; text: string }
  | { type: "finish"; id: string; result: {
    status: "success" | "failed" | "timed_out" | "cancelled" | "error";
    exitCode: number | null; durationMs: number; stdout: string; stderr: string;
    stdoutTruncated: boolean; stderrTruncated: boolean; error?: string;
  } };

interface RunResult {
  content: string;
  mode: "single" | "toa";
  usage: Record<string, unknown>;
  partial?: boolean;
}

interface YaRendererBridge {
  state(): Promise<AppState>;
  chooseWorkspace(): Promise<string | undefined>;
  activateWorkspace(workspace?: string): Promise<AppState>;
  chooseImages(): Promise<SelectedImage[] | undefined>;
  clearImages(): Promise<void>;
  workspaceEntries(path?: string): Promise<Array<{ path: string; type: string }>>;
  saveWorkspaceModelSelection(selection: {
    model: AppState["config"]["model"];
    reasoningEffort: AppState["config"]["reasoningEffort"];
  }): Promise<AppState>;
  saveSettings(settings: Record<string, unknown>): Promise<AppState>;
  loginDeepSeek(): Promise<AppState>;
  cancelDeepSeekLogin(): Promise<void>;
  logoutDeepSeek(): Promise<{ state: AppState; revoked: boolean }>;
  runTask(options: Record<string, unknown>): Promise<RunResult>;
  cancelTask(): Promise<void>;
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
    projects: "Projects", addProject: "Add project", newSession: "New session", conversations: "Conversations",
    generalChats: "Without a project", noProject: "No project selected", addProjectHint: "Add a folder to start a project.",
    welcome: "What would you like to work on?", welcomeHint: "Start a conversation, or choose a project to work with local files.",
    toggleSidebar: "Toggle sidebar", taskOptions: "Task options", closePanel: "Close panel", sendShortcut: "Ctrl / ⌘ Enter to send",
    interrupted: "This task was interrupted. You can send it again.", historySaveError: "Session history could not be saved. Local storage may be full.",
    workspace: "Workspace", memory: "Memory", settings: "Settings", files: "Files", choose: "Choose…", refresh: "Refresh",
    changes: "Changes", noChanges: "File changes made by Ya will appear here after approval.",
    changesSummary: "{files} files · {changes} changes", createdFile: "Created", editedFile: "Edited", replacedFile: "Replaced",
    noTextChanges: "No text changes.", emptyFileCreated: "Created an empty file.",
    diffTruncated: "Preview shortened for this large change. Counts cover the complete change.",
    diffUnavailable: "This change is too large to preview.", showDiffLines: "Show {count} more lines", collapseDiff: "Show fewer lines",
    copyDiff: "Copy diff", copiedDiff: "Copied", copyDiffFailed: "Could not copy diff", noNewline: "No newline at end of file",
    local: "Enable local tools", task: "Task", taskPlaceholder: "Ask Ya a question or describe a workspace task…", send: "Send",
    model: "Model", thinking: "Thinking", web: "Web", toa: "Tree of Agents", workers: "Workers", auto: "Auto", on: "On", off: "Off",
    ready: "Ready", working: "Ya is working…", waiting: "Waiting for action approval…", done: "Done", relevant: "Relevant memory",
    commands: "Allow command execution", stop: "Stop", stopping: "Stopping…", success: "Succeeded", failed: "Failed",
    timed_out: "Timed out", cancelled: "Cancelled", error: "Error", truncated: "Output truncated; showing the tail.",
    noRelevant: "No approved memory meets the relevance threshold.", activity: "Activity", noActivity: "No local activity for this task.",
    pendingAction: "Pending action", noAction: "No action is waiting for approval.", approve: "Approve", deny: "Deny",
    noTasks: "Ask a question to begin.", answer: "Ya", learn: "Learn from this answer", noWorkspace: "Choose a workspace folder",
    status: "Status", kind: "Kind", text: "Text", evidence: "Evidence", actions: "Actions", candidateText: "What should Ya learn?",
    createCandidate: "Create candidate", prune: "Prune", includeCandidates: "Include candidates", reject: "Reject", revoke: "Revoke",
    language: "Language", stream: "Stream simple answers", reasoning: "Reasoning effort", budget: "ToA token budget",
    timeout: "ToA timeout (seconds)", apiKey: "DeepSeek API key", apiPlaceholder: "Leave blank to keep the current key",
    keychain: "Save in macOS Keychain", saveSettings: "Save settings", clearAudit: "Clear audit history", apiReady: "API key available",
    apiMissing: "No API key configured", saved: "Saved.", about: "About Ya", partial: "Some ToA worker results were unavailable.",
    deepseekAccount: "DeepSeek platform account", accountHint: "Sign in and authorize Ya in your browser to use your DeepSeek platform account.",
    accountLogin: "Sign in with DeepSeek", accountCancel: "Cancel sign-in", accountLogout: "Sign out",
    accountSignedIn: "Signed in to DeepSeek", accountSignedOut: "Signed out", accountWaiting: "Complete sign-in in your browser…",
    accountActive: "DeepSeek account available", accountLoggingOut: "Signing out…",
    accountRevokeFailed: "Signed out locally. The platform session could not be revoked.",
    accountInvalid: "Saved sign-in is invalid. Sign in again or clear it.", accountClear: "Clear saved sign-in",
    approvalExpired: "Approval expired; the action was not approved.",
    activityPending: "Activity, 1 action awaiting approval", approvalAnnouncement: "1 action awaiting approval.",
    taskError: "Ya error", confirmToa: "Start Tree of Agents?", confirmPrune: "Permanently delete {count} memory card(s)?",
    confirmAudit: "Permanently delete {count} audit log file(s) ({bytes} bytes)?", auditEmpty: "No audit logs to delete.",
    explicitFeedback: "Explicit user feedback after Ya task", sourceHint: "For knowledge, include a source URL in the evidence.",
    attachImages: "Attach images…", clearImages: "Clear", imageDetail: "Image detail", images: "Images",
    lowApiKeyOnly: "low (API key only)",
    visionOnly: "Image input requires the DeepSeek-V4.1-Flash-1017 model.", noImages: "No images attached.",
    defaultVisionTask: "Describe and analyze the attached image(s).", imagesToa: "re-sent to every worker, the root synthesis, and follow-up requests",
  },
  "zh-CN": {
    projects: "项目", addProject: "添加项目", newSession: "新建会话", conversations: "对话",
    generalChats: "未关联项目", noProject: "尚未选择项目", addProjectHint: "添加文件夹，开始一个项目。",
    welcome: "今天想做些什么？", welcomeHint: "开始一段对话，或选择项目来处理本地文件。",
    toggleSidebar: "展开或收起侧栏", taskOptions: "任务选项", closePanel: "关闭面板", sendShortcut: "Ctrl / ⌘ Enter 发送",
    interrupted: "此任务已中断，可以重新发送。", historySaveError: "无法保存会话记录，本地存储空间可能已满。",
    workspace: "工作区", memory: "记忆", settings: "设置", files: "文件", choose: "选择…", refresh: "刷新",
    changes: "变更", noChanges: "Ya 经批准完成的文件变更将显示在这里。",
    changesSummary: "{files} 个文件 · {changes} 次变更", createdFile: "新建", editedFile: "编辑", replacedFile: "替换",
    noTextChanges: "文本没有变化。", emptyFileCreated: "已创建空文件。",
    diffTruncated: "变更较大，预览已截断；行数统计包含完整变更。",
    diffUnavailable: "此变更过大，无法预览。", showDiffLines: "展开其余 {count} 行", collapseDiff: "收起差异",
    copyDiff: "复制 diff", copiedDiff: "已复制", copyDiffFailed: "无法复制 diff", noNewline: "文件末尾没有换行符",
    local: "启用本地工具", task: "任务", taskPlaceholder: "向 Ya 提问，或描述一个工作区任务…", send: "发送",
    model: "模型", thinking: "思考", web: "网页", toa: "Tree of Agents", workers: "工作 Agent", auto: "自动", on: "开启", off: "关闭",
    ready: "就绪", working: "Ya 正在处理…", waiting: "等待操作批准…", done: "完成", relevant: "相关记忆",
    commands: "允许命令执行", stop: "停止", stopping: "正在停止…", success: "成功", failed: "失败",
    timed_out: "超时", cancelled: "已取消", error: "错误", truncated: "输出已截断，显示末尾内容。",
    noRelevant: "没有达到相关性阈值的已批准记忆。", activity: "活动", noActivity: "本次任务还没有本地活动。",
    pendingAction: "待确认操作", noAction: "当前没有等待确认的操作。", approve: "批准", deny: "拒绝",
    noTasks: "输入问题即可开始。", answer: "Ya", learn: "从此回答中学习", noWorkspace: "请选择工作区文件夹",
    status: "状态", kind: "类别", text: "内容", evidence: "依据", actions: "操作", candidateText: "Ya 应该学到什么？",
    createCandidate: "创建候选记忆", prune: "清理", includeCandidates: "包括候选项", reject: "拒绝", revoke: "撤销",
    language: "语言", stream: "简单回答使用流式输出", reasoning: "推理强度", budget: "ToA Token 预算",
    timeout: "ToA 超时（秒）", apiKey: "DeepSeek API 密钥", apiPlaceholder: "留空以保留当前密钥",
    keychain: "保存到 macOS 钥匙串", saveSettings: "保存设置", clearAudit: "清除操作审计", apiReady: "API 密钥可用",
    apiMissing: "尚未配置 API 密钥", saved: "已保存。", about: "关于 Ya", partial: "部分 ToA 工作 Agent 未返回结果。",
    deepseekAccount: "DeepSeek 开放平台账号", accountHint: "在浏览器中登录 DeepSeek 并授权 Ya，即可使用开放平台账号。",
    accountLogin: "登录 DeepSeek", accountCancel: "取消登录", accountLogout: "退出登录",
    accountSignedIn: "已登录 DeepSeek", accountSignedOut: "尚未登录", accountWaiting: "请在浏览器中完成登录和授权…",
    accountActive: "DeepSeek 账号可用", accountLoggingOut: "正在退出登录…",
    accountRevokeFailed: "已在本机退出，未能撤销平台会话。",
    accountInvalid: "保存的登录信息无效，请重新登录或清除。", accountClear: "清除登录信息",
    approvalExpired: "批准已过期，此操作未获批准。",
    activityPending: "活动，有 1 项操作等待批准", approvalAnnouncement: "有 1 项操作等待批准。",
    taskError: "Ya 错误", confirmToa: "启动 Tree of Agents？", confirmPrune: "永久删除 {count} 条记忆？",
    confirmAudit: "永久删除 {count} 个操作审计日志（{bytes} 字节）？", auditEmpty: "没有可删除的操作审计日志。",
    explicitFeedback: "Ya 任务后的显式用户反馈", sourceHint: "知识类记忆请在依据中附上来源 URL。",
    attachImages: "添加图片…", clearImages: "清除", imageDetail: "图片细节", images: "图片",
    lowApiKeyOnly: "low（仅 API Key）",
    visionOnly: "图片输入需要选择 DeepSeek-V4.1-Flash-1017 模型。", noImages: "尚未添加图片",
    defaultVisionTask: "描述并分析所附图片。", imagesToa: "将重复发送给每个工作 Agent、根协调 Agent 和后续请求",
  },
} as const;

type TextKey = keyof typeof TEXT.en;
let state: AppState;
let currentDirectory = ".";
let activeAnswer: HTMLElement | undefined;
let activeAnswerText = "";
let pendingAction: { id: string; action: LocalAction; responding?: boolean } | undefined;
let approvalReturnFocus: HTMLElement | undefined;
let actionExpired = false;
let activities: LocalActivity[] = [];
let lastAnswer = "";
let selectedImages: SelectedImage[] = [];
let workspaceModelSaving = false;
let accountPending: "login" | "logout" | undefined;
type CommandResult = Extract<ShellCommandEvent, { type: "finish" }>["result"];
interface ConversationCommand {
  id: string;
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  result?: CommandResult;
}
interface ConversationTurn {
  task: string;
  images: SelectedImage[];
  answer: string;
  status: "running" | "complete" | "error" | "interrupted";
  partial?: boolean;
  commands: ConversationCommand[];
  changes: FileChange[];
}
interface ConversationSession {
  id: string;
  workspace?: string;
  title: string;
  updatedAt: number;
  draft: string;
  turns: ConversationTurn[];
  activities: LocalActivity[];
}
const SESSION_STORAGE_KEY = "ya.desktop.sessions.v1";
let sessions: ConversationSession[] = [];
let currentSession: ConversationSession;
let activeTurn: ConversationTurn | undefined;
let navigationPending = false;
let sessionSaveTimer: number | undefined;
let drawerPage: "files" | "changes" | "activity" | undefined;
const commandLogs = new Map<string, { summary: HTMLElement; stdout: HTMLElement; stderr: HTMLElement; command: string; cwd: string }>();
const VISION_MODEL = "deepseek-flash";

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
  document.querySelectorAll<HTMLElement>("[data-i18n-label]").forEach((node) => {
    const label = t(node.dataset.i18nLabel as TextKey);
    node.setAttribute("aria-label", label);
    node.title = label;
  });
  document.querySelectorAll<HTMLButtonElement>(".nav-button").forEach((node) => {
    const label = node.querySelector(".nav-label")?.textContent ?? "";
    node.setAttribute("aria-label", label);
    node.title = label;
  });
  element<HTMLSelectElement>("web-mode").options[0]!.text = t("auto");
  element<HTMLSelectElement>("web-mode").options[1]!.text = t("on");
  element<HTMLSelectElement>("web-mode").options[2]!.text = t("off");
  element<HTMLSpanElement>("about-version").textContent = `Ya ${state.version}`;
  renderWorkspaceLabel();
  renderActivities();
  renderChanges();
  // Existing cards are snapshots too; switching language must keep their expanded state.
  const changes = new Map(sessionChanges().map((change) => [change.id, change]));
  document.querySelectorAll<HTMLDetailsElement>(".turn .file-change").forEach((card) => {
    const change = changes.get(card.dataset.changeId ?? "");
    if (change) card.replaceWith(fileChangeCard(change, card.open));
  });
  renderPendingAction();
  renderImages();
  renderNavigation();
  renderPageTitle();
  if (!activeAnswer) setStatus(t("ready"));
}

function switchPage(page: "workspace" | "memory" | "settings"): void {
  document.querySelectorAll<HTMLElement>(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((node) => {
    const active = node.dataset.page === page;
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  element<HTMLDivElement>("workspace-actions").hidden = page !== "workspace";
  renderPageTitle();
  if (page === "memory") renderMemory();
}

function renderWorkspaceLabel(): void {
  const path = currentSession?.workspace ?? state.workspace;
  const label = element<HTMLDivElement>("workspace-path");
  label.textContent = path ?? t("noProject");
  label.title = path ?? "";
  label.classList.toggle("missing", !state.validWorkspace);
  const hint = element<HTMLSpanElement>("project-hint");
  hint.textContent = path ? projectName(path) : t("noProject");
  hint.title = path ?? "";
}

function projectName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

function sessionTitle(session: ConversationSession): string {
  return session.title || t("newSession");
}

function renderPageTitle(): void {
  const page = document.querySelector<HTMLButtonElement>(".tab.active")?.dataset.page;
  element<HTMLHeadingElement>("page-title").textContent = page === "settings" ? t("settings")
    : page === "memory" ? t("memory") : currentSession ? sessionTitle(currentSession) : t("newSession");
}

function persistSessions(): void {
  if (sessionSaveTimer !== undefined) window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = undefined;
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ activeId: currentSession.id, sessions,
      sidebarCollapsed: document.body.classList.contains("sidebar-collapsed") }));
  } catch {
    setStatus(t("historySaveError"), "error");
  }
}

function scheduleSessionSave(): void {
  if (sessionSaveTimer !== undefined) window.clearTimeout(sessionSaveTimer);
  sessionSaveTimer = window.setTimeout(persistSessions, 250);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSavedCommand(value: unknown): value is ConversationCommand {
  if (!isRecord(value) || ![value.id, value.command, value.cwd, value.stdout, value.stderr].every((part) => typeof part === "string")) return false;
  if (value.result === undefined) return true;
  const result = value.result;
  return isRecord(result) && ["success", "failed", "timed_out", "cancelled", "error"].includes(String(result.status))
    && (result.exitCode === null || typeof result.exitCode === "number") && typeof result.durationMs === "number"
    && typeof result.stdout === "string" && typeof result.stderr === "string"
    && typeof result.stdoutTruncated === "boolean" && typeof result.stderrTruncated === "boolean"
    && (result.error === undefined || typeof result.error === "string");
}

function validSavedFileChange(value: unknown): value is FileChange {
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

function loadSessionHistory(): string | undefined {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? "null");
    if (!isRecord(saved) || !Array.isArray(saved.sessions)) return undefined;
    document.body.classList.toggle("sidebar-collapsed", saved.sidebarCollapsed === true);
    element<HTMLButtonElement>("sidebar-toggle").setAttribute("aria-expanded", String(saved.sidebarCollapsed !== true));
    const ids = new Set<string>();
    for (const value of saved.sessions) {
      if (!isRecord(value) || typeof value.id !== "string" || ids.has(value.id) || typeof value.title !== "string"
        || typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt) || typeof value.draft !== "string"
        || (value.workspace !== undefined && typeof value.workspace !== "string") || !Array.isArray(value.turns)) continue;
      const turns: ConversationTurn[] = [];
      for (const turn of value.turns) {
        if (!isRecord(turn) || typeof turn.task !== "string" || typeof turn.answer !== "string"
          || !["running", "complete", "error", "interrupted"].includes(String(turn.status))) continue;
        const images = Array.isArray(turn.images) ? turn.images.filter((image): image is SelectedImage =>
          isRecord(image) && typeof image.id === "string" && typeof image.name === "string"
          && typeof image.size === "number" && typeof image.mimeType === "string") : [];
        turns.push({ task: turn.task, answer: turn.answer, images,
          status: turn.status === "running" ? "interrupted" : turn.status as ConversationTurn["status"],
          partial: turn.partial === true,
          commands: Array.isArray(turn.commands) ? turn.commands.filter(validSavedCommand) : [],
          changes: Array.isArray(turn.changes) ? turn.changes.filter(validSavedFileChange) : [],
        });
      }
      const savedActivities = Array.isArray(value.activities) ? value.activities.filter((activity): activity is LocalActivity =>
        isRecord(activity) && typeof activity.operation === "string" && typeof activity.status === "string"
        && Array.isArray(activity.paths) && activity.paths.every((path) => typeof path === "string")) : [];
      sessions.push({ id: value.id, title: value.title, updatedAt: value.updatedAt, draft: value.draft,
        ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}), turns, activities: savedActivities });
      ids.add(value.id);
    }
    return typeof saved.activeId === "string" ? saved.activeId : undefined;
  } catch {
    return undefined;
  }
}

function createSession(workspace = state.workspace): ConversationSession {
  const session: ConversationSession = { id: crypto.randomUUID(), ...(workspace ? { workspace } : {}),
    title: "", updatedAt: Date.now(), draft: "", turns: [], activities: [] };
  sessions.unshift(session);
  return session;
}

function renderNavigation(): void {
  const list = element<HTMLDivElement>("project-list");
  list.replaceChildren();
  const disabled = navigationPending || document.body.classList.contains("task-running");
  const projects: Array<string | undefined> = [...state.workspaces];
  if (sessions.some((session) => !session.workspace)) projects.push(undefined);
  for (const workspace of projects) {
    const group = document.createElement("section");
    group.className = "project-group";
    const row = document.createElement("div");
    row.className = "project-row";
    const project = document.createElement("button");
    project.type = "button";
    project.className = "project-button";
    project.classList.toggle("active", workspace === currentSession?.workspace);
    project.dataset.workspace = workspace ?? "";
    project.disabled = disabled;
    project.title = workspace ?? t("generalChats");
    project.innerHTML = '<svg class="project-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
    const name = document.createElement("span");
    name.textContent = workspace ? projectName(workspace) : t("generalChats");
    project.append(name);
    project.addEventListener("click", () => void selectSession(undefined, workspace));
    const add = document.createElement("button");
    add.type = "button";
    add.className = "icon-button";
    add.textContent = "+";
    add.title = `${t("newSession")} · ${name.textContent}`;
    add.setAttribute("aria-label", add.title);
    add.disabled = disabled;
    add.addEventListener("click", () => void selectSession(undefined, workspace, true));
    row.append(project, add);
    const children = document.createElement("div");
    children.className = "session-list";
    for (const session of sessions.filter((item) => item.workspace === workspace).sort((a, b) => b.updatedAt - a.updatedAt)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-button";
      button.classList.toggle("active", session.id === currentSession?.id);
      if (session.id === currentSession?.id) button.setAttribute("aria-current", "true");
      button.dataset.sessionId = session.id;
      button.disabled = disabled;
      button.title = sessionTitle(session);
      const title = document.createElement("span");
      title.textContent = sessionTitle(session);
      button.append(title);
      if (session.turns.length > 0) {
        const count = document.createElement("span");
        count.className = "session-time";
        count.textContent = String(session.turns.length);
        button.append(count);
      }
      button.addEventListener("click", () => void selectSession(session));
      children.append(button);
    }
    group.append(row, children);
    list.append(group);
  }
  if (state.workspaces.length === 0) {
    const hint = document.createElement("p");
    hint.className = "sidebar-empty";
    hint.textContent = t("addProjectHint");
    list.prepend(hint);
  }
  element<HTMLButtonElement>("new-session").disabled = disabled;
  element<HTMLButtonElement>("choose-workspace").disabled = disabled;
}

function renderSession(): void {
  const timeline = element<HTMLDivElement>("timeline");
  timeline.querySelectorAll(".turn").forEach((turn) => turn.remove());
  commandLogs.clear();
  lastAnswer = "";
  for (const turn of currentSession.turns) {
    const answer = appendTask(turn.task, turn.images);
    answer.classList.remove("busy-answer");
    if (turn.status === "error") {
      answer.textContent = turn.answer;
      answer.classList.add("error-copy");
    } else {
      renderMarkdown(answer, turn.answer);
      if (turn.status === "complete") lastAnswer = turn.answer;
    }
    if (turn.partial || turn.status === "interrupted") {
      const warning = document.createElement("p");
      warning.className = "warning";
      warning.textContent = t(turn.status === "interrupted" ? "interrupted" : "partial");
      answer.append(warning);
    }
    activeAnswer = answer;
    for (const command of turn.commands) {
      renderCommand({ type: "start", id: command.id, command: command.command, cwd: command.cwd });
      if (command.result) renderCommand({ type: "finish", id: command.id, result: command.result });
      else {
        renderCommand({ type: "output", id: command.id, stream: "stdout", text: command.stdout });
        renderCommand({ type: "output", id: command.id, stream: "stderr", text: command.stderr });
      }
    }
    for (const change of turn.changes ?? []) answer.parentElement?.append(fileChangeCard(change, true));
    activeAnswer = undefined;
  }
  element<HTMLDivElement>("timeline-empty").hidden = currentSession.turns.length > 0;
  element<HTMLTextAreaElement>("task-input").value = currentSession.draft;
  resizeTaskInput();
  element<HTMLButtonElement>("learn-button").disabled = !lastAnswer;
  element<HTMLInputElement>("local-enabled").checked = Boolean(state.validWorkspace);
  element<HTMLInputElement>("commands-enabled").checked = false;
  activities = currentSession.activities;
  pendingAction = undefined;
  renderActivities();
  renderChanges();
  renderPendingAction();
  renderWorkspaceLabel();
  renderPageTitle();
  syncWorkspaceControls();
  const lastTask = currentSession.turns.at(-1)?.task;
  if (lastTask) void renderRelevant(lastTask);
  else element<HTMLDivElement>("relevant-list").textContent = t("noRelevant");
}

function resizeTaskInput(): void {
  const input = element<HTMLTextAreaElement>("task-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function setNavigationPending(pending: boolean): void {
  navigationPending = pending;
  renderNavigation();
  syncWorkspaceControls();
  renderImages();
}

async function openSession(session: ConversationSession): Promise<void> {
  await clearImages();
  currentSession = session;
  currentDirectory = ".";
  switchPage("workspace");
  renderSession();
  setDrawer(undefined);
  await renderFiles();
  setStatus(t("ready"));
  persistSessions();
  element<HTMLTextAreaElement>("task-input").focus();
}

async function selectSession(session?: ConversationSession, workspace?: string, fresh = false): Promise<void> {
  if (navigationPending || document.body.classList.contains("task-running")) return;
  currentSession.draft = element<HTMLTextAreaElement>("task-input").value;
  persistSessions();
  setNavigationPending(true);
  try {
    const targetWorkspace = session ? session.workspace : workspace;
    await activateSessionWorkspace(targetWorkspace);
    const candidates = sessions.filter((item) => item.workspace === targetWorkspace).sort((a, b) => b.updatedAt - a.updatedAt);
    const selected = session ?? (fresh ? candidates.find((item) => item.turns.length === 0 && !item.draft) : candidates[0])
      ?? createSession(targetWorkspace);
    await openSession(selected);
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    setNavigationPending(false);
  }
}

async function activateSessionWorkspace(workspace?: string): Promise<void> {
  if (state.workspace === workspace) return;
  try {
    state = await bridge.activateWorkspace(workspace);
  } catch (error) {
    if (!workspace || !state.workspaces.includes(workspace)) throw error;
    // History is independent of the folder, but must never inherit another project's tools.
    state = await bridge.activateWorkspace();
  }
}

function setDrawer(page: "files" | "changes" | "activity" | undefined): void {
  drawerPage = page;
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
}

async function chooseWorkspace(): Promise<void> {
  if (navigationPending || document.body.classList.contains("task-running")) return;
  currentSession.draft = element<HTMLTextAreaElement>("task-input").value;
  persistSessions();
  setNavigationPending(true);
  try {
    const selected = await bridge.chooseWorkspace();
    if (!selected) return;
    state = await bridge.state();
    const session = sessions.filter((session) => session.workspace === state.workspace)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? createSession();
    await openSession(session);
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    setNavigationPending(false);
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
  element<HTMLButtonElement>("choose-images").disabled = running || workspaceModelSaving || navigationPending || !visionEnabled();
  element<HTMLButtonElement>("choose-images").title = t(visionEnabled() ? "attachImages" : "visionOnly");
  element<HTMLButtonElement>("clear-images").disabled = running || workspaceModelSaving || selectedImages.length === 0;
  element<HTMLSelectElement>("image-detail").disabled = running || workspaceModelSaving || !visionEnabled() || selectedImages.length === 0;
  const lowDetail = element<HTMLOptionElement>("image-detail-low");
  lowDetail.disabled = state.accountSignedIn;
  lowDetail.textContent = state.accountSignedIn ? t("lowApiKeyOnly") : "low";
  list.replaceChildren();
  element<HTMLDivElement>("image-controls").hidden = selectedImages.length === 0;
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
    const workspace = state.validWorkspace;
    const directory = currentDirectory;
    const entries = await bridge.workspaceEntries(currentDirectory);
    if (workspace !== state.validWorkspace || directory !== currentDirectory) return;
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
  if (document.body.classList.contains("task-running") || workspaceModelSaving || navigationPending) return;
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

  const history = currentSession.turns.flatMap((turn): ConversationMessage[] => {
    const messages: ConversationMessage[] = [{ role: "user", content: turn.task }];
    if (turn.status === "complete" && turn.answer) messages.push({ role: "assistant", content: turn.answer });
    return messages;
  });
  input.value = "";
  resizeTaskInput();
  currentSession.draft = "";
  currentSession.updatedAt = Date.now();
  if (!currentSession.title) currentSession.title = task.replace(/\s+/gu, " ").slice(0, 48);
  activeTurn = { task, images: taskImages, answer: "", status: "running", commands: [], changes: [] };
  currentSession.turns.push(activeTurn);
  activeAnswer = appendTask(task, taskImages);
  activeAnswerText = "";
  lastAnswer = "";
  actionExpired = false;
  activities = [];
  currentSession.activities = activities;
  commandLogs.clear();
  pendingAction = undefined;
  renderPendingAction();
  renderActivities();
  setRunning(true);
  renderPageTitle();
  persistSessions();
  element<HTMLDetailsElement>("task-options").open = false;
  void renderRelevant(task);
  setStatus(t("working"), "busy");
  try {
    const result = await bridge.runTask({
      task,
      history,
      webMode: element<HTMLSelectElement>("web-mode").value,
      toa,
      toaWorkers: Number(element<HTMLSelectElement>("toa-workers").value),
      stream: state.stream,
      local,
      exec: local && element<HTMLInputElement>("commands-enabled").checked,
      imageIds: taskImages.map((image) => image.id),
      imageDetail: element<HTMLSelectElement>("image-detail").value as ImageDetail,
    });
    activeAnswerText = result.content;
    activeTurn.answer = result.content;
    activeTurn.status = "complete";
    activeTurn.partial = result.partial;
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
    activeTurn.answer = activeAnswer.textContent;
    activeTurn.status = "error";
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
    if (state.accountSignedIn) {
      try { state = await bridge.state(); fillSettings(); }
      catch { /* Keep the task error visible if refreshing account state also fails. */ }
    }
  } finally {
    clearPendingAction();
    activeAnswer = undefined;
    activeTurn = undefined;
    selectedImages = [];
    void bridge.clearImages().catch(() => undefined);
    setRunning(false);
    persistSessions();
  }
}

function setRunning(running: boolean): void {
  element<HTMLTextAreaElement>("task-input").disabled = running;
  document.body.classList.toggle("task-running", running);
  element<HTMLButtonElement>("stop-button").hidden = !running;
  element<HTMLButtonElement>("stop-button").disabled = false;
  syncWorkspaceControls();
  renderImages();
  renderNavigation();
}

function renderCommand(event: ShellCommandEvent): void {
  if (activeTurn) {
    if (event.type === "start") activeTurn.commands.push({ id: event.id, command: event.command, cwd: event.cwd, stdout: "", stderr: "" });
    else {
      const command = activeTurn.commands.find((item) => item.id === event.id);
      if (command && event.type === "output") command[event.stream] = `${command[event.stream]}${event.text}`.slice(-65_536);
      if (command && event.type === "finish") {
        command.result = event.result;
        command.stdout = "";
        command.stderr = "";
      }
    }
    scheduleSessionSave();
  }
  if (event.type === "start") {
    if (!activeAnswer) return;
    const details = document.createElement("details");
    details.className = "command-run";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${event.command} · ${event.cwd} · ${t("working")}`;
    const stdout = document.createElement("pre");
    const stderr = document.createElement("pre");
    stderr.className = "command-stderr";
    details.append(summary, stdout, stderr);
    activeAnswer.parentElement?.append(details);
    commandLogs.set(event.id, { summary, stdout, stderr, command: event.command, cwd: event.cwd });
    if (activeTurn) setStatus(t("working"), "busy");
  } else {
    const log = commandLogs.get(event.id);
    if (!log) return;
    if (event.type === "output") {
      const output = log[event.stream];
      output.textContent = `${output.textContent ?? ""}${event.text}`.slice(-65_536);
    } else {
      const result = event.result;
      log.summary.textContent = `${log.command} · ${log.cwd} · ${t(result.status)} (exit ${result.exitCode ?? "—"}, ${(result.durationMs / 1_000).toFixed(1)}s)`;
      log.summary.classList.toggle("error-copy", result.status !== "success");
      const note = result.stdoutTruncated || result.stderrTruncated ? `${t("truncated")}\n` : "";
      log.stdout.textContent = `${note}${result.stdout}`;
      log.stderr.textContent = [result.stderr, result.error].filter(Boolean).join("\n");
    }
  }
  const timeline = element<HTMLDivElement>("timeline");
  timeline.scrollTop = timeline.scrollHeight;
}

async function stopTask(): Promise<void> {
  const button = element<HTMLButtonElement>("stop-button");
  button.disabled = true;
  setStatus(t("stopping"), "busy");
  try { await bridge.cancelTask(); }
  catch (error) { button.disabled = false; setStatus(errorText(error), "error"); }
}

async function renderRelevant(task: string): Promise<void> {
  const panel = element<HTMLDivElement>("relevant-list");
  panel.replaceChildren();
  try {
    const sessionId = currentSession.id;
    const matches = await bridge.relevantCards(task);
    if (sessionId !== currentSession.id) return;
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

function sessionChanges(): FileChange[] {
  return currentSession?.turns.flatMap((turn) => turn.changes ?? []) ?? [];
}

function renderChanges(): void {
  const changes = sessionChanges();
  const count = element<HTMLSpanElement>("changes-count");
  const files = new Set(changes.map((change) => change.path)).size;
  count.hidden = files === 0;
  count.textContent = String(files);
  element<HTMLDivElement>("changes-summary").textContent = changes.length === 0 ? ""
    : interpolate(t("changesSummary"), { files, changes: changes.length });
  const list = element<HTMLDivElement>("change-list");
  const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>(".file-change[open]"), (card) => card.dataset.changeId));
  list.replaceChildren();
  if (changes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = t("noChanges");
    list.append(empty);
  } else {
    // Each entry is the diff at the time of the operation, including repeated edits to one path.
    for (const change of changes.toReversed()) list.append(fileChangeCard(change, open.has(change.id)));
  }
}

interface DiffDisplayLine {
  kind: "hunk" | "addition" | "deletion" | "context" | "note";
  oldLine?: number;
  newLine?: number;
  marker?: string;
  text: string;
}

function diffDisplayLines(change: FileChange): DiffDisplayLine[] {
  return change.hunks.flatMap((hunk) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    const lines: DiffDisplayLine[] = [{ kind: "hunk", text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` }];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) {
        lines.push({ kind: "note", marker: "\\", text: t("noNewline") });
      } else {
        const kind = line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context";
        lines.push({ kind, marker: line[0], text: line.slice(1),
          ...(kind !== "addition" ? { oldLine: oldLine++ } : {}),
          ...(kind !== "deletion" ? { newLine: newLine++ } : {}),
        });
      }
    }
    return lines;
  });
}

function fileChangeText(change: FileChange): string {
  return [`--- ${change.operation === "create" ? "/dev/null" : change.path}`, `+++ ${change.path}`,
    ...change.hunks.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines]),
    ...(change.truncated ? [`... ${t("diffTruncated")}`] : []), ""].join("\n");
}

function fileChangeCard(change: FileChange, open = false): HTMLDetailsElement {
  const card = document.createElement("details");
  card.className = "file-change";
  card.dataset.changeId = change.id;
  card.open = open;
  const summary = document.createElement("summary");
  const path = document.createElement("span");
  path.className = "change-path";
  path.textContent = change.path;
  path.title = change.path;
  const operation = document.createElement("span");
  operation.className = "change-operation";
  operation.textContent = t(change.operation === "create" ? "createdFile" : change.operation === "edit" ? "editedFile" : "replacedFile");
  const stats = document.createElement("span");
  stats.className = "change-stats";
  if (change.additions !== null && change.deletions !== null) {
    const additions = document.createElement("span");
    additions.className = "diff-additions";
    additions.textContent = `+${change.additions}`;
    const deletions = document.createElement("span");
    deletions.className = "diff-deletions";
    deletions.textContent = `−${change.deletions}`;
    stats.append(additions, deletions);
  }
  summary.append(path, operation, stats);
  card.append(summary);
  let loaded = false;
  const load = (): void => {
    if (loaded) return;
    loaded = true;
    const body = document.createElement("div");
    body.className = "diff-body";
    const rows = diffDisplayLines(change);
    if (rows.length > 0) {
      const toolbar = document.createElement("div");
      toolbar.className = "diff-toolbar";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "diff-copy";
      copy.textContent = t("copyDiff");
      copy.addEventListener("click", () => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(fileChangeText(change));
            copy.textContent = t("copiedDiff");
          } catch { copy.textContent = t("copyDiffFailed"); }
        })();
      });
      toolbar.append(copy);
      const scroll = document.createElement("div");
      scroll.className = "diff-lines";
      scroll.tabIndex = 0;
      scroll.setAttribute("role", "region");
      scroll.setAttribute("aria-label", `${t("changes")} · ${change.path}`);
      const grid = document.createElement("div");
      grid.className = "diff-grid";
      scroll.append(grid);
      let expanded = false;
      const appendRow = (line: DiffDisplayLine): void => {
        const row = document.createElement("div");
        row.className = `diff-row ${line.kind}`;
        if (line.kind === "hunk") row.textContent = line.text;
        else {
          for (const number of [line.oldLine, line.newLine]) {
            const gutter = document.createElement("span");
            gutter.className = "diff-number";
            gutter.textContent = number === undefined ? "" : String(number);
            gutter.setAttribute("aria-hidden", "true");
            row.append(gutter);
          }
          const marker = document.createElement("span");
          marker.className = "diff-marker";
          marker.textContent = line.marker ?? "";
          const code = document.createElement("code");
          code.className = "diff-code";
          code.textContent = line.text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu,
            (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
          row.append(marker, code);
        }
        grid.append(row);
      };
      const renderRows = (): void => {
        grid.replaceChildren();
        if (rows.length <= 16 || expanded) rows.forEach(appendRow);
        else rows.slice(0, 8).forEach(appendRow);
        if (rows.length > 16) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "diff-expand";
          toggle.textContent = expanded ? t("collapseDiff") : interpolate(t("showDiffLines"), { count: rows.length - 16 });
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.addEventListener("click", () => {
            expanded = !expanded;
            renderRows();
            grid.querySelector<HTMLButtonElement>(".diff-expand")?.focus({ preventScroll: true });
          });
          grid.append(toggle);
          if (!expanded) rows.slice(-8).forEach(appendRow);
        }
      };
      renderRows();
      body.append(toolbar, scroll);
    } else {
      const empty = document.createElement("p");
      empty.className = "diff-notice";
      empty.textContent = t(change.additions === null ? "diffUnavailable" : change.operation === "create" ? "emptyFileCreated" : "noTextChanges");
      body.append(empty);
    }
    if (change.truncated && change.additions !== null) {
      const notice = document.createElement("p");
      notice.className = "diff-notice";
      notice.textContent = t("diffTruncated");
      body.append(notice);
    }
    card.append(body);
  };
  card.addEventListener("toggle", () => { if (card.open) load(); });
  if (open) load();
  return card;
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
  element<HTMLButtonElement>("action-approve").disabled = Boolean(pendingAction?.responding);
  element<HTMLButtonElement>("action-deny").disabled = Boolean(pendingAction?.responding);
  const toggle = element<HTMLButtonElement>("toggle-activity");
  toggle.classList.toggle("has-pending", Boolean(pendingAction));
  const label = t(pendingAction ? "activityPending" : "activity");
  toggle.setAttribute("aria-label", label);
  toggle.title = label;
  const announcement = element<HTMLParagraphElement>("approval-announcement");
  const message = pendingAction ? t("approvalAnnouncement") : actionExpired ? t("approvalExpired") : "";
  if (announcement.textContent !== message) announcement.textContent = message;
  if (!pendingAction) {
    empty.hidden = false;
    empty.textContent = t(actionExpired ? "approvalExpired" : "noAction");
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

function clearPendingAction(expired = actionExpired): void {
  const restore = Boolean(pendingAction) && (element<HTMLElement>("approval-panel").contains(document.activeElement)
    || document.activeElement === document.body);
  const target = approvalReturnFocus;
  pendingAction = undefined;
  approvalReturnFocus = undefined;
  actionExpired = expired;
  renderPendingAction();
  if (restore) {
    if (target?.isConnected && !target.matches(":disabled") && target.getClientRects().length > 0) target.focus({ preventScroll: true });
    else element<HTMLButtonElement>("toggle-activity").focus({ preventScroll: true });
  }
}

function decideLocalAction(approved: boolean): void {
  if (!pendingAction || pendingAction.responding) return;
  pendingAction.responding = true;
  renderPendingAction();
  try { bridge.respondLocalAction(pendingAction.id, approved); }
  catch (error) {
    pendingAction.responding = false;
    renderPendingAction();
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  }
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
  element<HTMLSpanElement>("api-state").textContent = state.accountError ? t("accountInvalid")
    : state.accountSignedIn ? t("accountActive") : state.hasApiKey ? t("apiReady") : t("apiMissing");
  renderAccount();
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
  element<HTMLButtonElement>("send-button").disabled = running || workspaceModelSaving || navigationPending;
  element<HTMLSelectElement>("task-model").disabled = running || workspaceModelSaving || navigationPending;
  element<HTMLSelectElement>("task-reasoning").disabled = running || workspaceModelSaving || navigationPending;
  const local = element<HTMLInputElement>("local-enabled");
  local.disabled = running || navigationPending || !state.validWorkspace;
  const commands = element<HTMLInputElement>("commands-enabled");
  commands.disabled = running || navigationPending || !local.checked;
  if (!local.checked) commands.checked = false;
  element<HTMLSelectElement>("web-mode").disabled = running;
  element<HTMLInputElement>("toa-enabled").disabled = running;
  element<HTMLSelectElement>("toa-workers").disabled = running || !element<HTMLInputElement>("toa-enabled").checked;
  renderAccount();
}

function renderAccount(): void {
  const running = document.body.classList.contains("task-running");
  element<HTMLElement>("account-state").textContent = accountPending === "login" ? t("accountWaiting")
    : accountPending === "logout" ? t("accountLoggingOut") : state.accountError ? t("accountInvalid")
    : state.accountSignedIn ? t("accountSignedIn") : t("accountSignedOut");
  element<HTMLButtonElement>("account-login").hidden = state.accountSignedIn || accountPending === "login";
  element<HTMLButtonElement>("account-login").disabled = running || Boolean(accountPending);
  element<HTMLButtonElement>("account-cancel").hidden = accountPending !== "login";
  element<HTMLButtonElement>("account-logout").hidden = (!state.accountSignedIn && !state.accountError) || accountPending === "login";
  element<HTMLButtonElement>("account-logout").disabled = running || Boolean(accountPending);
  element<HTMLButtonElement>("account-logout").textContent = t(state.accountError ? "accountClear" : "accountLogout");
}

async function signInDeepSeek(): Promise<void> {
  accountPending = "login";
  renderAccount();
  try {
    state = await bridge.loginDeepSeek();
    setStatus(t("accountSignedIn"));
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    try { state = await bridge.state(); }
    catch { /* Release the sign-in controls even if the state refresh fails. */ }
    accountPending = undefined;
    fillSettings();
  }
}

async function signOutDeepSeek(): Promise<void> {
  accountPending = "logout";
  renderAccount();
  try {
    const result = await bridge.logoutDeepSeek();
    state = result.state;
    setStatus(t(result.revoked ? "accountSignedOut" : "accountRevokeFailed"));
  } catch (error) {
    setStatus(`${t("taskError")}: ${errorText(error)}`, "error");
  } finally {
    accountPending = undefined;
    fillSettings();
  }
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
  element<HTMLButtonElement>("new-session").addEventListener("click", () => void selectSession(undefined, currentSession.workspace, true));
  element<HTMLButtonElement>("sidebar-toggle").addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-collapsed");
    element<HTMLButtonElement>("sidebar-toggle").setAttribute("aria-expanded", String(!collapsed));
    persistSessions();
  });
  for (const page of ["files", "changes", "activity"] as const) {
    element<HTMLButtonElement>(`toggle-${page}`).addEventListener("click", () => setDrawer(drawerPage === page ? undefined : page));
    element<HTMLButtonElement>(`drawer-${page}-tab`).addEventListener("click", () => setDrawer(page));
  }
  element<HTMLButtonElement>("close-drawer").addEventListener("click", () => {
    const previous = drawerPage;
    setDrawer(undefined);
    if (previous) element<HTMLButtonElement>(`toggle-${previous}`).focus();
  });
  element<HTMLButtonElement>("refresh-files").addEventListener("click", () => void renderFiles());
  element<HTMLButtonElement>("choose-images").addEventListener("click", () => void chooseImages());
  element<HTMLButtonElement>("clear-images").addEventListener("click", () => void clearImages());
  element<HTMLSelectElement>("task-model").addEventListener("change", () => void saveWorkspaceModelSelection());
  element<HTMLSelectElement>("task-reasoning").addEventListener("change", () => void saveWorkspaceModelSelection());
  element<HTMLButtonElement>("send-button").addEventListener("click", () => void runTask());
  element<HTMLButtonElement>("stop-button").addEventListener("click", () => void stopTask());
  element<HTMLInputElement>("local-enabled").addEventListener("change", syncWorkspaceControls);
  element<HTMLTextAreaElement>("task-input").addEventListener("keydown", (event) => {
    if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void runTask();
    }
  });
  element<HTMLTextAreaElement>("task-input").addEventListener("input", (event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    currentSession.draft = input.value;
    resizeTaskInput();
    scheduleSessionSave();
  });
  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void selectSession(undefined, currentSession.workspace, true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      element<HTMLButtonElement>("sidebar-toggle").click();
    } else if (event.key === "Escape") {
      element<HTMLDetailsElement>("task-options").open = false;
      if (pendingAction) {
        event.preventDefault();
        switchPage("workspace");
        setDrawer("activity");
        element<HTMLElement>(pendingAction.responding ? "action-summary" : "action-deny").focus({ preventScroll: true });
        return;
      }
      const previous = drawerPage;
      setDrawer(undefined);
      if (previous) element<HTMLButtonElement>(`toggle-${previous}`).focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !element<HTMLDetailsElement>("task-options").contains(event.target)) {
      element<HTMLDetailsElement>("task-options").open = false;
    }
  });
  window.addEventListener("beforeunload", () => {
    currentSession.draft = element<HTMLTextAreaElement>("task-input").value;
    persistSessions();
  });
  element<HTMLInputElement>("toa-enabled").addEventListener("change", (event) => {
    element<HTMLSelectElement>("toa-workers").disabled = !(event.currentTarget as HTMLInputElement).checked;
  });
  element<HTMLButtonElement>("action-approve").addEventListener("click", () => decideLocalAction(true));
  element<HTMLButtonElement>("action-deny").addEventListener("click", () => decideLocalAction(false));
  element<HTMLButtonElement>("memory-create").addEventListener("click", () => void createMemory());
  element<HTMLButtonElement>("memory-prune").addEventListener("click", () => void pruneMemory());
  element<HTMLButtonElement>("settings-save").addEventListener("click", () => void saveSettings());
  element<HTMLButtonElement>("account-login").addEventListener("click", () => void signInDeepSeek());
  element<HTMLButtonElement>("account-cancel").addEventListener("click", () => {
    void bridge.cancelDeepSeekLogin().catch((error: unknown) => setStatus(`${t("taskError")}: ${errorText(error)}`, "error"));
  });
  element<HTMLButtonElement>("account-logout").addEventListener("click", () => void signOutDeepSeek());
  element<HTMLButtonElement>("audit-clear").addEventListener("click", () => void clearAudit());
  element<HTMLButtonElement>("learn-button").addEventListener("click", learnFromAnswer);

  bridge.onTaskEvent((event) => {
    if (event.type === "content" && activeAnswer) {
      activeAnswerText += event.content;
      if (activeTurn) activeTurn.answer = activeAnswerText;
      activeAnswer.classList.remove("busy-answer");
      renderMarkdown(activeAnswer, activeAnswerText);
      element<HTMLDivElement>("timeline").scrollTop = element<HTMLDivElement>("timeline").scrollHeight;
      scheduleSessionSave();
    } else if (event.type === "activity") {
      activities.push(event.activity);
      renderActivities();
      scheduleSessionSave();
    } else if (event.type === "command") {
      renderCommand(event.event);
    } else if (event.type === "file-change" && activeTurn && activeAnswer) {
      activeTurn.changes.push(event.change);
      activeAnswer.parentElement?.append(fileChangeCard(event.change, true));
      renderChanges();
      persistSessions();
      void renderFiles();
    } else if (event.type === "local-action") {
      if (!pendingAction) approvalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      actionExpired = false;
      pendingAction = { id: event.id, action: event.action };
      renderPendingAction();
      switchPage("workspace");
      setDrawer("activity");
      setStatus(t("waiting"), "busy");
      element<HTMLButtonElement>("action-deny").focus({ preventScroll: true });
    } else if (event.type === "local-action-expired" && pendingAction?.id === event.id) {
      clearPendingAction(true);
      setStatus(t("approvalExpired"), "error");
    } else if (event.type === "local-action-resolved" && pendingAction?.id === event.id) {
      clearPendingAction(false);
      if (document.body.classList.contains("task-running")) setStatus(t("working"), "busy");
    }
  });
}

async function initialize(): Promise<void> {
  document.body.inert = true;
  state = await bridge.state();
  const activeId = loadSessionHistory();
  currentSession = sessions.find((session) => session.id === activeId && (!session.workspace || state.workspaces.includes(session.workspace)))
    ?? sessions.find((session) => session.workspace === state.workspace) ?? createSession();
  await activateSessionWorkspace(currentSession.workspace);
  registerEvents();
  applyLanguage();
  fillSettings();
  renderMemory();
  renderSession();
  persistSessions();
  await renderFiles();
  document.body.dataset.ready = "true";
  document.body.inert = false;
}

void initialize().catch((error: unknown) => {
  document.body.inert = false;
  document.body.dataset.startupError = "true";
  document.body.textContent = `Ya failed to start: ${errorText(error)}`;
});
