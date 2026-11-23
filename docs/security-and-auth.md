# Authentication, Security Boundaries, and Networking

[English README](../README.md) | [中文 README](../README.zh-CN.md)

## DeepSeek authentication

Ya supports two ways to authenticate with DeepSeek: **DeepSeek platform account sign-in** (browser PKCE flow) and **API keys**. While signed in with a platform account, the account takes priority over API keys.

### DeepSeek platform account sign-in

- **Desktop app:** open **Settings → DeepSeek platform account → Sign in with DeepSeek**. Your browser opens [DeepSeek's platform](https://platform.deepseek.com/), where you sign in and approve the connection. Return to Ya after authorization. You can cancel while waiting, or sign out from the same settings card.
- **CLI:**

```sh
ya login deepseek
ya auth-status deepseek
ya ask "Explain this project" --web off
ya logout deepseek
```

Operational and protocol details:

- Run the CLI command and browser on the same computer. If the browser does not open automatically, open the URL printed by the CLI; `Ctrl+C` cancels the attempt.
- The local OAuth callback listens only on `127.0.0.1` on a temporary port, and authorization expires after at most **10 minutes**.
- Account sign-in uses the PKCE protocol implemented by [DeepSeek's official Harness](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform). Ya receives a platform account grant and sends it to the official Messages API as `x-dsh-auth-token`; it never requests your password. Available access and billing follow your platform account.
- Signing out removes the local account grant and attempts remote session revocation; existing API keys remain available. A rejected account token prompts you to sign in again.

### Credential storage by platform

| Operating system | Platform account grant storage | API key storage |
| --- | --- | --- |
| macOS | macOS Keychain (separate service from API keys) | macOS Keychain (`ya auth deepseek`) or `DEEPSEEK_API_KEY` |
| Linux x64 | Plaintext JSON at `~/.ya/auth/credentials.json` (`0700`/`0600`) | `DEEPSEEK_API_KEY` or session-only key in GUI Settings |
| Windows x64 | Plaintext JSON at `~/.ya/auth/credentials.json` (directory ACLs) | `DEEPSEEK_API_KEY` or session-only key in GUI Settings |

Set `YA_HOME` to store credentials and state under another directory (`$YA_HOME/auth/credentials.json` on Linux/Windows, or a separate Keychain entry on macOS).

- **macOS Keychain behavior:** CLI and GUI share the Keychain entry for the same data directory. Existing plaintext records automatically migrate to Keychain and are removed only after a successful save and read-back verification. Account operations share a process lock; if another process is modifying the login, Ya reports that storage is busy so you can retry after it finishes. If Keychain access or migration fails, Ya reports an error and retains any existing credential file; unlock Keychain and retry, or run `ya logout deepseek` to remove the login.
- **Linux and Windows plaintext storage:** `credentials.json` is stored unencrypted and separately from settings. Linux sets `0700` directory and `0600` file permissions; Windows relies on directory access controls. These controls restrict local access without encrypting the grant—use **disk encryption** and **encrypted backups** (including for any macOS record awaiting migration) and keep the data directory private.
- **API keys:** `ya auth deepseek` is macOS-only because it uses the system `security` utility. On Linux and Windows, export `DEEPSEEK_API_KEY` in your environment or enter a session-only API key in Desktop **Settings**.
- **Exposure safeguards:** grants are never returned to the desktop renderer or stored in conversation history or task records, and local file tools block reading credential files.

## Command execution boundaries and environment allowlist

When `--local --exec` is enabled in the CLI:

- Only the **initial working directory** is confined to the resolved workspace. Shell commands execute with your user account's permissions and can modify or delete files elsewhere or access the network; execution is **not sandboxed**.
- CLI commands use a default **environment allowlist**: system and home paths, locale and temporary-directory settings, terminal settings, and common Node.js, Python, Java, Go, Rust, Android, and .NET toolchain locations.
- Other inherited environment variables are **omitted**, including cloud/CI/API credentials, SSH agents, askpass helpers, `DEEPSEEK_API_KEY`, `YA_HOME`, and application runtime flags. Project-specific variables must be set explicitly in the command you approve. Files and other credentials accessible to your user account on disk remain accessible to commands.
- Approving `npm install` or `npm ci` can execute [dependency lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/#life-cycle-operation-order), including `postinstall`. These scripts can access files, the network, and credentials available to the command; review the repository and its dependencies before approving installation.

## Audit logs

Local file and command action audit logs record metadata only—never file contents, diffs, command text, or `stdout`/`stderr`:

- File audit entries record operation metadata; command audit entries record status, working-directory metadata, exit code, and duration.
- Logs rotate at **1 MiB** with **three archives**.
- Clear logs at any time with `ya audit clear` (or `ya audit clear --yes` in non-interactive shells).

## Desktop renderer isolation

The desktop application does not start a local web server. The Electron renderer cannot access Node.js or the filesystem directly; all API requests, credential operations, and workspace file operations execute in the Electron main process behind validated IPC handlers and a narrow context-isolated preload bridge.

## TLS and proxies

Keep certificate verification enabled. The Electron desktop application uses the operating system's Chromium network stack. For the Node.js CLI behind a trusted corporate proxy, configure Node's supported CA settings such as `NODE_EXTRA_CA_CERTS` rather than disabling TLS verification.
