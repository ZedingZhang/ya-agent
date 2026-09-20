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

## Milestones

| # | Scope | State |
|---|-------|-------|
| 0 | Toolchain, crate scaffold, napi bridge, parity harness | done |
| 1 | `config` — model table, aliases, retired-id migration, vision rules | ported + parity verified; TS not switched yet |
| 2 | `keychain` — macOS `security` shell-out, `DEEPSEEK_API_KEY` fallback | done: ported, parity verified pre-switch, TS delegates |
| 3 | `memory` — card storage, ranking (English keywords + Chinese n-grams) | next |
| 4 | `images` — signature sniffing, data URLs, size limits | not started |
| 5 | `web` — result parsing and normalisation | not started |
| 6 | `deepseek` — payload/response/SSE logic; transport stays in TS | not started |
| 7 | `orchestrator` — single agent, tool rounds, ToA workers | not started |
| 8 | `local` — workspace confinement, audit rotation, unified diff | not started |
| 9 | `service` + CLI front end | not started |
| 10 | Packaging: prebuilt bindings per platform, `electron-builder` + `pkg` | not started |

The TypeScript modules stay in place and keep working while each port lands, so
the branch is never in a half-broken state.
