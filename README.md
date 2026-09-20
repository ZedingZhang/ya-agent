# Ya

[English](README.md) | [中文](README.zh-CN.md)

Ya is a consent-first personal research and decision agent with a command-line interface and a native desktop application. The project is implemented in strict TypeScript on Node.js; the desktop application uses Electron while sharing the same typed service layer as the CLI.

Ya uses the DeepSeek V4.1 API—`deepseek-v4.1-flash` by default, with `deepseek-v4-pro-0813` for the hardest tasks—stores long-term memory locally, and starts its bounded Tree of Agents (ToA) mode only after explicit confirmation. It never gives its model unrestricted shell access or permission to delete local files.

## Architecture

- **SEA controlled learning:** explicit user feedback becomes a candidate memory card. Only approved cards can influence later tasks.
- **ICM curiosity loop:** when a response marks one material evidence gap, Ya performs at most one bounded, source-seeking follow-up.
- **Bounded ToA:** one root coordinator uses at most two temporary workers with explicit token and timeout limits.
- **Shared typed core:** the CLI and desktop application use the same configuration, memory, orchestration, API, web-search, and local-workspace modules.
- **Vision input:** the CLI and desktop application can send verified JPEG, PNG, GIF, and WebP inputs to `deepseek-v4.1-flash`, which has native vision support, through the same OpenAI-compatible chat-completions path.
- **Isolated desktop renderer:** the Electron renderer has no Node.js or direct filesystem access. Privileged operations pass through a narrow preload bridge into the main process.

## Platform support

Release assets are self-contained and do not require Node.js. Node.js 22 or newer is required only for source development or npm installation.

| Operating system | CLI | Desktop GUI | API key storage |
| --- | --- | --- | --- |
| macOS Apple Silicon and Intel | Standalone executable | Native `.app` bundle | macOS Keychain or `DEEPSEEK_API_KEY` |
| Linux x64 (glibc) | Standalone executable | AppImage | `DEEPSEEK_API_KEY` or a session-only GUI key |
| Windows x64 | Standalone `.exe` | Portable `.exe` | `DEEPSEEK_API_KEY` or a session-only GUI key |

`ya auth deepseek` is macOS-only because it uses the system `security` utility. On Linux and Windows, use `DEEPSEEK_API_KEY` or enter a session-only key in Settings.

## Install from source

```sh
git clone https://github.com/ZedingZhang/ya-agent.git
cd ya-agent
npm ci
npm run check
npm link
```

After `npm link`, the `ya` command is available in your current Node.js environment. You can also run it without linking:

```sh
npm start -- ask "Explain Graph Engineering in plain language"
```

Start the desktop application from source with:

```sh
npm run gui
```

## Standalone releases

