# Architecture

slopmax in TypeScript is an Effect program. It does what the Rust slopmax
does (the feature inventory is `parity/`), but it is designed from Effect's
own building blocks, not translated from Rust. The Rust-shaped first port is
kept on the branch `ts-reference/rust-shaped` (and unpacked at
`/tmp/slopmax-ts-reference/ts`) only as a reference for behavior.

## Packages

```
ts/
  packages/
    domain   @slopmax/domain   the shared vocabulary: Schema classes and tagged errors,
                               the admin HttpApi, the desktop Rpc group, formatting for people
    wire     @slopmax/wire     the three API formats as Schemas, the common form, translation,
                               and streaming transcoders
    core     @slopmax/core     the engine as services and layers: accounts, credentials,
                               providers, agents, pool, router, proxy, admin API, daemon, ledger
    app      @slopmax/app      the desktop app's engine: state, actions, view model, Rpc handlers
  apps/
    cli      slopmax           effect/cli commands over the core; `app-host` serves the Rpc group
    desktop  slopmax-desktop   Electron shell + React renderer, an Rpc client of `app-host`
  tools/
    test     @slopmax/test     it.effect / it.layer over bun:test
```

`domain` imports only `effect`, so Electron's main process and the renderer
can use its schemas, the Rpc group, and the HttpApi client definitions without
pulling in the engine. `wire` imports `domain`. `core` imports both. `app`
imports `core`. The apps import packages; packages never import apps.

## The engine as services

Each concern is a service with a live layer and, where tests need it, a test
layer. Layers compose into the daemon, the CLI, and the app host.

| Service               | Owns                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `Home`                | where slopmax keeps its files (`SLOPMAX_HOME`, platform user directories)                        |
| `Settings`            | `config.json`: load, validate (Schema), watch, change                                            |
| `Accounts`            | the account files: list, find, save, remove, pin; change notifications                           |
| `Credentials`         | OAuth tokens: refresh ahead of expiry under a cross-process lock, never interrupted mid-rotation |
| `Providers`, `Agents` | the registries: each provider and agent is a value implementing an interface                     |
| `Upstream`            | the outbound `HttpClient`: pooling, HTTP/SOCKS proxies, base-URL overrides for tests             |
| `Pool`                | account health, session affinity, placement; a `SubscriptionRef` others watch                    |
| `Router`              | model → steps: pure planning over the registries and accounts                                    |
| `Usage`               | usage windows: polling, rate-limit headers, resets; persisted state                              |
| `Ledger`              | the usage ledger (NDJSON per month), summaries, history                                          |
| `Notifier`            | webhooks, commands, nudges from account changes                                                  |
| `Proxy`               | the `HttpRouter` app: provider routes, failover, streaming, the Codex WebSocket relay            |
| `Admin`               | the `HttpApi` for `/slopmax/*` and the CLIProxyAPI-compatible hub, plus the dashboard page       |
| `Daemon`              | the long-running server and its background schedules                                             |
| `Background`          | a running proxy seen from outside: an `HttpApiClient`, start/stop, the login service             |
| `Doctor`, `Importer`  | setup checks; importing logins from Claude Code, Codex, CLIProxyAPI                              |

## A request's path

1. The `Proxy` router matches the path to a provider route; the slopmax key is
   checked by `HttpApiMiddleware`-style middleware.
2. The body is read once as bytes so it can be replayed on another account.
   The few values routing needs (model, stream, session) are peeked from the
   bytes without parsing the whole body — a deliberate performance choice.
3. `Router.plan` returns the steps; `Pool.pick` chooses an account per step.
4. Same-format requests go upstream as sent with the credential swapped;
   others are decoded with `wire`'s Schemas and re-encoded for the account's
   API.
5. Refusals are classified into a `Verdict` (a `Data.TaggedEnum`), which
   decides whether to block the account and try the next step. Failover
   happens only before the first byte reaches the client.
6. The response streams back as a `Stream<Uint8Array>`: an SSE tap
   (`encoding/Sse`) records usage in the `Ledger` when it ends; translated
   streams pass through `wire`'s transcoder.

## Background work

The `Daemon` forks each task into its scope as a fiber on a `Schedule`:
reloading accounts and settings, saving pool state, refreshing tokens,
polling usage, listing and redeeming limit resets, warming idle windows, and
watching account conditions. Each reads current settings when it runs, so a
change takes effect without a restart.

## The desktop app

```
renderer (React)  ⇄  preload (contextBridge)  ⇄  Electron main  ⇄  stdio  ⇄  slopmax app-host  ⇄  HTTP  ⇄  slopmax serve
   AtomRpc / view model                           RpcClient (NDJSON)          RpcServer (@slopmax/app)        the daemon
```

The engine runs only in the Bun binary. Electron's main is a shell: window,
tray, notifications, and a byte relay for the Rpc protocol. The renderer
draws the view model `@slopmax/app` computes, so it holds no logic.

## Files

```
~/.slopmax/                 (SLOPMAX_HOME moves it; directories 0700, files 0600)
  config.json               settings (JSON Schema at config.schema.json for editors)
  accounts/<id>.json        one account each
  state.json                pool and usage state the daemon persists
  pins.json, nudged.json, setup-backup.json
  usage/<year>-<month>.ndjson
  windows.ndjson
  slopmax.log
```

Nothing is shared with the Rust slopmax's files; logins come in through the
importers (Claude Code, Codex, CLIProxyAPI) or a fresh sign-in.
