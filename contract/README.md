# The API contract

slopmax's own API (`/slopmax/api`, the types in `crates/slopmax-api`) is held to one wire format by
fixtures, not by generated code.

- `fixtures/` — the Rust daemon's answers, one file per endpoint and outcome
  (`<group>.<endpoint>.<case>.json`, each `{status, body}`), times, secrets and paths made steady.
  `crates/slopmax-core/tests/contract.rs` checks every answer against its file;
  `SLOPMAX_BLESS=1 cargo test -p slopmax-core --test contract` rewrites them after a change on
  purpose.
- `ts/packages/domain/test/rust-contract.test.ts` decodes every fixture with the TypeScript schemas
  strictly (`onExcessProperty: "error"`), so a field Rust adds, renames or drops fails there, and the
  web UI and desktop window built on those schemas keep working against the Rust daemon.
- The Swift app decodes them too (`apple/Tests/ContractTests.swift`).
- `zero/` — the TypeScript daemon's own answers, recorded from its demo before the Rust API was
  written: the shapes Rust matched, and the only record of the endpoints the Rust fixtures leave out
  because they reach real things (import, starting a sign-in, adding a key, doctor, agent wiring).
