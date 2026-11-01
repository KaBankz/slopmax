// The daemon: how its periodic tasks run, what it keeps across restarts,
// and how it starts and stops.
import { describe, expect } from "bun:test"
import { Limits, type Settings, Window } from "@slopmax/domain"
import { it, TestHome } from "@slopmax/test"
import { BunServices } from "@effect/platform-bun"
import {
  Array,
  Cause,
  ConfigProvider,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Daemon, every, keepState, lookForNotices, quotaTasks } from "../../src/daemon.ts"
import { Events } from "../../src/events.ts"
import { Ledger } from "../../src/ledger.ts"
import { block, observe, pin, Pool, SavedState } from "../../src/pool.ts"
import { ListenFailed, Server } from "../../src/server.ts"
import { Quota } from "../../src/quota.ts"
import { SettingsService } from "../../src/settings.ts"
import { oauth } from "../proxy/stack.ts"
import { Assets } from "../../src/api/assets.ts"
import { apiStack, home } from "../api/stack.ts"

/** Log lines at `level` and above, as text. */
const captureLogs = () => {
  const lines: Array<{ readonly level: string; readonly text: string }> = []
  const layer = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      lines.push({ level: logLevel, text: Array.ensure(message).map(String).join(" ") })
    }),
  ])
  return {
    lines,
    layer,
    text: (level: string) => lines.filter((line) => line.level === level).map((line) => line.text),
  }
}

const codexAccount = oauth("codex", "a", "tok-ok", 1)
const codexId = codexAccount.id

/** The pool's state as written to `state.json`, or none. */
const savedState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const exists = yield* fs.exists(`${home}/state.json`)
  if (!exists) return Option.none<SavedState>()
  const text = yield* fs.readFileString(`${home}/state.json`)
  return Option.some(Schema.decodeUnknownSync(Schema.fromJsonString(SavedState))(text))
})

/** How often each quota task ran over half an hour of the clock, under `on`. */
const tally = (on: Partial<typeof Settings.Encoded>) =>
  Effect.gen(function* () {
    const counts = { refresh: 0, list: 0, redeem: 0, warm: 0, poll: 0 }
    const count = (name: keyof typeof counts) =>
      Effect.sync(() => {
        counts[name] += 1
      })
    const quota = Layer.succeed(Quota)({
      refreshDue: count("refresh"),
      listDue: () => count("list"),
      redeemExpiring: count("redeem"),
      warm: count("warm"),
      pollDue: () => count("poll"),
      poll: () => Effect.die("not scheduled"),
      listResets: () => Effect.die("not scheduled"),
      redeem: () => Effect.die("not scheduled"),
      rescue: () => Effect.die("not scheduled"),
    })
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* quotaTasks
        // Half an hour, ten seconds at a time: runs at 0 and then a period after each.
        for (let step = 0; step <= 180; step++) yield* TestClock.adjust("10 seconds")
      }).pipe(Effect.provide(Layer.merge(quota, SettingsService.layerValue(on)))),
    )
    return counts
  })

describe("Daemon schedules", () => {
  it.effect("runs a task at once, then a full period after each run ends, never overlapping or catching up", () =>
    Effect.gen(function* () {
      const runs = yield* Ref.make<Array<number>>([])
      const running = yield* Ref.make(0)
      const overlapped = yield* Ref.make(false)
      const task = Effect.gen(function* () {
        const now = (yield* DateTime.now).epochMilliseconds
        yield* Ref.update(runs, (all) => [...all, now / 1000])
        if ((yield* Ref.getAndUpdate(running, (n) => n + 1)) > 0) yield* Ref.set(overlapped, true)
        // Each run takes 4 seconds of a 10-second period.
        yield* Effect.sleep("4 seconds")
        yield* Ref.update(running, (n) => n - 1)
      })
      yield* every("10 seconds", task)
      yield* TestClock.adjust("0 millis")
      expect(yield* Ref.get(runs)).toEqual([0])
      // A long pause on the clock brings one run at a time, each 10 s after the last ended.
      for (let step = 0; step < 50; step++) yield* TestClock.adjust("1 second")
      expect(yield* Ref.get(runs)).toEqual([0, 14, 28, 42])
      expect(yield* Ref.get(overlapped)).toBe(false)
    }).pipe(Effect.provide(SettingsService.layerValue())),
  )

  it.effect("skips a run while its setting is off, and follows a change without a restart", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsService
      const count = yield* Ref.make(0)
      yield* every(
        "1 minute",
        Ref.update(count, (n) => n + 1),
        (s) => s.warmWindows,
      )
      yield* TestClock.adjust("2 minutes")
      expect(yield* Ref.get(count)).toBe(0)
      yield* settings.setLive({ warmWindows: true })
      yield* TestClock.adjust("1 minute")
      expect(yield* Ref.get(count)).toBe(1)
      yield* settings.setLive({ warmWindows: false })
      yield* TestClock.adjust("3 minutes")
      expect(yield* Ref.get(count)).toBe(1)
    }).pipe(Effect.provide(SettingsService.layerValue({ warmWindows: false }))),
  )

  it.effect("keeps tokens, readings and resets current on their periods, each only while its setting is on", () => {
    // Each setting on in one run and off in the other, so a task under the wrong setting shows.
    return Effect.gen(function* () {
      expect(yield* tally({ refreshTokens: true, redeemExpiring: false, warmWindows: true, pollMinutes: 0 })).toEqual({
        refresh: 7,
        list: 31,
        redeem: 0,
        warm: 31,
        poll: 0,
      })
      expect(yield* tally({ refreshTokens: false, redeemExpiring: true, warmWindows: false, pollMinutes: 5 })).toEqual({
        refresh: 0,
        list: 31,
        redeem: 2,
        warm: 0,
        poll: 31,
      })
    })
  })

  it.effect("logs a failed run and goes on with the schedule", () => {
    const logs = captureLogs()
    return Effect.gen(function* () {
      const count = yield* Ref.make(0)
      yield* every(
        "1 minute",
        Effect.flatMap(
          Ref.updateAndGet(count, (n) => n + 1),
          (n) => (n === 1 ? Effect.fail("disk full") : Effect.void),
        ),
      )
      yield* TestClock.adjust("2 minutes")
      expect(yield* Ref.get(count)).toBe(3)
      expect(logs.text("Warn").some((line) => line.includes("disk full"))).toBe(true)
    }).pipe(Effect.provide(SettingsService.layerValue().pipe(Layer.provideMerge(logs.layer))))
  })
})

