import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { LimitReset, Usage } from "@slopmax/domain"
import { DateTime, Duration, HashMap, Option, Schema } from "effect"
import {
  addUsage,
  affinityOverride,
  block,
  blockedFor,
  clearBlocks,
  failed,
  fromSaved,
  healthOf,
  isBlocked,
  isUnmeasured,
  lapses,
  limitedUntil,
  next,
  observe,
  pin,
  pooledView,
  pooledWindows,
  prune,
  recordReset,
  recordResets,
  resetsLeft,
  routingOf,
  SavedState,
  sawAgent,
  sawCodex,
  sessionCounts,
  succeeded,
  sync,
  throttle,
  toSaved,
  unexpiredResets,
  unpinAll,
} from "../../src/pool.ts"
import { claude, Driver, id, limits, some, subscription, ts, window } from "./fixtures.ts"

const a = claude("a", 1)
const b = claude("b", 2)
const c = claude("c", 3)

const served = (requests: number, input: number, output: number) =>
  new Usage({ requests, input, output, cacheRead: 0, cacheWrite: 0 })

const reason = (driver: Driver, at = 1000) => some(next(driver.m, "claude", driver.strategy, ts(at)))?.reason

const hours = (h: number) => 1000 + h * 3600

const reset = (resetId: string, expires: number) =>
  new LimitReset({ id: resetId, grantedAt: ts(0), expiresAt: ts(expires) })

