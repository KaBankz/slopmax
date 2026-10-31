// slopmax's engine: connected accounts and signing in, the pool that picks
// an account for each request, the proxy agents talk to, and everything the
// CLI and the desktop app do alike. Neither front end reimplements what is
// here; each only asks and shows.
//
// The packages beneath it are re-exported under the names the modules here
// use, so a front end needs this package alone.

export * as account from "./account.ts"
export * as agent from "./agent/index.ts"
export * as auth from "./auth/index.ts"
export * as background from "./background.ts"
export * as config from "./config.ts"
export * as daemon from "./daemon.ts"
export * as doctor from "./doctor.ts"
export * as error from "./error.ts"
export * as fsx from "./fsx.ts"
export * as history from "./history.ts"
export * as import_ from "./import.ts"
export * as ledger from "./ledger.ts"
export * as limits from "./limits.ts"
export * as notify from "./notify.ts"
export * as paths from "./paths.ts"
export * as pool from "./pool.ts"
export * as pricing from "./pricing.ts"
export * as proc from "./proc.ts"
export * as provider from "./provider/index.ts"
export * as proxy from "./proxy/index.ts"
export * as report from "./report.ts"
export * as route from "./route.ts"
export * as serde from "./serde.ts"
export * as service from "./service.ts"
export * as summary from "./summary.ts"
export * as toml from "./toml.ts"
export * as usage from "./usage.ts"
export * as waste from "./waste.ts"

export { Account, Store, Tokens } from "./account.ts"
export { Config } from "./config.ts"
export { Failure } from "./error.ts"
export { Home } from "./paths.ts"
export { Pool } from "./pool.ts"
export { ProviderId } from "./provider/mod.ts"
// Importing the registry installs every provider where `ProviderId.get` finds it.
export { PROVIDERS } from "./provider/registry.ts"
export { USER_AGENT, VERSION } from "./version.ts"

export { fmt, human, ids, log, num, text, time } from "@slopmax/common"
export * as net from "@slopmax/net"
export * as wire from "@slopmax/wire"
