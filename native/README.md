# Ya core (Rust)

The shared core of Ya, compiled to a Node-API addon so the CLI and the Electron
desktop application keep consuming **one** implementation instead of two that
drift apart.

```
src/cli.ts        ─┐
                   ├─► native/ya-core.<platform>.node   (this crate)
src/gui/main.ts   ─┘
```

The root `package.json` depends on this crate as `ya-core` (`file:./native`), so
`import ... from "ya-core"` resolves from both `src/` (vitest) and
`dist/typescript/` (the built CLI).

## Build

```sh
npm install                       # once, installs @napi-rs/cli and links ya-core
npm run build                     # debug binding
npm run build -- --release        # release binding
```

Outputs: `ya-core.<platform-arch-abi>.node` (git-ignored), plus the generated
`index.js` and `index.d.ts`, which are committed so typechecking works without a
Rust toolchain.

Windows needs the MSVC linker and the Windows SDK; Rust finds them through the
Visual Studio Build Tools installation.

## Verifying a port

Each module is ported in three ordered steps, and the order matters:

1. **Port** the logic to Rust.
2. **Run parity while both implementations still exist** — `npm run test:parity`
   compares the TypeScript and Rust implementations. Run it *before* step 3,
   because once the TypeScript module delegates, its parity section compares
   Rust with itself and proves nothing.
3. **Delegate**: rewrite the TypeScript module to call `ya-core`, keeping its
   exported API so callers do not change.

The vitest suite is the ongoing gate after step 3; parity is the gate before it.

## Testable I/O seams

The TypeScript tests mock `node:fs`, `node:child_process`, and `process.platform`,
and none of those mocks survive the move into Rust. Rather than reintroduce
mocking, the ported functions take the environment as parameters —
`macosKeychainAvailable(platform, securityPath)` and
`saveApiKey(key, platform, securityPath)` — so tests can exercise the real code
path on any host. `tests/keychain.test.ts` fails a genuine subprocess by pointing
`securityPath` at a real non-executable file, which is stronger than the mock it
replaced.

## JavaScript compatibility

`src/compat.rs` collects the places where JavaScript semantics differ from the
Rust default. Each one was found by the parity harness rather than assumed:

- `is_js_space` — JavaScript's `\s` also matches `\uFEFF` and the line and
  paragraph separators, which `char::is_whitespace` does not.
- `utf16_len` — `String.prototype.length` counts UTF-16 code units, so
  length-based guards disagree with `chars().count()` on astral characters.
- `decode_base64_lenient` — `Buffer.from(value, "base64")` ignores padding and
  trailing characters that do not complete a group of four; the `base64` crate
  rejects what Node accepts, so it is used for encoding only.
- Lone surrogates — JavaScript strings can hold the lone surrogate that
  `String.fromCodePoint` produces for `&#xD800;`. Rust strings are valid UTF-8
  and cannot, so the code point becomes U+FFFD. This is the one permanent
  behavioural difference and it is recorded as a golden check.

## Milestones

| # | Scope | State |
|---|-------|-------|
| 0 | Toolchain, crate scaffold, napi bridge, parity harness | done |
| 1 | `config` — model table, aliases, retired-id migration, vision rules | done: behaviour ported, TS delegates; `VALID_MODELS` stays as the compile-time contract and a test pins it to the Rust table |
| 2 | `keychain` — macOS `security` shell-out, `DEEPSEEK_API_KEY` fallback | done: ported, parity verified pre-switch, TS delegates |
| 3 | `memory` — ranking: NFKC folding, English words/phrases, Han n-grams | done: ranking ported, parity verified pre-switch, TS delegates; card file I/O stays in TS |
| 4 | `images` — signature sniffing, data URLs, source validation | done: ported, parity verified pre-switch, TS delegates; file inspection stays in TS |
| 5 | `web` — search-result parsing, redirect unwrapping, HTML entities | done: ported, parity verified pre-switch, TS delegates; the HTTP call stays in TS |
| 6 | `deepseek` — request body, reply parsing, stream chunks, SSE framing | done: ported, parity verified pre-switch, TS delegates; transport and the retry loop stay in TS |
| 7 | `orchestrator` — single agent, tool rounds, ToA workers | next |
| 8 | `local` — workspace confinement, audit rotation, unified diff | not started |
| 9 | `service` + CLI front end | not started |
| 10 | Packaging: prebuilt bindings per platform, `electron-builder` + `pkg` | not started |

The TypeScript modules stay in place and keep working while each port lands, so
the branch is never in a half-broken state.
