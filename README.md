# Ya

[English](README.md) | [中文](README.zh-CN.md)

Ya is a consent-first personal research and decision agent with a command-line interface and a native desktop application. The project is implemented in strict TypeScript on Node.js; the desktop application uses Electron while sharing the same typed service layer as the CLI.

Ya uses the DeepSeek V4 API, stores long-term memory locally, and starts its bounded Tree of Agents (ToA) mode only after explicit confirmation. It never gives its model unrestricted shell access or permission to delete local files.

## Architecture

- **SEA controlled learning:** explicit user feedback becomes a candidate memory card. Only approved cards can influence later tasks.
- **ICM curiosity loop:** when a response marks one material evidence gap, Ya performs at most one bounded, source-seeking follow-up.
- **Bounded ToA:** one root coordinator uses at most two temporary workers with explicit token and timeout limits.
- **Shared typed core:** the CLI and desktop application use the same configuration, memory, orchestration, API, web-search, and local-workspace modules.
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
```

Interactive terminals render Ya's common Markdown subset. Redirected output preserves raw Markdown for scripts and files:

```sh
ya ask --format terminal "Create a concise table"
ya ask --format markdown "Create a concise table" > answer.md
```

Simple tool-free answers stream by default in an interactive terminal. Web research, ToA, local workspace tasks, pipes, and Markdown output remain buffered. Use `--stream off` to disable streaming.

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

Configuration remains compatible with earlier Python releases and is stored at `~/.ya/config.json`. Set `YA_HOME` to choose another state directory.

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

It also includes memory review and pruning, bilingual English/简体中文 UI, DeepSeek settings, ToA preflight, streaming simple answers, and audit-history management. It does not start a local web server. The renderer cannot access Node.js directly; API calls and filesystem operations run in the Electron main process behind validated IPC handlers.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:gui
npm run check
```

Production output is written under `dist/typescript/` so older generated Python artifacts in `dist/` cannot accidentally enter the npm or Electron packages.

Useful commands:

```sh
npm start -- --help        # build and run the CLI
npm run gui                # build and run Electron
npm run smoke:gui          # load IPC/preload/renderer and verify navigation
npm run test:watch         # watch unit tests
npm run package:cli        # package a CLI for the current host
npm run package:gui        # package the Electron app for the current host
```

The test suite covers configuration/data compatibility, Keychain fallback, memory ranking, local-workspace confinement, audit rotation, DeepSeek request/retry/stream/tool behavior, web result parsing, orchestration, CLI semantics, and GUI controller/rendering helpers. The GUI smoke test additionally loads the packaged renderer boundary and verifies page navigation.

## Project layout

```text
src/
  cli.ts                 CLI entry point and consent flows
  config.ts              validated persistent model configuration
  deepseek.ts            typed DeepSeek HTTP, SSE, retry, and tool loop
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
