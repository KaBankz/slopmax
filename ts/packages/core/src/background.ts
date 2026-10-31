// The proxy in the background: talking to a running one, and starting it
// detached or as a login service. The CLI and the app both manage it
// through here; `exe` is always the slopmax binary that runs `serve`.
import process from "node:process"

import { Effect, Schedule, Schema } from "effect"

import { Client, type HttpError } from "@slopmax/net"

import { Config } from "./config.ts"
import { context, Failure } from "./error.ts"
import * as fsx from "./fsx.ts"
import * as paths from "./paths.ts"
import * as proc from "./proc.ts"
import { OutcomeSchema, type Outcome } from "./provider/credits.ts"
import { type Report, ReportSchema } from "./report.ts"
import * as service from "./service.ts"

const RedeemedSchema = Schema.Struct({ outcome: OutcomeSchema, report: ReportSchema })

const decodeReport = Schema.decodeUnknownOption(ReportSchema)
const decodeRedeemed = Schema.decodeUnknownOption(RedeemedSchema)

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined

/** Talks to a running proxy. */
export class Daemon {
  private constructor(
    readonly base: string,
    private readonly key: string,
    private readonly http: Client,
  ) {}

  /** A client for the proxy `config` describes: plain HTTP, 30 s a request, 1 s to connect. */
  static make(config: Config): Effect.Effect<Daemon> {
    return Effect.map(
      Client.builder().timeout("30 seconds").connectTimeout("1 second").plainHttp().build(),
      (http) => new Daemon(Config.baseUrl(config), config.apiKey, http),
    )
  }

  get isRunning(): Effect.Effect<boolean> {
    return Effect.map(this.version, (v) => v !== undefined)
  }

  /** The running proxy's version, if one answers on the configured port. */
  get version(): Effect.Effect<string | undefined> {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.http.get(`${this.base}/healthz`).send()
      const body = yield* response.json()
      if (field(body, "service") !== "slopmax") return undefined
      const version = field(body, "version")
      return typeof version === "string" ? version : undefined
    }).pipe(Effect.orElseSucceed(() => undefined))
  }

  /** The running proxy's report, after polling every account's usage first with `refresh`. */
  report(refresh: boolean): Effect.Effect<Report | undefined> {
    return this.call(refresh ? "refresh" : "status", refresh)
  }

  /**
   * Has the running proxy pick up changes on disk now, rather than at its
   * next check, and returns its report.
   */
  get sync(): Effect.Effect<Report | undefined> {
    return this.call("sync", true)
  }

  /**
   * Has the running proxy redeem a reset credit on account `id`: the
   * soonest to expire. Returns how that went, and the report after.
   */
  redeem(id: string): Effect.Effect<readonly [Outcome, Report], Failure> {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.http
        .post(`${this.base}/slopmax/accounts/${id}/redeem`)
        .bearerAuth(this.key)
        .send()
        .pipe(context("the proxy is not running"))
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.json().pipe(Effect.orElseSucceed((): unknown => null))
        const message = field(field(body, "error"), "message")
        return yield* Effect.fail(new Failure({ message: typeof message === "string" ? message : "it failed" }))
      }
      const body = yield* response.json().pipe(context("unexpected answer from the proxy"))
      const redeemed = decodeRedeemed(body)
      if (redeemed._tag === "None")
        return yield* Effect.fail(new Failure({ message: "unexpected answer from the proxy" }))
      return [redeemed.value.outcome, redeemed.value.report] as const
    })
  }

  get shutdown(): Effect.Effect<void, HttpError> {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.http.post(`${this.base}/slopmax/shutdown`).bearerAuth(this.key).send()
      yield* response.errorForStatus()
    })
  }

  private call(path: string, post: boolean): Effect.Effect<Report | undefined> {
    return Effect.gen({ self: this }, function* () {
      const url = `${this.base}/slopmax/${path}`
      const request = post ? this.http.post(url) : this.http.get(url)
      const response = yield* (yield* request.bearerAuth(this.key).send()).errorForStatus()
      const decoded = decodeReport(yield* response.json())
      return decoded._tag === "Some" ? decoded.value : undefined
    }).pipe(Effect.orElseSucceed(() => undefined))
  }
}

/**
 * @internal The slopmax binary, given the running program and its main
 * module: the program itself when it is a built slopmax, whose modules live
 * inside it (Bun's `/$bunfs/`, `B:\\~BUN\\` on Windows). From source the
 * program is Bun, which cannot run `serve`, so there is none.
 */
export const builtExe = (execPath: string, main: string | undefined): string | undefined =>
  execPath !== "" && main !== undefined && /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main) ? execPath : undefined

/** The binary this process runs as, for front ends that are slopmax itself. */
export const currentExe: Effect.Effect<string, Failure> = Effect.suspend(() => {
  const exe = builtExe(process.execPath, process.argv[1])
  return exe === undefined ? Effect.fail(new Failure({ message: "locating the slopmax binary" })) : Effect.succeed(exe)
})

/** Starts the proxy unless one already answers. Returns whether it started one. */
export const ensureRunning = Effect.fn("background.ensureRunning")(function* (config: Config, exe: string) {
  if (yield* (yield* Daemon.make(config)).isRunning) return false
  yield* launch(config, exe)
  return true
})

/**
 * Starts the proxy: through the service when one is installed, so it stays
 * supervised, else as a detached process logging to the home's log file.
 */
export const launch = Effect.fn("background.launch")(function* (config: Config, exe: string) {
  const manager = yield* service.detect
  const installed = manager !== undefined && (yield* service.status(manager)).installed
  if (manager !== undefined && installed) yield* service.start(manager)
  else yield* spawn(exe)
  yield* waitUntilRunning(config)
})

/** Stops a running proxy. Returns whether one was running. */
export const stop = Effect.fn("background.stop")(function* (config: Config) {
  const daemon = yield* Daemon.make(config)
  if (!(yield* daemon.isRunning)) return false
  yield* daemon.shutdown
  return true
})

/**
 * Installs the login service that runs `exe`, taking over from a proxy
 * started another way, and waits until it answers. Returns the service
 * definition's file.
 */
export const installService = Effect.fn("background.installService")(function* (
  config: Config,
  manager: service.Manager,
  exe: string,
) {
  if (yield* stop(config)) {
    // Give the port back before the service takes it.
    yield* Effect.sleep("300 millis")
  }
  const file = yield* service.install(manager, exe)
  yield* waitUntilRunning(config)
  return file
})

/**
 * Starts `exe serve` detached from this process, logging to the home's
 * log file. See `proc.detached`: it outlives the terminal.
 */
export const spawn = Effect.fn("background.spawn")(function* (exe: string) {
  const home = yield* paths.Home.current
  yield* fsx.privateDir(home.dir)
  yield* proc
    .detached(exe, ["serve"], home.log())
    .pipe(Effect.catchTag("StartError", (e) => Effect.fail(new Failure({ message: "starting the proxy", cause: e }))))
})

const waitUntilRunning = Effect.fn("background.waitUntilRunning")(function* (config: Config) {
  const daemon = yield* Daemon.make(config)
  // 50 tries, 100 ms apart.
  const running = yield* daemon.isRunning.pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (up) => up, times: 49 }),
  )
  if (!running)
    return yield* Effect.fail(new Failure({ message: `the proxy did not start; see ${yield* paths.logFile}` }))
})
