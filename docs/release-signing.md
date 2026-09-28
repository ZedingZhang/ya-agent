# Release signing

Tag releases require signing credentials before building on macOS or Windows.
Missing credentials, invalid signatures, or failed Apple notarization stop the
release; the publish job waits for every platform. Local development builds do
not require certificates. Existing published downloads are not changed by this
workflow update; a new tag is needed to publish signed replacements.

Configure these repository Actions secrets (Settings → Secrets and variables →
Actions). Never commit certificates or passwords:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64 PKCS#12 (`.p12`) containing a valid **Developer ID Application** certificate and private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting that PKCS#12 file |
| `APPLE_ID` | Apple developer account used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Team ID matching the Developer ID certificate |
| `WIN_CSC_LINK` | Base64 PKCS#12 (`.pfx`) containing a publicly trusted code-signing certificate and private key |
| `WIN_CSC_KEY_PASSWORD` | Password protecting that PKCS#12 file |

Both certificate secrets must contain base64 file contents, not URLs or paths.
Use password-protected certificates. A self-signed certificate does not meet the
release trust checks. If your Windows provider only supports hardware-backed or
cloud signing and cannot supply a usable PFX, this workflow needs that provider's
signing integration before a release can run; do not export a non-exportable key
or substitute a self-signed certificate.

The macOS GUI uses electron-builder's hardened runtime, Developer ID signing,
notarization, and ticket stapling. The downloaded ZIP is extracted and checked
with `codesign`, `stapler`, and Gatekeeper before upload. The CLI is separately
signed with hardened runtime and submitted to Apple's notary service; only an
`Accepted` response permits publishing. Its entitlements allow Node/V8 JIT and
loading the packaged native addon. Raw CLI executables cannot carry stapled
tickets, so notarization lookup requires network access on first use.

Windows GUI executables, DLLs, native addons, and the portable wrapper are signed
by electron-builder. The CLI is signed with Authenticode separately. All are
checked for a valid trusted signature, timestamp, and expected certificate before
upload. Signing identifies the publisher; SmartScreen reputation can still take
time to accumulate for a new certificate or download.

After configuring credentials, push the next version tag through the existing
release process. Confirm both macOS architectures and Windows pass the signing
steps before distributing the new release. SHA-256 checksums are generated from
the final signed assets. Certificate-dependent checks require GitHub's macOS and
Windows runners and cannot be proven by local unit tests without credentials.

References: [electron-builder signing](https://www.electron.build/code-signing.html),
[Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
