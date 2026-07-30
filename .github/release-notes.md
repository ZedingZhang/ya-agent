## Balanced ask-page controls

- The Thinking control now occupies the flexible space between Model and Web on
  the Ask page, instead of being grouped against Web.

### 中文说明

- 问答页的“思考”控件现在位于模型与网页之间的弹性区域中，不再贴近网页控件。

## Ask-page model alignment

- The Model selector on the Ask page now stays left-aligned beside its label
  when the workspace control expands across the row below.

### 中文说明

- 问答页的模型选择框现在会始终左对齐在“模型”标签旁，不再因为下方工作区控件扩张而被推远。

## Compact settings layout

- The native GUI settings form now keeps labels and their controls together in
  compact rows, including the Model selector, regardless of window width.

### 中文说明

- 原生 GUI 的设置页现在使用紧凑行布局；包括模型选择在内的标签与控件会保持相邻，不会随窗口宽度拉开。

## Audit log management and GUI metadata

- Local workspace action audit logs now rotate at 1 MiB and retain three
  archives, bounding local storage to about 4 MiB without recording file
  content, diffs, or credentials.
- Run `ya audit clear` to review and permanently clear local audit history;
  non-interactive use requires `--yes`. The GUI offers the same confirmed action
  in Settings.
- GUI language choices now display as `English` and `简体中文`. Help > About Ya
  shows the application version, and macOS app bundles now carry the release
  version in their native About panel.

### 中文说明

- 本地工作区操作审计日志现在会在达到 1 MiB 时自动轮转，并保留三份归档，将本地占用限制在约
  4 MiB；日志不会记录文件内容、diff 或凭据。
- 使用 `ya audit clear` 可查看并永久清除本地审计历史；非交互环境必须传入 `--yes`。GUI 设置页
  提供同样需要确认的清理操作。
- GUI 语言选项现显示为 `English` 和 `简体中文`。帮助菜单中的“关于 Ya”会显示应用版本，macOS
  应用包的系统“About Ya”也会显示实际 Release 版本。

## GUI local workspace agent

- The native GUI now provides the same constrained local workspace mode as the
  CLI. Select a folder on the Ask page; Ya remembers its path locally while
  keeping local mode off at every launch.
- File changes pause for a default-deny GUI confirmation showing absolute paths
  and a scrollable capped diff. The existing sensitive-file protections, action
  audit, no-shell policy, and no-delete policy are unchanged.
- Local workspace tasks can use web research, are buffered, and cannot be
  combined with ToA.

## CLI local workspace agent

- `ya ask --local [--workspace PATH]` now gives the CLI a deliberately limited
  local file workspace. It can list, read, search, create directories, write
  text files, and move or rename paths; it cannot execute commands or delete.
- Every filesystem change requires an interactive confirmation and shows an
  absolute path; replacements show a capped unified diff. Non-interactive
  writes require `--approve` for that task.
- Reads remain bounded to non-sensitive UTF-8 text inside the workspace.
  `.env`, credentials, private keys, binary files, and files larger than 1 MiB
  are blocked from model reads. Change metadata is audited locally without
  content or diffs.
- Local mode can use web research but is incompatible with `--toa` and buffers
  output.

## Native desktop GUI

- Ya now ships with a zero-runtime-dependency native Tk desktop GUI alongside
  the CLI on macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64.
- The app includes streamed simple answers, rendered Markdown, ToA preflight,
  local memory review, approval and pruning, and model configuration.
- The GUI defaults to English. A complete Chinese interface is available in
  Settings and the selection persists locally.
- macOS GUI credentials use the existing Keychain integration. Windows and
  Linux accept `DEEPSEEK_API_KEY` or a session-only key, never plaintext storage.

## macOS TLS compatibility

- The frozen macOS GUI now uses the system certificate bundle when no
  `SSL_CERT_FILE` override is supplied. This keeps the GUI aligned with the CLI
  on networks that install a locally trusted proxy certificate, without
  weakening TLS verification.

## Markdown rendering resilience

- Terminal rendering now recovers when a model leaves a fenced code block
  unclosed before a subsequent Markdown heading, so later headings, lists, and
  emphasis do not appear as raw Markdown.

## Relevant local memory

- Ya now ranks approved memory for each task instead of always injecting the
  oldest three cards.
- Ranking is local and dependency-free: exact phrases and meaningful English
  keywords rank before Chinese character n-gram overlap; ties prefer newer
  cards, and low-scoring cards stay out of the model context.
- `ya ask --show-memory` displays the cards and scores selected for a task.
  It is opt-in because it can print personal memory text.

## Faster, more reliable answers

- Interactive single-agent answers now stream line-by-line with readable
  Markdown terminal rendering.
