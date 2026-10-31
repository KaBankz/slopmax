// @slopmax/domain: the shared vocabulary of every slopmax package and app.
// Schemas that cross a process boundary, provider and agent facts, errors,
// and the pure rules over them. It imports effect alone, so it also loads in
// the browser. The API is `@slopmax/domain/api`, people's formats
// `@slopmax/domain/format`, and the desktop bridge `@slopmax/domain/desktop`.
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
