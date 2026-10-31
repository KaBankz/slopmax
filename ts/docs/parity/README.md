# Parity inventory

> **Scope (2026-10-31).** These items list the Rust slopmax's features. The
> TypeScript rewrite must have every feature; everything else (internals,
> outputs, shapes, files, URLs, settings, APIs, wording) is free to change,
> and breaking changes are fine (`../CONVENTIONS.md`, "What parity means").
> Only protocols set by other programs are fixed: what Claude Code, Codex and
> OpenAI-style clients speak, provider APIs, agents' config formats, and
> T3 Code's hub calls. Judges check that each feature exists and works.

These files are the contract the TypeScript port of slopmax is judged
against. Every line item is one checkable behavior of the Rust workspace
(`crates/`, plus the repository-level build, install, and CI files), with a
stable ID, what the port must do, and where the Rust does it (`path:line`).

| File                                   | Covers                                                                                                                                                                                                                                            | Items | Rust tests mapped |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------- |
| [frontends.md](frontends.md)           | the `slopmax` CLI (`crates/slopmax`), the toolkit-free app core (`crates/slopmax-app`), the desktop app (`crates/slopmax-desktop-gpui`), and the repository's build, packaging, install, CI, dev scripts, and performance baseline                | 394   | 92                |
| [core-accounts.md](core-accounts.md)   | `slopmax-core` outside the proxy: config, paths and private files, accounts and the store, sign-in, importing logins, providers, agents, routing, the pool, limits, the login service, the background-proxy client, the doctor, the status report | 364   | 241               |
| [proxy-wire-net.md](proxy-wire-net.md) | the proxy, the `/slopmax/*` API and dashboard, the CLIProxyAPI-compatible API, the daemon, the ledger and its summaries, notifications, `slopmax-wire`, `slopmax-net`, `slopmax-common`, and the end-to-end test harness                          | 315   | 169               |
| [rust-tests.tsv](rust-tests.tsv)       | every Rust test (`file`, `test`, `line`)                                                                                                                                                                                                          |       | 502               |

Total: 1,073 items. All 502 tests in `rust-tests.tsv` are named in the
section for their module (the per-file test lists at the end of each
section, or "Rust tests to mirror" in frontends.md and proxy-wire-net.md
§17).

## Item counts by prefix

IDs are not contiguous: numbers were left free between groups, so the
highest number in a prefix can be above its count. That is intentional, not
a missing item.

### frontends.md

| Prefix | Area                                                                                                                                                                                | Items | Highest ID |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------- |
| `CLI`  | the `slopmax` binary: process, parser, command table, every command, terminal I/O, environment, bench rig, CLI test harness                                                         | 182   | CLI-231    |
| `APP`  | `slopmax-app`: state, lifecycle, actions and notices, notifications state, what a window draws                                                                                      | 82    | APP-105    |
| `DESK` | `slopmax-desktop-gpui`: screens, process and keys, sidebar, pages, menu bar panel, notifications, theme, components, motion, prefs, accessibility, screenshots, assets and bundle   | 114   | DESK-170   |
| `DIST` | build profile and features, size budgets, mise tasks, CI/desktop/release workflows, `install.sh`, Docker image, `scripts/bench.sh`, `scripts/demo.sh`, performance baseline, assets | 16    | DIST-016   |

### core-accounts.md

| Prefix  | Area                                                                                   | Items | Highest ID |
| ------- | -------------------------------------------------------------------------------------- | ----- | ---------- |
| `CFG`   | `config.toml`: keys, defaults, live settings, first-run key, template, reload behavior | 35    | CFG-035    |
| `FS`    | paths, private files, locks, test support (`testkit.rs`)                               | 19    | FS-019     |
| `ACC`   | account files, the store, pins                                                         | 24    | ACC-024    |
| `AUTH`  | sign-in, callback server, PKCE, JWT, refresh under lock                                | 35    | AUTH-035   |
| `IMP`   | importing logins from Claude Code, Codex, CLIProxyAPI                                  | 12    | IMP-012    |
| `PROV`  | provider registry, Claude, ChatGPT, reset credits, API keys, compatible endpoints      | 73    | PROV-073   |
| `LIM`   | usage windows, refusals, polling one account                                           | 26    | LIM-026    |
| `AGT`   | agents: detection, sessions, run/env/setup/undo, backups                               | 39    | AGT-039    |
| `ROUTE` | model → steps                                                                          | 10    | ROUTE-010  |
| `POOL`  | health, affinity, placement, `state.json`                                              | 37    | POOL-037   |
| `SVC`   | systemd/launchd login service                                                          | 10    | SVC-010    |
| `BG`    | the proxy seen from outside (`background.rs`)                                          | 13    | BG-013     |
| `DOC`   | `slopmax doctor` checks                                                                | 18    | DOC-018    |
| `REP`   | the status report                                                                      | 13    | REP-013    |

