---
date: 2026-10-15
topic: "Preserve desktop conversation context in model requests"
status: done
---

# Preserve desktop conversation context

## Goal

On a new branch from PR #15, make follow-up desktop requests include earlier user requests and completed assistant replies from the active session. In particular, after a missing-key failure, configuring the key and sending “继续” must retain the original request. Switching sessions, projects, or reloading the application must preserve session isolation.

## Decisions

- Use `codex/fix-session-context`, based on `251968c` from PR #15 (requested).
- Reuse the existing persisted session turns as the source of text history; pass typed user/assistant messages through the existing renderer, IPC, controller, service, and orchestrator path (assumed).
- Retain user requests from failed/interrupted turns, but exclude application errors and incomplete answers from assistant history. Do not replay old permissions, commands, tool calls, or file diffs (assumed).
- Apply the same history to streaming, local/web tools, ToA, and ICM follow-ups; preserve CLI behavior when history is absent (assumed).
- Keep the existing history storage format and image attachment lifecycle (assumed).

## Todo

- [x] Identify the missing model-history path and create the repair branch.
- [x] Add focused failing regression coverage, then connect active-session history to model requests.
- [x] Verify the complete request path, review, commit, and reopen the repaired desktop application for manual testing.

## Verification

- Focused Vitest regressions for model payloads, controller forwarding, and IPC validation.
- `npm run check`
- `npm run smoke:gui` with its isolated temporary home/profile, including failed-key recovery, follow-up history, session isolation, and reload recovery.

## Findings

- `ConversationSession.turns` is persisted in renderer local storage, but `bridge.runTask` submits only the current task. `messagesForTask` always creates only a system message and the latest user message.
- Failed turns store their application error in `answer`; only completed turn answers are valid assistant history.
- The existing responsive smoke compared drawer bounds with zero tolerance. At Windows 150% scaling, its right edge was `1426.000061` in a `1426`-pixel viewport. Allow one pixel of rounding in that assertion; no layout styles changed.

## Verification results

- Before implementation, model-request, controller, and IPC history regressions failed because history was omitted.
- After implementation, the focused suite passed all 50 tests; `npm run check` passed with 303 tests and 3 platform-dependent skips.
- The real Electron context scenario checks actual outbound payloads with a deterministic local transport: missing key, configuration, “继续”, a separate session, returning to the original session, and reloading before another follow-up.
- Interrupted-turn fixtures preserve the user request while excluding the unfinished answer from outbound history.
- Final `npm run check`: type checks and build passed, 303 tests passed, 3 platform-dependent tests skipped.
- Final `npm run smoke:gui`: passed, including the context fixture and the existing desktop regressions.
- Negative control: removing only the generated renderer's history property made the real Electron smoke fail with the expected context-loss error (exit 2). Rebuilt from source afterward and verified the positive smoke again.
- Model payload checks use a deterministic local transport, without live DeepSeek requests.
- Reopened the repaired Ya desktop and confirmed its visible window is responding. Session-only API keys must be reentered after restarting, per the existing storage behavior.

## Code review

Target: uncommitted/staged repair against `251968c5349109c80b9779d83b97399711a5ef03`.

### Standards

Independent review found no Standards findings. Existing layers carry the narrow history type, IPC reconstructs only role/content, and no new dependency or abstraction was introduced.

### Spec

Independent review found no Spec findings. Verified active-session selection, failed/interrupted user requests, completed replies, reload recovery, and propagation through all model request paths. The reviewer independently reran the focused suite: 50 tests passed.
