# Ya

[English](README.md) | [中文](README.zh-CN.md)

Ya (丫丫) is a coding agent built specifically for DeepSeek, with a command-line interface and a native desktop application. The shared core is written in TypeScript; the desktop application uses Electron and shares the same typed service layer as the CLI.

Ya uses the DeepSeek API (`DeepSeek-V4.1-Flash` by default, with the option to switch to `DeepSeek-V4-Pro-0813`), stores long-term memory locally, and starts its bounded Tree of Agents (ToA) mode only after explicit confirmation. Command execution is opt-in for each task and requires separate approval.

## Desktop preview

Navigate projects and sessions on the left, chat with Ya on the right, and open Settings from the bottom of the sidebar. Files, applied diffs, relevant memory, tool activity, and approvals are available in an optional details panel.

![Ya desktop workspace: project and session navigation on the left, conversation and composer on the right, and Settings at the bottom-left](assets/ya-gui-workspace-screenshot.png)

## Architecture

- **SEA controlled learning:** explicit user feedback becomes a candidate memory card. Only approved cards can influence later tasks.
- **ICM curiosity loop:** when a response marks one material evidence gap, Ya performs at most one bounded, source-seeking follow-up.
- **Bounded ToA:** one root coordinator uses at most two temporary workers with explicit token and timeout limits.
- **Shared typed core:** the CLI and desktop application use the same configuration, memory, orchestration, API, web-search, and local-workspace modules.
- **Code verification:** approved commands return exit codes and bounded output so Ya can run tests, type checks and builds, repair failures, and rerun checks.
- **Vision input:** the CLI and desktop application can send verified JPEG, PNG, GIF, and WebP inputs to `deepseek-flash`, which has native vision support. API keys use Chat Completions; platform accounts use Messages.
- **Isolated desktop renderer:** the Electron renderer has no Node.js or direct filesystem access. Privileged operations pass through a narrow preload bridge into the main process.

## Platform support

Standalone CLI and desktop release assets are self-contained and do not require Node.js. Node.js 22 or newer is required for source development or installation of the npm package.

| Operating system | CLI | Desktop GUI | API key storage |
| --- | --- | --- | --- |
| macOS Apple Silicon and Intel | Standalone executable | Native `.app` bundle | macOS Keychain or `DEEPSEEK_API_KEY` |
| Linux x64 (glibc) | Standalone executable | AppImage | `DEEPSEEK_API_KEY` or a session-only GUI key |
| Windows x64 | Standalone `.exe` | Portable `.exe` | `DEEPSEEK_API_KEY` or a session-only GUI key |

Browser account sign-in is available on all three platforms. The API-key command `ya auth deepseek` is macOS-only because it uses the system `security` utility. On Linux and Windows, API-key users can use `DEEPSEEK_API_KEY` or enter a session-only key in Settings.

## DeepSeek platform account sign-in