Download the matching files from the [latest GitHub Release](https://github.com/ZedingZhang/ya-agent/releases/latest). The command-line and GUI assets are built separately.

### macOS Apple Silicon

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-macos-arm64
chmod +x ya-macos-arm64
./ya-macos-arm64 ask "Explain Graph Engineering in plain language"
```

Use `ya-macos-x64` on an Intel Mac. The GUI archives are named `ya-gui-macos-arm64.zip` and `ya-gui-macos-x64.zip`.

### Linux x64

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-linux-x64
chmod +x ya-linux-x64
./ya-linux-x64 ask "Explain Graph Engineering in plain language"
```

The desktop AppImage is published as `ya-gui-linux-x64`; make it executable before launching it. Linux release binaries target x64 glibc systems such as Ubuntu 22.04 and are not built for musl-based distributions such as Alpine Linux.

### Windows x64 (PowerShell)

```powershell
Invoke-WebRequest https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-windows-x64.exe -OutFile ya-windows-x64.exe
.\ya-windows-x64.exe ask "Explain Graph Engineering in plain language"
```

The portable desktop application is `ya-gui-windows-x64.exe`.

### Verify unsigned downloads

macOS and Windows artifacts are currently unsigned. Download `checksums.txt` from the same release and compare the matching SHA-256 value before overriding an operating-system warning:

```sh
shasum -a 256 ya-macos-arm64
# Linux: sha256sum ya-linux-x64
```

```powershell
Get-FileHash .\ya-windows-x64.exe -Algorithm SHA256
```

## CLI usage

```sh
ya --help
ya ask --help
ya ask "Explain recursion"
ya ask --web on "Compare the latest evidence for two approaches"
ya ask --thinking on --reasoning-effort max "Analyze this decision"
ya ask --model vision --image ./chart.png "Explain this chart"
```

Interactive terminals render Ya's common Markdown subset. Redirected output preserves raw Markdown for scripts and files:

```sh
ya ask --format terminal "Create a concise table"
ya ask --format markdown "Create a concise table" > answer.md
```

Simple tool-free answers stream by default in an interactive terminal. Web research, ToA, local workspace tasks, pipes, and Markdown output remain buffered. Use `--stream off` to disable streaming.

### Vision input

Vision is native to `deepseek-v4.1-flash`, the default model, so images work without switching models; the text-only `deepseek-v4-pro-0813` rejects them. `--image` is repeatable and accepts a local file, an HTTP(S) URL, a base64 data URL, or an existing DeepSeek Files API ID:

```sh
ya ask --image ./chart.png \
  --image https://example.com/photo.webp \
  --image-detail high \
  "Compare these images and explain the important differences"

ya ask --image file-api-EXISTING_ID "Read this uploaded image"
```

`--image-detail` accepts `auto` (the default), `low`, `high`, or `original`. `low` downsizes an image to 512×512 before inference; the other values currently preserve the original image. Local files are checked by their actual file signature—not their extension—and converted to canonical data URLs only after validation. JPEG, PNG, GIF, and WebP are supported. Image content is allowed only with `deepseek-v4.1-flash` and is placed only in the user message, as required by DeepSeek's [vision guide](https://api-docs.deepseek.com/guides/vision/) and [chat-completions schema](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/).

Ya enforces DeepSeek's limit of 600 images and 8,192 characters per external URL. A single local or data-URL image may contain at most 32 MiB; Ya conservatively caps all inline image bytes at 32 MiB so base64 expansion and the prompt stay below the API's 48 MiB request-body limit. A `file-api-*` value must refer to an image already uploaded through DeepSeek's Files API; Ya does not upload it for you.

In ToA mode, every attached image is sent to each worker and again to the root synthesis. Tool-call rounds and the one optional ICM follow-up also resend the request context when triggered. The preflight shows this explicitly because DeepSeek bills image tokens on each request.

### Tree of Agents

ToA has a root coordinator and one or two temporary evidence/risk workers. It always shows a preflight before starting:

```sh
ya ask --toa --toa-workers 2 "Evaluate this strategic decision"
```

Non-interactive use requires explicit authorization for that invocation:

```sh
ya ask --toa --yes "Evaluate this strategic decision"
```

`--local` and `--toa` cannot be combined.

### Local workspace tools

Local mode gives Ya a deliberately limited filesystem capability for one workspace:

```sh
ya ask --local --workspace "$PWD" "Create notes/summary.md from the text files here"
```

The tool set can:

- list directories;
- read and search bounded UTF-8 text;
- create one directory at a time;
- create or replace text files;
- move or rename files and directories.

It cannot execute shell commands, scripts, Git, or package managers, and it cannot delete files. Every change shows an absolute path and requires approval. Replacements include a unified diff capped at 200 lines. In a non-interactive shell, changes are denied unless that invocation includes `--approve`.

Reads remain inside the resolved workspace. Symlink escapes, `.git`, `.env`, credentials, private keys, binary files, invalid UTF-8, and files larger than 1 MiB are blocked. Action audit logs contain metadata—not file content or diffs—and rotate at 1 MiB with three archives.

```sh
ya audit clear
ya audit clear --yes  # required in a non-interactive shell
```

### Configuration

```sh
ya config set model pro
ya config set thinking on
ya config set reasoning-effort max
```

Configuration remains compatible with earlier Python releases and is stored at `~/.ya/config.json`. Set `YA_HOME` to choose another state directory. Model IDs retired by the V4.1 line-up—`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`, and the `vision` alias—are migrated to their V4.1 equivalents when the file is loaded.

### Long-term memory

```sh
ya memory review
ya memory approve CARD_ID
ya memory reject CARD_ID
ya memory revoke CARD_ID
ya memory prune
```

Ya stores at most 100 local memory cards. Candidate cards do not enter model context until approved. For each task, Ya deterministically selects at most three relevant approved cards using English phrases/keywords and Chinese character n-grams. `--show-memory` displays the selection before an answer.

The existing `~/.ya/memory.json` format is preserved, so upgrading from the Python implementation does not discard memory.

## Desktop application

The desktop application is a workspace-first three-column workbench:

- a navigation-only file browser;
- a session-only task timeline;
- relevant memory, local activity metadata, and inline file-change approval.

It also includes memory review and pruning, bilingual English/简体中文 UI, DeepSeek settings, ToA preflight, streaming simple answers, vision image selection, and audit-history management. Model and reasoning-effort controls live in the workspace and are saved as soon as they change; `deepseek-v4.1-flash` is selected by default and is the model to use before attaching images. The renderer receives only opaque selection IDs plus display metadata; local paths and image bytes remain in the main process and are cleared after the task, when the selection is cleared, or when the window closes.

The application does not start a local web server. The renderer cannot access Node.js directly; API calls and filesystem operations run in the Electron main process behind validated IPC handlers.

## Development

The shared core is written in Rust and compiled to a Node-API addon, so a Rust
toolchain is required (see [native/README.md](native/README.md)):

```sh
npm ci
npm run build:native
npm run typecheck
npm test
npm run test:parity
npm run build
npm run smoke:gui
npm run check
```

Production output is written under `dist/typescript/` so older generated Python artifacts in `dist/` cannot accidentally enter the npm or Electron packages.

Useful commands:

```sh
npm start -- --help        # build and run the CLI
npm run build:native       # compile the Rust core for this host
npm run test:parity        # compare the Rust core against the TypeScript one
npm run gui                # build and run Electron
npm run smoke:gui          # load IPC/preload/renderer and verify navigation
npm run test:watch         # watch unit tests
npm run package:cli        # package a CLI for the current host
npm run package:gui        # package the Electron app for the current host
```

The test suite covers configuration/data compatibility, Keychain fallback, memory ranking, local-workspace confinement, audit rotation, DeepSeek request/retry/stream/tool behavior, vision input validation and payloads, web result parsing, orchestration, CLI semantics, and GUI controller/rendering helpers. The GUI smoke test additionally loads the packaged renderer boundary and verifies page navigation and vision controls.

## Project layout

```text
src/
  cli.ts                 CLI entry point and consent flows
  config.ts              validated persistent model configuration
  deepseek.ts            typed DeepSeek HTTP, SSE, retry, and tool loop
  images.ts              validated vision sources and content blocks
  local.ts               confined local filesystem tools and audit log
  memory.ts              candidate lifecycle and relevance ranking
  orchestrator.ts        single-agent, ToA, web, local, and ICM logic
  service.ts             shared CLI/GUI task service
  terminal.ts            safe terminal Markdown renderer
  gui/
    main.ts              Electron main process and validated IPC
    preload.ts           narrow context-isolated bridge
    renderer.ts          desktop interaction and safe DOM rendering
    controller.ts        GUI state and shared-service facade
tests/                   Vitest behavior tests
```

## TLS and proxies

Keep certificate verification enabled. The Electron desktop application uses the operating system's Chromium network stack. For the Node.js CLI behind a trusted corporate proxy, configure Node's supported CA settings such as `NODE_EXTRA_CA_CERTS` rather than disabling TLS verification.

## License

[MIT](LICENSE)
