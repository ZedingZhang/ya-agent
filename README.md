# Ya

Ya is a consent-first personal research CLI agent. It uses the DeepSeek V4 API,
keeps long-term memory locally, and only starts its bounded Tree of Agents
(ToA) mode when the user explicitly requests and confirms it.

## Install

Ya requires Python 3.9 or later.

```sh
python3 -m pip install .
ya auth deepseek
```

For development, install the checkout in editable mode:

```sh
python3 -m pip install -e .
python3 -m pytest -q
```

`ya auth deepseek` stores the key in the macOS Keychain. For non-interactive
environments, set `DEEPSEEK_API_KEY` instead. Ya stores configuration and
memory under `~/.ya`; set `YA_HOME` to use a different local state directory.

## Use

```sh
ya ask "Explain Graph Engineering"
ya ask "Compare two database designs" --model pro --thinking on
ya ask "Assess this proposal" --toa --toa-workers 2
ya memory review
```

`--toa` shows a preflight and requires confirmation. In a non-interactive
shell, use `--toa --yes` to explicitly authorize the current run.

## Safety model

- Only `deepseek-v4-flash` and `deepseek-v4-pro` are accepted.
- Raw reasoning content is kept only during an in-flight tool-call loop.
- Feedback becomes a candidate memory first; it changes future behavior only
  after explicit approval.
- `YA_HOME` can override Ya's local state directory for tests or portability.

## License

MIT. See [LICENSE](LICENSE).
