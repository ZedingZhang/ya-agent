#!/usr/bin/env bash
set -euo pipefail

work=$(mktemp -d "$RUNNER_TEMP/ya-signing.XXXXXX")
keychain="$work/signing.keychain-db"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
printf '%s' "$MAC_CSC_LINK" | base64 --decode > "$work/certificate.p12"
password=$(openssl rand -hex 32)
security create-keychain -p "$password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$password" "$keychain"
security import "$work/certificate.p12" -k "$keychain" -P "$MAC_CSC_KEY_PASSWORD" -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
identity=$(security find-identity -v -p codesigning "$keychain" | awk '/"Developer ID Application:/ {print $2; exit}')
test -n "$identity" || { echo 'No valid Developer ID Application identity'; exit 1; }

cli="release-cli/$CLI_ASSET"
codesign --force --timestamp --options runtime --entitlements .github/signing/cli.entitlements.plist \
  --keychain "$keychain" --sign "$identity" "$cli"
codesign --verify --strict --verbose=2 "$cli"
# Enforce Apple's Developer ID trust anchor and the configured publisher team.
requirement="anchor apple generic and certificate leaf[subject.OU] = \"$APPLE_TEAM_ID\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
codesign --verify -R "$requirement" "$cli"
ditto -c -k --keepParent "$cli" "$work/cli.zip"
xcrun notarytool submit "$work/cli.zip" --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 30m --output-format json > "$work/notarization.json"
node -e 'const r=require(process.argv[1]); if(r.status!=="Accepted") throw new Error("CLI notarization failed: "+r.status)' "$work/notarization.json"
# Raw executables cannot carry a stapled ticket. Apple keeps the ticket online.

# Check what users actually download, including the stapled GUI ticket.
shopt -s nullglob
archives=(release/electron/*.zip)
test "${#archives[@]}" -eq 1
ditto -x -k "${archives[0]}" "$work/gui"
apps=("$work/gui/"*.app)
test "${#apps[@]}" -eq 1
codesign --verify --deep --strict --verbose=2 "${apps[0]}"
codesign --verify -R "$requirement" "${apps[0]}"
xcrun stapler validate "${apps[0]}"
spctl --assess --type execute --verbose=2 "${apps[0]}"
