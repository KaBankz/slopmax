import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Option, Redacted, Ref, Stream } from "effect"
import { ProxyState, StartedProxy } from "@slopmax/domain/desktop"
import { it } from "@slopmax/test"
import { connectionOf, Engine, keyFromDashboard, sameState, versionVerdict, withKey } from "../src/main/engine.ts"
import { healthClient, type Script, scriptedCli, service, started } from "./support.ts"

const script = (overrides: Partial<Script> = {}): Script => ({
  version: "0.4.0",
  start: [started("0.4.0")],
  stop: undefined,
  service: service(false),
  install: undefined,
  uninstall: undefined,
  ...overrides,
})

/** The engine over a scripted CLI and a proxy whose `/healthz` answers while `up` holds a version. */
const engineWith = (given: Script, up: Option.Option<string> = Option.some("0.4.0")) => {
  const cli = scriptedCli(given)
  const health = Ref.makeUnsafe(up)
  const layer = Engine.layer.pipe(Layer.provide(Layer.mergeAll(cli.layer, healthClient(health))))
  return { layer, calls: cli.calls, health, script: given }
}

const runningOn = (version: string) => ProxyState.cases.Running.make({ version })

const tags = (states: ReadonlyArray<ProxyState>) => states.map((state) => state._tag)

describe("where the proxy runs", () => {
  test("the owner key comes from the dashboard's address", () => {
    expect(keyFromDashboard("http://127.0.0.1:7567/slopmax/#key=sm-abc")).toEqual(Option.some("sm-abc"))
    expect(keyFromDashboard("http://127.0.0.1:7567/slopmax/")).toEqual(Option.none())
  })

  it.effect("a proxy reported without its key is refused", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        connectionOf(new StartedProxy({ ...started("0.4.0"), dashboard: "http://127.0.0.1:7567/slopmax/" })),
      )
      expect(error.message).toContain("without its owner key")
    }),
  )

  test("the web dashboard opens with the key the window never holds, and nothing else gets it", () => {
    const connection = { url: "http://127.0.0.1:7567", key: Redacted.make("sm-abc"), version: "0.4.0" }
    expect(withKey("http://127.0.0.1:7567/slopmax/", connection)).toEqual(
      Option.some("http://127.0.0.1:7567/slopmax/#key=sm-abc"),
    )
    expect(withKey("https://claude.ai/oauth/authorize?x=1", connection)).toEqual(Option.none())
    expect(withKey("http://127.0.0.1:9999/slopmax/", connection)).toEqual(Option.none())
    expect(withKey("http://127.0.0.1:7567/v1/models", connection)).toEqual(Option.none())
  })
})

describe("the proxy's release", () => {
  test("the same release, or a CLI that cannot say, is used as it is", () => {
    expect(versionVerdict("0.4.0", Option.some("0.4.0"), Option.none())).toBe("use")
    expect(versionVerdict("0.3.0", Option.none(), Option.none())).toBe("use")
  })

  test("another release is restarted, unless a login service runs it", () => {
    expect(versionVerdict("0.3.0", Option.some("0.4.0"), Option.some(service(false)))).toBe("restart")
    expect(versionVerdict("0.3.0", Option.some("0.4.0"), Option.none())).toBe("restart")
    expect(versionVerdict("0.3.0", Option.some("0.4.0"), Option.some(service(true)))).toBe("flag")
  })

  test("states read the same only when every part of them does", () => {
    expect(sameState(runningOn("0.4.0"), runningOn("0.4.0"))).toBe(true)
    expect(sameState(runningOn("0.4.0"), runningOn("0.4.1"))).toBe(false)
    expect(sameState(ProxyState.cases.Stopped.make({}), ProxyState.cases.Stopped.make({}))).toBe(true)
  })
})

