---
date: 2026-10-11
topic: "YA Desktop project and session navigation"
status: done
completed: 2026-10-12
---

# YA Desktop project and session navigation

## Goal

Create a new branch and adapt the DeepSeek Harness desktop layout to YA: project and session navigation on the left, conversation and composer on the right, and a Settings entry pinned to the bottom-left. Preserve existing memory, files, tool approval, images, and command controls.

## Decisions

- Work on `codex/desktop-harness-layout` (requested).
- Reference the official `apps/desktop`, `client/ui-layout`, `client/ui-sidebar`, and `client/ui-conversation` sources; implement the layout using YA's existing renderer and isolated Electron bridge (assumed).
- Keep projects chosen through the existing native directory picker and add validated activation of previously chosen projects (assumed).
- Store session transcripts and drafts locally for navigation; keep the existing task service behavior (assumed).
- Present files and task context in an optional drawer, automatically reveal pending approvals, and preserve the Memory page (assumed).

## Todo

- [x] Implement project/session navigation and local session history.
- [x] Rebuild the two-column shell, conversation, composer, and bottom Settings navigation.
- [x] Validate behavior in Electron, update desktop documentation/screenshots, review and commit.

## Verification

- `npm run check`
- `npm run smoke:gui` with an isolated temporary YA home and Electron profile.
- Electron interaction checks: project/session switching and persistence, draft isolation, Settings/Memory navigation, approvals, keyboard shortcuts, narrow/large windows, English/Chinese, and light/dark appearance.

## Verification results

- Full check: 267 tests passed, 3 platform-dependent tests skipped; typecheck and production build passed.
- Electron smoke uses an isolated home/profile, validates draft and transcript restoration after reload, and exercises real renderer/IPC/controller task round trips using a deterministic runner without model API requests.
- Live smoke scenarios cover streaming while the task is still running, approved file writing, task-time project locks, failure history, and subsequent session restoration.
- Layout geometry passes in English and Chinese, light and dark appearance, at 920 × 680 and 1440 × 900.
- Settings field containment, non-overlapping cards, and the scroll-reachable Save button pass in the same matrix.
- A negative control that removed the first streamed chunk from generated output failed as intended; a clean rebuild and the complete positive smoke passed afterward.

## Code review

Review target: working diff against `6cdad722a47206220129d1966d521d12bb54f5f3`.

### Standards

No remaining Standards findings after the final targeted review. Fixed all Minor findings: shared navigation completion/lock handling, removed duplicate completed-command output buffers, and restored expanded formatting of the existing Memory/Settings forms. Also corrected smoke-home isolation and Windows shutdown cleanup. The Important streaming-validation gap is fixed: the deterministic runner waits for a partial reply in the live renderer before completing, and the negative control proves that final content cannot satisfy the streaming assertion.

### Spec

No remaining Spec findings. The follow-up review verified both READMEs and refreshed locale screenshots. Its Minor streaming-coverage note is addressed by the live-delivery check and negative control.

## PR review regression fixes — 2026-10-12

- Preserve access to transcripts and drafts for unavailable project directories, including cross-project selection and reopening after the active filesystem workspace has been cleared. Keep native-picker authorization and activation validation intact, and disable local tools instead of inheriting the previous project's folder.
- Cancel tasks when the renderer starts loading, wait for cancellation to settle before returning startup state, and suppress cancelled-task content, activity, command events, and late approval requests. Keep the replacement renderer inactive until initialization completes.
- Before the fixes, the unavailable-history Electron case failed because it remained in the other project; the active-task reload case failed because the task was not cancelled. The main-process reload lifecycle cases also failed on the old code.
- After the fixes, `npm run check` passed with 269 tests and 3 platform-dependent skips. Real Electron smoke exercises both regression scenarios; the IPC test additionally covers delayed stopping and events after the next task has started.

## References

- https://github.com/deepseek-ai/deepseek-harness/tree/master/apps/desktop
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/src/client/AppFrame.tsx
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/client/ui-conversation
