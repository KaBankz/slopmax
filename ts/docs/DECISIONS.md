# Decisions

What the TypeScript port is built with, and why. The evidence is in
`RUNTIME.md`, `AOT.md`, and `STYLING.md`; each was checked by independent
judges, whose corrections are folded in below.

## Stack

| Piece                                      | Choice                                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language                                   | TypeScript 7 (strict), Effect 4.1                                                                                                                                 |
| Runtime: CLI, daemon, and the app's engine | Bun (the CLI binary)                                                                                                                                              |
| CLI binary                                 | `bun compile --trim` (ahead of time, Bun canary); `--no-aot --minify --bytecode` as the fallback build                                                            |
| Package manager                            | `bun install`, workspaces                                                                                                                                         |
| Types                                      | `bun check -b`; `@effect/tsgo` for Effect's diagnostics in CI (with `unstableApiUsage` lowered to a message, since `effect/http` and friends are tagged unstable) |
| Tests                                      | `bun test` with `@slopmax/test` (`it.effect`, `it.live`, `it.layer` over `bun:test` and `effect/testing`)                                                         |
| Format                                     | `bun fmt` (`printWidth = 120`, `semi = false`)                                                                                                                    |
| Lint                                       | oxlint, with `@shadcn/lint` and `eslint-plugin-better-tailwindcss` as JS plugins for the renderer                                                                 |
| Desktop                                    | Electron 45; main, preload, and renderer bundled by `Bun.build`; packaged with `@electron/packager` (asar, `en-US` only)                                          |
| UI                                         | React 19, Tailwind CSS v4, shadcn/ui on Base UI                                                                                                                   |

## Where the code runs

```
Electron main (Node)  ──stdio, typed messages──  slopmax app-host (Bun)  ──HTTP──  slopmax serve (Bun)
   window, tray,                                    @slopmax/app:                   the proxy daemon
   notifications,                                   snapshot, actions,              (or the login service)
   IPC to the renderer                              sign-in, background
```

- **The engine runs on Bun only.** The core, the app's state and actions, and
  the daemon all run inside the one Bun binary. Electron's main process is a
  shell: it draws the window and tray, shows notifications, and relays typed
  messages between the renderer and a `slopmax app-host` child (a hidden
  subcommand of the bundled CLI).
- **Why not the core in Electron's main.** It would save one process (about
  35 MB), but the core needs `flock` (shared with the token refresh in the
  daemon and the CLI), which Node does not have, and running the core on two
  runtimes doubles what must be tested. With the host, `@slopmax/app` is a
  straight port of `slopmax-app` and the core never runs on Node.
- **The proxy outlives the window**, as in Rust: the host starts the bundled
  CLI's `serve` if none runs, and the login service runs the same binary.
- **Electron is started lean:** `app.disableHardwareAcceleration()` plus
  `--enable-features=NetworkServiceInProcess2` (about 40 MB less), and the
  Vulkan/SwiftShader files are dropped from the package.

## The CLI

- **The parser is ported, not replaced by `effect/cli`.** Tests assert its
  exact error texts, exit code 2, `-1` read as a value, the trailing-argument
  rules, and the completion scripts. The table-driven parser is a few hundred
  lines of pure functions; `effect/cli` would not reproduce those bytes, and it
  costs about half of the measured startup floor.
- **`slopmax run`** cannot replace itself with the agent (`exec`) on Bun; it
  spawns the agent with inherited stdio, forwards signals, and exits with its
  code.

## Parity traps settled up front

- **Numbers print as Rust prints them.** `@slopmax/common` has a formatter with
  Rust's round-half-to-even and `25.0`-style floats; nothing uses `toFixed` for
  output.
- **Widths count characters** (code points), not UTF-16 units.
- **Time:** timestamps are epoch milliseconds in memory. RFC 3339 parsing
  accepts nanoseconds; formatting drops trailing zeros as Rust does. A Rust
  test that round-trips nanoseconds is ported against milliseconds and noted.
- **TOML:** config edits keep the user's comments and place new keys where
  Rust's `toml_edit` does. No JS library does this, so `@slopmax/core` has a
  small format-preserving editor for the subset slopmax writes.
- **Locks** are `flock` through `bun:ffi`, which interoperates with Rust's
  `File::lock`.
- **SOCKS5** outbound proxies go through a small local CONNECT-to-SOCKS5
  bridge, since Bun's `fetch` takes only HTTP proxies.
- **Compressed upstream bodies pass through untouched** (`decompress: false`),
  as the Rust forwards `accept-encoding`.
- **`JSON.parse` is not used on request bodies on the hot path**: `rawjson`
  scans bytes (it must also see duplicate `model` keys).

## Styling, with the judges' corrections

Tailwind v4 + shadcn/ui, checked by `@shadcn/lint` 0.2.3 (pinned) and
`eslint-plugin-better-tailwindcss` under oxlint, and by TypeScript through
`cva` variant types. Both judges kept the decision; their corrections:

- `no-raw-colors` must be configured as `{ "allow": [], "deny": ["*-white", "*-black"] }`.
  `deny` alone stops checking every other raw color.
- Conflicting and duplicate classes (`p-2 p-4`) are caught by
  `better-tailwindcss/no-conflicting-classes` and `no-duplicate-classes`.
- Off-design steps that are valid Tailwind (`m-13`) are caught by resetting the
  spacing scale in `@theme` and declaring only the steps the design (and
  shadcn's components) use; `no-unknown-classes` then reports the rest.
- Custom tokens stay colors only, or `cn` is built with `cn/vite`, because the
  default `cn` misclassifies custom non-color scales.
- StyleX's real advantages (override limits in component types, rename-safe
  tokens, per-property merging) were confirmed. They are not worth giving up
  shadcn's components and agent fluency for a one-window app. Components that
  should not be restyled omit `className` and `style` from their props, which
  gives the same type-level guarantee.