Open **Settings → DeepSeek platform account → Sign in with DeepSeek** in the desktop app. Your browser opens [DeepSeek's platform](https://platform.deepseek.com/), where you sign in and approve the connection. Return to Ya after authorization. You can cancel while waiting, or sign out from the same settings card.

The CLI uses the same browser flow:

```sh
ya login deepseek
ya auth-status deepseek
ya ask "Explain this project" --web off
ya logout deepseek
```

Run the command and browser on the same computer. If the browser does not open automatically, open the URL printed by the CLI; Ctrl+C cancels the attempt. The callback listens only on `127.0.0.1` on a temporary port, and authorization expires after at most ten minutes.

Account sign-in uses the PKCE protocol implemented by [DeepSeek's official Harness](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform). Ya receives a platform account grant and sends it to the official Messages API as `x-dsh-auth-token`; it does not request your password. Available access and billing follow your platform account. While signed in, the account takes priority over API keys. Signing out removes the account grant and attempts remote session revocation; existing API keys remain available. A rejected account token prompts you to sign in again.

The account grant is stored as plaintext (unencrypted JSON), separately from settings, at `~/.ya/auth/credentials.json` (or `$YA_HOME/auth/credentials.json`). On Unix, the directory and file use permissions `0700` and `0600`; Windows uses the directory's access controls. These permissions and access controls restrict file access but do not encrypt the grant. Use disk encryption and encrypted backups to protect the stored grant if a disk is lost or a backup is exposed. Keep this user data directory private. The grant is never returned to the desktop renderer or stored in conversation history, and local file tools block reading the credential file.

## Install the CLI from a release tarball

Install Node.js 22 or newer, then download `ya-agent-<version>.tgz` from the [GitHub Release assets](https://github.com/ZedingZhang/ya-agent/releases/latest). Before running the command, replace `<version>` with the package version in the downloaded filename, without the tag's leading `v`. Run it from the directory containing that file:

```sh
npm install -g "./ya-agent-<version>.tgz"
ya --help
```

The release workflow attaches the npm tarball to GitHub Releases; it does not publish it to the npm registry. This package installs the CLI. For the desktop app or a CLI that does not require Node.js, use the separate [standalone release assets](#standalone-releases).

The published `v0.8.0` tarball still uses legacy native bindings: a clean Windows installation fails to start with `Cannot find native binding`. Until a release built from the current TypeScript core is available, use [source installation](#install-from-source).

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

### Verify downloads

Releases are distributed without publisher code signing or Apple notarization. macOS builds may use ad-hoc signatures for execution, which do not verify the publisher. macOS Gatekeeper and Windows SmartScreen may warn about or block these downloads. See [release signing](docs/release-signing.md) for details. Download `checksums.txt` from the same release and compare the matching SHA-256 value:

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
ya ask --image ./chart.png "Explain this chart"
```

Interactive terminals render Ya's common Markdown subset. Redirected output preserves raw Markdown for scripts and files:

```sh
ya ask --format terminal "Create a concise table"
ya ask --format markdown "Create a concise table" > answer.md
```

Simple tool-free answers stream by default in an interactive terminal. Web research, ToA, local workspace tasks, pipes, and Markdown output remain buffered. Use `--stream off` to disable streaming.

### Vision input

Vision is native to `deepseek-flash`, the default model, so images work without switching models; the text-only `deepseek-v4-pro` rejects them. `--image` is repeatable and accepts a local file, an HTTP(S) URL, a base64 data URL, or an existing DeepSeek Files API ID:

```sh
ya ask --image ./chart.png \
  --image https://example.com/photo.webp \
  --image-detail high \
  "Compare these images and explain the important differences"

ya ask --image file-api-EXISTING_ID "Read this uploaded image"
```

`--image-detail` accepts `auto` (the default), `low`, `high`, or `original`. With API-key authentication, `low` downsizes an image to 512×512 before inference; the other values currently preserve the original image. Account sign-in supports `auto`, `high`, and `original`; it rejects `low` for local files, data URLs, and external image URLs before sending a request. The desktop labels this option as API-key-only while signed in. Files API IDs are unaffected by the detail setting. Local files are checked by their actual file signature—not their extension—and converted to canonical data URLs only after validation. JPEG, PNG, GIF, and WebP are supported. Image content is allowed only with `deepseek-flash` and is placed only in the user message, as required by DeepSeek's [vision guide](https://api-docs.deepseek.com/guides/vision/) and [chat-completions schema](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/).

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
- edit existing files with revision-checked, exact replacements;
- move or rename files and directories.

The file tools cannot delete files. Every change shows an absolute path and requires approval. Replacements include a unified diff capped at 200 lines. In a non-interactive shell, file changes are denied unless that invocation includes `--approve`.

Reads remain inside the resolved workspace. Symlink escapes, `.git`, `.env`, credentials, private keys, binary files, invalid UTF-8, and files larger than 1 MiB are blocked. Writes, edits, and moves also reject sensitive paths before approval. Action audit logs contain metadata—not file content or diffs—and rotate at 1 MiB with three archives.

Search returns at most 100 filename and text matches. Recursive searches skip directories named `node_modules`, `dist`, and `.next` at any depth. Selecting one of these directories explicitly as the search root searches its contents; the exclusions still apply to descendant directories.

For existing files, Ya prefers `local_edit`: `local_read` returns exact content and a SHA-256 `revision`, which the edit submits as `expected_revision` with 1–100 `{old_text, new_text}` replacements. Each non-empty `old_text` must match exactly once in the original file; ambiguous, missing or overlapping matches reject the whole batch before approval. Use surrounding context for insertion and an empty `new_text` for deletion. No fuzzy matching or newline normalization is performed.

The approval shows the resulting diff. After approval, the tool rechecks the path, file identity, permissions and content before publishing the batch through a same-directory atomic rename. Conflicts require a fresh read and new edits. Read-only files are refused, because a rename needs only directory write permission and would otherwise rewrite a file the user protected. Untouched content, including BOM and line endings, is preserved, along with the ordinary permission bits and, where the platform has them, the owner and group; when Ya cannot restore the owner it refuses instead of transferring the file to your account. Because publishing replaces the file with a new one, ACLs, extended attributes and hard links are not carried over, and other links to the old file keep the previous content. Local edits use the same workspace, sensitive-file, UTF-8, 1 MiB and cancellation restrictions as reads; rejected batches leave the original intact. `local_write` remains available for new files and explicitly needed whole-file replacement.

```sh
ya audit clear
ya audit clear --yes  # required in a non-interactive shell
```

### Command execution and verification

Enable `local_run` for a coding task with `--local --exec`. Ya inspects the repository's existing scripts, chooses relevant tests, type checks or builds, reads failure output, and can repair the code and rerun the check:

```sh
ya ask --local --exec --workspace "$PWD" "Fix the bug and run the relevant tests and type check"
```

Each command approval displays the exact shell command, absolute working directory and timeout. The desktop equivalent is **Allow command execution** in the workspace; command cards display live stdout/stderr, completion status, exit code and duration. **Stop** cancels pending approvals, API requests and the running command's process tree. The CLI uses Ctrl+C.

Commands containing terminal control characters are rejected before approval; LF and tab are allowed. CLI approvals show controls in file paths and diffs as visible escapes. Library callers can pass `signal` to `runTask` to cancel local tools and pending approvals without configuring a second signal on `LocalWorkspace`.

For an unattended task, file changes and commands have separate authorizations:

```sh
ya ask --local --exec --approve --approve-commands --no-feedback "Fix the bug and verify it"
```

`--approve-commands` approves all commands for that non-interactive invocation. `--approve` and `--yes` do not approve commands. Interactive terminals still prompt for every command.

Commands use `cmd.exe /d /s /c` on Windows and `/bin/sh -c` on macOS/Linux, inherit the installed project toolchain, and run without stdin. Use one-shot checks instead of watch modes, interactive programs or detached background services. Process-tree termination uses the operating system's process controls; if cleanup cannot be confirmed, the result reports an error and bounds output draining instead of hanging. The default timeout is 120 seconds; the model can request an integer from 1 to 600 seconds. Each tool result retains the last 64 KiB of stdout and stderr, with explicit truncation flags. Command-enabled tasks have up to 20 tool rounds for inspection, repair and verification; other tasks retain the six-round limit. Final answers must report the checks performed and any failures, denied commands or incomplete checks.

Only the **initial working directory** is confined to the resolved workspace. Shell commands execute with your account's permissions and can modify or delete files elsewhere or access the network; execution is not sandboxed. CLI and GUI commands share a default environment allowlist: system and home paths, locale and temporary-directory settings, terminal settings, and common Node.js, Python, Java, Go, Rust, Android and .NET toolchain locations. Other inherited variables are omitted, including cloud/CI/API credentials, SSH agents, askpass helpers, `DEEPSEEK_API_KEY`, `YA_HOME` and application runtime flags. Project-specific variables must be set explicitly in the command you approve. Files and other credentials accessible to your account remain accessible to commands. Audit logs record command status, working-directory metadata, exit code and duration, without command text or stdout/stderr.

Approving `npm install` or `npm ci` can also run [dependency lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/#life-cycle-operation-order), including `postinstall`. These scripts can access files, the network, and credentials available to the command; review the repository and its dependencies before approving installation.

### Configuration

```sh
ya config set model pro
ya config set thinking on
ya config set reasoning-effort max
```

API attempts allow up to 90 seconds for the initial response. Non-streaming attempts have a 90-second total deadline. After a streaming response starts, its 90-second idle timeout resets as data or heartbeats arrive, so an active answer can continue beyond 90 seconds. These limits apply to both API keys and platform accounts and are independent of the ToA worker timeout. Stop or Ctrl+C still cancels the request; a failed stream is not retried after visible text has been delivered.

Configuration remains compatible with earlier Python releases and is stored at `~/.ya/config.json`. Set `YA_HOME` to choose another state directory. Model ids that are no longer served—`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, the `vision` alias, and the `deepseek-v4.1-flash` and `deepseek-v4-pro-0813` names this project briefly shipped before the API rejected them—are migrated when the file is loaded.

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

The desktop application uses a two-column workspace inspired by the [official DeepSeek Harness desktop and sidebar sources](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop):

- Project and session navigation on the left, with Settings pinned to the bottom and a separate Memory entry.
- Conversation history and a compact composer on the right. Each session keeps its own draft, replies, and command output locally across restarts. Follow-up requests include that session's earlier user messages and completed replies, including requests that failed before an answer, so you can configure an API key and then ask Ya to continue. Application errors and incomplete replies are excluded from model context; prior image attachments must be selected again to resend their contents.
- An optional Files/Changes/Activity panel for file navigation, applied diffs, relevant memory, and approvals. Pending approvals open the panel automatically.

After a successful `local_write` or `local_edit`, the conversation shows an expandable diff card. Open **Changes** in the top-right corner to review the current session's file changes; repeated edits to a path are recorded separately. Diffs include red/green additions and deletions, old/new line numbers, three lines of context, expansion for longer changes, and copying. Cards and change history are saved with the conversation, so switching sessions or restarting preserves the diff at the time of each operation, without requiring Git.

Each preview retains at most 2,000 lines and 128K characters. Larger previews are marked as truncated while statistics cover the complete change; a diff calculation timeout displays an unavailable preview. Sensitive-path writes are rejected before approval; non-text writes do not retain content diffs. The history covers file-tool operations, excluding changes made by shell commands, and records individual operations rather than a net session diff. Action audits and model-facing tool results continue to contain metadata only.

Add projects with the sidebar's **+** button, create sessions with **New session**, and switch between saved sessions in the project list. Ctrl/⌘+N starts a session, Ctrl/⌘+B collapses the sidebar, and Ctrl/⌘+Enter sends a task. The composer’s **Task options** menu contains local tools, command execution, web search, ToA, and image-detail controls.

Saved transcripts and drafts remain accessible if a project's folder is moved or deleted. Opening that history disables local tools and clears access to the previously selected project's folder. Reloading the desktop during a task cancels it and waits for it to stop before enabling session navigation.

It also includes memory review and pruning, bilingual English/简体中文 UI, DeepSeek settings, ToA preflight, streaming simple answers, vision image selection, and audit-history management. Model and reasoning-effort controls live in the workspace and are saved as soon as they change; `deepseek-flash` is selected by default and is the model to use before attaching images. The renderer receives only opaque selection IDs plus display metadata; local paths and image bytes remain in the main process and are cleared after the task, when the selection is cleared, or when the window closes.

The application does not start a local web server. The renderer cannot access Node.js directly; API calls and filesystem operations run in the Electron main process behind validated IPC handlers.

## Development

The shared core, CLI, and Electron desktop application are written in TypeScript.
Development requires Node.js 22 or later:

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
npm run gui                # build and run Ya (branded Ya.app on macOS)
npm run smoke:gui          # load IPC/preload/renderer and verify navigation
npm run test:watch         # watch unit tests
npm run package:cli        # package a CLI for the current host
npm run package:gui        # package the Electron app for the current host
```

The test suite covers configuration/data compatibility, Keychain fallback, memory ranking, local-workspace confinement, audit rotation, command approval/output/timeouts/process-tree cancellation, failed-check repair and re-verification, DeepSeek request/retry/stream/tool behavior and cancellation, vision input validation and payloads, web result parsing, orchestration, CLI semantics, and GUI controller/rendering helpers. The GUI smoke test additionally loads the packaged renderer boundary and verifies page navigation, vision and command controls.

## Project layout

```text
src/
  cli.ts                 CLI entry point and consent flows
  config.ts              validated persistent model configuration
  deepseek.ts            typed DeepSeek HTTP, SSE, retry, and tool loop
  images.ts              validated vision sources and content blocks
  local.ts               confined local filesystem tools and audit log
  commands.ts            approved shell execution, output capture and process cancellation
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
