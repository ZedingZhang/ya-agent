# Installation and Standalone Releases

[English README](../README.md) | [中文 README](../README.zh-CN.md)

## Runtime requirements

- **Standalone releases (CLI and Desktop GUI):** bundle their JavaScript runtime and do not require Node.js.
- **npm release tarball and source builds:** require **Node.js 22 or newer**.
- **Long-term memory (all platforms):** uses [Octop Memory](https://github.com/TencentCloud/octop-memory) and requires **Python 3.12+** with `octop-memory==1.0.4` installed separately. See [CLI, tools, and memory reference](cli-and-tools.md#long-term-memory) for `YA_MEMORY_PYTHON` and Windows interpreter lookup details.
- **Building/testing the desktop app from source:** also requires **CMake 3.15+** and a **C compiler** for the native directory identity and file move helpers.

## Standalone releases

Download the matching files from the [latest GitHub Release](https://github.com/ZedingZhang/ya-agent/releases/latest). The CLI executables and Desktop GUI bundles are built and distributed separately.

| Operating system | CLI asset | Desktop GUI asset |
| --- | --- | --- |
| macOS Apple Silicon | `ya-macos-arm64` | `ya-gui-macos-arm64.zip` |
| macOS Intel | `ya-macos-x64` | `ya-gui-macos-x64.zip` |
| Linux x64 (glibc) | `ya-linux-x64` | `ya-gui-linux-x64` (AppImage) |
| Windows x64 | `ya-windows-x64.exe` | `ya-gui-windows-x64.exe` (portable) |

### macOS Apple Silicon

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-macos-arm64
chmod +x ya-macos-arm64
./ya-macos-arm64 ask "Explain Graph Engineering in plain language"
```

Use `ya-macos-x64` on an Intel Mac. The GUI archives are named `ya-gui-macos-arm64.zip` and `ya-gui-macos-x64.zip`.

### Linux x64

```sh
curl -fL -O https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-linux-x64
chmod +x ya-linux-x64
./ya-linux-x64 ask "Explain Graph Engineering in plain language"
```

The desktop AppImage is published as `ya-gui-linux-x64`; make it executable before launching it. Linux release binaries target x64 glibc systems such as Ubuntu 22.04 and are not built for musl-based distributions such as Alpine Linux.

### Windows x64 (PowerShell)

```powershell
Invoke-WebRequest https://github.com/ZedingZhang/ya-agent/releases/latest/download/ya-windows-x64.exe -OutFile ya-windows-x64.exe
.\ya-windows-x64.exe ask "Explain Graph Engineering in plain language"
```

The portable desktop application is `ya-gui-windows-x64.exe`.

### Verify downloads

Read each Release's notes for its macOS signing mode:

- With complete release credentials, the workflow signs both the CLI and GUI with Developer ID, enables hardened runtime, and verifies Apple notarization.
- Without credentials, the GUI uses ad-hoc signatures, which do not identify a publisher; Windows and Linux builds remain without publisher signing.
- Unsigned or ad-hoc downloads may trigger Gatekeeper or SmartScreen warnings. The existing `v0.8.0` assets predate this conditional workflow. See [release signing](release-signing.md) for setup and verification details.

Download `checksums.txt` from the same release and compare the matching SHA-256 value:

```sh
shasum -a 256 ya-macos-arm64
# Linux: sha256sum ya-linux-x64
```

```powershell
Get-FileHash .\ya-windows-x64.exe -Algorithm SHA256
```

## Install the CLI from a release tarball

Install Node.js 22 or newer, then download `ya-agent-<version>.tgz` from the [GitHub Release assets](https://github.com/ZedingZhang/ya-agent/releases/latest). Before running the command, replace `<version>` with the package version in the downloaded filename, without the tag's leading `v`. Run it from the directory containing that file:

```sh
npm install -g "./ya-agent-<version>.tgz"
ya --help
```

The release workflow attaches the npm tarball to GitHub Releases; it does not publish it to the npm registry. This package installs the CLI. For the desktop app or a CLI that does not require Node.js, use the [standalone releases](#standalone-releases) above.

> [!NOTE]
> The published `v0.8.0` tarball still uses legacy native bindings: a clean Windows installation fails to start with `Cannot find native binding`. Until a release built from the current TypeScript core is available, use [source installation](#install-from-source).

## Install from source

Requires Node.js 22+, Python 3.12+ (for long-term memory), CMake 3.15+, and a C compiler (for desktop native helpers):

```sh
git clone https://github.com/ZedingZhang/ya-agent.git
cd ya-agent
npm ci
python -m pip install octop-memory==1.0.4
npm run check
npm link
```

After `npm link`, the `ya` command is available in your current Node.js environment. You can also run it without linking:

```sh
npm start -- ask "Explain Graph Engineering in plain language"
```

Start the desktop application from source with:

```sh
npm run gui
```
