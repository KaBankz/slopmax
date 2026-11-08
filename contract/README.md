# The API contract

slopmax's own API (`/slopmax/api`, the types in `crates/slopmax-api`) is held to one wire format by
fixtures, not by generated code.

- `fixtures/` — the Rust daemon's answers, one file per endpoint and outcome
  (`<group>.<endpoint>.<case>.json`, each `{status, body}`), times, secrets and paths made steady.
  `crates/slopmax-core/tests/contract.rs` checks every answer against its file;
  `SLOPMAX_BLESS=1 cargo test -p slopmax-core --test contract` rewrites them after a change on
  purpose.
- `web/packages/client/test/rust-contract.test.ts` decodes every fixture with `@slopmax/client`, the
  TypeScript client the web UI is built on, strictly (`onExcessProperty: "error"`), so a field Rust
  adds, renames or drops fails there.
- The Swift app decodes them too (`apple/Tests/ContractTests.swift`).
