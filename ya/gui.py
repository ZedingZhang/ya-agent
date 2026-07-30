"""Native, dependency-free Ya desktop application."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
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
from .local import LocalAction
from .memory import DuplicateMemoryError, MemoryLimitError


TEXT = {
    "en": {
        "title": "Ya", "ask": "Ask", "memory": "Memory", "settings": "Settings",
        "task": "Task", "send": "Ask Ya", "stop": "Working...", "answer": "Answer",
        "model": "Model", "thinking": "Thinking", "web": "Web", "toa": "Tree of Agents",
        "stream": "Stream simple answers", "auto": "Auto", "on": "On", "off": "Off",
        "local": "Local workspace", "workspace": "Workspace", "choose": "Choose...",
        "status_ready": "Ready", "status_working": "Ya is working...", "status_waiting": "Waiting for file-change confirmation...", "status_done": "Done",
        "no_answer": "Ask a question to begin.", "learn": "Learn from this answer",
        "memory_empty": "No local memory cards.", "refresh": "Refresh", "approve": "Approve",
        "reject": "Reject", "revoke": "Revoke", "prune": "Prune", "include_candidates": "Include candidates",
        "relevant": "Relevant to current task", "no_relevant": "No approved memory meets the relevance threshold.",
        "language": "Language", "api_key": "DeepSeek API key", "save_key": "Save key", "save_settings": "Save settings",
        "session_key": "Use for this session", "key_help_macos": "macOS saves the key in Keychain.",
        "key_help_other": "Windows and Linux use DEEPSEEK_API_KEY, or a session-only key below.",
        "reasoning": "Reasoning effort", "budget": "ToA token budget", "timeout": "ToA timeout (seconds)",
        "preflight": "ToA preflight", "start_toa": "Start ToA", "cancel": "Cancel", "workers": "Workers",
        "candidate": "Create memory candidate", "candidate_prompt": "What should Ya learn?", "kind_prompt": "Memory kind", "created": "Created candidate {id}.",
        "confirm_prune": "Delete {count} selected memory card(s)?", "nothing_prune": "No matching memory cards to delete.",
        "pruned": "Deleted {count} memory card(s).", "saved": "Saved.", "error": "Ya error",
        "api_missing": "No DeepSeek API key found. Add one in Settings.", "source": "Explicit user feedback after Ya task",
        "workspace_required": "Choose an existing folder before enabling local workspace mode.",
        "local_action": "Confirm local file action", "action_paths": "Absolute path", "apply": "Approve", "deny": "Deny",
        "language_en": "English", "language_zh": "简体中文", "response_partial": "Some ToA worker results were unavailable.",
        "help": "Help", "about": "About Ya", "about_text": "Ya\n\nVersion {version}",
        "clear_audit": "Clear audit history", "confirm_clear_audit": "Permanently delete {count} audit log file(s) ({size} bytes)?",
        "nothing_audit": "No audit logs to delete.", "audit_cleared": "Deleted {count} audit log file(s).",
        "id": "ID", "status": "Status", "kind": "Kind", "text": "Text", "candidate_status": "Candidate",
        "approved_status": "Approved", "rejected_status": "Rejected", "revoked_status": "Revoked",
        "preference_kind": "Preference", "procedure_kind": "Procedure", "knowledge_kind": "Knowledge",
    },
    "zh-CN": {
        "title": "Ya", "ask": "问答", "memory": "记忆", "settings": "设置",
        "task": "任务", "send": "询问 Ya", "stop": "处理中...", "answer": "回答",
        "model": "模型", "thinking": "思考", "web": "网页", "toa": "Tree of Agents", "stream": "简单回答使用流式输出",
        "auto": "自动", "on": "开启", "off": "关闭", "local": "本地工作区", "workspace": "工作区", "choose": "选择...",
        "status_ready": "就绪", "status_working": "Ya 正在处理...", "status_waiting": "正在等待文件变更确认...", "status_done": "完成",
        "no_answer": "输入问题后开始。", "learn": "从此回答中学习", "memory_empty": "没有本地记忆卡片。",
        "refresh": "刷新", "approve": "批准", "reject": "拒绝", "revoke": "撤销", "prune": "清理", "include_candidates": "包含候选卡片",
        "relevant": "与当前任务相关", "no_relevant": "没有已批准记忆达到相关度阈值。", "language": "语言",
        "api_key": "DeepSeek API 密钥", "save_key": "保存密钥", "save_settings": "保存设置", "session_key": "仅在本次运行使用",
        "key_help_macos": "macOS 会将密钥保存到钥匙串。", "key_help_other": "Windows 和 Linux 使用 DEEPSEEK_API_KEY，或在下方仅本次运行输入。",
        "reasoning": "推理强度", "budget": "ToA Token 预算", "timeout": "ToA 超时（秒）", "preflight": "ToA 预检", "start_toa": "开始 ToA", "cancel": "取消", "workers": "工作 Agent",
        "candidate": "创建记忆候选", "candidate_prompt": "希望 Ya 学到什么？", "kind_prompt": "记忆类别", "created": "已创建候选卡片 {id}。",
        "confirm_prune": "删除选中的 {count} 张记忆卡片？", "nothing_prune": "没有可清理的匹配记忆卡片。", "pruned": "已删除 {count} 张记忆卡片。",
        "saved": "已保存。", "error": "Ya 错误", "api_missing": "未找到 DeepSeek API 密钥。请在设置中添加。", "source": "Ya 任务后的显式用户反馈",
        "workspace_required": "启用本地工作区模式前，请选择一个存在的文件夹。",
        "local_action": "确认本地文件操作", "action_paths": "绝对路径", "apply": "批准", "deny": "拒绝",
        "language_en": "English", "language_zh": "简体中文", "response_partial": "部分 ToA 工作 Agent 未返回结果。",
        "help": "帮助", "about": "关于 Ya", "about_text": "Ya\n\n版本 {version}",
        "clear_audit": "清除操作审计", "confirm_clear_audit": "永久删除 {count} 个操作审计日志文件（{size} 字节）？",
        "nothing_audit": "没有可删除的操作审计日志。", "audit_cleared": "已删除 {count} 个操作审计日志文件。",
        "id": "ID", "status": "状态", "kind": "类别", "text": "内容", "candidate_status": "候选",
        "approved_status": "已批准", "rejected_status": "已拒绝", "revoked_status": "已撤销",
        "preference_kind": "偏好", "procedure_kind": "流程", "knowledge_kind": "知识",
    },
}


@dataclass
class LocalActionRequest:
    action: LocalAction
    completed: threading.Event
    approved: bool = False


class YaApp(ttk.Frame):
    def __init__(self, root: tk.Tk, controller: GuiController | None = None) -> None:
        super().__init__(root, padding=12)
        self.root = root
        self.controller = controller or GuiController()
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.running = False
        self.answer = ""
        self._link_urls: dict[str, str] = {}
        self._set_vars()
        self._build()
        self.pack(fill="both", expand=True)
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
        self.task_var = tk.StringVar()
        self.model_var = tk.StringVar(value="flash" if config.model == VALID_MODELS["flash"] else "pro")
        self.thinking_var = tk.BooleanVar(value=config.thinking_enabled)
        self.web_var = tk.StringVar(value=self._web_label("auto"))
        self.toa_var = tk.BooleanVar(value=False)
        self.stream_var = tk.BooleanVar(value=True)
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
        self.root.minsize(840, 620)
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        self._build_menu()
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True)
        self.ask_page = ttk.Frame(self.notebook, padding=12)
        self.memory_page = ttk.Frame(self.notebook, padding=12)
        self.settings_page = ttk.Frame(self.notebook, padding=12)
        self.notebook.add(self.ask_page, text=self.t("ask"))
        self.notebook.add(self.memory_page, text=self.t("memory"))
        self.notebook.add(self.settings_page, text=self.t("settings"))
        self._build_ask()
        self._build_memory()
        self._build_settings()

    def _build_menu(self) -> None:
        menu = tk.Menu(self.root)
        help_menu = tk.Menu(menu, tearoff=False)
        help_menu.add_command(label=self.t("about"), command=self._show_about)
        menu.add_cascade(label=self.t("help"), menu=help_menu)
        self.root.configure(menu=menu)

    def _build_ask(self) -> None:
        page = self.ask_page
        page.columnconfigure(0, weight=1)
        page.rowconfigure(3, weight=1)
        ttk.Label(page, text=self.t("task")).grid(row=0, column=0, sticky="w")
        self.task_entry = tk.Text(page, height=4, wrap="word", font=("TkDefaultFont", 12))
        self.task_entry.grid(row=1, column=0, sticky="nsew", pady=(4, 8))
        controls = ttk.Frame(page)
        controls.grid(row=2, column=0, sticky="ew", pady=(0, 8))
        for col in range(8): controls.columnconfigure(col, weight=0)
        controls.columnconfigure(1, weight=1)
        ttk.Label(controls, text=self.t("model")).grid(row=0, column=0, sticky="w")
        ttk.Combobox(controls, textvariable=self.model_var, values=("flash", "pro"), state="readonly", width=8).grid(row=0, column=1, sticky="w", padx=(4, 12))
        ttk.Checkbutton(controls, text=self.t("thinking"), variable=self.thinking_var).grid(row=0, column=2, padx=(0, 12))
        ttk.Label(controls, text=self.t("web")).grid(row=0, column=3)
        ttk.Combobox(controls, textvariable=self.web_var, values=tuple(self._web_label(value) for value in ("auto", "on", "off")), state="readonly", width=7).grid(row=0, column=4, padx=(4, 12))
        self.toa_check = ttk.Checkbutton(controls, text=self.t("toa"), variable=self.toa_var, command=self._toggle_toa)
        self.toa_check.grid(row=0, column=5)
        self.workers_box = ttk.Combobox(controls, textvariable=self.workers_var, values=("1", "2"), state="readonly", width=3)
        self.workers_box.grid(row=0, column=6, padx=4)
        ttk.Checkbutton(controls, text=self.t("local"), variable=self.local_var, command=self._toggle_local).grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.workspace_entry = ttk.Entry(controls, textvariable=self.workspace_var, state="readonly")
        self.workspace_entry.grid(row=1, column=1, columnspan=4, sticky="ew", padx=(4, 8), pady=(6, 0))
        ttk.Button(controls, text=self.t("choose"), command=self._choose_workspace).grid(row=1, column=5, sticky="w", pady=(6, 0))
        ttk.Checkbutton(controls, text=self.t("stream"), variable=self.stream_var).grid(row=2, column=0, columnspan=4, sticky="w", pady=(6, 0))
        self.send_button = ttk.Button(controls, text=self.t("send"), command=self._ask)
        self.send_button.grid(row=2, column=5, columnspan=2, sticky="e", pady=(6, 0))
        answer_frame = ttk.LabelFrame(page, text=self.t("answer"), padding=6)
        answer_frame.grid(row=3, column=0, sticky="nsew")
        answer_frame.columnconfigure(0, weight=1); answer_frame.rowconfigure(0, weight=1)
        self.answer_text = tk.Text(answer_frame, wrap="word", state="disabled", padx=10, pady=8, font=("TkDefaultFont", 12), cursor="arrow")
        scroll = ttk.Scrollbar(answer_frame, command=self.answer_text.yview)
        self.answer_text.configure(yscrollcommand=scroll.set)
        self.answer_text.grid(row=0, column=0, sticky="nsew"); scroll.grid(row=0, column=1, sticky="ns")
        self._configure_text_tags()
        footer = ttk.Frame(page)
        footer.grid(row=4, column=0, sticky="ew", pady=(8, 0))
        ttk.Label(footer, textvariable=self.status_var).pack(side="left")
        self.learn_button = ttk.Button(footer, text=self.t("learn"), command=self._learn, state="disabled")
        self.learn_button.pack(side="right")
        self._toggle_toa()
        self._render_answer(self.t("no_answer"))

    def _configure_text_tags(self) -> None:
        text = self.answer_text
        text.tag_configure("heading", font=("TkDefaultFont", 14, "bold"), foreground="#0f4c5c", spacing1=10, spacing3=3)
        text.tag_configure("bold", font=("TkDefaultFont", 12, "bold"))
        text.tag_configure("italic", font=("TkDefaultFont", 12, "italic"))
        text.tag_configure("code", font=("TkFixedFont", 11), background="#edf1f2")
        text.tag_configure("code_block", font=("TkFixedFont", 11), background="#edf1f2", lmargin1=12, lmargin2=12)
        text.tag_configure("quote", foreground="#55616a")
        text.tag_configure("rule", foreground="#9aa5ab")
        text.tag_configure("link", foreground="#1261a0", underline=True)

    def _build_memory(self) -> None:
        page = self.memory_page
        page.columnconfigure(0, weight=1); page.rowconfigure(1, weight=1)
        top = ttk.Frame(page); top.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Button(top, text=self.t("refresh"), command=self._refresh_memory).pack(side="left")
        ttk.Checkbutton(top, text=self.t("include_candidates"), variable=self.include_candidates_var).pack(side="left", padx=10)
        ttk.Button(top, text=self.t("prune"), command=self._prune).pack(side="right")
        columns = ("id", "status", "kind", "text")
        self.memory_tree = ttk.Treeview(page, columns=columns, show="headings", selectmode="browse")
        for column, width in (("id", 92), ("status", 95), ("kind", 100), ("text", 520)):
            self.memory_tree.heading(column, text=self.t(column)); self.memory_tree.column(column, width=width, anchor="w")
        self.memory_tree.grid(row=1, column=0, sticky="nsew")
        bottom = ttk.Frame(page); bottom.grid(row=2, column=0, sticky="ew", pady=(8, 0))
        for key, action in (("approve", "approved"), ("reject", "rejected"), ("revoke", "revoked")):
            ttk.Button(bottom, text=self.t(key), command=lambda status=action: self._set_memory_status(status)).pack(side="left", padx=(0, 6))
        self.relevant_label = ttk.Label(bottom, text=self.t("relevant")); self.relevant_label.pack(side="left", padx=(18, 6))
        self.relevant_value = ttk.Label(bottom, text="")
        self.relevant_value.pack(side="left", fill="x", expand=True)
        self._refresh_memory()

    def _build_settings(self) -> None:
        page = self.settings_page
        page.columnconfigure(0, weight=1)
        row = 0
        fields = [
            ("language", lambda parent: ttk.Combobox(parent, textvariable=self.language_var, values=tuple(self._language_label(code) for code in ("en", "zh-CN")), state="readonly", width=16)),
            ("model", lambda parent: ttk.Combobox(parent, textvariable=self.model_var, values=("flash", "pro"), state="readonly", width=16)),
            ("thinking", lambda parent: ttk.Checkbutton(parent, variable=self.thinking_var)),
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
        ttk.Separator(page).grid(row=row, column=0, sticky="ew", pady=12); row += 1
        api_key = ttk.Frame(page)
        api_key.grid(row=row, column=0, sticky="w", pady=5)
        ttk.Label(api_key, text=self.t("api_key")).pack(side="left")
        ttk.Entry(api_key, textvariable=self.key_var, show="•", width=38).pack(side="left", padx=(12, 0)); row += 1
        ttk.Label(page, text=self.t("key_help_macos") if sys.platform == "darwin" else self.t("key_help_other"), wraplength=500).grid(row=row, column=0, sticky="w"); row += 1
        buttons = ttk.Frame(page); buttons.grid(row=row, column=0, sticky="w", pady=(12, 0))
        ttk.Button(buttons, text=self.t("save_settings"), command=self._save_settings).pack(side="left")
        ttk.Button(buttons, text=self.t("save_key") if sys.platform == "darwin" else self.t("session_key"), command=self._save_key).pack(side="left", padx=8)
        ttk.Button(buttons, text=self.t("clear_audit"), command=self._clear_audit).pack(side="left")

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
                messagebox.showinfo(self.t("local"), self.t("workspace_required"), parent=self.root)
            return False
        try:
            self.workspace_var.set(self.controller.set_workspace(selected))
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
        self.running = True; self.answer = ""; self.send_button.configure(state="disabled"); self.learn_button.configure(state="disabled")
        self.status_var.set(self.t("status_working")); self._render_answer("")
        threading.Thread(target=self._run_worker, args=(options,), daemon=True).start()

    def _confirm_toa(self, options: GuiTaskOptions) -> bool:
        detail = f"{self.t('model')}: {self.model_var.get()}\n{self.t('workers')}: {options.toa_workers}\n{self.t('budget')}: {self.controller.config.toa_token_budget}\n{self.t('timeout')}: {self.controller.config.toa_timeout}"
        return messagebox.askokcancel(self.t("preflight"), detail, parent=self.root, default="cancel")

    def _run_worker(self, options: GuiTaskOptions) -> None:
        def on_content(chunk: str) -> None:
            self.events.put(("chunk", chunk))
        try:
            result = self.controller.run(options, on_content=on_content, on_local_action=self._request_local_action)
            self.events.put(("done", result))
        except Exception as error:
            self.events.put(("error", str(error)))

    def _drain_events(self) -> None:
        try:
            while True:
                event, value = self.events.get_nowait()
                if event == "chunk":
                    self.answer += str(value)
                    self._render_answer(self.answer)
                elif event == "done":
                    result = value
                    self.answer = result.content
                    self._render_answer(self.answer)
                    self.running = False; self.send_button.configure(state="normal"); self.learn_button.configure(state="normal")
                    self.status_var.set(self.t("response_partial") if result.partial else self.t("status_done"))
                    self._refresh_memory()
                elif event == "local_action":
                    request = value
                    assert isinstance(request, LocalActionRequest)
                    self.status_var.set(self.t("status_waiting"))
                    request.approved = self._confirm_local_action(request.action)
                    request.completed.set()
                    if self.running:
                        self.status_var.set(self.t("status_working"))
                else:
                    self.running = False; self.send_button.configure(state="normal")
                    self.status_var.set(self.t("status_ready"))
                    messagebox.showerror(self.t("error"), str(value), parent=self.root)
        except queue.Empty:
            pass
        self.root.after(40, self._drain_events)

    def _request_local_action(self, action: LocalAction) -> bool:
        request = LocalActionRequest(action=action, completed=threading.Event())
        self.events.put(("local_action", request))
        request.completed.wait()
        return request.approved

    def _confirm_local_action(self, action: LocalAction) -> bool:
        dialog = tk.Toplevel(self.root)
        dialog.title(self.t("local_action"))
        dialog.transient(self.root)
        dialog.resizable(True, True)
        dialog.minsize(620, 280)
        dialog.columnconfigure(0, weight=1)
        dialog.rowconfigure(2, weight=1)

        ttk.Label(dialog, text=action.summary, wraplength=680).grid(row=0, column=0, sticky="w", padx=14, pady=(14, 6))
        paths = "\n".join(str(path) for path in action.paths)
        ttk.Label(dialog, text=f"{self.t('action_paths')}:\n{paths}", wraplength=680).grid(row=1, column=0, sticky="w", padx=14, pady=(0, 8))
        preview = tk.Text(dialog, height=13, wrap="none", font=("TkFixedFont", 11), state="normal")
        preview.insert("1.0", action.diff or action.summary)
        preview.configure(state="disabled")
        scroll_y = ttk.Scrollbar(dialog, orient="vertical", command=preview.yview)
        scroll_x = ttk.Scrollbar(dialog, orient="horizontal", command=preview.xview)
        preview.configure(yscrollcommand=scroll_y.set, xscrollcommand=scroll_x.set)
        preview.grid(row=2, column=0, sticky="nsew", padx=(14, 0), pady=(0, 12))
        scroll_y.grid(row=2, column=1, sticky="ns", pady=(0, 12))
        scroll_x.grid(row=3, column=0, sticky="ew", padx=(14, 0))

        decision = {"approved": False}

        def close(approved: bool) -> None:
            decision["approved"] = approved
            dialog.grab_release()
            dialog.destroy()

        buttons = ttk.Frame(dialog)
        buttons.grid(row=4, column=0, columnspan=2, sticky="e", padx=14, pady=14)
        ttk.Button(buttons, text=self.t("deny"), command=lambda: close(False)).pack(side="right")
        ttk.Button(buttons, text=self.t("apply"), command=lambda: close(True)).pack(side="right", padx=(0, 8))
        dialog.protocol("WM_DELETE_WINDOW", lambda: close(False))
        dialog.grab_set()
        dialog.wait_window()
        return bool(decision["approved"])

    def _render_answer(self, value: str) -> None:
        text = self.answer_text
        text.configure(state="normal"); text.delete("1.0", "end"); self._link_urls.clear()
        link_index = 0
        for line in markdown_lines(value):
            for span in line:
                tags = span.tags
                if span.url:
                    name = f"link_{link_index}"; link_index += 1; self._link_urls[name] = span.url
                    text.tag_bind(name, "<Button-1>", lambda _event, url=span.url: webbrowser.open(url))
                    text.tag_bind(name, "<Enter>", lambda _event: text.configure(cursor="hand2"))
                    text.tag_bind(name, "<Leave>", lambda _event: text.configure(cursor="arrow"))
                    tags = tags + (name,)
                text.insert("end", span.text, tags)
            text.insert("end", "\n")
        text.configure(state="disabled"); text.see("end")

    def _refresh_memory(self) -> None:
        for item in self.memory_tree.get_children(): self.memory_tree.delete(item)
        cards = self.controller.cards()
        for card in cards:
            self.memory_tree.insert(
                "", "end", iid=card.id,
                values=(card.id, self.t(f"{card.status}_status"), self.t(f"{card.kind}_kind"), card.text),
            )
        task = self.task_entry.get("1.0", "end").strip()
        matches = self.controller.relevant_cards(task) if task else []
        self.relevant_value.configure(text="; ".join(f"{match.card.id} ({match.score})" for match in matches) if matches else self.t("no_relevant"))

    def _set_memory_status(self, status: str) -> None:
        selected = self.memory_tree.selection()
        if not selected: return
        try:
            self.controller.set_memory_status(selected[0], status); self._refresh_memory()
        except ValueError as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _prune(self) -> None:
        preview = self.controller.prune_preview(self.include_candidates_var.get())
        if not preview:
            messagebox.showinfo(self.t("memory"), self.t("nothing_prune"), parent=self.root); return
        details = "\n".join(f"{card.id}  {card.status}  {card.text}" for card in preview)
        if messagebox.askyesno(self.t("prune"), self.t("confirm_prune").format(count=len(preview)) + "\n\n" + details, parent=self.root):
            removed = self.controller.prune(self.include_candidates_var.get()); self._refresh_memory()
            messagebox.showinfo(self.t("memory"), self.t("pruned").format(count=len(removed)), parent=self.root)

    def _learn(self) -> None:
        text = simpledialog.askstring(self.t("candidate"), self.t("candidate_prompt"), initialvalue=self.answer[:500], parent=self.root)
        if not text: return
        kind = simpledialog.askstring(self.t("candidate"), self.t("kind_prompt") + " [preference/procedure/knowledge]", initialvalue="procedure", parent=self.root)
        if not kind: return
        try:
            card = self.controller.create_memory(text, self.t("source"), kind)
            self._refresh_memory(); messagebox.showinfo(self.t("memory"), self.t("created").format(id=card.id), parent=self.root)
        except (ValueError, DuplicateMemoryError, MemoryLimitError) as error:
            messagebox.showerror(self.t("error"), str(error), parent=self.root)

    def _save_settings(self) -> None:
        try:
            config = ModelConfig(
                model=VALID_MODELS[self.model_var.get()], thinking_enabled=self.thinking_var.get(),
                reasoning_effort=self.reasoning_var.get(), toa_token_budget=int(self.budget_var.get()), toa_timeout=int(self.timeout_var.get()),
            )
            self.controller.save_config(config)
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
            if sys.platform == "darwin": self.controller.save_macos_api_key(self.key_var.get())
            else: self.controller.set_session_api_key(self.key_var.get())
            self.key_var.set(""); messagebox.showinfo(self.t("settings"), self.t("saved"), parent=self.root)
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
        task, answer = self.task_entry.get("1.0", "end").strip(), self.answer
        self.notebook.destroy(); self._set_vars(); self._build()
        self.task_entry.insert("1.0", task); self.answer = answer; self._render_answer(answer or self.t("no_answer"))


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
