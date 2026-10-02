# Ya v0.8.0 — TypeScript core and reliability fixes

## What changed

- Restored the shared TypeScript core for configuration, memory ranking,
  Keychain integration, image validation, web-result parsing, DeepSeek response
  processing, orchestration, local-operation policies, and terminal Markdown.
  Source builds and packages no longer require Rust or a Node-API binding.
- Updated model identifiers to those accepted by the API and migrated stored
  legacy model names when loading configuration.
- Improved DeepSeek retry classification and support for `Retry-After`. Malformed
  streaming responses fail without retrying; regression tests cover this behavior.
- Added actionable configuration-load errors and recovery guidance, and checked
  platform support before prompting for Keychain credentials in the CLI.
- Fixed desktop approval requests that could leave tasks stuck indefinitely.
  Requests now time out after 120 seconds, and renderer destruction, crashes, or
  window closure reject pending approvals and clear their timers.
- Fixed clipped memory forms and elements that ignored the HTML `hidden` attribute.

## Downloads and compatibility

- Separate CLI and desktop downloads target macOS ARM64/x64, Windows x64, and
  Linux x64. The Linux desktop download is an AppImage named `ya-gui-linux-x64`.
- Existing configuration and user data remain compatible; obsolete model names
  are migrated automatically.
- These builds have no publisher code signing or Apple notarization. macOS may
  use ad-hoc signatures for execution. Gatekeeper and SmartScreen may warn about
  or block downloads. Compare files with `checksums.txt` from this release. The npm package tarball is also provided as a GitHub Release asset.

---

# Ya v0.8.0 — TypeScript 核心与稳定性修复

## 主要变化

- 恢复共享 TypeScript 核心，涵盖配置、记忆排序、钥匙串、图片验证、
  网页结果解析、DeepSeek 响应处理、任务编排、本地操作策略和终端 Markdown 渲染。
  源码构建和安装包不再依赖 Rust 或 Node-API 绑定。
- 使用 API 实际支持的模型标识，加载配置时自动迁移旧模型名称。
- 完善 DeepSeek 重试分类并遵循 `Retry-After`；流式响应解析失败时直接报错，
  不再重试，回归测试覆盖这些行为。
- 为配置加载失败提供具体原因和恢复指引；CLI 在提示输入钥匙串凭据前
  先检查平台支持情况。
- 修复桌面审批请求可能导致任务一直占用的问题：审批等待超过 120 秒会
  超时报错；渲染进程销毁、崩溃或窗口关闭时拒绝待处理审批并清理计时器。
- 修复记忆表单被裁切以及部分元素不遵循 HTML `hidden` 属性的问题。

## 下载与兼容性

- 分别提供 macOS ARM64/x64、Windows x64 和 Linux x64 的 CLI 与桌面下载。
  Linux 桌面下载为名叫 `ya-gui-linux-x64` 的 AppImage。
- 现有配置和用户数据继续兼容，过时模型名称会自动迁移。
- 此版本无发布者代码签名或 Apple 公证，系统可能提示或阻止运行。下载后请核对同一
  release 中的 `checksums.txt`；npm 包 tarball 也作为 GitHub Release 附件提供。