describe("placement", () => {
  it("round-robin takes turns within the top priority, and the lower tier serves only when the top cannot", () => {
    const reserve = claude("reserve", 3, { priority: -1 })
    const pool = new Driver([a, b, reserve], "round-robin")
    expect([1, 2, 3, 4].map(() => pool.pick(1000))).toEqual([a.id, b.id, a.id, b.id])
    pool.apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    pool.apply((m) => block(m, b.id, ts(5000), undefined, "limit"))
    expect(pool.pick(1000)).toBe(reserve.id)
  })

  it("housekeeping requests take no round-robin turn", () => {
    const pool = new Driver([a, b], "round-robin")
    expect(pool.pick(1000, undefined, { housekeeping: true })).toBe(a.id)
    expect(pool.pick(1000)).toBe(a.id)
    expect(pool.pick(1000)).toBe(b.id)
  })

  it("reset-first spends the window that expires soonest", () => {
    const pool = new Driver([a, b, c], "reset-first")
    // a is idle; b's 5-hour window resets in 3 hours; c's week resets in 2 days.
    pool.apply((m) => observe(m, a.id, limits([window("5h", 0)]), ts(1000)))
    pool.apply((m) => observe(m, b.id, limits([window("5h", 60, 1000 + 3 * 3600)]), ts(1000)))
    pool.apply((m) => observe(m, c.id, limits([window("7d", 30, 1000 + 2 * 86_400)]), ts(1000)))
    expect(pool.pick(1000)).toBe(b.id)
  })

  it("reset-first saves a week about to be lost before any 5-hour window", () => {
    const pool = new Driver([a, b], "reset-first")
    // a is busy: its 5-hour window resets in 4 hours, its week in 6 days.
    pool.apply((m) => observe(m, a.id, limits([window("5h", 10, hours(4)), window("7d", 50, hours(144))]), ts(1000)))
    // b has no 5-hour window running, but 80% of a week is lost in 10 hours.
    pool.apply((m) => observe(m, b.id, limits([window("7d", 20, hours(10))]), ts(1000)))
    expect(pool.pick(1000)).toBe(b.id)
    expect(reason(pool)).toBe("week-ending")
    // A week two days out is no emergency: the 5-hour window goes first.
    pool.apply((m) => observe(m, b.id, limits([window("7d", 20, hours(48))]), ts(1000)))
    expect(pool.pick(1000)).toBe(a.id)
    // A full week is nothing to save.
    pool.apply((m) => observe(m, b.id, limits([window("7d", 100, hours(10)), window("5h", 0)]), ts(1000)))
    expect(reason(pool)).not.toBe("week-ending")
  })

  it("fill-first drains accounts oldest first and returns to one once it resets", () => {
    const pool = new Driver([b, a], "fill-first")
    expect(pool.pick(1000)).toBe(a.id)
    pool.apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    expect(pool.pick(1000)).toBe(b.id)
    expect(pool.pick(6000)).toBe(a.id)
  })

  it("least-used prefers headroom and ranks accounts never measured last", () => {
    const pool = new Driver([a, b, c], "least-used")
    pool.apply((m) => observe(m, a.id, limits([window("7d", 80, 9000)]), ts(1000)))
    pool.apply((m) => observe(m, b.id, limits([window("7d", 20, 9000)]), ts(1000)))
    expect(pool.pick(1000)).toBe(b.id)
    pool.apply((m) => block(m, b.id, ts(5000), undefined, "limit"))
    expect(pool.pick(1000)).toBe(a.id)
    expect(isUnmeasured(healthOf(pool.m, c.id), ts(1000))).toBe(true)
    expect(isUnmeasured(healthOf(pool.m, a.id), ts(1000))).toBe(false)
  })

  it("priority tiers and pins come before the strategy", () => {
    const high = claude("high", 2, { priority: 5 })
    const pool = new Driver([a, high], "fill-first")
    expect(pool.pick(1000)).toBe(high.id)
    pool.apply((m) => pin(m, "claude", a.id))
    expect(pool.pick(1000)).toBe(a.id)
    pool.apply(unpinAll)
    expect(pool.pick(1000)).toBe(high.id)
  })

  it("known exhaustion is skipped without sending a request", () => {
    const pool = new Driver([a, b])
    pool.apply((m) => observe(m, a.id, limits([window("5h", 100, 4000)]), ts(1000)))
    expect(pool.pick(1000)).toBe(b.id)
    expect(pool.pick(4001)).toBe(a.id)
  })

  it("a full window without a reset time stops blocking once its reading is stale", () => {
    const pool = new Driver([a])
    pool.apply((m) => observe(m, a.id, limits([window("5h", 100)]), ts(1000)))
    // Blocked for the default 5 minutes while the reading is fresh.
    expect(some(Option.fromUndefinedOr(blockedFor(healthOf(pool.m, a.id), undefined, ts(1000))))).toEqual(ts(1300))
    expect(pool.pick(1000)).toStartWith("none")
    expect(pool.pick(1000 + 301)).toBe(a.id)
  })

  it("when nothing can serve, the pick reports the earliest return", () => {
    const pool = new Driver([a, b])
    pool.apply((m) => block(m, a.id, ts(9000), undefined, "limit"))
    pool.apply((m) => block(m, b.id, ts(7000), undefined, "limit"))
    const answer = pool.choose(1000)
    expect(answer._tag).toBe("NoneReady")
    if (answer._tag !== "NoneReady") return
    expect(answer.until).toEqual(ts(7000))
    expect(answer.spent).toBe(true)
    expect(answer.reason).toBe("every claude account is rate limited")
  })

  it("accounts tried by this request are skipped, but their blocks still say when the pool frees up", () => {
    const pool = new Driver([a])
    pool.apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    const answer = pool.choose(1000, { exclude: new Set([a.id]) })
    expect(answer._tag === "NoneReady" ? answer.until : undefined).toEqual(ts(5000))
    const tried = new Driver([a]).choose(1000, { exclude: new Set([a.id]) })
    expect(tried._tag === "NoneReady" ? [tried.reason, tried.spent] : []).toEqual([
      "every claude account failed this request",
      false,
    ])
  })

  it("a cap on one model affects only that model", () => {
    const pool = new Driver([a])
    pool.apply((m) => block(m, a.id, ts(9000), "claude-fable", "overage cap"))
    expect(pool.pick(1000, undefined, { model: "claude-fable" })).toStartWith("none")
    expect(pool.pick(1000, undefined, { model: "claude-sonnet" })).toBe(a.id)
  })

  it("a fresh reading below the limit lifts a block early", () => {
    const pool = new Driver([a])
    pool.apply((m) => block(m, a.id, ts(90_000), undefined, "limit"))
    expect(pool.pick(1000)).toStartWith("none")
    pool.apply((m) => observe(m, a.id, limits([window("7d", 40, 90_000)]), ts(1000)))
    expect(pool.pick(1000)).toBe(a.id)
  })

  it("turned-off and signed-out accounts are skipped, and the reason says so", () => {
    const off = claude("off", 1, { disabled: true })
    const out = claude("out", 2, { authError: "revoked" })
    expect(new Driver([off, out]).pick(1000)).toBe("none: every claude account is disabled or signed out")
    expect(new Driver([]).pick(1000)).toBe("none: no claude accounts connected; run `slopmax login claude`")
  })

  it("routing narrows the accounts a pick may choose", () => {
    const pool = new Driver([a, b])
    expect(pool.pick(1000, undefined, { candidates: [b.id] })).toBe(b.id)
  })
})

