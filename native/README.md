# Ya core (Rust)

The shared core of Ya, compiled to a Node-API addon so the CLI and the Electron
desktop application keep consuming **one** implementation instead of two that
drift apart.

```
src/cli.ts        ─┐
                   ├─► native/ya-core.<platform>.node   (this crate)
src/gui/main.ts   ─┘
```

## Build

```sh
npm install                       # once, installs @napi-rs/cli
npm run build                     # debug binding
npm run build -- --release        # release binding
```

Outputs (git-ignored): `ya-core.<platform-arch-abi>.node`, `index.js`, `index.d.ts`.

Windows needs the MSVC linker and the Windows SDK; Rust finds them through the
Visual Studio Build Tools installation.

## Parity harness

`node parity.js` runs the same inputs through the compiled TypeScript core
(`dist/typescript/*.js`, so run `npm run build` in the repository root first) and
through this binding, and fails on any divergence.

The rewrite is verified module by module with this harness rather than by
eyeballing two implementations. Every ported module adds a section to it.

## Porting strategy

Each TypeScript module splits into two parts, which are ported differently:

- **Pure logic** — payload construction, response parsing, retry policy, SSE
  framing, memory ranking, path confinement, diff generation. Moves into Rust
  and is verified by the parity harness.
- **I/O shell** — `fetch`, `fs`, `child_process`. Stays in the host at first,
  because the existing tests inject fakes through these seams
  (`new DeepSeekClient(key, fakeFetcher)`, `tempHome()`) and a cross-language
  boundary cannot carry an injected JavaScript object without a
  `ThreadsafeFunction`. Where the shell does move, the Rust side takes a
  configurable base URL so the tests can point it at a local server.

## Milestones

| # | Scope | State |
|---|-------|-------|
| 0 | Toolchain, crate scaffold, napi bridge, parity harness | in progress |
| 1 | `config` — model table, aliases, retired-id migration, vision rules | bound, pending parity run |
| 2 | `keychain` — macOS `security` shell-out, `DEEPSEEK_API_KEY` fallback | not started |
| 3 | `memory` — card storage, ranking (English keywords + Chinese n-grams) | not started |
| 4 | `images` — signature sniffing, data URLs, size limits | not started |
| 5 | `web` — result parsing and normalisation | not started |
| 6 | `deepseek` — payload/response/SSE logic; transport stays in TS | not started |
| 7 | `orchestrator` — single agent, tool rounds, ToA workers | not started |
| 8 | `local` — workspace confinement, audit rotation, unified diff | not started |
| 9 | `service` + CLI front end | not started |
| 10 | Packaging: prebuilt bindings per platform, `electron-builder` + `pkg` | not started |

The TypeScript modules stay in place and keep working while each port lands, so
the branch is never in a half-broken state.