- `ya ask --web auto|on|off` selects an intelligent default, requires web
  search, or disables web access for a faster direct answer.
- `ya ask --stream auto|off` controls interactive streaming. ToA, web research,
  pipes, and Markdown output remain buffered for reliable tool handling.
- DeepSeek and web-search requests retry transient failures before output is
  shown, without duplicating a partial answer.

## Standalone executables

Ya now ships as standalone executables for macOS Apple Silicon, macOS Intel,
Windows x64, and Linux x64. Download the matching asset and run it directly;
Python, pip, and a PATH change are not required.

The macOS and Windows files are currently unsigned. Verify `checksums.txt`
before overriding a system warning. `ya auth deepseek` remains macOS-only;
Linux and Windows use `DEEPSEEK_API_KEY`.

## Python packages

The universal wheel and source distribution remain available for Python users
and contributors.

## 中文说明

### GUI 本地工作区 Agent

- 原生 GUI 现在提供与 CLI 相同的受限本地工作区模式。在问答页选择文件夹后，Ya 会在本地记住路径，
  但每次启动时本地模式保持关闭。
- 文件变更会暂停并显示默认拒绝的确认窗口，其中包含绝对路径和可滚动的截断 diff。敏感文件保护、操作审计、
  禁止 shell 与禁止删除策略维持不变。
- 本地工作区任务可使用网页检索，会保持缓冲，且不能与 ToA 同时使用。

### CLI 本地工作区 Agent

- `ya ask --local [--workspace PATH]` 现在让 CLI 在一个明确授权的受限本地工作区内操作：可列举、读取、
  搜索、新建目录、写入文本，以及移动或重命名；不能执行命令，也不支持删除。
- 每项文件变更都会显示绝对路径并要求交互确认；覆盖文本会展示截断的统一 diff。非交互写入必须为本次
  任务显式传入 `--approve`。
- 读取严格限定于工作区内的非敏感 UTF-8 文本。`.env`、凭据、私钥、二进制文件和超过 1 MiB 的文件不会
  发送给模型。审计仅记录操作元数据，不记录内容或 diff。
- 本地模式可使用网页检索，但不能与 `--toa` 同时使用，且会缓冲输出。

### 独立可执行文件

Ya 现提供 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 的独立
可执行文件。下载对应附件后即可直接运行，无需安装 Python、pip 或修改 PATH。

macOS 和 Windows 文件当前未签名。在绕过系统提示前，请先校验 `checksums.txt`。
`ya auth deepseek` 仍仅支持 macOS；Linux 和 Windows 请使用 `DEEPSEEK_API_KEY`。

### 原生桌面 GUI

- Ya 现在会与 CLI 一同发行零运行时依赖的原生 Tk 桌面 GUI，覆盖 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64。
- GUI 提供简单任务流式回答、Markdown 渲染、ToA 预检、本地记忆审核/批准/清理和模型设置。
- GUI 默认英文；可在 Settings 中完整切换中文，选择会在本地持久化。
- macOS GUI 使用现有钥匙串集成；Windows 和 Linux 可使用 `DEEPSEEK_API_KEY` 或仅当前会话的密钥，绝不明文保存。

### macOS TLS 兼容性

- 冻结 macOS GUI 在未设置 `SSL_CERT_FILE` 覆盖时会使用系统证书包。对于安装本地受信任代理证书的网络，这使 GUI 与 CLI 使用相同的证书链，且不会降低 TLS 校验强度。

### 更快、更可靠的回答

- 交互式终端中的单 Agent 回答现在会逐行流式输出，并保持易读的 Markdown 渲染。
- `ya ask --web auto|on|off` 分别提供智能默认策略、强制网页检索和关闭网页访问以加快直接回答。
- `ya ask --stream auto|off` 控制交互式流式输出。ToA、网页检索、管道和 Markdown 输出会保持缓冲，
  以保证工具处理可靠。
- DeepSeek 和网页检索在输出前遇到瞬时故障时会重试，且不会重复已经显示的部分回答。

### 相关本地记忆

- Ya 现在会为每个任务排序已批准记忆，不再固定注入最早的三张卡片。
- 排序完全在本地、零依赖完成：精确短语和有意义的英文关键词优先于中文字符 n-gram 重合；
  同分时优先较新的卡片，低分卡片不会进入模型上下文。
- `ya ask --show-memory` 可显示本次任务实际选用的卡片和分数。该选项需要显式传入，因为它可能
  打印个人记忆文本。

### Markdown 渲染恢复能力

- 当模型漏掉围栏代码块的结束标记、随后输出 Markdown 标题时，终端渲染现在会自动恢复，后续的
  标题、列表和强调文本不会再原样显示 Markdown 标记。

### Python 包

仍保留通用 wheel 与源码包，供 Python 用户和贡献者使用。
