import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import {
  AccountId,
  AccountView,
  Condition,
  LimitReset,
  Notice,
  type NoticeKind,
  type ProviderId,
  Report,
  type Settings,
  slopmaxVersion,
  Usage,
  Window,
} from "@slopmax/domain"
import { it } from "@slopmax/test"
import {
  Array,
  DateTime,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  Schema,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { Events } from "../../src/events.ts"
import type { Pricing } from "../../src/ledger-views.ts"
import {
  commandEnv,
  type Conditions,
  noConditions,
  Notifier,
  NotifyFailed,
  NotifyOff,
  nudges,
  shellFor,
  tell,
  testMessage,
  Told,
  type ToldSet,
  watch,
} from "../../src/notifier.ts"
import { SettingsService } from "../../src/settings.ts"
import { Upstream } from "../../src/upstream.ts"

const id = Schema.decodeUnknownSync(AccountId)
const utc = DateTime.zoneMakeOffset(0)
const now = DateTime.makeUnsafe("2027-01-15T08:00:00Z")
const hours = (n: number) => DateTime.addDuration(now, Duration.hours(n))

const ready = Condition.cases.Ready.make({})
const limitedUntil = (until: DateTime.Utc) => Condition.cases.Limited.make({ until })
const signedOut = (error: string) => Condition.cases.SignInNeeded.make({ error })

const account = (
  provider: ProviderId,
  name: string,
  fields: Partial<ConstructorParameters<typeof AccountView>[0]> = {},
): AccountView =>
  new AccountView({
    id: id(
      `${provider}-${name
        .replace(/[^a-z]/g, "")
        .padEnd(8, "0")
        .slice(0, 8)}`,
    ),
    provider,
    name,
    disabled: false,
    priority: 0,
    pinned: false,
    models: [],
    sessions: 0,
    condition: ready,
    notes: [],
    windows: [],
    resets: [],
    served: Usage.zero,
    ...fields,
  })

const report = (accounts: ReadonlyArray<AccountView>, nudgesNow: ReadonlyArray<Notice> = [], at = now) =>
  new Report({
    version: slopmaxVersion,
    live: true,
    generatedAt: at,
    strategy: "reset-first",
    accounts,
    pools: [],
    nudges: nudgesNow,
  })

const limitedForAnHour = (view: AccountView) => new AccountView({ ...view, condition: limitedUntil(hours(1)) })

const kinds = (notices: ReadonlyArray<Notice>): ReadonlyArray<NoticeKind> => notices.map((notice) => notice.kind)

/** Looks at reports one after another, as the daemon does every 15 seconds. */
const watcher = () => {
  let seen: Conditions = noConditions
  return (accounts: ReadonlyArray<AccountView>) => {
    const [notices, next] = watch(seen, report(accounts), utc)
    seen = next
    return notices
  }
}

describe("watching conditions", () => {
  it("reports each change once, and the first look only takes stock", () => {
    const look = watcher()
    const a = account("claude", "a@x.dev")
    const b = account("claude", "b@x.dev")
    const later = hours(2)
    const aLimited = new AccountView({ ...a, condition: limitedUntil(later) })
    const bLimited = new AccountView({ ...b, condition: limitedUntil(later) })

    // The first look takes stock, even of a limited account.
    expect(look([aLimited, b])).toEqual([])
    expect(look([aLimited, b])).toEqual([])

    // The last ready account going down is one notice, for the provider.
    const spent = look([aLimited, bLimited])
    expect(kinds(spent)).toEqual(["exhausted"])
    expect(spent[0]?.until).toEqual(later)
    expect(spent[0]?.message).toBe(
      "Every Claude account is limited or signed out, so Claude requests fail until in 2h00m (10:00).",
    )
    expect(look([aLimited, bLimited])).toEqual([])

    // One coming back is its own news and the provider's.
    expect(kinds(look([a, bLimited]))).toEqual(["available", "recovered"])

    // A sign-out names the fix.
    const out = look([new AccountView({ ...a, condition: signedOut("refresh token revoked") }), bLimited])
    expect(kinds(out)).toEqual(["signed-out", "exhausted"])
    expect(out[0]?.message).toBe(
      "a@x.dev is signed out (refresh token revoked); run `slopmax login claude` to sign in again.",
    )
  })

  it("tells of an account limited on its own, with when it is back", () => {
    const look = watcher()
    const a = account("codex", "a@x.dev")
    const b = account("codex", "b@x.dev")
    look([a, b])
    const [limited] = look([new AccountView({ ...a, condition: limitedUntil(hours(3)) }), b])
    expect(limited?.kind).toBe("limited")
    expect(limited?.message).toBe("a@x.dev hit a usage limit; back in 3h00m (11:00).")
    expect(limited?.account).toBe("a@x.dev")
    expect(limited?.provider).toBe("codex")
    expect(limited?.until).toEqual(hours(3))
    expect(limited?.key).toBe(`account:${a.id}`)
  })

  it("ignores accounts their owner switched off", () => {
    const look = watcher()
    const a = account("codex", "a@x.dev")
    const off = account("codex", "b@x.dev", { disabled: true, condition: Condition.cases.Disabled.make({}) })
    expect(look([a, off])).toEqual([])
    expect(kinds(look([new AccountView({ ...a, condition: limitedUntil(hours(1)) }), off]))).toEqual(["exhausted"])
    // Switched off with a failed sign-in too, it is still none of the notices' business.
    expect(look([a, new AccountView({ ...off, condition: signedOut("revoked") })]).map((n) => n.kind)).toEqual([
      "available",
      "recovered",
    ])
  })

  it("forgets a removed account, so one added again starts fresh", () => {
    const look = watcher()
    const a = account("claude", "a@x.dev")
    const b = account("claude", "b@x.dev")
    look([a, b])
    look([b])
    expect(look([new AccountView({ ...a, condition: limitedUntil(hours(1)) }), b])).toEqual([])
  })
})

const fees: Readonly<Record<string, number>> = { "claude/max 20x": 200 }
const planFee: Pick<Pricing, "planFee"> = { planFee: (provider, plan) => fees[`${provider}/${plan}`] }

const options = (autoRedeem: boolean, at = now) => ({ autoRedeem, pricing: planFee, now: at, zone: utc })

describe("nudges", () => {
  const work = account("claude", "work@x.dev", {
    plan: "max 20x",
    resets: [
      new LimitReset({ id: "soon", expiresAt: hours(5) }),
      new LimitReset({ id: "later", expiresAt: hours(72) }),
    ],
    windows: [Window.of("5h", 0, hours(2)), Window.of("7d", 40, hours(10)), Window.of("7d", 0, hours(10), "Fable")],
  })

  it("names lapsing resets and spare weeks, once each", () => {
    const found = nudges([work], options(false))
    expect(kinds(found)).toEqual(["reset-expiring", "quota-unused"])
    const [reset, spare] = found
    expect(reset?.message).toBe(
      "A limit reset on work@x.dev expires in 5h00m (13:00); redeem it with `slopmax redeem work@x.dev` before it is lost.",
    )
    expect(reset?.until).toEqual(hours(5))
    expect(reset?.key).toBe(`reset:${work.id}:soon`)
    // 60% of a $200 plan's week: about $28.
    expect(spare?.message).toBe(
      "work@x.dev's week resets in 10h00m (18:00) with 60% of it unused, about $28 of its plan. Work sent there before then costs nothing extra.",
    )
    expect(spare?.worth).toBeCloseTo(((200 * 12) / 52) * 0.6, 9)
    expect(spare?.key).toBe(`unused:${work.id}:7d:${DateTime.toEpochMillis(hours(10)) / 1000}`)

    // With redeeming on, slopmax spends the reset itself.
    expect(nudges([work], options(true)).length).toBe(1)

    // Each is told once, a restart included.
    const first = tell({}, nudges([work], options(false)), now)
    expect(first.fresh.length).toBe(2)
    expect(tell(first.told, nudges([work], options(false)), now).fresh).toEqual([])
    const restarted: ToldSet = { ...first.told }
    expect(tell(restarted, nudges([work], options(false)), now).fresh).toEqual([])
  })

  it("says nothing of a week nearly spent, an account switched off or signed out, or a week far from its reset", () => {
    const nearly = new AccountView({ ...work, windows: [Window.of("7d", 90, hours(10))] })
    expect(nudges([nearly], options(true))).toEqual([])
    expect(nudges([new AccountView({ ...work, disabled: true })], options(false))).toEqual([])
    expect(nudges([new AccountView({ ...work, condition: signedOut("revoked") })], options(false))).toEqual([])
    expect(nudges([work], options(true, DateTime.subtractDuration(now, Duration.hours(48))))).toEqual([])
  })

  it("says nothing of a limited account's spare week, which could not take the work", () => {
    const limited = new AccountView({ ...work, condition: limitedUntil(hours(1)) })
    expect(kinds(nudges([limited], options(false)))).toEqual(["reset-expiring"])
  })

  it("calls a monthly window a month, and leaves out the worth of a plan with no known price", () => {
    const team = account("codex", "team@x.dev", { plan: "team", windows: [Window.of("30d", 0, hours(3))] })
    const [month] = nudges([team], options(true))
    expect(month?.message).toBe(
      "team@x.dev's month resets in 3h00m (11:00) with 100% of it unused. Work sent there before then costs nothing extra.",
    )
    expect(month?.worth).toBeUndefined()
  })
})

const nudge = (key: string, until: DateTime.Utc) =>
  new Notice({ kind: "quota-unused", key, until, message: "spare", at: now })

describe("the told set", () => {
  it("tells a nudge once", () => {
    const first = tell({}, [nudge("a", hours(1))], now)
    expect(first.fresh.map((n) => n.key)).toEqual(["a"])
    expect(first.changed).toBe(true)
    const again = tell(first.told, [nudge("a", hours(1))], now)
    expect(again.fresh).toEqual([])
    expect(again.changed).toBe(false)
  })

  it("keeps what was told past a restart until its moment passes", () => {
    const told: ToldSet = { a: hours(1), b: hours(-1) }
    const kept = tell(told, [nudge("a", hours(1))], now)
    expect(kept.fresh).toEqual([])
    expect(Object.keys(kept.told)).toEqual(["a"])
    expect(kept.changed).toBe(true)
    expect(tell(kept.told, [], hours(2)).told).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Sending

interface Received {
  readonly url: string
  readonly body: unknown
}

const Posted = Schema.Struct({ kind: Schema.String, message: Schema.String })
const posted = (received: Received) => Schema.decodeUnknownSync(Posted)(received.body)

const webhookServer = (status = 204) => {
  const received: Array<Received> = []
  const layer = Upstream.layerHandler(async (request) => {
    received.push({ url: request.url, body: await request.json() })
    return new Response(null, { status })
  })
  return { received, layer }
}

const notifierWith = (
  notify: NonNullable<Partial<typeof Settings.Encoded>["notify"]>,
  upstream: Layer.Layer<Upstream>,
  told: ToldSet = {},
  spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> = BunServices.layer,
) =>
  Notifier.layer.pipe(
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(Told.layerMemory(told)),
    Layer.provide(SettingsService.layerValue({ notify })),
    Layer.provide(upstream),
    Layer.provide(spawner),
  )

const exhausted = new Notice({
  kind: "exhausted",
  key: "provider:claude",
  provider: "claude",
  until: hours(2),
  message: "Every Claude account is limited or signed out, so Claude requests fail until in 2h00m (10:00).",
  at: now,
})

const signedOutNotice = new Notice({
  kind: "signed-out",
  key: "account:claude-a",
  provider: "claude",
  account: "a@x.dev",
  message: "a@x.dev is signed out (revoked); run `slopmax login claude` to sign in again.",
  at: now,
})

const failureOf = <A, R>(effect: Effect.Effect<A, NotifyFailed | NotifyOff, R>) =>
  Effect.map(Effect.flip(effect), (error) => error.message)

describe("Notifier", () => {
  it.effect("posts a notice to the webhook as JSON, with text and content for chat apps", () => {
    const hook = webhookServer()
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.send(exhausted)
      expect(hook.received.length).toBe(1)
      expect(hook.received[0]?.url).toBe("https://hooks.example/slopmax")
      expect(hook.received[0]?.body).toEqual({
        kind: "exhausted",
        key: "provider:claude",
        provider: "claude",
        until: "2027-01-15T10:00:00Z",
        message: exhausted.message,
        at: "2027-01-15T08:00:00Z",
        text: exhausted.message,
        content: exhausted.message,
      })
    }).pipe(Effect.provide(notifierWith({ webhook: "https://hooks.example/slopmax" }, hook.layer)))
  })

  it.effect("fails with the status a webhook answered other than 2xx", () => {
    const hook = webhookServer(500)
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      expect(yield* failureOf(notifier.send(exhausted))).toBe("webhook: HTTP 500")
    }).pipe(Effect.provide(notifierWith({ webhook: "https://hooks.example/slopmax" }, hook.layer)))
  })

  it.effect("sends only the kinds the settings want, and the test notice always", () => {
    const hook = webhookServer()
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.send(exhausted)
      expect(hook.received.length).toBe(0)
      yield* notifier.send(signedOutNotice)
      yield* notifier.test
      expect(hook.received.map((r) => posted(r).kind)).toEqual(["signed-out", "test"])
      expect(hook.received.map((r) => posted(r).message)[1]).toBe(testMessage)
    }).pipe(
      Effect.provide(notifierWith({ webhook: "https://hooks.example/slopmax", events: ["signed-out"] }, hook.layer)),
    )
  })

  it.effect("refuses the test when nowhere is set up to receive it", () =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      const refused = yield* Effect.flip(notifier.test)
      expect(refused).toBeInstanceOf(NotifyOff)
    }).pipe(Effect.provide(notifierWith({}, webhookServer().layer))),
  )

  it.effect("runs the command with the notice in SLOPMAX_ variables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-notify-" })
      const out = path.join(dir, "out")
      const command = `printf '%s|%s|%s|%s|%s' "$SLOPMAX_EVENT" "$SLOPMAX_PROVIDER" "$SLOPMAX_ACCOUNT" "$SLOPMAX_UNTIL" "$SLOPMAX_MESSAGE" > '${out}'`
      yield* Effect.gen(function* () {
        const notifier = yield* Notifier
        yield* notifier.test
        expect(yield* fs.readFileString(out)).toBe(`test||||${testMessage}`)
        yield* notifier.send(exhausted)
        expect(yield* fs.readFileString(out)).toBe(`exhausted|claude||2027-01-15T10:00:00Z|${exhausted.message}`)
      }).pipe(Effect.provide(notifierWith({ command }, webhookServer().layer)))
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.effect("tries the webhook and the command both, and names each failure", () =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      expect(yield* failureOf(notifier.send(exhausted))).toBe("webhook: HTTP 502; command: exit status 3: nope")
    }).pipe(
      Effect.provide(
        notifierWith(
          { webhook: "https://hooks.example/slopmax", command: "echo nope >&2; exit 3" },
          webhookServer(502).layer,
        ),
      ),
    ),
  )

  it.effect("stops a command that runs past 30 seconds, and says it timed out", () =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      const sending = yield* Effect.forkScoped(failureOf(notifier.send(exhausted)))
      // Real time for the shell to start, then the test clock past the limit.
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(sending)).toBe("command: timed out")
    }).pipe(Effect.provide(notifierWith({ command: "sleep 30" }, webhookServer().layer))),
  )

  it.effect("kills a command that ignores being stopped, so the next notice is not held up", () =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      const sending = yield* Effect.forkScoped(Effect.flip(notifier.send(exhausted)))
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      yield* TestClock.adjust("30 seconds")
      const failed = yield* Fiber.join(sending)
      expect(failed).toBeInstanceOf(NotifyFailed)
      expect(failed instanceof NotifyFailed ? failed.command?.reason : undefined).toBe("timeout")
    }).pipe(Effect.provide(notifierWith({ command: "trap '' TERM; sleep 30" }, webhookServer().layer))),
  )

  it.effect("says which of the webhook and the command failed, and how", () =>
    Effect.gen(function* () {
      const notifier = yield* Notifier
      const failed = yield* Effect.flip(notifier.send(exhausted))
      expect(failed.webhook?.status).toBe(502)
      expect([failed.command?.reason, failed.command?.code, failed.command?.stderr]).toEqual(["exit", 3, "nope"])
    }).pipe(
      Effect.provide(
        notifierWith(
          { webhook: "https://hooks.example/slopmax", command: "echo nope >&2; exit 3" },
          webhookServer(502).layer,
        ),
      ),
    ),
  )

  it.effect("says a command that cannot be started could not start", () => {
    const refusing = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.fail(PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" })),
      ),
    )
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      expect(yield* failureOf(notifier.test)).toBe("command: could not start it")
    }).pipe(Effect.provide(notifierWith({ command: "true" }, webhookServer().layer, {}, refusing)))
  })

  it("runs the command in the system's shell", () => {
    expect(shellFor("notify-send hi", "linux")).toEqual(["sh", ["-c", "notify-send hi"]])
    expect(shellFor("notify-send hi", "darwin")).toEqual(["sh", ["-c", "notify-send hi"]])
    expect(shellFor("msg * hi", "win32")).toEqual(["cmd", ["/C", "msg * hi"]])
  })

  it("puts the notice's parts in the command's environment, blank when absent", () => {
    expect(commandEnv(signedOutNotice)).toEqual({
      SLOPMAX_EVENT: "signed-out",
      SLOPMAX_PROVIDER: "claude",
      SLOPMAX_ACCOUNT: "a@x.dev",
      SLOPMAX_UNTIL: "",
      SLOPMAX_MESSAGE: signedOutNotice.message,
    })
  })
})

