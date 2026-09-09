# Ya v0.7.0 — DeepSeek vision

Ya now supports DeepSeek's experimental `deepseek-v4-flash-vision-exp`
multimodal model in both the command-line client and desktop application. The
implementation follows DeepSeek's OpenAI-compatible Chat Completions vision
format and keeps the existing consent, memory, tool, and workspace boundaries.

## What changed

- Added the `vision` model alias and persisted
  `deepseek-v4-flash-vision-exp` configuration.
- Added repeatable CLI `--image` input for local files, public HTTP(S) URLs,
  base64 data URLs, and existing DeepSeek `file-api-*` IDs.
- Added `--image-detail` with `auto`, `low`, `high`, and `original` modes.
- Added native multi-image selection to the Electron desktop application,
  including file metadata chips, image-only prompts, and bilingual UI copy.
- Propagated multimodal user messages through streaming, tool calls, single
  Agent, Tree of Agents (ToA), root synthesis, and the bounded ICM follow-up.
- Exported the vision types, model helpers, image inspection utilities, and
  content-part builders from the npm package.

## Validation and safety

- JPEG, PNG, GIF, and WebP inputs are detected from their file signatures
  instead of trusting file extensions or declared MIME types.
- Non-vision models and images outside `user` messages are rejected before a
  network request is sent.
- Ya enforces the 600-image and 8,192-character URL limits. Local and data-URL
  inputs use a conservative 32 MiB aggregate cap to leave room under
  DeepSeek's 48 MiB request-body limit.
- Desktop renderer code receives opaque image IDs and display metadata only;
  local paths and image bytes stay in the Electron main process. Files are
  checked again before transmission and selections are cleared after use.
- ToA preflight now warns that images are resent to workers, root synthesis,
  and follow-up requests because image tokens are billed per request.

See the official [DeepSeek vision guide](https://api-docs.deepseek.com/guides/vision/)
for model behavior and service-side limits.

## Compatibility and verification

- Existing v0.6.0 configuration, memory, GUI preferences, Keychain credentials,
  and audit logs remain compatible.
- Existing CLI behavior is unchanged when no image is attached.
- Type checking, all 109 automated tests, the production build, npm package
  dry-run, and the Electron renderer smoke test pass.
- macOS and Windows applications remain unsigned; verify `checksums.txt` before
  overriding an operating-system warning.

---

# Ya v0.7.0 — DeepSeek 视觉能力

Ya 现已在命令行与桌面应用中支持 DeepSeek 实验性多模态模型
`deepseek-v4-flash-vision-exp`。实现遵循 DeepSeek 的 OpenAI 兼容 Chat
Completions 视觉格式，并保留现有的授权、记忆、工具和工作区安全边界。

## 主要变化

- 新增 `vision` 模型别名和 `deepseek-v4-flash-vision-exp` 持久化配置。
- CLI 新增可重复的 `--image`，支持本地文件、公开 HTTP(S) URL、base64
  data URL，以及已有的 DeepSeek `file-api-*` 文件 ID。
- 新增 `--image-detail`，可选 `auto`、`low`、`high`、`original`。
- Electron 桌面端新增原生多图片选择、文件元数据标签、纯图片默认提示词和
  中英文界面文案。
- 多模态 user 消息已贯通流式输出、工具调用、单 Agent、Tree of Agents
  （ToA）、根协调合成和受限 ICM 补充请求。
- npm 包新增视觉类型、模型辅助函数、图片检查工具和内容块构建器导出。

## 校验与安全

- JPEG、PNG、GIF、WebP 按真实文件签名识别，不信任文件扩展名或声明的
  MIME 类型。
- 非视觉模型或出现在 `user` 以外消息中的图片会在网络请求前被拒绝。
- Ya 执行 600 张图片和 URL 8,192 字符上限。本地文件与 data URL 使用
  保守的 32 MiB 总量限制，为 DeepSeek 的 48 MiB 请求体上限留出空间。
- 桌面渲染进程只接收不透明图片 ID 和展示元数据；本地路径与图片字节只
  留在 Electron 主进程。发送前会再次检查文件，用后会清除选择。
- ToA 预检会提示图片将重复发送给工作 Agent、根协调 Agent 和后续请求，
  因为每次请求都会计算图片 Token。

模型行为与服务端限制详见 DeepSeek 官方的
[视觉理解指南](https://api-docs.deepseek.com/guides/vision/)。

## 兼容性与验证

- v0.6.0 的配置、记忆、GUI 偏好、钥匙串凭据和审计日志继续兼容。
- 不附加图片时，现有 CLI 行为不变。
- TypeScript 类型检查、全部 109 项自动化测试、生产构建、npm 打包预检和
  Electron renderer 烟测均已通过。
- macOS 与 Windows 应用仍未签名；绕过系统警告前请先核对
  `checksums.txt`。
