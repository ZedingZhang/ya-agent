# Ya

[English](README.md) | [中文](README.zh-CN.md)

Ya（丫丫）是一个专门适配 DeepSeek 的 Coding Agent，同时提供命令行与原生桌面应用。项目内核采用 TypeScript，桌面端采用 Electron，并与 CLI 共享同一套带类型的服务层。

Ya 使用 DeepSeek API（默认 `DeepSeek-V4.1-Flash`，可切换到 `DeepSeek-V4-Pro-0813`），在本地保存长期记忆，并且只有在用户明确确认后才会启动受限的 Tree of Agents（ToA）。命令执行需要为每次任务显式开启，并单独批准。

## 桌面界面

在工作区中浏览本地文件、与 Ya 对话，并查看相关记忆、工具执行记录和待审批的文件操作。

![Ya 桌面工作区：左侧文件列表、中间对话与任务输入区、右侧相关记忆和工具执行记录](assets/ya-gui-workspace-screenshot.png)

## 架构

- **SEA 受控学习**：显式用户反馈先成为候选记忆卡；只有已批准的卡片才会影响后续任务。
- **ICM 好奇心循环**：回答标记出一个重要证据缺口时，Ya 最多执行一次受限的来源探索。
- **受限 ToA**：一个根协调 Agent 最多使用两个临时工作 Agent，并受 Token 与超时预算约束。
- **共享类型核心**：CLI 和桌面端复用配置、记忆、编排、API、网页检索和本地工作区模块。
- **代码验证**：已批准的命令返回退出码与有大小上限的输出，Ya 可以运行测试、类型检查和构建，修复失败原因后再次验证。
- **视觉输入**：CLI 与桌面端都可通过同一条 OpenAI 兼容的 Chat Completions 链路，把经过校验的 JPEG、PNG、GIF 和 WebP 输入发送给原生支持视觉的 `deepseek-flash`。
- **隔离桌面渲染器**：Electron 渲染进程没有 Node.js 或直接文件系统权限；特权操作通过窄化的 preload 桥接进入主进程。

## 平台支持

Release 产物是自包含文件，不要求安装 Node.js。只有源码开发或 npm 安装需要 Node.js 22 或更高版本。

| 操作系统 | CLI | 桌面 GUI | API 密钥存储 |
| --- | --- | --- | --- |
| macOS Apple Silicon / Intel | 独立可执行文件 | 原生 `.app` | macOS 钥匙串或 `DEEPSEEK_API_KEY` |
| Linux x64（glibc） | 独立可执行文件 | AppImage | `DEEPSEEK_API_KEY` 或 GUI 会话密钥 |
| Windows x64 | 独立 `.exe` | 便携 `.exe` | `DEEPSEEK_API_KEY` 或 GUI 会话密钥 |

`ya auth deepseek` 仅支持 macOS，因为它调用系统的 `security` 工具。Linux 和 Windows 请使用 `DEEPSEEK_API_KEY`，或在设置页输入仅本次会话使用的密钥。

## 从源码安装

```sh
git clone https://github.com/ZedingZhang/ya-agent.git
cd ya-agent
npm ci
npm run check
npm link
```

执行 `npm link` 后，当前 Node.js 环境会提供 `ya` 命令。也可以不链接，直接运行：

```sh
npm start -- ask "用通俗语言解释 Graph Engineering"
```

从源码启动桌面端：

```sh
npm run gui
```

## 独立 Release

