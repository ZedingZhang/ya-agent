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

### 独立可执行文件

Ya 现提供 macOS Apple Silicon、macOS Intel、Windows x64 和 Linux x64 的独立
可执行文件。下载对应附件后即可直接运行，无需安装 Python、pip 或修改 PATH。

macOS 和 Windows 文件当前未签名。在绕过系统提示前，请先校验 `checksums.txt`。
`ya auth deepseek` 仍仅支持 macOS；Linux 和 Windows 请使用 `DEEPSEEK_API_KEY`。

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

### Python 包

仍保留通用 wheel 与源码包，供 Python 用户和贡献者使用。
