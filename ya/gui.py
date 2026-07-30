"""Native, dependency-free Ya desktop application."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import queue
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk
import webbrowser

from . import __version__
from .config import ModelConfig, VALID_MODELS
from .gui_controller import GuiController, GuiTaskOptions
from .gui_markdown import markdown_lines
from .local import LocalAction, LocalActivity
from .memory import DuplicateMemoryError, MemoryLimitError


TEXT = {
    "en": {
        "title": "Ya", "workspace": "Workspace", "memory": "Memory", "settings": "Settings",
        "files": "Files", "activity": "Activity", "task": "Task", "send": "Ask Ya",
        "model": "Model", "thinking": "Thinking", "web": "Web", "toa": "Tree of Agents",
        "stream": "Stream simple answers", "auto": "Auto", "on": "On", "off": "Off",
        "local": "Enable local tools", "choose": "Choose...", "refresh": "Refresh",
        "no_workspace": "Choose a workspace folder", "workspace_path": "Workspace folder",
        "status_ready": "Ready", "status_working": "Ya is working...",
        "status_waiting": "Waiting for file-change confirmation...", "status_done": "Done",
        "answer": "Answer", "no_answer": "Ask a question to begin.", "learn": "Learn from this answer",
        "related_memory": "Relevant memory", "no_relevant": "No approved memory meets the relevance threshold.",
        "action": "Pending file action", "action_none": "No file change is waiting for approval.",
        "action_paths": "Absolute path", "apply": "Approve", "deny": "Deny",
        "activity_status": "Status", "activity_detail": "Detail", "activity_empty": "No local activity for this task.",
        "memory_empty": "No local memory cards.", "approve": "Approve", "reject": "Reject", "revoke": "Revoke",
        "prune": "Prune", "include_candidates": "Include candidates", "relevant": "Relevant to current task",
        "language": "Language", "api_key": "DeepSeek API key", "save_key": "Save key",
        "save_settings": "Save settings", "session_key": "Use for this session",
        "key_help_macos": "macOS saves the key in Keychain.",
        "key_help_other": "Windows and Linux use DEEPSEEK_API_KEY, or a session-only key below.",
        "reasoning": "Reasoning effort", "budget": "ToA token budget", "timeout": "ToA timeout (seconds)",
        "preflight": "ToA preflight", "start_toa": "Start ToA", "cancel": "Cancel", "workers": "Workers",
        "candidate": "Create memory candidate", "candidate_prompt": "What should Ya learn?",
        "kind_prompt": "Memory kind", "created": "Created candidate {id}.",
        "confirm_prune": "Delete {count} selected memory card(s)?", "nothing_prune": "No matching memory cards to delete.",
        "pruned": "Deleted {count} memory card(s).", "saved": "Saved.", "error": "Ya error",
        "api_missing": "No DeepSeek API key found. Add one in Settings.",
        "source": "Explicit user feedback after Ya task", "workspace_required": "Choose an existing folder before enabling local tools.",
        "language_en": "English", "language_zh": "简体中文", "response_partial": "Some ToA worker results were unavailable.",
        "help": "Help", "about": "About Ya", "about_text": "Ya\n\nVersion {version}",
        "clear_audit": "Clear audit history", "confirm_clear_audit": "Permanently delete {count} audit log file(s) ({size} bytes)?",
        "nothing_audit": "No audit logs to delete.", "audit_cleared": "Deleted {count} audit log file(s).",
        "id": "ID", "status": "Status", "kind": "Kind", "text": "Text", "candidate_status": "Candidate",
        "approved_status": "Approved", "rejected_status": "Rejected", "revoked_status": "Revoked",
        "preference_kind": "Preference", "procedure_kind": "Procedure", "knowledge_kind": "Knowledge",
        "activity_list": "Listed", "activity_read": "Read", "activity_search": "Searched",
        "activity_mkdir": "Created directory", "activity_write": "Wrote", "activity_move": "Moved",
        "activity_success": "Done", "activity_denied": "Denied", "activity_error": "Error",
    },
    "zh-CN": {
        "title": "Ya", "workspace": "工作区", "memory": "记忆", "settings": "设置",
        "files": "文件", "activity": "活动", "task": "任务", "send": "询问 Ya",
        "model": "模型", "thinking": "思考", "web": "网页", "toa": "Tree of Agents",
        "stream": "简单回答使用流式输出", "auto": "自动", "on": "开启", "off": "关闭",
        "local": "启用本地工具", "choose": "选择...", "refresh": "刷新",
        "no_workspace": "选择工作区文件夹", "workspace_path": "工作区文件夹",
        "status_ready": "就绪", "status_working": "Ya 正在处理...",
        "status_waiting": "正在等待文件变更确认...", "status_done": "完成",
        "answer": "回答", "no_answer": "输入问题后开始。", "learn": "从此回答中学习",
        "related_memory": "相关记忆", "no_relevant": "没有已批准记忆达到相关度阈值。",
        "action": "待确认的文件操作", "action_none": "当前没有等待批准的文件变更。",
        "action_paths": "绝对路径", "apply": "批准", "deny": "拒绝",
        "activity_status": "状态", "activity_detail": "详情", "activity_empty": "本次任务没有本地活动。",
        "memory_empty": "没有本地记忆卡片。", "approve": "批准", "reject": "拒绝", "revoke": "撤销",
        "prune": "清理", "include_candidates": "包含候选卡片", "relevant": "与当前任务相关",
        "language": "语言", "api_key": "DeepSeek API 密钥", "save_key": "保存密钥",
        "save_settings": "保存设置", "session_key": "仅在本次运行使用",
        "key_help_macos": "macOS 会将密钥保存到钥匙串。",
        "key_help_other": "Windows 和 Linux 使用 DEEPSEEK_API_KEY，或在下方仅本次运行输入。",
        "reasoning": "推理强度", "budget": "ToA Token 预算", "timeout": "ToA 超时（秒）",
        "preflight": "ToA 预检", "start_toa": "开始 ToA", "cancel": "取消", "workers": "工作 Agent",
        "candidate": "创建记忆候选", "candidate_prompt": "希望 Ya 学到什么？", "kind_prompt": "记忆类别",
        "created": "已创建候选卡片 {id}。", "confirm_prune": "删除选中的 {count} 张记忆卡片？",
        "nothing_prune": "没有可清理的匹配记忆卡片。", "pruned": "已删除 {count} 张记忆卡片。",
        "saved": "已保存。", "error": "Ya 错误", "api_missing": "未找到 DeepSeek API 密钥。请在设置中添加。",
        "source": "Ya 任务后的显式用户反馈", "workspace_required": "启用本地工具前，请选择一个存在的文件夹。",
        "language_en": "English", "language_zh": "简体中文", "response_partial": "部分 ToA 工作 Agent 未返回结果。",
        "help": "帮助", "about": "关于 Ya", "about_text": "Ya\n\n版本 {version}",
        "clear_audit": "清除操作审计", "confirm_clear_audit": "永久删除 {count} 个操作审计日志文件（{size} 字节）？",
        "nothing_audit": "没有可删除的操作审计日志。", "audit_cleared": "已删除 {count} 个操作审计日志文件。",
        "id": "ID", "status": "状态", "kind": "类别", "text": "内容", "candidate_status": "候选",
        "approved_status": "已批准", "rejected_status": "已拒绝", "revoked_status": "已撤销",
        "preference_kind": "偏好", "procedure_kind": "流程", "knowledge_kind": "知识",
        "activity_list": "已列出", "activity_read": "已读取", "activity_search": "已搜索",
        "activity_mkdir": "已创建目录", "activity_write": "已写入", "activity_move": "已移动",
        "activity_success": "完成", "activity_denied": "已拒绝", "activity_error": "错误",
    },
}


def initial_window_geometry(screen_width: int, screen_height: int) -> tuple[int, int, int, int]:
    """Choose a spacious, centered first-run workbench without exceeding a display."""
    width = max(1020, min(1900, round(screen_width * 0.92)))
    height = max(680, min(1180, round(screen_height * 0.90)))
    return width, height, max(0, (screen_width - width) // 2), max(0, (screen_height - height) // 2)


def initial_workbench_sashes(width: int) -> tuple[int, int]:
    """Reserve enough center space for the task controls on first launch."""
    left = max(190, min(260, round(width * 0.12)))
    right_start = max(left + 620, min(width - 300, round(width * 0.75)))
    return left, right_start


def task_controls_wrap_required(width: int) -> bool:
    """Keep the learning command reachable when a smaller display limits the center pane."""
    return width < 820


@dataclass
class LocalActionRequest:
    action: LocalAction
    completed: threading.Event
    approved: bool = False


@dataclass
class SessionTask:
    prompt: str
    content: str = ""
    status: str = "working"


class YaApp(ttk.Frame):
    def __init__(self, root: tk.Tk, controller: GuiController | None = None) -> None:
        super().__init__(root, padding=10)
        self.root = root
        self.controller = controller or GuiController()
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.running = False
        self.answer = ""
        self.session_tasks: list[SessionTask] = []
        self.activities: list[LocalActivity] = []
        self.active_task: SessionTask | None = None
        self.pending_action: LocalActionRequest | None = None
        self._initial_sashes_applied = False
        self._task_controls_wrapped = False
        self._link_urls: dict[str, str] = {}
        self._prompt_bubbles: list[tk.Label] = []
        self._set_vars()
        self._build()
        self.pack(fill="both", expand=True)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.after(40, self._drain_events)

    def t(self, key: str) -> str:
        return TEXT[self.controller.language][key]

    def _web_label(self, value: str) -> str:
        return self.t(value)

    def _web_mode(self) -> str:
        return next((value for value in ("auto", "on", "off") if self._web_label(value) == self.web_var.get()), "auto")

    def _language_label(self, code: str) -> str:
        return self.t("language_en" if code == "en" else "language_zh")

    def _language_code(self) -> str:
        return next((code for code in ("en", "zh-CN") if self._language_label(code) == self.language_var.get()), "en")

    def _set_vars(self) -> None:
        config = self.controller.config
        self.model_var = tk.StringVar(value="flash" if config.model == VALID_MODELS["flash"] else "pro")
        self.thinking_var = tk.BooleanVar(value=config.thinking_enabled)
        self.web_var = tk.StringVar(value=self._web_label("auto"))
        self.toa_var = tk.BooleanVar(value=False)
        self.stream_var = tk.BooleanVar(value=self.controller.stream)
        # Local access must be newly and explicitly granted every launch.
        self.local_var = tk.BooleanVar(value=False)
        self.workspace_var = tk.StringVar(value=self.controller.workspace or "")
        self.workers_var = tk.StringVar(value="2")
        self.status_var = tk.StringVar(value=self.t("status_ready"))
        self.language_var = tk.StringVar(value=self._language_label(self.controller.language))
        self.reasoning_var = tk.StringVar(value=config.reasoning_effort)
        self.budget_var = tk.StringVar(value=str(config.toa_token_budget))
        self.timeout_var = tk.StringVar(value=str(config.toa_timeout))
        self.key_var = tk.StringVar()
        self.include_candidates_var = tk.BooleanVar(value=False)

    def _build(self) -> None:
        self.root.title(self.t("title"))
        self.root.minsize(1020, 680)
        width, height, x, y = initial_window_geometry(self.root.winfo_screenwidth(), self.root.winfo_screenheight())
        self.root.geometry(f"{width}x{height}+{x}+{y}")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        self._build_menu()
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True)
        self.workspace_page = ttk.Frame(self.notebook, padding=10)
        self.memory_page = ttk.Frame(self.notebook, padding=10)
        self.settings_page = ttk.Frame(self.notebook, padding=10)
        self.notebook.add(self.workspace_page, text=self.t("workspace"))
        self.notebook.add(self.memory_page, text=self.t("memory"))
        self.notebook.add(self.settings_page, text=self.t("settings"))
        self._build_workspace()
        self._build_memory()
        self._build_settings()
        self.root.after(100, self._set_initial_workbench_sashes)

    def _build_menu(self) -> None:
        menu = tk.Menu(self.root)
        help_menu = tk.Menu(menu, tearoff=False)
        help_menu.add_command(label=self.t("about"), command=self._show_about)
        menu.add_cascade(label=self.t("help"), menu=help_menu)
        self.root.configure(menu=menu)

    def _build_workspace(self) -> None:
        page = self.workspace_page
        page.columnconfigure(0, weight=1)
        page.rowconfigure(1, weight=1)

        ribbon = ttk.Frame(page)
        ribbon.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ribbon.columnconfigure(1, weight=1)
        ttk.Label(ribbon, text=self.t("workspace_path")).grid(row=0, column=0, sticky="w")
        self.workspace_label = ttk.Label(ribbon, textvariable=self.workspace_var, anchor="w")
        self.workspace_label.grid(row=0, column=1, sticky="ew", padx=(8, 8))
        ttk.Button(ribbon, text=self.t("choose"), command=self._choose_workspace).grid(row=0, column=2, padx=(0, 6))
        ttk.Button(ribbon, text=self.t("refresh"), command=self._refresh_file_tree).grid(row=0, column=3, padx=(0, 14))
        ttk.Checkbutton(ribbon, text=self.t("local"), variable=self.local_var, command=self._toggle_local).grid(row=0, column=4, sticky="e")

        self.workbench = ttk.Panedwindow(page, orient="horizontal")
        self.workbench.grid(row=1, column=0, sticky="nsew")
        files = ttk.Labelframe(self.workbench, text=self.t("files"), padding=6)
        center = ttk.Frame(self.workbench, padding=(8, 0))
        right = ttk.Frame(self.workbench, padding=(8, 0, 0, 0))
        self.workbench.add(files, weight=1)
        self.workbench.add(center, weight=3)
        self.workbench.add(right, weight=1)
        self._build_file_panel(files)
        self._build_task_panel(center)
        self._build_context_panel(right)

    def _set_initial_workbench_sashes(self) -> None:
        """Use the workbench proportions once; later user drags remain authoritative."""
        if self._initial_sashes_applied:
            return
        width = self.workbench.winfo_width()
        if width < 900:
            self.root.after(60, self._set_initial_workbench_sashes)
            return
        left, right_start = initial_workbench_sashes(width)
        self.workbench.sashpos(0, left)
        self.workbench.sashpos(1, right_start)
        self._initial_sashes_applied = True

    def _build_file_panel(self, panel: ttk.Labelframe) -> None:
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(0, weight=1)
        self.file_tree = ttk.Treeview(panel, show="tree", selectmode="browse")
        tree_scroll = ttk.Scrollbar(panel, orient="vertical", command=self.file_tree.yview)
        self.file_tree.configure(yscrollcommand=tree_scroll.set)
        self.file_tree.grid(row=0, column=0, sticky="nsew")
        tree_scroll.grid(row=0, column=1, sticky="ns")
        self.file_tree.bind("<<TreeviewOpen>>", self._expand_file_node)
        self._refresh_file_tree()

    def _build_task_panel(self, panel: ttk.Frame) -> None:
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(0, weight=1)
        timeline_frame = ttk.Frame(panel)
        timeline_frame.grid(row=0, column=0, sticky="nsew")
        timeline_frame.columnconfigure(0, weight=1)
        timeline_frame.rowconfigure(0, weight=1)
        self.timeline_text = tk.Text(timeline_frame, wrap="word", state="disabled", padx=12, pady=10, font=("TkDefaultFont", 12), cursor="arrow")
        scroll = ttk.Scrollbar(timeline_frame, orient="vertical", command=self.timeline_text.yview)
        self.timeline_text.configure(yscrollcommand=scroll.set)
        self.timeline_text.grid(row=0, column=0, sticky="nsew")
        scroll.grid(row=0, column=1, sticky="ns")
        self._configure_markdown_tags(self.timeline_text)

        composer = ttk.Frame(panel)
        composer.grid(row=1, column=0, sticky="ew", pady=(8, 0))
        composer.columnconfigure(0, weight=1)
        ttk.Label(composer, text=self.t("task")).grid(row=0, column=0, sticky="w")
        self.task_entry = tk.Text(composer, height=4, wrap="word", font=("TkDefaultFont", 12))
        self.task_entry.grid(row=1, column=0, sticky="ew", pady=(4, 6))
        controls = ttk.Frame(composer)
        controls.grid(row=2, column=0, sticky="ew")
        self.task_controls = controls
        ttk.Label(controls, text=self.t("model")).grid(row=0, column=0, sticky="w")
        ttk.Combobox(controls, textvariable=self.model_var, values=("flash", "pro"), state="readonly", width=8).grid(row=0, column=1, sticky="w", padx=(4, 14))
        ttk.Checkbutton(controls, text=self.t("thinking"), variable=self.thinking_var).grid(row=0, column=2, padx=(0, 14))
        ttk.Label(controls, text=self.t("web")).grid(row=0, column=3)
        ttk.Combobox(controls, textvariable=self.web_var, values=tuple(self._web_label(value) for value in ("auto", "on", "off")), state="readonly", width=7).grid(row=0, column=4, padx=(4, 14))
        self.toa_check = ttk.Checkbutton(controls, text=self.t("toa"), variable=self.toa_var, command=self._toggle_toa)
        self.toa_check.grid(row=0, column=5)
        self.workers_box = ttk.Combobox(controls, textvariable=self.workers_var, values=("1", "2"), state="disabled", width=3)
        self.workers_box.grid(row=0, column=6, padx=(4, 14))
        self.send_button = ttk.Button(controls, text=self.t("send"), command=self._ask)
        self.send_button.grid(row=0, column=7, padx=(14, 0))
        self.learn_button = ttk.Button(controls, text=self.t("learn"), command=self._learn, state="disabled")
        self.learn_button.grid(row=0, column=8, padx=(6, 0))
        controls.bind("<Configure>", self._reflow_task_controls)
        self._render_timeline()

    def _reflow_task_controls(self, _event: tk.Event | None = None) -> None:
        """Wrap only the optional learning button when the task pane becomes narrow."""
        should_wrap = task_controls_wrap_required(self.task_controls.winfo_width())
        if should_wrap == self._task_controls_wrapped:
            return
        self._task_controls_wrapped = should_wrap
        if should_wrap:
            self.learn_button.grid_configure(row=1, column=0, columnspan=9, sticky="e", padx=0, pady=(6, 0))
        else:
            self.learn_button.grid_configure(row=0, column=8, columnspan=1, sticky="", padx=(6, 0), pady=0)

    def _build_context_panel(self, panel: ttk.Frame) -> None:
        panel.columnconfigure(0, weight=1)
        panel.rowconfigure(2, weight=1)
        ttk.Label(panel, textvariable=self.status_var, wraplength=260).grid(row=0, column=0, sticky="ew", pady=(0, 8))
        memory = ttk.Labelframe(panel, text=self.t("related_memory"), padding=6)
        memory.grid(row=1, column=0, sticky="ew", pady=(0, 8))
        self.relevant_value = ttk.Label(memory, text=self.t("no_relevant"), wraplength=250, justify="left")
        self.relevant_value.pack(fill="x")
        activity = ttk.Labelframe(panel, text=self.t("activity"), padding=6)
        activity.grid(row=2, column=0, sticky="nsew", pady=(0, 8))
        activity.columnconfigure(0, weight=1)
        activity.rowconfigure(0, weight=1)
        self.activity_tree = ttk.Treeview(activity, columns=("status", "detail"), show="headings", height=8)
        self.activity_tree.heading("status", text=self.t("activity_status"))
        self.activity_tree.heading("detail", text=self.t("activity_detail"))
        self.activity_tree.column("status", width=72, stretch=False)
        self.activity_tree.column("detail", width=170, stretch=True)
        self.activity_tree.grid(row=0, column=0, sticky="nsew")
        activity_scroll = ttk.Scrollbar(activity, orient="vertical", command=self.activity_tree.yview)
        self.activity_tree.configure(yscrollcommand=activity_scroll.set)
        activity_scroll.grid(row=0, column=1, sticky="ns")
        action = ttk.Labelframe(panel, text=self.t("action"), padding=6)
        action.grid(row=3, column=0, sticky="ew")
        action.columnconfigure(0, weight=1)
        self.action_summary = ttk.Label(action, text=self.t("action_none"), wraplength=250, justify="left")
        self.action_summary.grid(row=0, column=0, sticky="ew")
        self.action_paths = ttk.Label(action, text="", wraplength=250, justify="left")
        self.action_paths.grid(row=1, column=0, sticky="ew", pady=(4, 0))
        self.action_preview = tk.Text(action, height=7, wrap="none", font=("TkFixedFont", 10), state="disabled")
        self.action_preview.grid(row=2, column=0, sticky="ew", pady=(6, 0))
        buttons = ttk.Frame(action)
        buttons.grid(row=3, column=0, sticky="e", pady=(6, 0))
        self.deny_action_button = ttk.Button(buttons, text=self.t("deny"), command=lambda: self._resolve_local_action(False), state="disabled")
        self.deny_action_button.pack(side="right")
        self.apply_action_button = ttk.Button(buttons, text=self.t("apply"), command=lambda: self._resolve_local_action(True), state="disabled")
        self.apply_action_button.pack(side="right", padx=(0, 6))

    def _configure_markdown_tags(self, text: tk.Text) -> None:
        text.tag_configure("task_title", font=("TkDefaultFont", 12, "bold"), foreground="#286090", justify="right", rmargin=12)
        text.tag_configure("task_prompt", justify="right", rmargin=12, spacing3=8)
        text.tag_configure("answer_title", font=("TkDefaultFont", 11, "bold"))
        text.tag_configure("task_separator", foreground="#9aa0a6", spacing1=14, spacing3=14)
        text.tag_configure("heading", font=("TkDefaultFont", 14, "bold"))
        text.tag_configure("bold", font=("TkDefaultFont", 12, "bold"))
        text.tag_configure("italic", font=("TkDefaultFont", 12, "italic"))
        text.tag_configure("code", font=("TkFixedFont", 11))
        text.tag_configure("code_block", font=("TkFixedFont", 11), background="#eeeeee")
        text.tag_configure("quote", foreground="#666666")
        text.tag_configure("rule", foreground="#888888")
        text.tag_configure("link", foreground="#1a73e8", underline=True)

    def _insert_markdown(self, text: tk.Text, value: str) -> None:
        for line in markdown_lines(value):
            for span in line:
                tags = span.tags
                if span.url:
                    name = f"link_{len(self._link_urls)}"
                    self._link_urls[name] = span.url
                    text.tag_bind(name, "<Button-1>", lambda _event, url=span.url: webbrowser.open(url))
                    text.tag_bind(name, "<Enter>", lambda _event: text.configure(cursor="hand2"))
                    text.tag_bind(name, "<Leave>", lambda _event: text.configure(cursor="arrow"))
                    tags = tags + (name,)
                text.insert("end", span.text, tags)
            text.insert("end", "\n")

    def _insert_task_prompt(self, text: tk.Text, prompt: str) -> None:
        """Embed a right-aligned prompt bubble while leaving Ya's output in the text flow."""
        wraplength = max(260, int(max(text.winfo_width(), 720) * 0.62))
        bubble = tk.Label(
            text,
            text=prompt,
            anchor="e",
            justify="left",
            wraplength=wraplength,
            background="#dbeafe",
            foreground="#174ea6",
            padx=10,
            pady=6,
        )
        self._prompt_bubbles.append(bubble)
        text.insert("end", "\u200b", ("task_prompt",))
        text.window_create("end", window=bubble, align="center")
        text.insert("end", "\n\n", ("task_prompt",))

    def _render_timeline(self) -> None:
        text = self.timeline_text
        text.configure(state="normal")
        for bubble in self._prompt_bubbles:
            if bubble.winfo_exists():
                bubble.destroy()
        self._prompt_bubbles.clear()
        text.delete("1.0", "end")
        self._link_urls.clear()
        if not self.session_tasks:
            text.insert("end", self.t("no_answer"))
        for index, task in enumerate(self.session_tasks, start=1):
            if index > 1:
                text.insert("end", "\n" + "─" * 72 + "\n\n", ("task_separator",))
            text.insert("end", f"{self.t('task')} {index} - {task.status}\n", ("task_title",))
            self._insert_task_prompt(text, task.prompt)
            text.insert("end", self.t("answer") + "\n", ("answer_title",))
            self._insert_markdown(text, task.content or (self.t("status_working") if task.status == "working" else ""))
        text.configure(state="disabled")
        text.see("end")

    def _refresh_file_tree(self) -> None:
        if not hasattr(self, "file_tree"):
            return
        self.file_tree.delete(*self.file_tree.get_children())
        workspace = self.controller.valid_workspace()
        if not workspace:
            self.file_tree.insert("", "end", text=self.t("no_workspace"), open=False)
            return
        root = str(Path(workspace))
        self.file_tree.insert("", "end", iid=root, text=Path(root).name or root, open=True)
        self._populate_file_node(root)

    def _populate_file_node(self, item: str) -> None:
        for child in self.file_tree.get_children(item):
            self.file_tree.delete(child)
        try:
            entries = self.controller.workspace_entries(item)
        except (OSError, ValueError):
            return
        for entry in entries:
            relative, kind = str(entry["path"]), str(entry["type"])
            target = str(Path(self.controller.valid_workspace() or "") / relative)
            label = Path(relative).name + (" (link)" if kind == "symlink" else "")
            self.file_tree.insert(item, "end", iid=target, text=label, values=(kind,))
            if kind == "directory":
                self.file_tree.insert(target, "end", text="")

    def _expand_file_node(self, _event=None) -> None:
        selected = self.file_tree.focus()
        if selected and Path(selected).is_dir():
            self._populate_file_node(selected)

    def _toggle_toa(self) -> None:
        if self.toa_var.get():
            self.local_var.set(False)
        self.workers_box.configure(state="readonly" if self.toa_var.get() else "disabled")

    def _toggle_local(self) -> None:
        if not self.local_var.get():
            self.toa_check.configure(state="normal")
            self._toggle_toa()
            return
        self.toa_var.set(False)
        self.toa_check.configure(state="disabled")
        self.workers_box.configure(state="disabled")
        if not self.controller.valid_workspace() and not self._choose_workspace(required=True):
            self.local_var.set(False)
            self.toa_check.configure(state="normal")

    def _choose_workspace(self, required: bool = False) -> bool:
        initial = self.controller.valid_workspace() or ""
        selected = filedialog.askdirectory(parent=self.root, initialdir=initial, mustexist=True)
        if not selected:
            if required:
                messagebox.showinfo(self.t("workspace"), self.t("workspace_required"), parent=self.root)
            return False
        try:
            self.workspace_var.set(self.controller.set_workspace(selected))
            self._refresh_file_tree()
            return True
        except ValueError as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)
            return False

    def _ask(self) -> None:
        task = self.task_entry.get("1.0", "end").strip()
        if not task or self.running:
            return
        if self.local_var.get() and not self.controller.valid_workspace():
            self.local_var.set(False)
            if not self._choose_workspace(required=True):
                return
            self.local_var.set(True)
        options = GuiTaskOptions(
            task=task,
            web_mode=self._web_mode(),
            toa=self.toa_var.get(),
            toa_workers=int(self.workers_var.get()),
            stream=self.stream_var.get(),
            local=self.local_var.get(),
            workspace=self.workspace_var.get() or None,
        )
        if options.toa and not self._confirm_toa(options):
            return
        if not self.controller.api_key():
            self.notebook.select(self.settings_page)
            messagebox.showerror(self.t("error"), self.t("api_missing"), parent=self.root)
            return
        self.running = True
        self.answer = ""
        self.activities = []
        self.active_task = SessionTask(task)
        self.session_tasks.append(self.active_task)
        self.task_entry.delete("1.0", "end")
        self.send_button.configure(state="disabled")
        self.learn_button.configure(state="disabled")
        self.status_var.set(self.t("status_working"))
        self._refresh_relevant(task)
        self._render_activities()
        self._render_timeline()
        threading.Thread(target=self._run_worker, args=(options,), daemon=True).start()

    def _confirm_toa(self, options: GuiTaskOptions) -> bool:
        detail = f"{self.t('model')}: {self.model_var.get()}\n{self.t('workers')}: {options.toa_workers}\n{self.t('budget')}: {self.controller.config.toa_token_budget}\n{self.t('timeout')}: {self.controller.config.toa_timeout}"
        return messagebox.askokcancel(self.t("preflight"), detail, parent=self.root, default="cancel")

    def _run_worker(self, options: GuiTaskOptions) -> None:
        try:
            result = self.controller.run(
                options,
                on_content=lambda chunk: self.events.put(("chunk", chunk)),
                on_local_action=self._request_local_action,
                on_local_activity=lambda activity: self.events.put(("local_activity", activity)),
            )
            self.events.put(("done", result))
        except Exception as error:
            self.events.put(("error", str(error)))

    def _request_local_action(self, action: LocalAction) -> bool:
        request = LocalActionRequest(action=action, completed=threading.Event())
        self.events.put(("local_action", request))
        request.completed.wait()
        return request.approved

    def _drain_events(self) -> None:
        try:
            while True:
                event, value = self.events.get_nowait()
                if event == "chunk":
                    self.answer += str(value)
                    if self.active_task:
                        self.active_task.content = self.answer
                    self._render_timeline()
                elif event == "local_activity":
                    assert isinstance(value, LocalActivity)
                    self.activities.append(value)
                    self._render_activities()
                    if value.status == "success" and value.operation in {"mkdir", "write", "move"}:
                        self._refresh_file_tree()
                elif event == "local_action":
                    assert isinstance(value, LocalActionRequest)
                    self._show_pending_action(value)
                elif event == "done":
                    result = value
                    self.answer = result.content
                    if self.active_task:
                        self.active_task.content = result.content
                        self.active_task.status = self.t("response_partial") if result.partial else self.t("status_done")
                    self.running = False
                    self.send_button.configure(state="normal")
                    self.learn_button.configure(state="normal")
                    self.status_var.set(self.t("response_partial") if result.partial else self.t("status_done"))
                    self._render_timeline()
                    self._refresh_memory()
                else:
                    self.running = False
                    self.send_button.configure(state="normal")
                    if self.active_task:
                        self.active_task.status = self.t("activity_error")
                        self.active_task.content = str(value)
                    self.status_var.set(self.t("status_ready"))
                    self._render_timeline()
                    messagebox.showerror(self.t("error"), str(value), parent=self.root)
        except queue.Empty:
            pass
        self.root.after(40, self._drain_events)

    def _show_pending_action(self, request: LocalActionRequest) -> None:
        self.pending_action = request
        action = request.action
        self.status_var.set(self.t("status_waiting"))
        self.action_summary.configure(text=action.summary)
        paths = "\n".join(str(path) for path in action.paths)
        self.action_paths.configure(text=f"{self.t('action_paths')}:\n{paths}")
        self.action_preview.configure(state="normal")
        self.action_preview.delete("1.0", "end")
        self.action_preview.insert("1.0", action.diff or action.summary)
        self.action_preview.configure(state="disabled")
        self.apply_action_button.configure(state="normal")
        self.deny_action_button.configure(state="normal")

    def _resolve_local_action(self, approved: bool) -> None:
        request = self.pending_action
        if request is None:
            return
        request.approved = approved
        request.completed.set()
        self.pending_action = None
        self.action_summary.configure(text=self.t("action_none"))
        self.action_paths.configure(text="")
        self.action_preview.configure(state="normal")
        self.action_preview.delete("1.0", "end")
        self.action_preview.configure(state="disabled")
        self.apply_action_button.configure(state="disabled")
        self.deny_action_button.configure(state="disabled")
        if self.running:
            self.status_var.set(self.t("status_working"))

    def _render_activities(self) -> None:
        for item in self.activity_tree.get_children():
            self.activity_tree.delete(item)
        for activity in self.activities:
            operation = self.t(f"activity_{activity.operation}")
            status = self.t(f"activity_{activity.status}")
            detail = ", ".join(activity.paths)
            self.activity_tree.insert("", "end", values=(status, f"{operation}: {detail}"))

    def _refresh_relevant(self, task: str) -> None:
        matches = self.controller.relevant_cards(task)
        text = "\n".join(f"{match.card.id} ({match.score}) {match.card.text}" for match in matches)
        self.relevant_value.configure(text=text or self.t("no_relevant"))

    def _build_memory(self) -> None:
        page = self.memory_page
        page.columnconfigure(0, weight=1)
        page.rowconfigure(1, weight=1)
        top = ttk.Frame(page)
        top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Button(top, text=self.t("refresh"), command=self._refresh_memory).pack(side="left")
        ttk.Checkbutton(top, text=self.t("include_candidates"), variable=self.include_candidates_var).pack(side="left", padx=10)
        ttk.Button(top, text=self.t("prune"), command=self._prune).pack(side="right")
        columns = ("id", "status", "kind", "text")
        self.memory_tree = ttk.Treeview(page, columns=columns, show="headings", selectmode="browse")
        for column, width in (("id", 92), ("status", 95), ("kind", 100), ("text", 520)):
            self.memory_tree.heading(column, text=self.t(column))
            self.memory_tree.column(column, width=width, anchor="w")
        self.memory_tree.grid(row=1, column=0, sticky="nsew")
        bottom = ttk.Frame(page)
        bottom.grid(row=2, column=0, sticky="ew", pady=(8, 0))
        for key, action in (("approve", "approved"), ("reject", "rejected"), ("revoke", "revoked")):
            ttk.Button(bottom, text=self.t(key), command=lambda status=action: self._set_memory_status(status)).pack(side="left", padx=(0, 6))
        self._refresh_memory()

    def _refresh_memory(self) -> None:
        if not hasattr(self, "memory_tree"):
            return
        for item in self.memory_tree.get_children():
            self.memory_tree.delete(item)
        for card in self.controller.cards():
            self.memory_tree.insert("", "end", iid=card.id, values=(card.id, self.t(f"{card.status}_status"), self.t(f"{card.kind}_kind"), card.text))

    def _set_memory_status(self, status: str) -> None:
        selected = self.memory_tree.selection()
        if not selected:
            return
        try:
            self.controller.set_memory_status(selected[0], status)
            self._refresh_memory()
        except ValueError as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _prune(self) -> None:
        preview = self.controller.prune_preview(self.include_candidates_var.get())
        if not preview:
            messagebox.showinfo(self.t("memory"), self.t("nothing_prune"), parent=self.root)
            return
        details = "\n".join(f"{card.id}  {card.status}  {card.text}" for card in preview)
        if messagebox.askyesno(self.t("prune"), self.t("confirm_prune").format(count=len(preview)) + "\n\n" + details, parent=self.root):
            removed = self.controller.prune(self.include_candidates_var.get())
            self._refresh_memory()
            messagebox.showinfo(self.t("memory"), self.t("pruned").format(count=len(removed)), parent=self.root)

    def _learn(self) -> None:
        text = simpledialog.askstring(self.t("candidate"), self.t("candidate_prompt"), initialvalue=self.answer[:500], parent=self.root)
        if not text:
            return
        kind = simpledialog.askstring(self.t("candidate"), self.t("kind_prompt") + " [preference/procedure/knowledge]", initialvalue="procedure", parent=self.root)
        if not kind:
            return
        try:
            card = self.controller.create_memory(text, self.t("source"), kind)
            self._refresh_memory()
            messagebox.showinfo(self.t("memory"), self.t("created").format(id=card.id), parent=self.root)
        except (ValueError, DuplicateMemoryError, MemoryLimitError) as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _build_settings(self) -> None:
        page = self.settings_page
        page.columnconfigure(0, weight=1)
        row = 0
        fields = [
            ("language", lambda parent: ttk.Combobox(parent, textvariable=self.language_var, values=tuple(self._language_label(code) for code in ("en", "zh-CN")), state="readonly", width=16)),
            ("model", lambda parent: ttk.Combobox(parent, textvariable=self.model_var, values=("flash", "pro"), state="readonly", width=16)),
            ("thinking", lambda parent: ttk.Checkbutton(parent, variable=self.thinking_var)),
            ("stream", lambda parent: ttk.Checkbutton(parent, variable=self.stream_var)),
            ("reasoning", lambda parent: ttk.Combobox(parent, textvariable=self.reasoning_var, values=("high", "max"), state="readonly", width=16)),
            ("budget", lambda parent: ttk.Entry(parent, textvariable=self.budget_var, width=18)),
            ("timeout", lambda parent: ttk.Entry(parent, textvariable=self.timeout_var, width=18)),
        ]
        for key, create_widget in fields:
            field = ttk.Frame(page)
            field.grid(row=row, column=0, sticky="w", pady=5)
            ttk.Label(field, text=self.t(key)).pack(side="left")
            create_widget(field).pack(side="left", padx=(12, 0))
            row += 1
        ttk.Separator(page).grid(row=row, column=0, sticky="ew", pady=12)
        row += 1
        api_key = ttk.Frame(page)
        api_key.grid(row=row, column=0, sticky="w", pady=5)
        ttk.Label(api_key, text=self.t("api_key")).pack(side="left")
        ttk.Entry(api_key, textvariable=self.key_var, show="*", width=38).pack(side="left", padx=(12, 0))
        row += 1
        ttk.Label(page, text=self.t("key_help_macos") if sys.platform == "darwin" else self.t("key_help_other"), wraplength=500).grid(row=row, column=0, sticky="w")
        row += 1
        buttons = ttk.Frame(page)
        buttons.grid(row=row, column=0, sticky="w", pady=(12, 0))
        ttk.Button(buttons, text=self.t("save_settings"), command=self._save_settings).pack(side="left")
        ttk.Button(buttons, text=self.t("save_key") if sys.platform == "darwin" else self.t("session_key"), command=self._save_key).pack(side="left", padx=8)
        ttk.Button(buttons, text=self.t("clear_audit"), command=self._clear_audit).pack(side="left")

    def _save_settings(self) -> None:
        try:
            config = ModelConfig(
                model=VALID_MODELS[self.model_var.get()], thinking_enabled=self.thinking_var.get(),
                reasoning_effort=self.reasoning_var.get(), toa_token_budget=int(self.budget_var.get()), toa_timeout=int(self.timeout_var.get()),
            )
            self.controller.save_config(config)
            self.controller.set_stream(self.stream_var.get())
            language = self._language_code()
            changed = language != self.controller.language
            self.controller.set_language(language)
            if changed:
                self._rebuild_for_language()
            else:
                messagebox.showinfo(self.t("settings"), self.t("saved"), parent=self.root)
        except (ValueError, KeyError) as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _save_key(self) -> None:
        try:
            if sys.platform == "darwin":
                self.controller.save_macos_api_key(self.key_var.get())
            else:
                self.controller.set_session_api_key(self.key_var.get())
            self.key_var.set("")
            messagebox.showinfo(self.t("settings"), self.t("saved"), parent=self.root)
        except ValueError as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _show_about(self) -> None:
        messagebox.showinfo(self.t("about"), self.t("about_text").format(version=__version__), parent=self.root)

    def _clear_audit(self) -> None:
        logs = self.controller.audit_logs()
        if not logs:
            messagebox.showinfo(self.t("settings"), self.t("nothing_audit"), parent=self.root)
            return
        size = self.controller.audit_log_total_bytes()
        details = "\n".join(f"{path.name} ({path.stat().st_size} bytes)" for path in logs)
        prompt = self.t("confirm_clear_audit").format(count=len(logs), size=size)
        if not messagebox.askyesno(self.t("clear_audit"), f"{prompt}\n\n{details}", parent=self.root):
            return
        removed = self.controller.clear_audit_logs()
        messagebox.showinfo(self.t("settings"), self.t("audit_cleared").format(count=len(removed)), parent=self.root)

    def _rebuild_for_language(self) -> None:
        task = self.task_entry.get("1.0", "end").strip()
        self.notebook.destroy()
        self._set_vars()
        self._build()
        self.task_entry.insert("1.0", task)
        self._render_timeline()
        self._render_activities()

    def _on_close(self) -> None:
        self._resolve_local_action(False)
        self.root.destroy()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ya-gui", description="Ya native desktop application")
    parser.add_argument("--smoke-test", action="store_true", help="Validate imports and local configuration without opening a window")
    args = parser.parse_args(argv)
    if args.smoke_test:
        GuiController()
        return 0
    root = tk.Tk()
    YaApp(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