从[最新 GitHub Release](https://github.com/ZedingZhang/ya-agent/releases/latest)下载对应文件。CLI 与 GUI 分别构建。

### macOS Apple Silicon

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-macos-arm64
chmod +x ya-macos-arm64
./ya-macos-arm64 ask "用通俗语言解释 Graph Engineering"
```

Intel Mac 使用 `ya-macos-x64`。GUI 压缩包名称分别为 `ya-gui-macos-arm64.zip` 和 `ya-gui-macos-x64.zip`。

### Linux x64

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-linux-x64
chmod +x ya-linux-x64
./ya-linux-x64 ask "用通俗语言解释 Graph Engineering"
```

桌面 AppImage 发布为 `ya-gui-linux-x64`，运行前需要添加可执行权限。Linux 产物面向 Ubuntu 22.04 等 x64 glibc 系统，不面向 Alpine Linux 等 musl 系统。

### Windows x64（PowerShell）

```powershell
Invoke-WebRequest https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-windows-x64.exe -OutFile ya-windows-x64.exe
.\ya-windows-x64.exe ask "用通俗语言解释 Graph Engineering"
```

便携桌面端文件名为 `ya-gui-windows-x64.exe`。

### 校验下载

当前发布不包含发布者代码签名或 Apple 公证。macOS 构建可能使用保障运行的临时签名（ad-hoc），该签名不验证发布者身份。macOS Gatekeeper 和 Windows SmartScreen 可能提示或阻止运行，详见[发布签名说明](docs/release-signing.md)。请从同一 Release 下载 `checksums.txt` 并核对 SHA-256：

```sh
shasum -a 256 ya-macos-arm64
# Linux：sha256sum ya-linux-x64
```

```powershell
Get-FileHash .\ya-windows-x64.exe -Algorithm SHA256
```

## CLI 使用

```sh
ya --help
ya ask --help
ya ask "解释递归"
ya ask --web on "比较两种方案的最新证据"
ya ask --thinking on --reasoning-effort max "分析这个决策"
ya ask --model vision --image ./chart.png "解释这张图表"
```

交互终端会渲染 Ya 常用的 Markdown。重定向时保留原始 Markdown，方便脚本或文件处理：

```sh
ya ask --format terminal "生成一个简洁表格"
ya ask --format markdown "生成一个简洁表格" > answer.md
```

简单、无工具的回答在交互终端中默认流式输出。网页研究、ToA、本地工作区任务、管道和 Markdown 输出保持缓冲。使用 `--stream off` 可关闭流式输出。

### 视觉输入

视觉能力原生集成在默认模型 `deepseek-flash` 中，无需切换模型即可使用图片；纯文本的 `deepseek-v4-pro` 会拒绝图片。`--image` 可以重复指定，支持本地文件、HTTP(S) URL、base64 data URL，以及已有的 DeepSeek Files API 文件 ID：

```sh
ya ask --image ./chart.png \
  --image https://example.com/photo.webp \
  --image-detail high \
  "比较这些图片并说明重要差异"

ya ask --image file-api-EXISTING_ID "读取这张已上传的图片"
```

`--image-detail` 可取 `auto`（默认）、`low`、`high` 或 `original`。`low` 会在推理前把图片缩放到 512×512；其他取值目前都会保留原图。本地文件按照真实文件签名而不是扩展名检查，校验通过后才转换为规范的 data URL；支持 JPEG、PNG、GIF 与 WebP。图片内容只能与 `deepseek-flash` 搭配，并且只会放入 user 消息，符合 DeepSeek 的[视觉理解指南](https://api-docs.deepseek.com/guides/vision/)和 [Chat Completions 参数说明](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。

Ya 会执行 DeepSeek 的 600 张图片上限和外部 URL 8,192 字符上限。单个本地图片或 data URL 的二进制内容最多 32 MiB；为给 base64 膨胀和提示词留出空间、确保请求低于 API 的 48 MiB body 上限，Ya 还会把所有内联图片的二进制总量保守限制为 32 MiB。`file-api-*` 必须指向已经通过 DeepSeek Files API 上传的图片；Ya 不负责上传该文件。

在 ToA 模式下，每张图片都会发送给每个工作 Agent，并再次发送给根协调 Agent；工具调用轮次和最多一次的 ICM 补充在触发时也会重发请求上下文。预检会明确展示这一点，因为 DeepSeek 会按每次请求中的图片 Token 计费。

### Tree of Agents

ToA 由一个根协调 Agent 和一到两个临时证据/风险 Agent 组成，启动前总会展示预检：

```sh
ya ask --toa --toa-workers 2 "评估这个战略决策"
```

非交互环境必须为本次调用显式授权：

```sh
ya ask --toa --yes "评估这个战略决策"
```

`--local` 与 `--toa` 不能同时使用。

### 本地工作区工具

本地模式只为单次任务授予一个受限工作区能力：

```sh
ya ask --local --workspace "$PWD" "根据这里的文本文件创建 notes/summary.md"
```

工具可以：

- 列出目录；
- 读取与搜索有大小上限的 UTF-8 文本；
- 每次创建一个目录；
- 创建或替换文本文件；
- 移动或重命名文件与目录。

文件工具不能删除文件。每项变更都会显示绝对路径并等待批准；替换文件时显示最多 200 行的统一 diff。非交互环境默认拒绝文件写入，只有本次调用带 `--approve` 时才允许。

读取始终限制在解析后的工作区中。符号链接逃逸、`.git`、`.env`、凭据、私钥、二进制文件、非法 UTF-8 和超过 1 MiB 的文件都会被阻止。操作审计只记录元数据，不记录文件内容或 diff；日志达到 1 MiB 后轮转，并保留三份归档。

```sh
ya audit clear
ya audit clear --yes  # 非交互环境必须添加
```

### 命令执行与代码验证

使用 `--local --exec` 为编码任务开启 `local_run`。Ya 会读取仓库现有脚本，选择相关测试、类型检查或构建，查看失败输出，修复代码后重新运行检查：

```sh
ya ask --local --exec --workspace "$PWD" "修复这个 bug，并运行相关测试和类型检查"
```

每次审批都会显示完整命令、绝对工作目录和超时时间。桌面端在工作区勾选 **允许命令执行**；命令卡片显示实时 stdout/stderr、完成状态、退出码和耗时。**停止** 会取消待审批操作、API 请求及正在执行的命令进程树；CLI 使用 Ctrl+C。

无人值守任务分别授权文件变更与命令：

```sh
ya ask --local --exec --approve --approve-commands --no-feedback "修复这个 bug 并验证"
```

`--approve-commands` 允许本次非交互调用中的全部命令。`--approve` 和 `--yes` 不会授权命令；交互终端仍逐条询问。

Windows 使用 `cmd.exe /d /s /c`，macOS/Linux 使用 `/bin/sh -c`，沿用已安装的项目工具链，stdin 关闭。检查应执行一次后退出，避免 watch 模式、交互程序和脱离父进程的后台服务。进程树终止使用操作系统的进程控制；若无法确认清理完成，结果会注明错误并限制输出排空时间，避免任务一直挂起。默认超时 120 秒，模型可以请求 1–600 秒的整数。每次工具结果保留 stdout 与 stderr 各自末尾 64 KiB，并标明是否截断。开启命令的任务最多使用 20 轮工具调用完成查看、修复与验证，其他任务保留 6 轮上限。最终回答需要说明实际执行的检查，以及失败、被拒绝或未完成的检查。

只有命令的 **初始工作目录** 被限制在解析后的工作区内。命令以当前用户权限运行，可修改或删除工作区外文件、访问网络，执行环境并非沙箱。Ya 不向子进程传递自身的 `DEEPSEEK_API_KEY`、`YA_HOME` 和应用运行时标志。命令审计记录状态、工作目录元数据、退出码与耗时，不记录命令文本或 stdout/stderr。

### 配置

```sh
ya config set model pro
ya config set thinking on
ya config set reasoning-effort max
```

配置继续兼容旧 Python 版本，存储在 `~/.ya/config.json`。可设置 `YA_HOME` 选择其他状态目录。已不再提供服务的模型 ID（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`、`vision` 别名，以及本项目在 API 拒绝前短暂使用过的 `deepseek-v4.1-flash` 与 `deepseek-v4-pro-0813`）会在加载配置时自动迁移。

### 长期记忆

```sh
ya memory review
ya memory approve CARD_ID
ya memory reject CARD_ID
ya memory revoke CARD_ID
ya memory prune
```

Ya 最多保存 100 张本地记忆卡。候选卡片在批准前不会进入模型上下文。每项任务最多选取三张相关的已批准卡片，排序完全在本地确定，依据包括英文短语/关键词与中文字符 n-gram。`--show-memory` 会在回答前显示本次选取结果。

现有 `~/.ya/memory.json` 格式保持不变，因此从 Python 实现升级不会丢失记忆。

## 桌面应用

桌面端是一个工作区优先的三栏工作台：

- 仅用于导航的文件浏览器；
- 仅本次会话保留的任务时间线；
- 相关记忆、本地活动元数据和行内文件变更审批。

应用还提供记忆审查与清理、English/简体中文界面、DeepSeek 配置、ToA 预检、简单回答流式输出、视觉图片选择和审计管理。模型与推理强度控件位于工作区，并会在选择变化后立即保存；默认选中 `deepseek-flash`，添加图片时使用该模型即可。渲染进程只会获得不透明的选择 ID 和展示所需元数据；本地路径与图片字节始终留在主进程，并会在任务结束、清除选择或关闭窗口时释放。

应用不会启动本地 Web 服务。渲染器不能直接访问 Node.js；API 与文件系统操作在 Electron 主进程内通过校验后的 IPC 处理。

## 开发

共享核心、CLI 与 Electron 桌面端均采用 TypeScript；源码开发需要 Node.js 22 或更高版本。

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:gui
npm run check
```

生产输出写入 `dist/typescript/`，从而避免 `dist/` 中旧的 Python 构建产物意外进入 npm 或 Electron 包。

常用命令：

```sh
npm start -- --help        # 构建并运行 CLI
npm run gui                # 构建并运行 Electron
npm run smoke:gui          # 加载 IPC/preload/renderer 并验证页面切换
npm run test:watch         # 监听单元测试
npm run package:cli        # 为当前平台打包 CLI
npm run package:gui        # 为当前平台打包 Electron 应用
```

测试覆盖配置/数据兼容、钥匙串回退、记忆排序、本地工作区边界、审计轮转、DeepSeek 请求/重试/SSE/工具循环、视觉输入校验与请求体、网页结果解析、编排、CLI 语义，以及 GUI 控制器和渲染辅助逻辑。GUI 烟测还会真正加载打包边界内的 renderer，并验证页面导航与视觉控件。

## 项目结构

```text
src/
  cli.ts                 CLI 入口与授权流程
  config.ts              经校验的持久化模型配置
  deepseek.ts            DeepSeek HTTP、SSE、重试与工具循环
  images.ts              经校验的视觉来源与内容块
  local.ts               受限本地文件工具与审计日志
  commands.ts            已批准的 shell 执行、输出捕获与进程取消
  memory.ts              候选记忆生命周期与相关性排序
  orchestrator.ts        单 Agent、ToA、网页、本地与 ICM 编排
  service.ts             CLI/GUI 共享任务服务
  terminal.ts            安全终端 Markdown 渲染
  gui/
    main.ts              Electron 主进程与校验后的 IPC
    preload.ts           上下文隔离的窄桥接
    renderer.ts          桌面交互与安全 DOM 渲染
    controller.ts        GUI 状态与共享服务门面
tests/                   Vitest 行为测试
```

## TLS 与代理

请保持证书校验开启。Electron 桌面端使用操作系统的 Chromium 网络栈。Node.js CLI 位于可信企业代理之后时，请配置 Node 支持的 CA 选项（例如 `NODE_EXTRA_CA_CERTS`），不要关闭 TLS 校验。

## 许可证

[MIT](LICENSE)