describe("starting the proxy", () => {
  it.effect("goes from checking to starting to running, keeping where it runs and its key", () => {
    const { layer } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      const seen = yield* engine.changes.pipe(Stream.take(3), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      const result = yield* engine.launch
      expect(result.ok).toBe(true)
      expect(tags(yield* Fiber.join(seen))).toEqual(["Checking", "Starting", "Running"])
      const running = yield* engine.running
      expect(Option.map(running, (found) => [found.url, Redacted.value(found.key)])).toEqual(
        Option.some(["http://127.0.0.1:7567", "sm-one"]),
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect("a start that fails leaves the proxy stopped and says why", () => {
    const { layer } = engineWith(script({ start: ["port 7567 is taken"] }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      const result = yield* engine.launch
      expect(result).toMatchObject({ ok: false, message: "port 7567 is taken" })
      expect((yield* engine.state)._tag).toBe("Stopped")
      expect(yield* engine.running).toEqual(Option.none())
    }).pipe(Effect.provide(layer))
  })

  it.effect("a proxy of another release is restarted on the bundled CLI", () => {
    const { layer, calls } = engineWith(script({ start: [started("0.3.0"), started("0.4.0", "sm-two")] }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect(calls).toEqual(["start --json", "--version", "service status --json", "stop", "start --json"])
      expect(yield* engine.state).toEqual(ProxyState.cases.Running.make({ version: "0.4.0" }))
      expect(Option.map(yield* engine.running, (found) => Redacted.value(found.key))).toEqual(Option.some("sm-two"))
    }).pipe(Effect.provide(layer))
  })

  it.effect("a proxy of another release under a login service is flagged, not talked to", () => {
    const { layer, calls } = engineWith(script({ start: [started("0.3.0")], service: service(true) }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect(calls).not.toContain("stop")
      expect(yield* engine.state).toEqual(
        ProxyState.cases.OtherVersion.make({ running: "0.3.0", bundled: "0.4.0", service: true }),
      )
      // Calls from the window are not passed to it.
      expect(yield* engine.running).toEqual(Option.none())
    }).pipe(Effect.provide(layer))
  })

  it.effect("a call made while the proxy starts waits for it", () => {
    const { layer } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      const waiting = yield* Effect.forkChild(engine.ready)
      yield* Effect.yieldNow
      yield* engine.launch
      const ready = yield* Fiber.join(waiting)
      expect(Option.map(ready, (found) => found.version)).toEqual(Option.some("0.4.0"))
    }).pipe(Effect.provide(layer))
  })
})

describe("the window's proxy actions", () => {
  it.effect("stop stops it and says so", () => {
    const { layer } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect((yield* engine.act("stop")).ok).toBe(true)
      expect((yield* engine.state)._tag).toBe("Stopped")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a stop that fails says why and leaves the state alone", () => {
    const { layer } = engineWith(script({ stop: "it still answers after 5 seconds" }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect(yield* engine.act("stop")).toMatchObject({ ok: false, message: "it still answers after 5 seconds" })
      expect((yield* engine.state)._tag).toBe("Running")
    }).pipe(Effect.provide(layer))
  })

  it.effect("restart under a login service points the service at the bundled CLI, then takes the proxy up", () => {
    const { layer, calls } = engineWith(script({ start: [started("0.3.0"), started("0.4.0")], service: service(true) }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect((yield* engine.state)._tag).toBe("OtherVersion")
      calls.length = 0
      expect((yield* engine.act("restart")).ok).toBe(true)
      expect(calls.slice(0, 2)).toEqual(["service install", "start --json"])
      expect((yield* engine.state)._tag).toBe("Running")
    }).pipe(Effect.provide(layer))
  })

  it.effect("restart without a service stops and starts it", () => {
    const { layer, calls } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      calls.length = 0
      yield* engine.act("restart")
      expect(calls.slice(0, 2)).toEqual(["stop", "start --json"])
    }).pipe(Effect.provide(layer))
  })
})

