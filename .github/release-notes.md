# Ya v0.7.1 — Workspace model controls

Ya now puts model and reasoning-effort selection where tasks are composed: in
the main workspace. These controls no longer live in Settings, so the active
model and reasoning level remain visible and easy to change while working.

## What changed

- Replaced the disabled workspace model display with a fully selectable model
  control for `deepseek-v4-flash`, `deepseek-v4-pro`, and
  `deepseek-v4-flash-vision-exp`.
- Added the `high` / `max` reasoning-effort selector beside the model control.
- Removed model and reasoning-effort inputs from Settings. Language, thinking,
  streaming, ToA limits, credentials, and audit management remain there.
- Persisted workspace model choices immediately through a dedicated IPC
  boundary, without saving unrelated or unfinished Settings edits.
- Kept controls locked while a task or model update is active to prevent
  configuration races.
- Made the task-control row wrap on narrower windows instead of hiding the
  model selector.
- Updated vision guidance so selecting the vision model in the workspace
  immediately enables image attachment.

## Compatibility and verification

- Existing v0.7.0 configuration, memory, GUI preferences, Keychain credentials,
  and audit logs remain compatible.
- CLI behavior and model configuration files are unchanged.
- Type checking, all 110 automated tests, the production build, npm package
  dry-run, and the Electron renderer smoke test pass.
- The workspace and Settings layouts were also checked in a live, isolated GUI
  session, including model persistence and vision-control activation.
- macOS and Windows applications remain unsigned; verify `checksums.txt` before
  overriding an operating-system warning.

---

# Ya v0.7.1 — 工作区模型控件

Ya 现在把模型和推理强度选择放在任务编写所在的主工作区。这两个控件不再
位于设置页，因此工作时可以直接看到并切换当前模型与推理级别。

## 主要变化

- 将原先禁用的工作区模型展示框改为可选择控件，支持
  `deepseek-v4-flash`、`deepseek-v4-pro` 和
  `deepseek-v4-flash-vision-exp`。
- 在模型旁新增 `high` / `max` 推理强度选择。
- 从设置页移除模型和推理强度；语言、思考开关、流式输出、ToA 限制、
  凭据和审计管理仍保留在设置页。
- 工作区选择变化后通过独立 IPC 立即持久化，不会连带保存设置页中尚未
  完成的其他修改。
- 任务执行或模型更新期间锁定相关控件，避免配置竞态。
- 窄窗口下任务控件会自动换行，不再隐藏模型选择。
- 更新视觉功能提示；在工作区选择视觉模型后会立即启用图片附件。

## 兼容性与验证

- v0.7.0 的配置、记忆、GUI 偏好、钥匙串凭据和审计日志继续兼容。
- CLI 行为与模型配置文件格式保持不变。
- TypeScript 类型检查、全部 110 项自动化测试、生产构建、npm 打包预检和
  Electron renderer 烟测均已通过。
- 另使用隔离配置的真实 GUI 检查工作区和设置页布局、模型持久化及视觉
  控件联动。
- macOS 与 Windows 应用仍未签名；绕过系统警告前请先核对
  `checksums.txt`。