describe("sessions", () => {
  it("a session sticks to its account until that account cannot serve, and then reports the move", () => {
    const pool = new Driver([a, b], "least-used")
    pool.apply((m) => observe(m, a.id, limits([window("7d", 10, 9000)]), ts(1000)))
    pool.apply((m) => observe(m, b.id, limits([window("7d", 50, 9000)]), ts(1000)))
    expect(pool.pick(1000, "s1")).toBe(a.id)
    // a becomes the busier account, but the session stays put; new sessions place afresh.
    pool.apply((m) => observe(m, a.id, limits([window("7d", 90, 9000)], 1001), ts(1001)))
    expect(pool.pick(1002, "s1")).toBe(a.id)
    expect(pool.pick(1002, "s2")).toBe(b.id)
    pool.apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    const moved = pool.choose(1003, { session: "s1" })
    expect(moved._tag === "Chosen" ? [moved.account.id, moved.movedFrom] : []).toEqual([b.id, a.id])
  })

  it("without affinity a session is placed afresh, but its move is still known", () => {
    const pool = new Driver([a, b], "round-robin", Duration.hours(1), false)
    const first = pool.choose(1000, { session: "s" })
    expect(first._tag === "Chosen" ? [first.account.id, first.movedFrom] : []).toEqual([a.id, undefined])
    const second = pool.choose(1001, { session: "s" })
    expect(second._tag === "Chosen" ? [second.account.id, second.movedFrom] : []).toEqual([b.id, a.id])
    // A request may ask for affinity anyway.
    const third = pool.choose(1002, { session: "s", affinity: true })
    expect(third._tag === "Chosen" ? [third.account.id, third.movedFrom] : []).toEqual([b.id, undefined])
  })

  it("a request's affinity header turns affinity on or off, and anything else leaves it to the settings", () => {
    for (const on of ["on", " TRUE ", "1", "yes"]) expect(affinityOverride(on)).toBe(true)
    for (const off of ["off", "False", "0", "no"]) expect(affinityOverride(off)).toBe(false)
    for (const other of ["maybe", "", null, undefined]) expect(affinityOverride(other)).toBeUndefined()
    const settings = { strategy: "fill-first" as const, sessionMinutes: 30, sessionAffinity: false }
    expect(routingOf(settings).affinity).toBe(false)
    expect(routingOf(settings, true).affinity).toBe(true)
    expect(Duration.toMinutes(routingOf(settings).ttl)).toBe(30)
  })

  it("a shorter session time forgets sessions sooner", () => {
    const pool = new Driver([a, b], "round-robin")
    expect(pool.pick(1000, "s")).toBe(a.id)
    pool.ttl = Duration.minutes(1)
    expect(pool.pick(1030, "s")).toBe(a.id)
    expect(pool.pick(1200, "s")).toBe(b.id)
    expect(sessionCounts(pool.m, ts(1200), pool.ttl).size).toBe(1)
  })

  it("sessions expire after their idle time and are placed afresh", () => {
    const pool = new Driver([a, b])
    pool.apply((m) => block(m, a.id, ts(1500), undefined, "limit"))
    expect(pool.pick(1000, "s")).toBe(b.id)
    expect(pool.pick(2000, "s")).toBe(b.id)
    expect(pool.pick(2000 + 3601, "s")).toBe(a.id)
  })

  it("a session leaving an account the request already tried reports where it came from", () => {
    const pool = new Driver([a, b])
    expect(pool.pick(1000, "s")).toBe(a.id)
    const moved = pool.choose(1001, { session: "s", exclude: new Set([a.id]) })
    expect(moved._tag === "Chosen" ? [moved.account.id, moved.movedFrom] : []).toEqual([b.id, a.id])
  })

  it("sessions survive a restart through state.json", () => {
    const first = new Driver([a, b], "least-used")
    first.apply((m) => observe(m, a.id, limits([window("7d", 90, 9000)]), ts(1000)))
    first.apply((m) => observe(m, b.id, limits([window("7d", 10, 9000)]), ts(1000)))
    expect(first.pick(1000, "s1")).toBe(b.id)
    const json = Schema.encodeSync(Schema.fromJsonString(SavedState))(toSaved(first.m, ts(1001)))
    const restored = new Driver([], "least-used")
    restored.m = sync(fromSaved(Schema.decodeUnknownSync(Schema.fromJsonString(SavedState))(json)), [a, b])
    // b is now the busier account, but the session stays on it.
    restored.apply((m) => observe(m, b.id, limits([window("7d", 95, 9000)], 1001), ts(1001)))
    expect(restored.pick(1002, "s1")).toBe(b.id)
  })

  it("sessions on removed accounts, or of a provider whose pin changed, are let go", () => {
    const pool = new Driver([a, b], "round-robin")
    expect(pool.pick(1000, "s1")).toBe(a.id)
    expect(pool.pick(1000, "s2")).toBe(b.id)
    pool.apply((m) => sync(m, [b]))
    expect(sessionCounts(pool.m, ts(1000), pool.ttl)).toEqual(new Map([[b.id, 1]]))
    pool.apply((m) => pin(m, "claude", b.id))
    expect(sessionCounts(pool.m, ts(1000), pool.ttl).size).toBe(0)
  })

  it("pruning drops idle sessions and caps that ran out", () => {
    const pool = new Driver([a])
    pool.pick(1000, "s")
    pool.apply((m) => block(m, a.id, ts(2000), "opus", "cap"))
    const pruned = prune(pool.m, ts(1000 + 3600), Duration.hours(1))
    expect(HashMap.size(pruned.sessions)).toBe(0)
    expect(healthOf(pruned, a.id).modelBlocks).toEqual({})
    expect(prune(pruned, ts(1000 + 3600), Duration.hours(1))).toBe(pruned)
  })
})

