// Test support for the desktop's main process: a scripted CLI, a proxy that
// answers `/healthz` (or not) in process, a spawner that runs nothing, and
// small report and doctor fixtures. Nothing here starts Electron.
import { Effect, Layer, Option, PlatformError, Redacted, Ref, Schema, Sink, Stream } from "effect"
import { Report, Section } from "@slopmax/domain"
import { ServiceView, StartedProxy } from "@slopmax/domain/desktop"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { Cli, CliFailed, type Ran, type Shape as CliShape } from "../src/main/cli.ts"
import { Engine, type Shape as EngineShape } from "../src/main/engine.ts"

export const report = (version = "0.4.0"): Report =>
  Schema.decodeUnknownSync(Report)({
    version,
    live: false,
    generatedAt: "2026-11-01T09:00:00Z",
    strategy: "fill-first",
    accounts: [],
    pools: [],
    nudges: [],
  })

export const doctorSections: ReadonlyArray<Section> = [
  Schema.decodeUnknownSync(Section)({ title: "Proxy", findings: [{ level: "fail", text: "slopmax is not running" }] }),
]

export const started = (version: string, key = "sm-one", port = 7567): StartedProxy =>
  new StartedProxy({
    url: `http://127.0.0.1:${port}`,
    dashboard: `http://127.0.0.1:${port}/slopmax/#key=${key}`,
    version,
    log: "/home/someone/.slopmax/slopmax.log",
  })

export const service = (installed: boolean): ServiceView =>
  new ServiceView({
    installed,
    running: installed,
    file: "/home/someone/.config/systemd/user/slopmax.service",
    lingering: null,
  })

/** What the scripted CLI answers; each field can be changed by a test as it goes. */
export interface Script {
  version: string
  /** What `start --json` answers next; a string fails with that message. */
  start: Array<StartedProxy | string>
  stop: string | undefined
  service: ServiceView | string
  install: string | undefined
  uninstall: string | undefined
}

const fail = (message: string) => Effect.fail(new CliFailed({ message }))
const done = (said: string | undefined) => (said === undefined ? Effect.void : fail(said))

/** A CLI that runs nothing: it answers from `script` and records what it was asked. */
export const scriptedCli = (script: Script) => {
  const calls: Array<string> = []
  const shape: CliShape = {
    program: Effect.succeed("/opt/slopmax/resources/bin/slopmax"),
    run: () => Effect.succeed<Ran>({ code: 0, stdout: "", stderr: "" }),
    version: Effect.suspend(() => {
      calls.push("--version")
      return Effect.succeed(script.version)
    }),
    start: Effect.suspend(() => {
      calls.push("start --json")
      const next = script.start.length > 1 ? script.start.shift() : script.start[0]
      if (next === undefined) return fail("nothing scripted for start")
      return typeof next === "string" ? fail(next) : Effect.succeed(next)
    }),
    stop: Effect.suspend(() => {
      calls.push("stop")
      return done(script.stop)
    }),
    status: Effect.sync(() => {
      calls.push("status --json")
      return report()
    }),
    doctor: Effect.sync(() => {
      calls.push("doctor --json")
      return doctorSections
    }),
    serviceStatus: Effect.suspend(() => {
      calls.push("service status --json")
      return typeof script.service === "string" ? fail(script.service) : Effect.succeed(script.service)
    }),
    serviceInstall: Effect.suspend(() => {
      calls.push("service install")
      return done(script.install)
    }),
    serviceUninstall: Effect.suspend(() => {
      calls.push("service uninstall")
      return done(script.uninstall)
    }),
  }
  return { layer: Layer.succeed(Cli, shape), calls }
}

/** An HttpClient where `/healthz` answers with `version` while `up` holds it, and nothing else answers. */
export const healthClient = (up: Ref.Ref<Option.Option<string>>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.flatMap(Ref.get(up), (version) =>
        Option.match(version, {
          onNone: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
              }),
            ),
          onSome: (found) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "ok", version: found }))),
        }),
      ),
    ),
  )

export const keyOf = (key: Redacted.Redacted<string>): string => Redacted.value(key)

const encoder = new TextEncoder()
const bytes = (text: string | undefined) =>
  text === undefined || text === "" ? Stream.empty : Stream.make(encoder.encode(text))

/** A spawner over a script of answers by arguments, recording each run. */
export const scriptedSpawner = (answer: (args: ReadonlyArray<string>) => Partial<Ran> | "missing") => {
  const calls: Array<ReadonlyArray<string>> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.suspend(() => {
      if (command._tag !== "StandardCommand") return Effect.die(new Error("piped commands are not scripted"))
      const args = command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg))
      calls.push([command.command, ...args])
      const ran = answer(args)
      if (ran === "missing") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            description: "not found",
          }),
        )
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(ran.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: bytes(ran.stdout),
          stderr: bytes(ran.stderr),
          all: Stream.concat(bytes(ran.stdout), bytes(ran.stderr)),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      )
    }),
  )
  return { layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner), calls }
}

const notScripted = (what: string) => Effect.die(new Error(`the test did not script ${what}`))

/** An engine whose every part fails the test unless the test gives it. */
export const fakeEngine = (given: Partial<EngineShape>): Layer.Layer<Engine> => {
  const unscripted: EngineShape = {
    state: notScripted("state"),
    changes: Stream.die(new Error("the test did not script changes")),
    running: notScripted("running"),
    ready: notScripted("ready"),
    last: notScripted("last"),
    alive: () => notScripted("alive"),
    launch: notScripted("launch"),
    act: () => notScripted("act"),
    service: () => notScripted("service"),
    offline: notScripted("offline"),
    heard: () => notScripted("heard"),
    lost: notScripted("lost"),
    refreshKey: notScripted("refreshKey"),
  }
  return Layer.succeed(Engine, { ...unscripted, ...given })
}