describe("Daemon state", () => {
  it.effect(
    "records ended windows in the ledger, lets go of idle sessions, and saves state.json when it changed",
    () => {
      const { layer } = apiStack({ accounts: [codexAccount], settings: { sessionMinutes: 30 } })
      return Effect.gen(function* () {
        const pool = yield* Pool
        const ledger = yield* Ledger
        // A week 40% used that ends at the 1-hour mark, and a session last used at the start.
        yield* pool.update((m) =>
          observe(
            m,
            codexId,
            new Limits({
              windows: [Window.of("7d", 40, DateTime.makeUnsafe(3_600_000))],
              observedAt: DateTime.makeUnsafe(0),
            }),
            DateTime.makeUnsafe(0),
          ),
        )
        yield* pool.update((m) => pin(m, "codex", codexId))
        yield* keepState
        const first = Option.getOrThrow(yield* savedState)
        expect(first.pins.codex).toBe(codexId)
        // Nothing changed since: the file is not written again.
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(`${home}/state.json`)
        yield* keepState
        expect(Option.isNone(yield* savedState)).toBe(true)

        // Past the window's end: the lapse is recorded once, with the account's provider.
        yield* TestClock.adjust("2 hours")
        yield* keepState
        yield* keepState
        yield* ledger.flush
        const ended = (yield* ledger.load(DateTime.makeUnsafe(0))).filter((record) => record._tag === "WindowEnded")
        expect(ended).toHaveLength(1)
        expect(ended[0]).toMatchObject({ account: codexId, provider: "codex", span: "7d", used: 40 })
        expect(Option.isSome(yield* savedState)).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect("lets go of sessions idle past the session time when it saves", () => {
    const { layer } = apiStack({
      accounts: [codexAccount],
      settings: { sessionMinutes: 30 },
      files: {
        "state.json": JSON.stringify({
          sessions: [{ provider: "codex", id: "s-1", account: codexId, at: "1970-01-01T00:00:00Z" }],
        }),
      },
    })
    return Effect.gen(function* () {
      const pool = yield* Pool
      expect((yield* pool.model).sessions.pipe((sessions) => [...sessions].length)).toBe(1)
      yield* TestClock.adjust("31 minutes")
      yield* keepState
      expect([...(yield* pool.model).sessions]).toHaveLength(0)
      expect(Option.getOrThrow(yield* savedState).sessions).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.effect("tells a nudge once, and never again after a restart", () => {
    // A week that ends in 12 hours with 90% of it unused.
    const health = {
      health: {
        [codexId]: {
          limits: {
            windows: [{ span: "7d", used: 10, resetsAt: "1970-01-01T12:00:00Z" }],
            observedAt: "1970-01-01T00:00:00Z",
          },
        },
      },
    }
    const watchNotices = Effect.gen(function* () {
      const events = yield* Events
      return yield* events.subscribe.pipe(
        Stream.filter((event) => event._tag === "Notice"),
        Stream.runCollect,
        Effect.forkScoped,
      )
    })
    const run = (state: string) =>
      Effect.gen(function* () {
        const notices = yield* watchNotices
        yield* TestClock.adjust("0 millis")
        yield* lookForNotices
        yield* lookForNotices
        yield* keepState
        yield* TestClock.adjust("0 millis")
        yield* Fiber.interrupt(notices)
        const fs = yield* FileSystem.FileSystem
        return {
          saved: yield* fs.readFileString(`${home}/state.json`),
          told: yield* Effect.flatMap(Pool, (p) => p.model),
        }
      }).pipe(Effect.provide(apiStack({ accounts: [codexAccount], files: { "state.json": state } }).layer))
    const logs = captureLogs()
    return Effect.gen(function* () {
      const first = yield* run(JSON.stringify(health))
      const told = logs.text("Info").filter((line) => line.includes("resets"))
      expect(told).toHaveLength(1)
      expect(Object.keys(first.told.told)).toHaveLength(1)
      const second = yield* run(first.saved)
      expect(logs.text("Info").filter((line) => line.includes("resets"))).toHaveLength(1)
      expect(Object.keys(second.told.told)).toEqual(Object.keys(first.told.told))
    }).pipe(Effect.provide(logs.layer))
  })
})

describe("Daemon start and stop", () => {
  it.effect("refuses to start beside another daemon on the same home", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      // The first daemon runs for the test; a second over the same home and locks (built afresh, as
      // another process would) cannot take the serve lock.
      const context = yield* Effect.context<never>()
      const fresh = yield* Layer.makeMemoMap
      const scope = yield* Effect.scope
      const second = yield* Effect.exit(
        Layer.buildWithMemoMap(Daemon.layerWith({ schedules: false, listen: false }), fresh, scope).pipe(
          Effect.provideContext(context),
        ),
      )
      expect(Exit.isFailure(second)).toBe(true)
      if (Exit.isFailure(second)) expect(String(second.cause)).toContain("AlreadyServing")
    }).pipe(Effect.provide(layer))
  })

  it.effect("will not start over a state.json it cannot read", () => {
    const { layer } = apiStack({ files: { "state.json": "{ not json" } })
    return Effect.gen(function* () {
      const started = yield* Effect.exit(Effect.provide(Effect.void, layer))
      expect(Exit.isFailure(started)).toBe(true)
      if (Exit.isFailure(started)) expect(String(started.cause)).toContain("state.json")
    })
  })

  it.effect("on stop, applies what finished answers left behind and saves state.json last", () => {
    const { layer } = apiStack({ accounts: [codexAccount] })
    const logs = captureLogs()
    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      const pool = Effect.provideContext(Effect.service(Pool), context)
      yield* Effect.flatMap(pool, (p) =>
        p.update((m, now) => block(m, codexId, DateTime.add(now, { hours: 1 }), undefined, "spent")),
      )
      yield* Scope.close(scope, Exit.void)
      const saved = Option.getOrThrow(yield* Effect.provideContext(savedState, context))
      expect(saved.health[codexId]?.blockedUntil).toBeDefined()
      expect(logs.text("Info").at(-1)).toBe("stopped")
    }).pipe(Effect.provide(logs.layer))
  })

  it.live("fails to start on an address already in use, naming it", () =>
    Effect.gen(function* () {
      const first = apiStack({ listen: true, settings: { listen: "127.0.0.1:0" } })
      const context = yield* Layer.build(first.layer)
      const address = Context.get(context, Server).address
      const second = apiStack({ listen: true, settings: { listen: address } })
      const started = yield* Effect.exit(Layer.build(second.layer))
      expect(Exit.isFailure(started)).toBe(true)
      const failure = Exit.isFailure(started) ? Cause.squash(started.cause) : undefined
      expect(failure instanceof ListenFailed && failure.message.startsWith(`cannot listen on ${address}`)).toBe(true)
    }),
  )

  it.live(
    "listens where the settings say, says so with its version, and stops when asked through the API",
    () =>
      Effect.gen(function* () {
        const testHome = yield* TestHome.make("daemon-serve")
        const log = testHome.path("slopmax.log")
        const config = ConfigProvider.fromUnknown({
          SLOPMAX_HOME: testHome.slopmax,
          HOME: testHome.root,
          CLAUDE_CONFIG_DIR: testHome.claude,
          CODEX_HOME: testHome.codex,
          SLOPMAX_LISTEN: "127.0.0.1:0",
          SLOPMAX_NO_SERVICE: "1",
        })
        const serving = yield* Daemon.serve({ log }).pipe(
          Effect.provide(Assets.none.pipe(Layer.provideMerge(ConfigProvider.layer(config)))),
          Effect.forkScoped,
        )
        const fs = yield* FileSystem.FileSystem
        // The log names the address once it listens.
        let base: string | undefined
        for (let tries = 0; tries < 200 && base === undefined; tries++) {
          yield* Effect.sleep("10 millis")
          const text = yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""))
          base = /slopmax \S+ listening on (http:\/\/\S+)/.exec(text)?.[1]
        }
        expect(base).toBeDefined()
        const settings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ apiKey: Schema.String })))(
          yield* fs.readFileString(`${testHome.slopmax}/config.json`),
        )
        const answer = yield* Effect.promise(() =>
          fetch(`${base}/slopmax/api/shutdown`, {
            method: "POST",
            headers: { authorization: `Bearer ${settings.apiKey}` },
          }),
        )
        expect(yield* Effect.promise(() => answer.json())).toEqual({ status: "stopping" })
        const exit = yield* Fiber.await(serving)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(yield* fs.readFileString(log)).toContain("stopped")
      }).pipe(Effect.provide(BunServices.layer)),
    15_000,
  )
})