describe("what the pool learns", () => {
  it("next says who a new session would get and why, and changes nothing", () => {
    const pool = new Driver([a, b], "reset-first")
    expect(reason(pool)).toBe("most-room")
    pool.apply((m) => observe(m, b.id, limits([window("5h", 40, 1000 + 3600)]), ts(1000)))
    const chosen = some(next(pool.m, "claude", "reset-first", ts(1000)))
    expect([chosen?.account, chosen?.reason, chosen?.why]).toEqual([b.id, "resets-first", "its quota resets soonest"])
    expect(pool.pick(1000, "s")).toBe(b.id)
    pool.apply((m) => block(m, b.id, ts(5000), undefined, "limit"))
    expect(reason(pool)).toBe("only-one")
    pool.apply((m) => pin(m, "claude", a.id))
    expect(reason(pool)).toBe("pinned")
    pool.apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    expect(reason(pool)).toBeUndefined()
    expect(some(next(pool.m, "codex", "reset-first", ts(1000)))).toBeUndefined()
    for (const [strategy, why] of [
      ["fill-first", "fills-first"],
      ["least-used", "most-room"],
      ["round-robin", "turn"],
    ] as const) {
      expect(some(next(new Driver([a, b]).m, "claude", strategy, ts(1000)))?.reason).toBe(why)
    }
  })

  it("a window that reset is told once, with what was used of it", () => {
    const pool = new Driver([claude("a", 1, { plan: "max 5x" })])
    pool.apply((m) => observe(m, a.id, limits([window("7d", 70, 5000), window("5h", 10, 9000)]), ts(1000)))
    const take = (at: number) => {
      const [records, m] = lapses(pool.m, ts(at))
      pool.m = m
      return records.map((record) => [record.span, record.used, record.plan])
    }
    expect(take(2000)).toEqual([])
    // The week's time passes with no reading since.
    expect(take(6000)).toEqual([["7d", 70, "max 5x"]])
    expect(take(6500)).toEqual([])
    // A reading of the next 5-hour period shows that one ended too.
    pool.apply((m) => observe(m, a.id, limits([window("5h", 1, 30_000)], 9500), ts(9500)))
    expect(take(9500)).toEqual([["5h", 10, "max 5x"]])
    // Told windows are remembered across a restart.
    const restored = sync(fromSaved(toSaved(pool.m, ts(9500))), pool.m.accounts)
    expect(lapses(restored, ts(9600))[0]).toEqual([])
  })

  it("a block only extends, a cap keeps its later time, and both say why", () => {
    let m = new Driver([a]).m
    m = block(m, a.id, ts(5000), undefined, "first")
    m = block(m, a.id, ts(4000), undefined, "second")
    expect(healthOf(m, a.id).blockedUntil).toEqual(ts(5000))
    expect(healthOf(m, a.id).lastError).toBe("second")
    m = block(m, a.id, ts(9000), "opus", "cap")
    m = block(m, a.id, ts(8000), "opus", "cap")
    expect(healthOf(m, a.id).modelBlocks).toEqual({ opus: ts(9000) })
    m = throttle(m, a.id, ts(3000))
    m = throttle(m, a.id, ts(2000))
    expect(healthOf(m, a.id).throttledUntil).toEqual(ts(3000))
  })

  it("throttling holds an account back briefly but is not a quota block", () => {
    const m = throttle(new Driver([a]).m, a.id, ts(1030))
    const health = healthOf(m, a.id)
    expect(blockedFor(health, undefined, ts(1000))).toEqual(ts(1030))
    expect(isBlocked(health, ts(1000))).toBe(false)
    expect(Option.isNone(limitedUntil(health, ts(1000)))).toBe(true)
  })

  it("a served request clears throttling and the last error, and adds to what was served", () => {
    let m = new Driver([a]).m
    m = throttle(failed(m, a.id, "boom"), a.id, ts(5000))
    m = succeeded(m, a.id, undefined, ts(1000))
    m = succeeded(m, a.id, served(1, 10, 5), ts(1001))
    m = succeeded(m, a.id, served(1, 20, 5), ts(1002))
    const health = healthOf(m, a.id)
    expect(health.throttledUntil).toBeUndefined()
    expect(health.lastError).toBeUndefined()
    expect(health.lastUsed).toEqual(ts(1002))
    expect([health.served.requests, health.served.input, health.served.output]).toEqual([2, 30, 10])
  })

  it("clearing blocks lifts them all and names the models that were capped", () => {
    let m = new Driver([a]).m
    m = block(block(throttle(m, a.id, ts(9000)), a.id, ts(9000), undefined, "x"), a.id, ts(9000), "opus", "cap")
    const [models, cleared] = clearBlocks(m, a.id)
    expect(models).toEqual(["opus"])
    expect(blockedFor(healthOf(cleared, a.id), "opus", ts(1000))).toBeUndefined()
  })

  it("resets count from their list once listed, and leave it when redeemed", () => {
    const codex = subscription("codex", "a", 1)
    let m = new Driver([codex]).m
    m = observe(m, codex.id, limits([window("5h", 100, 4000)], 1000, { resetCredits: 2 }), ts(1000))
    // Before a list, the usage's count stands.
    expect(resetsLeft(healthOf(m, codex.id), ts(1000))).toBe(2)
    m = recordResets(m, codex.id, [reset("soon", 2000), reset("later", 9000)], ts(1000))
    expect(resetsLeft(healthOf(m, codex.id), ts(1000))).toBe(2)
    // One that expired no longer counts.
    expect(resetsLeft(healthOf(m, codex.id), ts(3000))).toBe(1)
    m = block(m, codex.id, ts(9000), "opus", "cap")
    m = recordReset(m, codex.id, ts(1500), "soon")
    const health = healthOf(m, codex.id)
    expect(unexpiredResets(health, ts(1500)).map((left) => left.id)).toEqual(["later"])
    // The list and the count still agree, so nothing asks for a new list.
    expect(health.limits.resetCredits).toBe(1)
    expect(health.resets?.counted).toBe(1)
    expect(health.limits.windows[0]?.used).toBe(0)
    expect(health.limits.windows[0]?.resetsAt).toBeUndefined()
    expect(health.modelBlocks).toEqual({})
    expect(isBlocked(health, ts(1500))).toBe(false)
    // A reset the provider chose is unknown, so the list is due again.
    const unknown = healthOf(recordReset(m, codex.id, ts(1600)), codex.id)
    expect(unknown.resets?.counted).toBeUndefined()
    expect(unknown.resets?.list.length).toBe(1)
  })

  it("an agent's user agent and Codex's model are noted only when they change", () => {
    const m = new Driver([a]).m
    const seen = sawAgent(m, "claude", "claude-cli/2.1.0")
    expect(seen.dirty).toBe(true)
    expect(seen.agents.claude).toBe("claude-cli/2.1.0")
    const clean = { ...seen, dirty: false }
    expect(sawAgent(clean, "claude", "claude-cli/2.1.0")).toBe(clean)
    const codex = sawCodex(clean, { lastModel: "gpt-6-sol" })
    expect(codex.codex.lastModel).toBe("gpt-6-sol")
    expect(sawCodex(codex, { lastModel: "gpt-6-sol" })).toBe(codex)
  })

  it("warm-up usage adds to what an account served without marking it used", () => {
    const m = addUsage(new Driver([a]).m, a.id, served(1, 3, 1))
    expect(healthOf(m, a.id).lastUsed).toBeUndefined()
    expect(healthOf(m, a.id).served.tokens).toBe(4)
  })
})