describe("Notifier.look", () => {
  const a = account("claude", "a@x.dev")
  const b = account("claude", "b@x.dev")
  const spareWeek = new Notice({
    kind: "quota-unused",
    key: "unused:claude-a:7d:1800000000",
    provider: "claude",
    account: "a@x.dev",
    until: hours(10),
    message: "a@x.dev's week resets soon with 60% of it unused.",
    at: now,
  })

  const feed = Effect.flatMap(Events, (events) =>
    Effect.gen(function* () {
      const reader = yield* events.subscribe.pipe(
        Stream.filter((event) => event._tag === "Notice"),
        Stream.map((event) => (event._tag === "Notice" ? event.notice.kind : "test")),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* events.watchers.pipe(
        Stream.filter((n) => n > 0),
        Stream.take(1),
        Stream.runDrain,
      )
      return reader
    }),
  )

  it.effect("tells the feed and the webhook of each change and each new nudge once, and keeps what it told", () => {
    const hook = webhookServer()
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      const reader = yield* feed
      yield* notifier.look(report([a, b], [spareWeek]))
      yield* notifier.look(report([a, b], [spareWeek]))
      yield* notifier.look(report([limitedForAnHour(a), limitedForAnHour(b)], [spareWeek]))
      yield* notifier.look(report([a, limitedForAnHour(b)], []))
      // The feed hears everything; the settings' kinds choose what goes further.
      expect(yield* Fiber.join(reader)).toEqual(["quota-unused", "exhausted", "available", "recovered"])
      expect(Object.keys(yield* Effect.flatMap(Told, (told) => told.get))).toEqual([spareWeek.key])
      // The default kinds leave out an account coming back on its own.
      expect(hook.received.map((r) => posted(r).kind)).toEqual(["quota-unused", "exhausted", "recovered"])
    }).pipe(Effect.provide(notifierWith({ webhook: "https://hooks.example/slopmax" }, hook.layer)))
  })

  it.effect("does not tell again a nudge told before a restart", () => {
    const hook = webhookServer()
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.look(report([a], [spareWeek]))
      expect(hook.received).toEqual([])
    }).pipe(
      Effect.provide(
        notifierWith({ webhook: "https://hooks.example/slopmax" }, hook.layer, { [spareWeek.key]: hours(10) }),
      ),
    )
  })

  it.effect("keeps what it told even when notifications are off, so turning them on later repeats nothing", () => {
    const hook = webhookServer()
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.look(report([a], [spareWeek]))
      expect(Object.keys(yield* Effect.flatMap(Told, (told) => told.get))).toEqual([spareWeek.key])
      expect(hook.received).toEqual([])
    }).pipe(Effect.provide(notifierWith({}, hook.layer)))
  })

  it.effect("logs a send that failed as a warning, and goes on", () => {
    const warnings: Array<string> = []
    const capture = Logger.layer([
      Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(Array.ensure(message).map(String).join(" "))
      }),
    ])
    return Effect.gen(function* () {
      const notifier = yield* Notifier
      yield* notifier.look(report([a], [spareWeek]))
      expect(warnings).toEqual(["sending a notification: webhook: HTTP 500"])
    }).pipe(
      Effect.provide(notifierWith({ webhook: "https://hooks.example/slopmax" }, webhookServer(500).layer)),
      Effect.provide(capture),
    )
  })
})
