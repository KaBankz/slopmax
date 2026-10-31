# Conventions

slopmax in TypeScript is written as first-class Effect and TypeScript. It
keeps the Rust slopmax's features and external contracts, never its
internals. When the Rust and Effect would do a thing differently, do it the
Effect way. These rules bind every package; judges check them as hard as
they check features.

## What parity means

**Feature parity, nothing more.** Every feature the Rust slopmax has, the
TypeScript one has. Everything else is open: architecture, outputs, data
shapes, file layout, URL layout, ports, settings, the admin API, CLI
surface, wording. Breaking changes are fine; there is no compatibility to
keep with the Rust slopmax or its files. Choose whatever is cleanest and most
efficient in Effect, Bun, and TypeScript, and do not hold yourself to the
Rust's way of doing anything.

- **Fixed by others, not by us:** the protocols of programs slopmax does not
  control — what Claude Code, Codex, and OpenAI-style clients send and
  expect, the upstream provider APIs, the agents' config file formats, and
  T3 Code's CLIProxyAPI-style management calls (the hub feature). How
  slopmax plugs into them (paths, ports, env wiring) is ours to design.
- **Dependencies:** use Effect, Bun, and TypeScript to their fullest, plus any
  popular, well-maintained library that does a job better than code we would
  write. Record each one and why in the package's `package.json` `"//"` field.

## Use Effect's own types

| Need                                                    | Use                                                                           | Not                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A domain entity (account, window, ledger entry, report) | `Schema.Class`, `Schema.TaggedClass`                                          | hand-written classes or interfaces plus decoders           |
| A sum type (verdict, credential, billing)               | `Schema.TaggedUnion`/`Data.TaggedEnum` with `Match`                           | string flags, nested ifs                                   |
| An error                                                | `Schema.TaggedError` (crosses a boundary or serializes) or `Data.TaggedError` | a generic `Failure`, `Error` subclasses, thrown exceptions |
| Optional values                                         | `Option` inside Effect code, `undefined` at plain-data edges                  | sentinel values                                            |
| Time                                                    | `DateTime`, `Duration`, `Clock`                                               | custom timestamp or duration types                         |
| Ids, randomness, hashes                                 | `crypto.randomUUID`, `Random`, `effect/crypto`                                | in-house generators                                        |
| Files                                                   | `FileSystem`, `Path`                                                          | `node:fs`                                                  |
| Settings and env                                        | `Schema` for `config.json`; `Config` for env vars                             | hand-parsed files                                          |
| Logging                                                 | `Effect.log*` with a `Logger` layer                                           | a custom logger                                            |
| HTTP server                                             | `HttpRouter`; `HttpApi` + `HttpApiBuilder` for typed APIs                     | hand dispatch on paths                                     |
| HTTP client                                             | `HttpClient`; `HttpApiClient` for slopmax's own API                           | hand-built requests to slopmax                             |
| Streams, SSE, NDJSON                                    | `Stream`, `effect/encoding` `Sse` and `Ndjson`                                | manual line splitting                                      |
| State others watch                                      | `SubscriptionRef`, `PubSub`                                                   | callbacks, polling                                         |
| Timers                                                  | `Schedule` with `Effect.repeat`, forked into a `Scope`                        | `setInterval`                                              |
| Resources                                               | `Effect.acquireRelease`, `Scope`, `Layer.scoped`                              | try/finally                                                |
| Child processes                                         | `effect/process`                                                              | `Bun.spawn` in engine code                                 |
| CLI                                                     | `effect/cli` (`Command`, `Flag`, `Argument`, `Prompt`)                        | a hand-written parser                                      |
| App ⇄ engine                                            | `effect/rpc` (`RpcGroup`, `RpcServer`, `RpcClient`) over NDJSON               | an ad-hoc message protocol                                 |
| People-facing numbers and times                         | `Intl.NumberFormat`, `Intl.RelativeTimeFormat`, `DateTime.format`             | Rust format emulation                                      |

## Services and layers

```ts
export class Accounts extends Context.Service<
  Accounts,
  {
    readonly list: Effect.Effect<ReadonlyArray<Account>, AccountsError>
    readonly save: (account: Account) => Effect.Effect<void, AccountsError>
  }
>()("@slopmax/core/Accounts", {
  make: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const home = yield* Home
    const list = Effect.fn("Accounts.list")(function* () {
      /* … */
    })
    return {
      list: list(),
      save: Effect.fn("Accounts.save")(function* (account) {
        /* … */
      }),
    }
  }),
}) {
  static readonly layer = Layer.effect(Accounts, Accounts.make)
}
```

- Every stateful or I/O concern is a service; its dependencies are services.
  Tests provide test layers (an in-memory `FileSystem`, a mock `HttpClient`,
  `TestClock`) rather than temp directories and real ports wherever possible.
- Effectful functions are `Effect.fn("Service.method")`.
- Pure logic (planning, placement, pricing, translation, peeking at bytes)
  stays plain functions over Schema-typed data. Do not wrap it in `Effect`.

## Structure and names

- Files are named for what they hold in TypeScript's usual style:
  `accounts.ts`, `claude-code.ts`, `router.ts`. No `mod.ts`; a folder's
  public surface is its `index.ts`.
- Names are TypeScript's: `camelCase` values, `PascalCase` types and
  services. Pick the clearest name, not the Rust one.
- Comments explain why, in plain words about slopmax itself. Never explain
  code in terms of Rust, its crates, or its types.

## Performance

- Request bodies are bytes; routing peeks at the few fields it needs without
  parsing the whole body. Same-format requests are forwarded as sent.
- Responses stream; nothing buffers a whole answer.
- Typed code everywhere (no `any`, no unchecked casts), so the
  ahead-of-time compiler can do its job (`AOT.md`).
- Dependencies are welcome when they are popular, maintained, and better
  than writing it ourselves; record why in `package.json`'s `"//"` field.

## Tests

- `bun test` with `@slopmax/test` (`it.effect`, `it.live`, `it.layer`).
- Tests are named for the behavior they check, in plain English, grouped with
  `describe` by service. Each behavior the Rust tests covered is covered;
  `docs/parity/test-map.tsv` maps every Rust test to the TypeScript test (file
  and title) that covers it, or to the reason it does not apply.
- End-to-end tests run the real proxy against a mock provider.

## Toolchain

Bun is the runtime and the toolchain (`bun install`, `bun check -b`,
`bun test`, `bun fmt`); oxlint lints. The CLI ships compiled ahead of time
(`bun compile --trim`, Bun canary; see `AOT.md`).