describe("the pool read as one account", () => {
  it("working accounts are averaged, weighted by plan when every plan's size is known", () => {
    const big = claude("big", 1, { plan: "max 20x" })
    const small = claude("small", 2, { plan: "max 5x" })
    const off = claude("off", 3, { disabled: true })
    let m = new Driver([big, small, off]).m
    m = observe(m, big.id, limits([window("5h", 50, 5000)]), ts(1000))
    m = observe(m, small.id, limits([window("5h", 100, 4000)]), ts(1000))
    m = observe(m, off.id, limits([window("5h", 100, 4000)]), ts(1000))
    const [five] = pooledWindows(m, "claude", ts(1000))
    expect(five?.weighted).toBe(true)
    expect(five?.used).toBeCloseTo(0.8 * 50 + 0.2 * 100)
    expect(five?.resetsAt).toEqual(ts(4000))
    const view = some(pooledView(m, "claude", ts(1000)))
    expect(view?.accounts).toBe(2)
    expect(view?.shares).toEqual({ [big.id]: 0.8, [small.id]: 0.2 })
    // An unknown plan makes it a plain mean.
    const plain = sync(m, [big, claude("small", 2)])
    expect(pooledWindows(plain, "claude", ts(1000))[0]?.weighted).toBe(false)
    expect(pooledWindows(plain, "claude", ts(1000))[0]?.used).toBe(75)
  })

  it("a blocked account counts as full in its shortest window", () => {
    let m = new Driver([a, b]).m
    m = observe(m, a.id, limits([window("5h", 10, 5000), window("7d", 10, 90_000)]), ts(1000))
    m = observe(m, b.id, limits([window("5h", 10, 5000), window("7d", 10, 90_000)]), ts(1000))
    m = block(m, b.id, ts(5000), undefined, "limit")
    const windows = pooledWindows(m, "claude", ts(1000))
    expect(windows.map((w) => [w.span, w.used])).toEqual([
      ["5h", 55],
      ["7d", 10],
    ])
  })

  it("windows over one model are read as one too, by span then model", () => {
    let m = new Driver([a, b]).m
    m = observe(
      m,
      a.id,
      limits([window("5h", 10, 5000), window("30d", 40, 900_000, "Fable"), window("7d", 20, 90_000, "Opus")]),
      ts(1000),
    )
    m = observe(m, b.id, limits([window("5h", 10, 5000), window("7d", 60, 80_000, "Opus")]), ts(1000))
    const scoped = some(pooledView(m, "claude", ts(1000)))?.scoped
    expect(scoped?.map((w) => [w.span, w.model, w.used])).toEqual([
      ["7d", "Opus", 40],
      ["30d", "Fable", 40],
    ])
    expect(scoped?.[0]?.resetsAt).toEqual(ts(80_000))
  })

  it("a provider without a working account has no pool", () => {
    expect(Option.isNone(pooledView(new Driver([claude("off", 1, { disabled: true })]).m, "claude", ts(1000)))).toBe(
      true,
    )
  })
})

