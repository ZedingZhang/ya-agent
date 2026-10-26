#!/usr/bin/env bash
set -euo pipefail

assets=${1:?Expected release asset directory}
output=${2:?Expected release notes output file}
arm64=$(cat "$assets/ya-macos-arm64.signing-mode")
x64=$(cat "$assets/ya-macos-x64.signing-mode")
test "$arm64" = "$x64" || { echo 'macOS signing modes do not match' >&2; exit 1; }
case "$arm64" in
  signed)
    english='Developer ID signed with hardened runtime; Apple notarization verified for CLI and GUI'
    chinese='CLI 和 GUI 均已通过 Developer ID 签名、加固运行时及 Apple 公证验证'
    ;;
  ad-hoc)
    english='No publisher signing; GUI uses ad-hoc signatures without Apple notarization'
    chinese='无发布者签名；GUI 使用 ad-hoc 临时签名，未经 Apple 公证'
    ;;
  *) echo 'Invalid macOS signing mode record' >&2; exit 1 ;;
esac
sed -e "s/@@MACOS_SIGNING_EN@@/$english/g" -e "s/@@MACOS_SIGNING_ZH@@/$chinese/g" \
  .github/release-notes.md > "$output"
