# Release signing

Current releases intentionally ship without publisher code signing or Apple
notarization. No signing secrets or paid developer accounts are required.

The release workflow disables signing identity discovery, Windows signing, and
Apple notarization. macOS GUI packages use an ad-hoc identity (`-`) with hardened
runtime disabled so the packaged Electron application can run without a Developer
ID certificate. Ad-hoc signatures do not authenticate the publisher. The CLI
packager may also add ad-hoc signatures required by macOS ARM64.

macOS Gatekeeper and Windows SmartScreen may warn about or block downloaded
applications. SHA-256 values in `checksums.txt` let users compare their files with
release assets; checksums do not substitute for publisher signing or notarization.

## Adding publisher signing in the future

The scripts `.github/scripts/sign-macos.sh` and
`.github/scripts/sign-windows.ps1` are retained as references but are not run by
the current workflow. Re-enabling signed releases requires updating the workflow,
restoring hardened runtime and notarization, supplying credentials, and verifying
the resulting CLI and GUI downloads on each platform.

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 PKCS#12 containing a Developer ID Application certificate and private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that PKCS#12 file |
| `APPLE_ID` | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Team ID matching the Developer ID certificate |
| `WIN_CSC_LINK` | Base64 PFX containing a trusted code-signing certificate and private key |
| `WIN_CSC_KEY_PASSWORD` | Password protecting that PFX file |

The retained Windows script requires an importable PFX. Hardware-backed and cloud
signing services require their own CI integration; adding these secrets alone is
not sufficient. Never commit private keys or passwords.
