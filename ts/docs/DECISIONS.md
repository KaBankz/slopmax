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
| CLI                                        | `effect/cli`; the admin API client is `HttpApiClient`                                                                                                             |
| Tests                                      | `bun test` with `@slopmax/test` (`it.effect`, `it.live`, `it.layer` over `bun:test` and `effect/testing`)                                                         |
| Format                                     | `bun fmt` (`printWidth = 120`, `semi = false`)                                                                                                                    |
| Lint                                       | oxlint, with `@shadcn/lint` and `eslint-plugin-better-tailwindcss` as JS plugins for the renderer                                                                 |
| Desktop                                    | Electron 45; main, preload, and renderer bundled by `Bun.build`; packaged with `@electron/packager` (asar, `en-US` only)                                          |
| UI                                         | React 19, Tailwind CSS v4, shadcn/ui on Base UI                                                                                                                   |

## Where the code runs

```
Electron main (Node)  ──stdio, effect/rpc───────  slopmax app-host (Bun)  ──HTTP──  slopmax serve (Bun)
   window, tray,                                    @slopmax/app:                   the proxy daemon
   notifications,                                   snapshot, actions,              (or the login service)
   IPC to the renderer                              sign-in, background
```

- **The engine runs on Bun only.** The core, the app's state and actions, and
  the daemon all run inside the one Bun binary. Electron's main process is a
  shell: it draws the window and tray, shows notifications, and relays `effect/rpc`
  messages between the renderer and a `slopmax app-host` child (a hidden
  subcommand of the bundled CLI).
- **Why not the core in Electron's main.** It would save one process (about
  35 MB), but the core needs `flock` (shared with the token refresh in the
  daemon and the CLI), which Node does not have, and running the core on two
  runtimes doubles what must be tested. With the host, the core never runs on Node.
- **The proxy outlives the window**, as in Rust: the host starts the bundled
  CLI's `serve` if none runs, and the login service runs the same binary.
- **Electron is started lean:** `app.disableHardwareAcceleration()` plus
  `--enable-features=NetworkServiceInProcess2` (about 40 MB less), and the
  Vulkan/SwiftShader files are dropped from the package.

## Effect-native, not Rust-shaped (2026-10-31)

The first port mirrored the Rust's modules, types, test names, and byte-level
output. That is not the goal and was replaced; it survives only as a behavior
reference on `ts-reference/rust-shaped`. Settled with the user:

- **Parity is features only.** Architecture, outputs, files, URLs, settings,
  and APIs are all free to change; breaking changes are fine
  (`CONVENTIONS.md`, "What parity means").
- **Settings are `config.json`**, defined by an Effect `Schema` that also
  generates `config.schema.json` for editor completion and validation.
- **The CLI is `effect/cli`**, with its help, completions, and error wording.
- **`slopmax run`** spawns the agent with inherited stdio through
  `effect/process`, forwards signals, and exits with the agent's code (a
  process cannot replace itself on Bun).
- **The admin API is an `HttpApi`**, so the daemon, the CLI, and the app share
  one typed definition and client.
- **The desktop protocol is `effect/rpc`** over the app host's stdio.
- **Locks:** a `Semaphore` within a process; across processes, `flock`
  through `bun:ffi` behind a small `Lock` service (it costs about 9 MB of
  `--trim` savings in the AOT binary; measured in `AOT.md`).
- **Outbound SOCKS5** goes through a small local CONNECT-to-SOCKS5 bridge
  inside the `Upstream` layer, since Bun's `fetch` takes only HTTP proxies.
- **Compressed upstream bodies pass through untouched** (`decompress: false`).

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
