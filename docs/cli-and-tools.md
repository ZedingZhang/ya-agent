# CLI, Tools, Configuration, and Long-Term Memory

[English README](../README.md) | [中文 README](../README.zh-CN.md)

## CLI usage, output formats, and streaming

```sh
ya --help
ya ask --help
ya ask "Explain recursion"
ya ask --web on "Compare the latest evidence for two approaches"
ya ask --thinking on --reasoning-effort max "Analyze this decision"
ya ask --thinking on --reasoning-effort low "Summarize this function"
ya ask --image ./chart.png "Explain this chart"
```

Interactive terminals render Ya's common Markdown subset. Redirected output preserves raw Markdown for scripts and files:

```sh
ya ask --format terminal "Create a concise table"
ya ask --format markdown "Create a concise table" > answer.md
```

- When Markdown output is redirected, the result banner goes to `stderr`.
- The post-task feedback prompt appears only when both `stdin` and `stdout` are interactive terminals (disable explicitly with `--no-feedback`).
- Simple, tool-free answers stream by default in an interactive terminal. Web research, ToA, local workspace tasks, pipes, and Markdown output remain buffered. Use `--stream off` to disable streaming.

## Models, thinking, and API timeouts

Desktop model menus display the current model versions. CLI aliases and API IDs follow DeepSeek's [official model list](https://api-docs.deepseek.com/quick_start/pricing/):

| CLI alias | API model ID | Current model version | Image input |
| --- | --- | --- | --- |
| `flash` (default) | `deepseek-flash` | `DeepSeek-V4.1-Flash-1017` | Yes |
| `pro` | `deepseek-v4-pro` | `DeepSeek-V4-Pro-0813` | No |

Save defaults via `ya config set`:

```sh
ya config set model pro
ya config set thinking on
ya config set reasoning-effort max
```

