# Ya v0.7.2 — Composer alignment polish

This patch refines the desktop workspace composer after moving model controls
into it.

## What changed

- Removed the trailing Chinese full stop from the empty image-selection message,
  so it now reads `尚未添加图片`.
- Aligned the Tree of Agents checkbox and label vertically with the adjacent
  model, reasoning-effort, web, and worker controls.
- Preserved task-control wrapping at narrow window sizes.

## Compatibility and verification

- Existing v0.7.1 configuration, memory, GUI preferences, Keychain credentials,
  and audit logs remain compatible.
- CLI and model behavior are unchanged.
- Type checking, all 110 automated tests, the production build, npm package
  dry-run, and the Electron renderer smoke test pass.
- The Chinese workspace layout was also checked in a live, isolated GUI session
  against the reported screenshot.
- macOS and Windows applications remain unsigned; verify `checksums.txt` before
  overriding an operating-system warning.

---

# Ya v0.7.2 — 工作区排版微调

此补丁继续完善模型控件迁入主工作区后的桌面端任务编写区。

## 主要变化

- 移除未选择图片提示末尾的中文句号，现在显示为 `尚未添加图片`。
- 将 Tree of Agents 的复选框和文字与相邻的模型、推理强度、网页及工作
  Agent 控件垂直对齐。
- 保持窄窗口下任务控件自动换行的行为。

## 兼容性与验证

- v0.7.1 的配置、记忆、GUI 偏好、钥匙串凭据和审计日志继续兼容。
- CLI 与模型行为保持不变。
- TypeScript 类型检查、全部 110 项自动化测试、生产构建、npm 打包预检和
  Electron renderer 烟测均已通过。
- 另使用隔离配置的真实中文 GUI，对照反馈截图检查了工作区布局。
- macOS 与 Windows 应用仍未签名；绕过系统警告前请先核对
  `checksums.txt`。
