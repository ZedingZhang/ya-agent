#!/usr/bin/env bash
set -euo pipefail

mode=${1:?Expected signed or ad-hoc}
case "$mode" in signed|ad-hoc) ;; *) echo 'Invalid macOS verification mode' >&2; exit 1 ;; esac
work=$(mktemp -d "${RUNNER_TEMP:?}/ya-verify.XXXXXX")
case "$work" in "$RUNNER_TEMP"/ya-verify.*) ;; *) exit 1 ;; esac
trap 'rm -rf -- "$work"' EXIT

shopt -s nullglob
archives=(release/electron/*.zip)
test "${#archives[@]}" -eq 1 || { echo 'Expected one macOS GUI archive' >&2; exit 1; }
ditto -x -k "${archives[0]}" "$work/gui"
apps=("$work/gui/"*.app)
test "${#apps[@]}" -eq 1 || { echo 'Expected one macOS app in the archive' >&2; exit 1; }
app=${apps[0]}
codesign --verify --deep --strict --verbose=2 "$app"
signature=$(codesign --display --verbose=4 "$app" 2>&1)
if [[ "$mode" == signed ]]; then
  requirement="anchor apple generic and certificate leaf[subject.OU] = \"${APPLE_TEAM_ID:?}\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
  codesign --verify -R "$requirement" "$app"
  grep -q 'flags=.*runtime' <<< "$signature" || { echo 'GUI hardened runtime verification failed' >&2; exit 1; }
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
else
  grep -q '^Signature=adhoc$' <<< "$signature" || { echo 'Expected an ad-hoc GUI signature' >&2; exit 1; }
fi
