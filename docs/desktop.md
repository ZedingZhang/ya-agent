# Desktop Application Guide

[English README](../README.md) | [中文 README](../README.zh-CN.md)

The desktop application uses a two-column workspace inspired by the [official DeepSeek Harness desktop and sidebar sources](https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop):

- **Bot navigation** on the left, with **Settings** pinned to the bottom and a separate **Memory** entry.
- **Conversation history and a compact composer** on the right.
- An optional **Files / Changes / Activity** details panel on the right for file navigation, applied diffs, relevant memory, and approvals. Pending approvals open the panel automatically and remain visible and keyboard-accessible.

## Persistent named bots

Start with the default **Ya** bot, or click **New bot** (`Ctrl/⌘+N`) to create a named bot with optional standing instructions—for example, `"Review patches and suggest a regression test."` Each model request includes the selected bot's profile and conversation history. Click **Edit bot** in the chat header to update its name or instructions at any time.

Existing sessions from earlier versions appear one-for-one as individual bots with their original titles and history; untitled sessions open as **Ya**.

### Manage local history

In **Settings → Storage**, choose **Bot conversations**, **Task records (desktop and CLI)**, or **Action audit logs**. Select records older than 30 or 90 days, or enter a custom range. Both dates are included in your local time zone. To clean up one day, use the same start and end date.

Review the matching count and estimated size, then choose **Delete selected records…** and confirm. Deleting a conversation turn also removes its saved diffs and command output. Older turns use their linked task's date when available. Choose **Unknown date** to review the count and size of records that lack a date.

Each bot keeps its own draft, replies, and command output locally across restarts. Follow-up requests include that bot's earlier user messages and completed replies—including requests that failed before an answer, so you can configure an API key or sign in and ask Ya to continue. Application errors and incomplete replies are excluded from model context; prior image attachments must be selected again to resend their contents.

## Per-bot folder grants and scoped file tools

Every bot starts with **no local directory access**, including bots imported from older sessions.

1. Select a bot and open **Files → Choose folder…**.
2. Confirm **Grant access** in the native picker to give the current bot access to that folder and its subfolders.
3. Ya restores the grant across restarts when the filesystem supplies a persistent directory identifier. On other filesystems, the **Files** panel prompts you to choose the folder again after restarting.
4. Pick another folder to replace the grant, or use **Revoke access** to remove it.

File changes always require per-operation approval. Desktop bots use scoped file tools only; shell command execution (`--local --exec`) is available through the [CLI](cli-and-tools.md#command-execution-and-verification).

Saved transcripts and drafts remain accessible if a bot's granted folder is moved or deleted:

- Opening a bot whose folder is offline disables local tools while still allowing ordinary chat.
- If another folder or volume takes the previous path's place, or if an older grant cannot verify which folder you selected, choose the folder again to restore local tools.

## File diffs and change history

After a successful `local_write` or `local_edit`, the conversation shows an expandable diff card. Open **Changes** in the top-right corner to review the current bot's file changes; repeated edits to the same path are recorded separately.

- Diffs show red/green additions and deletions, old/new line numbers, three lines of context, expansion for longer changes, and one-click copying.
- Cards and change history are saved with the bot, so switching bots or restarting preserves the diff at the time of each operation without requiring Git.
- Each preview retains at most **2,000 lines** and **128K characters**. Larger previews are marked as truncated while line statistics still cover the complete change; a diff calculation timeout displays an unavailable preview.
- Sensitive-path writes are rejected before approval, and non-text writes do not retain content diffs.
- The **Changes** history covers file-tool operations only (excluding changes made by shell commands) and records individual operations rather than a net session diff. Action audits and model-facing tool results continue to contain metadata only.

## Reloading, pending approvals, and atomic writes

- Reloading the desktop cancels the current task.
- If an approved file operation is still waiting on its folder, you can resume chatting while its original turn tracks the outcome. Ya saves the turn before accepting a file approval.
- Desktop whole-file writes stage the complete content beside the destination and publish it atomically. As with `local_edit`, replacing a file preserves its ordinary permissions and ownership, while creating a new file identity (ACLs, extended attributes, and hard links are not carried over).

## Workspace controls, vision, and shortcuts

- **Keyboard shortcuts:** `Ctrl/⌘+N` creates a new bot, `Ctrl/⌘+B` collapses the sidebar, `Ctrl/⌘+,` opens or closes **Settings** (organized into **General**, **Account & API**, **Storage**, **Shortcuts**, and **About** with live search via `Ctrl/⌘+F`), and `Ctrl/⌘+Enter` sends a task.
- **Model & reasoning controls:** live in the workspace and save immediately when changed. `deepseek-flash` is selected by default and supports native vision input; select it before attaching images.
- **Task options menu:** in the composer; toggles local tools, web search, Tree of Agents (ToA), and image detail (`low` is labeled as API-key-only while signed in with a DeepSeek account).
- **Additional capabilities:** bilingual English / 简体中文 UI, DeepSeek platform account sign-in and settings, memory review and pruning, ToA preflight, streaming simple answers, vision image selection, and audit-history management.
- **Memory resilience:** desktop conversation history stays available even if the Octop Memory runtime fails to load.

## Isolated renderer architecture

The desktop application does **not** start a local web server. The Electron renderer has no Node.js or direct filesystem access; all API calls, credential handling, and filesystem operations run in the Electron main process behind validated IPC handlers via a narrow context-isolated preload bridge.

For vision attachments, the renderer receives only opaque selection IDs plus display metadata. Local paths and image bytes remain in the main process and are cleared after the task finishes, when the selection is cleared, or when the window closes.
