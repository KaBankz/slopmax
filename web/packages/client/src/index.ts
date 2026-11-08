// @slopmax/client: slopmax's API for TypeScript front ends, as SlopmaxKit is
// for Swift and slopmax-client for Rust. The daemon decides everything; this
// package holds the API's types (held to contract/fixtures, which the Rust
// daemon blesses), its HTTP client `@slopmax/client/api` and event stream,
// and the words people read them in, `@slopmax/client/format`. It imports
// effect alone, so it loads in the browser.
export * from "./agents.ts"
export * from "./doctor.ts"
export * from "./errors.ts"
export * from "./events.ts"
export * from "./ids.ts"
export * from "./ledger.ts"
export * from "./limits.ts"
export * from "./login.ts"
export * from "./notice.ts"
export * from "./providers.ts"
export * from "./report.ts"
export * from "./settings.ts"
export * from "./time.ts"
export * from "./version.ts"
