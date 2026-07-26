# Ya

[English](README.md) | [中文](README.zh-CN.md)

Ya 是一个以用户同意为先的个人研究型 CLI Agent。它使用 DeepSeek V4 API，
在本地保存长期记忆，并且仅会在用户明确请求和确认后，才启动受限的
Tree of Agents（ToA）模式。

## 安装

Ya 需要 Python 3.9 或更高版本。

```sh
python3 -m pip install .
ya auth deepseek
```

如需进行开发，请以可编辑模式安装当前检出目录：

```sh
python3 -m pip install -e .
python3 -m pytest -q
```

`ya auth deepseek` 会将密钥保存至 macOS 钥匙串。对于非交互式环境，请改为设置
`DEEPSEEK_API_KEY`。Ya 会将配置和记忆存储在 `~/.ya` 下；可通过设置 `YA_HOME`
使用其他本地状态目录。

## 使用

```sh
ya ask "Explain Graph Engineering"
ya ask "Compare two database designs" --model pro --thinking on
ya ask "Assess this proposal" --toa --toa-workers 2
ya memory review
```

`--toa` 会显示预检信息并要求确认。在非交互式 shell 中，请使用
`--toa --yes` 显式授权当前运行。

## 安全模型

- 仅接受 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- 原始推理内容仅在一次正在进行的工具调用循环中保留。
- 反馈会先成为候选记忆；只有在明确批准后才会影响未来行为。
- `YA_HOME` 可覆盖 Ya 的本地状态目录，便于测试或移植。

## 许可证

MIT。详见 [LICENSE](LICENSE)。
