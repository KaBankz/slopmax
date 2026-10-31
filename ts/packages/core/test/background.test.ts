import { describe, expect } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Schema } from "effect"

import { builtExe, currentExe, Daemon, spawn, stop } from "../src/background.ts"
import { Config } from "../src/config.ts"
import { build, ReportSchema } from "../src/report.ts"
import { json, Mock, noEnv, reply, Seen } from "../src/testkit.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const report = () =>
  Schema.encodeSync(ReportSchema)(
    build(
      [],
      () => {
        throw new Error("no accounts")
      },
      {},
      new Map(),
      "fill-first",
      true,
      Date.now(),
    ),
  )

const configAt = (mock: Mock, apiKey: string): Config => ({
  ...Config.default(),
  listen: { ip: "127.0.0.1", port: Number(new URL(mock.url).port) },
  apiKey,
})

const daemonAt = (mock: Mock) => Daemon.make(configAt(mock, "sm-key")).pipe(Effect.provide(noEnv))

/** A stand-in proxy that answers like slopmax's own endpoints. */
const proxy = (service: string) =>
  Mock.start((seen) => {
    const authorized = Seen.header(seen, "authorization") === "Bearer sm-key"
    const route = Seen.route(seen)
    if (route === "/healthz") return json(200, { service, version: "9.9.9" })
    if (!authorized) return json(401, {})
    switch (route) {
      case "/slopmax/status":
      case "/slopmax/refresh":
      case "/slopmax/sync":
        return json(200, report())
      case "/slopmax/accounts/codex-ok/redeem":
        return json(200, { outcome: "reset", report: report() })
      case "/slopmax/accounts/codex-garbled/redeem":
        return reply(200, "not json")
      case "/slopmax/accounts/codex-none/redeem":
        return json(409, { error: { message: "no reset credits left" } })
      case "/slopmax/shutdown":
        return reply(200, "")
      default:
        return reply(500, "")
    }
  })

/** A local port nothing listens on (never 8317). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      server.close(() => (port === 8317 ? freePort().then(resolve, reject) : resolve(port)))
    })
  })

describe("background", () => {
  it.live("the_running_proxy_reports_its_version", () =>
    Effect.gen(function* () {
      const daemon = yield* daemonAt(yield* proxy("slopmax"))
      expect(yield* daemon.version).toBe("9.9.9")
      expect(yield* daemon.isRunning).toBe(true)
    }),
  )

  it.live("another_program_on_the_port_is_not_the_proxy", () =>
    Effect.gen(function* () {
      const daemon = yield* daemonAt(yield* proxy("something-else"))
      expect(yield* daemon.version).toBeUndefined()
      expect(yield* daemon.isRunning).toBe(false)
    }),
  )

  it.live("nothing_listening_is_not_running", () =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(freePort)
      const config: Config = { ...Config.default(), listen: { ip: "127.0.0.1", port } }
      const daemon = yield* Daemon.make(config).pipe(Effect.provide(noEnv))
      expect(yield* daemon.isRunning).toBe(false)
      expect(yield* daemon.report(false)).toBeUndefined()
      expect(yield* Effect.isFailure(daemon.shutdown)).toBe(true)
      const error = yield* Effect.flip(daemon.redeem("codex-ok"))
      expect(error.message).toBe("the proxy is not running")
      // `stop` with nothing running says so instead of failing.
      expect(yield* stop(config).pipe(Effect.provide(noEnv))).toBe(false)
    }),
  )

  it.live("reports_are_read_with_the_key_and_refreshes_and_syncs_post", () =>
    Effect.gen(function* () {
      const mock = yield* proxy("slopmax")
      const daemon = yield* daemonAt(mock)
      expect((yield* daemon.report(false))?.live).toBe(true)
      expect(yield* daemon.report(true)).toBeDefined()
      expect(yield* daemon.sync).toBeDefined()
      expect(mock.seen().map((s) => [s.method, s.path])).toEqual([
        ["GET", "/slopmax/status"],
        ["POST", "/slopmax/refresh"],
        ["POST", "/slopmax/sync"],
      ])
      expect(mock.seen().every((s) => Seen.header(s, "authorization") === "Bearer sm-key")).toBe(true)
    }),
  )

  it.live("a_wrong_key_reads_as_no_report", () =>
    Effect.gen(function* () {
      const mock = yield* proxy("slopmax")
      const daemon = yield* Daemon.make(configAt(mock, "wrong")).pipe(Effect.provide(noEnv))
      expect(yield* daemon.report(false)).toBeUndefined()
      expect(yield* Effect.isFailure(daemon.shutdown)).toBe(true)
    }),
  )

  it.live("redeeming_returns_the_outcome_or_the_proxys_reason", () =>
    Effect.gen(function* () {
      const daemon = yield* daemonAt(yield* proxy("slopmax"))
      const [outcome, after] = yield* daemon.redeem("codex-ok")
      expect(outcome).toBe("reset")
      expect(after.accounts).toEqual([])

      expect((yield* Effect.flip(daemon.redeem("codex-none"))).message).toBe("no reset credits left")
      expect((yield* Effect.flip(daemon.redeem("codex-unknown"))).message).toBe("it failed")
      expect((yield* Effect.flip(daemon.redeem("codex-garbled"))).message).toBe("unexpected answer from the proxy")
    }),
  )

  it.live("stopping_asks_a_running_proxy_to_shut_down", () =>
    Effect.gen(function* () {
      const mock = yield* proxy("slopmax")
      expect(yield* stop(configAt(mock, "sm-key")).pipe(Effect.provide(noEnv))).toBe(true)
      expect(mock.seenAt("/slopmax/shutdown").length).toBe(1)
    }),
  )

  it.live("the_current_binary_is_found", () =>
    Effect.gen(function* () {
      // A built slopmax is its own binary; its modules live inside it.
      const built = builtExe(process.execPath, "/$bunfs/root/slopmax")
      expect(built).toBe(process.execPath)
      expect(existsSync(built ?? "")).toBe(true)
      expect(builtExe("C:\\slopmax.exe", "B:\\~BUN\\root\\slopmax.exe")).toBe("C:\\slopmax.exe")
      // From source the program is Bun, which cannot run `serve`.
      expect(builtExe(process.execPath, "/src/apps/cli/src/main.ts")).toBeUndefined()
      expect((yield* Effect.flip(currentExe)).message).toBe("locating the slopmax binary")
    }),
  )
})

describe("background, beyond the Rust tests", () => {
  it.live("spawn_runs_serve_detached_and_logs_to_the_home", () =>
    Effect.gen(function* () {
      const home = tempDir("background")
      const exe = join(home, "fake-slopmax")
      // A stand-in binary that says what it was asked to do and exits.
      yield* Effect.sync(() => Bun.write(exe, '#!/bin/sh\necho "ran $1"\necho "oops" >&2\n'))
      yield* Effect.promise(() => Bun.$`chmod +x ${exe}`.quiet())
      const withHome = Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ SLOPMAX_HOME: home })))
      yield* spawn(exe).pipe(withHome)
      const log = join(home, "slopmax.log")
      for (let i = 0; i < 100 && !(existsSync(log) && readFileSync(log, "utf8").includes("oops")); i++) {
        yield* Effect.sleep("20 millis")
      }
      expect(readFileSync(log, "utf8")).toBe("ran serve\noops\n")
      const missing = yield* Effect.flip(spawn(join(home, "nope")).pipe(withHome))
      expect(missing.message).toBe("starting the proxy")
    }),
  )
})