describe("state.json", () => {
  it("a partial or older file loads, every field taking its default", () => {
    const saved = Schema.decodeUnknownSync(Schema.fromJsonString(SavedState))(
      JSON.stringify({ health: { "claude-a": { lastError: "x" } } }),
    )
    const m = fromSaved(saved)
    expect(healthOf(m, id("claude-a")).lastError).toBe("x")
    expect(healthOf(m, id("claude-a")).served.requests).toBe(0)
    expect(HashMap.size(m.sessions)).toBe(0)
  })

  it("what is saved keeps only known accounts' health and caps still running", () => {
    let m = new Driver([a]).m
    m = block(failed(m, id("claude-gone"), "x"), a.id, ts(2000), "opus", "cap")
    const saved = toSaved(m, ts(3000))
    expect(Object.keys(saved.health)).toEqual([a.id])
    expect(saved.health[a.id]?.modelBlocks).toEqual({})
    // Before the accounts are known, nothing is dropped.
    expect(Object.keys(toSaved(fromSaved(saved), ts(3000)).health)).toEqual([a.id])
    // Round-robin's turns are kept, so the next turn continues after a restart.
    const turned = new Driver([a, b], "round-robin")
    turned.pick(1000)
    const again = new Driver([], "round-robin")
    again.m = sync(fromSaved(toSaved(turned.m, ts(1000))), [a, b])
    expect(again.pick(1000)).toBe(b.id)
    expect(DateTime.toEpochMillis(ts(1))).toBe(1000)
  })
})
