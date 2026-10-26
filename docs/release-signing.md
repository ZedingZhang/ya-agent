# Release signing

macOS Release packaging selects its mode from the five secrets below. With none
configured, it builds an ad-hoc GUI without hardened runtime or notarization. With
all five configured, electron-builder imports the Developer ID certificate and
builds a signed GUI with hardened runtime and notarization; the CLI is signed and
submitted to Apple by `.github/scripts/sign-macos.sh`. A partial configuration or
any signing/notarization failure stops the job instead of falling back to ad-hoc.

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 PKCS#12 containing a Developer ID Application certificate and private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that PKCS#12 file |
| `APPLE_ID` | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Team ID matching the Developer ID certificate |

The workflow maps `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` to electron-builder's
`CSC_LINK` and `CSC_KEY_PASSWORD`. Identity discovery and required signing are
enabled only on the signed branch. No disabling identity, hardened-runtime or
notarization overrides are passed there. Never commit private keys or passwords.

## Verification and release notes

Both modes unpack the actual GUI ZIP and verify its complete code signature.
Ad-hoc builds must have an ad-hoc signature. Signed builds additionally verify the
Apple Developer ID trust anchor, configured team, hardened runtime, stapled GUI
notarization ticket and Gatekeeper assessment. The CLI signature, team and
hardened runtime are verified, and its notarization submission must return
`Accepted`. Raw executables cannot carry a stapled ticket; Apple keeps the CLI's
accepted ticket online.

Each successful macOS job emits a `ya-macos-<arch>.signing-mode` asset containing
`signed` or `ad-hoc` only after verification passes. The publish job requires both
architecture records to agree and uses them to render the English and Chinese
release notes. The records are included in `checksums.txt`. Existing releases,
including `v0.8.0`, are not changed by this workflow update.

CI builds and verifies real ad-hoc macOS CLI/GUI packages without release secrets.
Synthetic tool fixtures cover the signed command path, all partial configurations
and verification failures. A real signed/notarized release requires the configured
Developer ID and Apple credentials; the release job enforces verification before
uploading its artifacts.

## Other platforms and local packaging

Windows and Linux release behavior remains unchanged: neither receives publisher
signing. Gatekeeper and SmartScreen may warn about or block unsigned/ad-hoc
downloads. Compare files with `checksums.txt`; checksums do not replace publisher
signing or notarization. The retained `.github/scripts/sign-windows.ps1` reference
is not invoked by the workflow. Configuring `WIN_CSC_LINK` and
`WIN_CSC_KEY_PASSWORD` alone does not enable it.

Local `npm run package:gui` retains electron-builder's normal configuration.
For an explicit local ad-hoc macOS build, use:

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run package:gui -- --mac zip \
  --config.mac.identity=- --config.mac.hardenedRuntime=false --config.mac.notarize=false
```
