#!/usr/bin/env bash
set -euo pipefail

required=(MAC_CSC_LINK MAC_CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID)
provided=0
for name in "${required[@]}"; do
  if [[ -n "${!name:-}" ]]; then provided=$((provided + 1)); fi
done
mode_file="release-cli/${CLI_ASSET:?}.signing-mode"
rm -f -- "$mode_file"
if [[ "$provided" -ne 0 && "$provided" -ne "${#required[@]}" ]]; then
  echo "Incomplete macOS signing credentials; set all five documented secrets or remove all five for an ad-hoc release." >&2
  exit 1
fi

read -r -a electron_args <<< "${ELECTRON_ARGS:?}"
if [[ "$provided" -eq 0 ]]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder "${electron_args[@]}" --publish never \
    --config.forceCodeSigning=false --config.mac.identity=- \
    --config.mac.hardenedRuntime=false --config.mac.notarize=false
  bash .github/scripts/verify-macos.sh ad-hoc
  mode=ad-hoc
else
  CSC_IDENTITY_AUTO_DISCOVERY=true CSC_LINK="$MAC_CSC_LINK" CSC_KEY_PASSWORD="$MAC_CSC_KEY_PASSWORD" \
    npx electron-builder "${electron_args[@]}" --publish never --config.forceCodeSigning=true \
      --config.mac.hardenedRuntime=true --config.mac.notarize=true
  bash .github/scripts/sign-macos.sh
  mode=signed
fi

# This record is produced only after verification and travels with both assets.
printf '%s\n' "$mode" > "$mode_file"
echo "Verified macOS release mode: $mode"