describe("the login service", () => {
  it.effect("its status reaches the window as JSON", () => {
    const { layer } = engineWith(script({ service: service(true) }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      const result = yield* engine.service("status")
      expect(result.ok).toBe(true)
      expect(JSON.parse(result.message)).toMatchObject({ installed: true, running: true })
    }).pipe(Effect.provide(layer))
  })

  it.effect("installing or removing it is followed by starting the proxy the app's way", () => {
    const { layer, calls } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      expect((yield* engine.service("uninstall")).ok).toBe(true)
      expect(calls).toEqual(["service uninstall", "start --json", "--version"])
      expect((yield* engine.state)._tag).toBe("Running")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a system with no service manager says so", () => {
    const { layer } = engineWith(script({ install: "this system has no service manager" }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      expect(yield* engine.service("install")).toMatchObject({
        ok: false,
        message: "this system has no service manager",
      })
    }).pipe(Effect.provide(layer))
  })
})

describe("following the proxy", () => {
  it.effect("a dropped stream with the proxy gone reads as stopped", () => {
    const { layer, health } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      yield* Ref.set(health, Option.none())
      yield* engine.lost
      expect((yield* engine.state)._tag).toBe("Stopped")
      // Where it ran is kept, so the app notices it coming back.
      expect(Option.isSome(yield* engine.last)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a dropped stream with the proxy still up is read again: it restarted", () => {
    const { layer, calls } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      calls.length = 0
      yield* engine.lost
      expect(calls[0]).toBe("start --json")
      expect((yield* engine.state)._tag).toBe("Running")
    }).pipe(Effect.provide(layer))
  })

  it.effect("hello from the same release changes nothing; from another, it is settled as at launch", () => {
    const given = script()
    const { layer, calls } = engineWith(given)
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      calls.length = 0
      yield* engine.heard("0.4.0")
      expect(calls).toEqual([])
      given.start = [started("0.5.0"), started("0.4.0")]
      yield* engine.heard("0.5.0")
      expect(calls).toContain("stop")
      expect(yield* engine.state).toEqual(ProxyState.cases.Running.make({ version: "0.4.0" }))
    }).pipe(Effect.provide(layer))
  })

  it.effect("a restart that brings the other release back is tried once, not on every reconnect", () => {
    // A CLI that says 0.5.0 while the proxy it starts answers 0.4.0.
    const { layer, calls } = engineWith(script({ version: "0.5.0", start: [started("0.4.0")] }))
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect(calls.filter((call) => call === "stop")).toHaveLength(1)
      expect(yield* engine.state).toEqual(
        ProxyState.cases.OtherVersion.make({ running: "0.4.0", bundled: "0.5.0", service: false }),
      )
      calls.length = 0
      // The restart dropped the stream: it reconnects, says hello, and drops once more.
      yield* engine.lost
      yield* engine.heard("0.4.0")
      yield* engine.lost
      expect(calls).not.toContain("stop")
      expect((yield* engine.state)._tag).toBe("OtherVersion")
    }).pipe(Effect.provide(layer))
  })

  it.effect("a refused key is read again, and only a new one is offered", () => {
    const given = script()
    const { layer } = engineWith(given)
    return Effect.gen(function* () {
      const engine = yield* Engine
      yield* engine.launch
      expect(yield* engine.refreshKey).toEqual(Option.none())
      given.start = [started("0.4.0", "sm-new")]
      const fresh = yield* engine.refreshKey
      expect(Option.map(fresh, (found) => Redacted.value(found.key))).toEqual(Option.some("sm-new"))
    }).pipe(Effect.provide(layer))
  })

  it.effect("the offline view is the CLI's report and doctor", () => {
    const { layer, calls } = engineWith(script())
    return Effect.gen(function* () {
      const engine = yield* Engine
      const offline = yield* engine.offline
      expect(offline.report.version).toBe("0.4.0")
      expect(offline.doctor.map((section) => section.title)).toEqual(["Proxy"])
      expect(calls.toSorted()).toEqual(["doctor --json", "status --json"])
    }).pipe(Effect.provide(layer))
  })
})