- **Thinking & reasoning effort:** supports `low`, `high`, and `max` in the CLI, desktop, and saved configuration. Ya defaults to thinking off, with `high` selected when thinking is enabled. Override per request with `ya ask --thinking on --reasoning-effort low "..."`. API-key requests send `reasoning_effort`, while platform-account requests send `output_config.effort`, following DeepSeek's [thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/).
- **Request timeouts:** API attempts allow up to 90 seconds for the initial response. Non-streaming attempts have a 90-second total deadline. After a streaming response starts, its 90-second idle timeout resets as data or heartbeats arrive, so an active answer can continue beyond 90 seconds. These limits apply to both API keys and platform accounts and are independent of the ToA worker timeout. Stop or `Ctrl+C` cancels the request; a failed stream is not retried after visible text has been delivered.
- **Configuration storage and migration:** stored at `~/.ya/config.json` (set `YA_HOME` to choose another state directory) and compatible with earlier Python releases. Older model names (`deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, the `vision` alias, and the `deepseek-v4.1-flash` and `deepseek-v4-pro-0813` names this project briefly shipped) are normalized to the current API IDs when loaded. DeepSeek also continues to accept the two older Flash API IDs and routes them to `DeepSeek-V4.1-Flash-1017`.

## Vision input

Vision is native to `deepseek-flash` (the default model), so images work without switching models; the text-only `deepseek-v4-pro` rejects them. `--image` is repeatable and accepts a local file, an HTTP(S) URL, a base64 data URL, or an existing DeepSeek Files API ID:

```sh
ya ask --image ./chart.png \
  --image https://example.com/photo.webp \
  --image-detail high \
  "Compare these images and explain the important differences"

ya ask --image file-api-EXISTING_ID "Read this uploaded image"
```

- **`--image-detail`:** accepts `auto` (default), `low`, `high`, or `original`.
  - With **API-key authentication**, `low` downsizes an image to 512×512 before inference; the other values preserve the original image.
  - With **platform-account sign-in**, `auto`, `high`, and `original` are supported; `low` is rejected for local files, data URLs, and external image URLs before sending a request (labeled API-key-only in the desktop UI).
  - `file-api-*` IDs are unaffected by `--image-detail`.
- **Validation and format rules:** local files are verified by their actual file signature (magic bytes)—not their filename extension—and converted to canonical data URLs only after validation. Supported formats are **JPEG, PNG, GIF, and WebP**. Image content is allowed only with `deepseek-flash` and is placed only in the user message, as required by DeepSeek's [vision guide](https://api-docs.deepseek.com/guides/vision/) and [chat-completions schema](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/).
- **Size and count limits:** enforces DeepSeek's limit of 600 images and 8,192 characters per external URL. A single local or data-URL image may contain at most 32 MiB; Ya conservatively caps all inline image bytes at 32 MiB total so base64 expansion and the prompt stay below the API's 48 MiB request-body limit. A `file-api-*` value must refer to an image already uploaded through DeepSeek's Files API (Ya does not upload it).
- **Multi-request billing note:** in ToA mode, every attached image is sent to each worker and again to the root synthesis. Tool-call rounds and the one optional ICM follow-up also resend the request context when triggered. The preflight shows this explicitly because DeepSeek bills image tokens on each request.

## Tree of Agents (ToA)

ToA runs a root coordinator alongside one or two temporary evidence/risk workers and always displays a preflight before starting:

```sh
ya ask --toa --toa-workers 2 "Evaluate this strategic decision"
```

Non-interactive shells require explicit authorization for that invocation:

```sh
ya ask --toa --yes "Evaluate this strategic decision"
```

- `--local` and `--toa` cannot be combined.
- Optional flags: `--toa-workers <1|2>` (default `2`), `--toa-token-budget <tokens>` (`1000–16000`, default `8000`), and `--toa-timeout <seconds>` (`30–180`, default `90`).
- **Cancellation:** declining the ToA preflight cancels the task, sends no API or web-search requests, and exits with code `0` (a normal user cancellation).
- **Budget accounting:** the completion-token budget covers every tool round across the workers, root synthesis, and optional ICM follow-up. Each allocation reserves tokens for a final answer and caps subsequent requests at its remaining allowance. When a response omits usage, Ya conservatively charges its requested allowance. Reported usage totals all provider-reported rounds, including completed rounds of a worker that later times out.

## Local workspace tools (`--local`)

Local mode grants Ya a deliberately limited filesystem capability for one workspace:

```sh
ya ask --local --workspace "$PWD" "Create notes/summary.md from the text files here"
```

The tool set can:

- list directories;
- read and search bounded UTF-8 text;
- create one directory at a time;
- create or replace text files (`local_write`);
- edit existing files with revision-checked, exact replacements (`local_edit`);
- move or rename files and directories.

The file tools **cannot delete files**. Every change displays an absolute path and requires approval (unified diffs are capped at 200 lines). In a non-interactive shell, file changes are denied unless the invocation includes `--approve`.

### Confinement, search, and audit logs

- Reads remain inside the resolved workspace. Symlink escapes, dangling symlinks, `.git`, `.env`, credentials, private keys (matched case-insensitively), binary files, invalid UTF-8, and files larger than **1 MiB** are blocked.
- Writes, edits, and moves reject sensitive paths before approval.
- Search returns at most **100** filename and text matches. Recursive searches skip directories named `node_modules`, `dist`, and `.next` at any depth; selecting one of those directories explicitly as the search root searches its contents while still excluding descendant directories with those names.
- Action audit logs record metadata only—never file content or diffs—and rotate at 1 MiB with three archives. Clear them with:

```sh
ya audit clear
ya audit clear --yes  # required in a non-interactive shell
```

### Revision-checked edits (`local_edit`)

For existing files, Ya prefers `local_edit`:

- `local_read` returns exact content and a SHA-256 `revision`, which the edit submits as `expected_revision` alongside 1–100 `{old_text, new_text}` replacements.
- Each non-empty `old_text` must match **exactly once** in the original file; ambiguous, missing, or overlapping matches reject the whole batch before approval. Use surrounding context for insertion and an empty `new_text` for deletion. No fuzzy matching or newline normalization is performed.
- Approval shows the resulting diff. After approval, the tool rechecks the path, file identity, permissions, and content before publishing through a same-directory atomic rename. Conflicts require a fresh read and new edits.
- Read-only files are refused (because rename requires only directory write permission and would otherwise overwrite user-protected files).
- Untouched content (including BOM and line endings) is preserved, along with ordinary permission bits and, where supported by the platform, owner and group; when Ya cannot restore the owner it refuses rather than transferring ownership to your account. Because publishing replaces the file with a new one, ACLs, extended attributes, and hard links are not carried over, and existing hard links to the old file retain the previous content.
- Rejected batches leave the original file intact. `local_write` remains available for new files and explicitly needed whole-file replacement.

## Command execution and verification

Enable `local_run` in the CLI for a coding task with `--local --exec`. Ya inspects the repository's scripts, selects relevant tests, type checks, or builds, reads failure output, repairs the code, and reruns verification:

```sh
ya ask --local --exec --workspace "$PWD" "Fix the bug and run the relevant tests and type check"
```

For an unattended task, file changes and shell commands require separate authorizations:

```sh
ya ask --local --exec --approve --approve-commands --no-feedback "Fix the bug and verify it"
```

- **Approval and input safety:** every command approval displays the exact shell command, absolute working directory, and timeout. Press `Ctrl+C` in the CLI to cancel pending approvals, API requests, and the running command's process tree.
  - Commands containing terminal control characters are rejected before approval (LF and tab are allowed).
  - Commands are limited to **8,192 characters** and **50 lines**, and consecutive blank or whitespace-only lines are refused.
  - CLI approvals show the complete, unchanged command with its line count, and escape terminal control characters inside file paths and diffs visibly.
  - `--approve-commands` approves all commands for that non-interactive invocation. `--approve` and `--yes` do **not** approve commands; interactive terminals prompt for every command.
  - Library callers can pass `signal` to `runTask` to cancel local tools and pending approvals without configuring a second signal on `LocalWorkspace`.
- **Execution runtime and limits:**
  - Runs via `cmd.exe /d /s /c` on Windows and `/bin/sh -c` on macOS/Linux, inheriting the installed project toolchain with closed `stdin`. Prefer one-shot checks rather than watch modes, interactive programs, or detached background services.
  - Process-tree termination uses OS process controls; if cleanup cannot be confirmed, the result reports an error and bounds output draining instead of hanging.
  - Default timeout is **120 seconds** (the model can request an integer from **1 to 600 seconds**).
  - Each tool result retains the last **64 KiB** of `stdout` and `stderr`, with explicit truncation flags.
  - Command-enabled tasks allow up to **20 tool rounds** for inspection, repair, and verification (other tasks retain the 6-round limit). Final answers must report the checks performed and any failures, denied commands, or incomplete checks.

> [!WARNING]
> Shell commands execute with your user account's permissions and are **not sandboxed**—only the initial working directory is confined to the resolved workspace. See [Security and authentication](security-and-auth.md#command-execution-boundaries-and-environment-allowlist) for environment allowlist and `npm install` lifecycle script risks.

## Long-term memory

```sh
ya memory review
ya memory approve CARD_ID
ya memory reject CARD_ID
ya memory revoke CARD_ID
ya memory prune          # supports --include-candidates and --yes
```

Ya uses [Octop Memory](https://github.com/TencentCloud/octop-memory) `1.0.4` backed by SQLite at `~/.ya/memory.sqlite` (or `$YA_HOME/memory.sqlite`), in namespace `ya`:

- **SEA controlled lifecycle:** explicit user feedback creates native candidates with evidence. Approval creates canonical atoms (`AtomCard`), and task context uses `MemoryService.recall()` for multilingual search, ranking, deduplication, and prompt budgeting. Rejection and revocation retire the corresponding atoms. Pruning removes selected cards and their native evidence records.
- **Bounds:** Ya stores at most **100** cards and deterministically selects up to **3** approved cards per task. Pass `--show-memory` to `ya ask` to inspect the selection before an answer.
- **Python runtime setup:** install `octop-memory==1.0.4` into a **Python 3.12+** environment accessible to Ya:

```sh
python -m pip install octop-memory==1.0.4
```

- Set `YA_MEMORY_PYTHON` to the full path of that environment's Python executable when using a virtual environment or launching the desktop app with a different `PATH`. Otherwise Ya tries `python` and `py` on Windows, and `python3` and `python` on macOS/Linux.
- The Python adapter (`octop-memory.py`) ships inside npm, standalone CLI, and Electron packages; Python and `octop-memory` are installed separately. Reads of an empty memory store return empty results; runtime failures for an existing store report an actionable error.
- On Windows, the memory adapter resolves interpreter names from absolute directories in `PATH` and launches the resulting full path. It starts Python with `-E -P` to exclude the working directory from its default import path and ignore inherited `PYTHON*` settings (`PYTHONPATH`, `PYTHONHOME`). Install `octop-memory` into the selected interpreter's environment or its standard user site-packages directory.
- **Migration and concurrency:** on first access, Ya imports legacy `memory.json` transactionally, preserving card IDs, kinds, evidence, statuses, creation times, and versions. A database marker makes migration resumable after failure and prevents repeated imports after success; the original `memory.json` remains as a backup (including records later pruned from SQLite). Concurrent processes serialize Octop schema initialization with `memory.init.lock` beside the database; the OS releases the lock when the initializer closes the file or exits.

## Durable task history

The shared service persists task identity and lifecycle records (`running`, `completed`, `failed`, `cancelled`, `interrupted`) locally across CLI and GUI processes using cross-process file locking (`task-store-lock.ts`) and automatic secret redaction before persisting metadata.
