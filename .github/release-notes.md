# Ya TypeScript rewrite

Ya has been rebuilt in strict TypeScript on Node.js. The command-line client and
the new Electron desktop application share one typed service layer for DeepSeek
requests, orchestration, memory, web research, and constrained local-workspace
tools.

## What changed

- Replaced the Python package and Tk GUI with a strict TypeScript codebase and an
  Electron desktop application.
- Preserved the existing CLI workflows for questions, bounded Tree of Agents
  (ToA), local workspace access, memory review, configuration, authentication,
  and audit-log management.
- Added typed DeepSeek JSON/SSE handling, bounded retry behavior, tool-call
  limits, and dependency-injected network adapters.
- Kept SEA candidate-memory approval, deterministic relevance ranking, and the
  single bounded ICM evidence follow-up.
- Added a bilingual English/简体中文 workspace-first desktop UI with task history,
  relevant memory, local activity metadata, inline file-change approval, memory
  review, model settings, and audit management.

## Security and compatibility

- Existing `~/.ya/config.json`, `memory.json`, `gui.json`, and audit JSONL files
  remain compatible with the earlier Python implementation.
- Local tools remain confined to one physically resolved workspace. Symlink
  escapes, sensitive-file reads, binary or invalid UTF-8 input, files over
  1 MiB, shell execution, and deletion are blocked.
- Every directory creation, text write, and move still requires explicit user
  approval. Replacement previews use a bounded unified diff, while audit logs
  contain metadata only and rotate at 1 MiB with three archives.
- The Electron renderer runs sandboxed with context isolation and no Node.js
  integration. Its narrow preload bridge reaches only validated IPC handlers;
  IPC and navigation are restricted to the packaged renderer document.
- Desktop DeepSeek and web-search traffic use Electron's Chromium network stack
  so operating-system proxy and trust settings are honored. The CLI uses Node's
  verified TLS stack.
- macOS can store the DeepSeek key in Keychain. Linux and Windows use
  `DEEPSEEK_API_KEY` or a session-only desktop key; plaintext key persistence was
  not added.

## Development and distribution

- Source development now requires Node.js 22 or newer and npm. Python is no
  longer required, and the old Python package entry points have been removed.
- CI type-checks, tests, and builds on Node.js 22/24 across Linux, macOS, and
  Windows. A renderer smoke test loads IPC, preload, and the browser UI and
  verifies page navigation.
- Releases include standalone CLI executables, macOS Electron ZIPs, a Windows
  portable executable, a Linux AppImage, an npm tarball, and SHA-256 checksums.
- macOS and Windows applications remain unsigned; verify the published checksum
  before overriding an operating-system warning.

---

# Ya TypeScript 重构

Ya 已使用 Node.js 上的严格 TypeScript 完成重构。命令行与新的 Electron 桌面端共享同一套带类型的
服务层，包括 DeepSeek 请求、任务编排、记忆、网页研究和受限本地工作区工具。

## 主要变化

- 以严格 TypeScript 代码库和 Electron 桌面应用替换 Python 包与 Tk GUI。
- 保留问答、受限 Tree of Agents（ToA）、本地工作区、记忆审查、配置、认证和审计管理等 CLI 流程。
- 新增带类型的 DeepSeek JSON/SSE 处理、受限重试、工具调用轮数限制，以及可注入的网络适配层。
- 保留 SEA 候选记忆审批、确定性相关度排序，以及最多一次的受限 ICM 证据补充。
- 新增 English/简体中文双语的工作区优先桌面界面，包含任务历史、相关记忆、本地活动元数据、行内文件
  变更审批、记忆审查、模型设置和审计管理。

## 安全与兼容

- 现有 `~/.ya/config.json`、`memory.json`、`gui.json` 和审计 JSONL 文件继续兼容旧 Python 实现。
- 本地工具仍被限制在一个经过物理路径解析的工作区内；符号链接逃逸、敏感文件读取、二进制或非法
  UTF-8、超过 1 MiB 的文件、shell 执行和删除均会被阻止。
- 创建目录、写入文本和移动路径仍需逐项获得用户批准。替换预览使用有上限的统一 diff；审计只记录
  元数据，并在 1 MiB 时轮转、保留三份归档。
- Electron renderer 启用沙箱和上下文隔离，并关闭 Node.js 集成。窄化的 preload 桥只能访问经过校验的
  IPC；IPC 来源与页面导航均限制为应用包内唯一的 renderer 文档。
- 桌面端的 DeepSeek 与网页搜索均使用 Electron Chromium 网络栈，从而遵循操作系统的代理和信任设置；
  CLI 使用 Node 的证书校验网络栈。
- macOS 可将 DeepSeek 密钥保存到钥匙串；Linux 与 Windows 使用 `DEEPSEEK_API_KEY` 或仅本次桌面会话
  有效的密钥，没有新增明文持久化。

## 开发与发行

- 源码开发现要求 Node.js 22 或更高版本及 npm；不再需要 Python，旧 Python 包入口已移除。
- CI 在 Linux、macOS、Windows 上使用 Node.js 22/24 执行类型检查、测试和构建。renderer 烟测会真正
  加载 IPC、preload 与浏览器界面，并验证页面导航。
- Release 包含独立 CLI、macOS Electron ZIP、Windows 便携程序、Linux AppImage、npm 压缩包和
  SHA-256 校验文件。
- macOS 与 Windows 应用目前仍未签名；绕过操作系统警告前请核对已发布的校验值。