### proxy-wire-net.md

| Prefix | Area                                                                                              | Items | Highest ID |
| ------ | ------------------------------------------------------------------------------------------------- | ----- | ---------- |
| `PRX`  | proxy entry, auth, paths, failover loop, stream taps, transcoding, `/v1/models`, warmups, rawjson | 86    | PRX-102    |
| `WS`   | Codex WebSocket relay                                                                             | 17    | WS-017     |
| `ADM`  | `/slopmax/*` API and the dashboard page                                                           | 45    | ADM-053    |
| `HUB`  | CLIProxyAPI-compatible management API                                                             | 12    | HUB-012    |
| `DMN`  | the daemon and its background tasks                                                               | 22    | DMN-022    |
| `LED`  | ledger, summaries, history, prices, quota left on the table                                       | 30    | LED-053    |
| `NOTE` | notifications and nudges                                                                          | 15    | NOTE-015   |
| `WIRE` | API formats and translation                                                                       | 47    | WIRE-065   |
| `NET`  | HTTP client, upstream proxies, server, WebSocket frames, forms                                    | 18    | NET-042    |
| `COM`  | time, ids, logging, human formats                                                                 | 13    | COM-021    |
| `HAR`  | the end-to-end harness the 47 tests in `tests/proxy.rs` and `tests/failover.rs` stand on          | 10    | HAR-010    |

## How judges use the IDs

1. **One verdict per ID.** For each item record `pass`, `partial`, `fail`,
   or `not-ported`, with evidence: the TypeScript location (`path:line`) and
   the test that proves it. An item passes only when every clause in it
   holds; a `partial` names the clause that does not.
2. **Exact text is exact.** Wording in backticks is output a test, an agent,
   or a person reads: compare byte for byte, including punctuation, quote
   style (`{x:?}` is a double-quoted, escaped string), spacing, and
   capitalization. `{x}` marks a substitution.
3. **Tests carry their Rust names.** Each Rust test in `rust-tests.tsv` must
   have a TypeScript test with the same title in the module that owns its
   section. Count a missing title against the items that test covers.
4. **Cross-references are part of the item.** `(XXX-NNN)` inside an item
   means "as that item specifies"; judge both.
5. **`not-ported` must be declared.** Anything the port deliberately leaves
   out (for example the `mimalloc` feature, CLI-010, or a Rust-only budget in
   DIST-004) belongs in the port's NOT-PORTED list with a reason; an
   undeclared omission is a `fail`.
6. **Platform clauses.** Items that say macOS, Linux, Windows, or Unix are
   judged on that platform; the cross-cutting "Platform-specific" sections
   list them together.
7. **IDs never change meaning.** New behavior gets a new number at the end
   of its prefix. An item whose text was fixed after review carries
   `(corrected)` next to its ID (or in the clause that changed) and says
   what was wrong; judge the corrected text.
8. **Effect port notes** at the end of each file are guidance for the port's
   design (services, schemas, streams, timers, platform layers), not
   checkable items.

## Completeness pass (2026-10-30)

A second walk over every `.rs` file, `dashboard.html`, README.md,
ARCHITECTURE.md, the config template, and the CI, mise, install, Docker,
bundle, and script files added or corrected:

| File              | Added                                                                           | Corrected                                                             |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| frontends.md      | 16 (`DIST-001`..`016`)                                                          | 0                                                                     |
| core-accounts.md  | 2 (`ACC-024`, `CFG-035`)                                                        | 1 (`DOC-013`)                                                         |
| proxy-wire-net.md | 24 (`PRX-102`, `DMN-021`..`022`, `ADM-044`..`053`, `COM-021`, `HAR-001`..`010`) | 9 (`DMN-001`, `005`, `007`, `008`, `010`, `011`, `013`, `015`, `017`) |

It also checked that every `path:line` reference falls inside its file, every
cross-referenced ID exists, every quoted message of five or more words
appears in the Rust sources, and every test in `rust-tests.tsv` sits at the
line it names and is listed under its own module.
