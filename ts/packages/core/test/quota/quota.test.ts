import { describe, expect } from "bun:test"
import { AccountId, LimitReset, Limits } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect, Fiber, Layer, Logger, Option, Redacted } from "effect"
import { TestClock } from "effect/testing"
import { Account, accountText, Credential, Identity } from "../../src/account.ts"
import { Events } from "../../src/events.ts"
import { Ledger } from "../../src/ledger.ts"
import { block, Health, healthOf, observe, Pool, recordResets, ResetList, sawAgent, sawCodex } from "../../src/pool.ts"
import { listIsDue, pollIsDue, Quota, warmupBody } from "../../src/quota.ts"
import { home, json, mockUpstream, oauthAccount, reply, type Seen, stored, storeLayer } from "../providers/support.ts"
import { claude, limits, subscription, ts, window } from "../pool/fixtures.ts"

const chatgpt = (name: string, more: Parameters<typeof subscription>[3] = {}) => subscription("codex", name, 0, more)

const seed = (...accounts: ReadonlyArray<Account>) => ({
  files: Object.fromEntries(accounts.map((account) => [`${home}/accounts/${account.id}.json`, accountText(account)])),
})

const tokenOf = (seen: Seen) => seen.headers.get("authorization")?.replace("Bearer token-", "") ?? ""

const credit = (id: string, expiresAt: number) => ({
  id,
  status: "available",
  expires_at: new Date(expiresAt * 1000).toISOString(),
})

/** ChatGPT's backend, answering per account from `script`. */
const backend = (
  script: {
    readonly usage?: (name: string) => Response
    readonly credits?: (name: string) => Response
    readonly consume?: (name: string, body: unknown) => Response | Promise<Response>
    readonly responses?: (name: string, body: unknown) => Response
  } = {},
) =>
  mockUpstream((seen) => {
    const name = tokenOf(seen)
    switch (seen.url.pathname) {
      case "/backend-api/wham/usage":
        return (
          script.usage?.(name) ??
          json(200, {
            plan_type: "pro",
            rate_limit: {
              primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
            },
          })
        )
      case "/backend-api/wham/rate-limit-reset-credits":
        return script.credits?.(name) ?? json(200, { credits: [] })
      case "/backend-api/wham/rate-limit-reset-credits/consume":
        return script.consume?.(name, JSON.parse(seen.body)) ?? json(200, { code: "reset" })
      case "/backend-api/codex/responses":
        return script.responses?.(name, JSON.parse(seen.body)) ?? reply(404)
    }
    return reply(404)
  })

const layerFor = (
  upstream: ReturnType<typeof mockUpstream>,
  accounts: ReadonlyArray<Account>,
  settings: Parameters<typeof storeLayer>[1] = {},
) =>
  Quota.layer.pipe(
    Layer.provideMerge(Pool.layerMemory()),
    Layer.provideMerge(Ledger.layer),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(storeLayer(upstream.layer, settings, seed(...accounts))),
  )

const healthNow = (id: AccountId) =>
  Effect.map(
    Effect.flatMap(Pool, (pool) => pool.model),
    (m) => healthOf(m, id),
  )

const update = (f: Parameters<Pool["Service"]["update"]>[0]) => Effect.flatMap(Pool, (pool) => pool.update(f))

/** Log lines, collected. */
const collectLogs = () => {
  const lines: Array<string> = []
  const layer = Logger.layer([Logger.make(({ message }) => void lines.push(String(message)))])
  return { lines, layer }
}

const read = (windows: ReturnType<typeof window>[], at: number) =>
  new Health({ ...Health.empty, limits: limits(windows, at) })

const listed = (at: number, counted?: number, resetCredits?: number) =>
  new Health({
    ...Health.empty,
    limits: new Limits({ windows: [], ...(resetCredits === undefined ? {} : { resetCredits }) }),
    resets: new ResetList({ list: [], listedAt: ts(at), ...(counted === undefined ? {} : { counted }) }),
  })

const sse = (usage: { readonly input: number; readonly output: number }) =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: usage.input, output_tokens: usage.output } } })}\n\n`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-codex-primary-used-percent": "1",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "18000",
      },
    },
  )

describe("when usage is due", () => {
  const every = Duration.minutes(5)

  it("an account never read is due", () => {
    expect(pollIsDue(Health.empty, ts(0), every)).toBe(true)
  })

  it("a reading older than the poll interval is due", () => {
    expect(pollIsDue(read([window("5h", 10, 99_999)], 1000), ts(1000 + 299), every)).toBe(false)
    expect(pollIsDue(read([window("5h", 10, 99_999)], 1000), ts(1000 + 300), every)).toBe(true)
  })

  it("a window that reset since the reading is due at once", () => {
    expect(pollIsDue(read([window("5h", 10, 1010)], 1000), ts(1020), every)).toBe(true)
  })

  it("a blocked account is read again every 10 minutes", () => {
    const blocked = new Health({ ...read([window("5h", 10, 99_999)], 1000), blockedUntil: ts(99_999) })
    expect(pollIsDue(blocked, ts(1000 + 599), Duration.hours(1))).toBe(false)
    expect(pollIsDue(blocked, ts(1000 + 600), Duration.hours(1))).toBe(true)
  })
})

describe("when limit resets are due to be listed", () => {
  it("never listed is due; counted resets are listed every 6 hours, uncounted every hour", () => {
    expect(listIsDue(Health.empty, true, ts(0))).toBe(true)
    expect(listIsDue(listed(0, 1, 1), true, ts(6 * 3600 - 1))).toBe(false)
    expect(listIsDue(listed(0, 1, 1), true, ts(6 * 3600))).toBe(true)
    expect(listIsDue(listed(0), false, ts(3599))).toBe(false)
    expect(listIsDue(listed(0), false, ts(3600))).toBe(true)
  })

  it("a changed count lists them again, but not within 10 minutes of the last list", () => {
    expect(listIsDue(listed(0, 1, 2), true, ts(599))).toBe(false)
    expect(listIsDue(listed(0, 1, 2), true, ts(600))).toBe(true)
  })
})

describe("usage polls", () => {
  it.effect("read an account's windows into the pool and save a new plan to its file", () => {
    const a = chatgpt("a")
    const api = backend()
    return Effect.gen(function* () {
      yield* (yield* Quota).poll(a)
      const health = yield* healthNow(a.id)
      expect(health.limits.windows.map((w) => [w.span, w.used])).toEqual([["5h", 20]])
      expect((yield* stored(a.id))?.identity.plan).toBe("pro")
    }).pipe(Effect.provide(layerFor(api, [a])))
  })

  it.effect("a failed poll is logged and shows as the account's last error", () => {
    const a = chatgpt("a")
    const api = backend({ usage: () => reply(500, "down") })
    const logs = collectLogs()
    return Effect.gen(function* () {
      yield* (yield* Quota).poll(a)
      expect((yield* healthNow(a.id)).lastError).toStartWith("usage poll: usage endpoint returned 500")
      expect(logs.lines.some((line) => line.startsWith(`${a.id}: usage poll failed:`))).toBe(true)
    }).pipe(Effect.provide(Layer.merge(layerFor(api, [a]), logs.layer)))
  })

  it.effect("only due accounts are polled, all at once; signed-out ones and keys never are", () => {
    const fresh = chatgpt("fresh")
    const due = chatgpt("due")
    const off = chatgpt("off", { disabled: true })
    const out = chatgpt("out", { authError: "revoked" })
    const key = new Account({
      id: AccountId.make("openai-key"),
      provider: "openai",
      credential: Credential.cases.Key.make({ key: Redacted.make("k") }),
      addedAt: ts(0),
    })
    const api = backend()
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000)
      yield* update((m, now) => observe(m, fresh.id, limits([window("5h", 1, 99_999)], 999), now))
      yield* (yield* Quota).pollDue()
      const polled = api.at("/backend-api/wham/usage").map(tokenOf).toSorted()
      expect(polled).toEqual(["due", "off"])
      yield* (yield* Quota).pollDue({ force: true })
      expect(api.at("/backend-api/wham/usage").map(tokenOf).toSorted()).toEqual(["due", "due", "fresh", "off", "off"])
    }).pipe(Effect.provide(layerFor(api, [fresh, due, off, out, key])))
  })
})

describe("limit resets", () => {
  it.effect("are listed when due, kept in the pool, and skipped when the usage counts none", () => {
    const a = chatgpt("a")
    const none = chatgpt("none")
    const api = backend({ credits: () => json(200, { credits: [credit("c1", 90_000)] }) })
    return Effect.gen(function* () {
      yield* update((m, now) => observe(m, a.id, limits([], 0, { resetCredits: 1 }), now))
      yield* update((m, now) => observe(m, none.id, limits([], 0, { resetCredits: 0 }), now))
      yield* (yield* Quota).listDue()
      expect(api.at("/backend-api/wham/rate-limit-reset-credits").map(tokenOf)).toEqual(["a"])
      expect((yield* healthNow(a.id)).resets?.list.map((reset) => reset.id)).toEqual(["c1"])
      // Listed just now: not due again.
      yield* (yield* Quota).listDue()
      expect(api.at("/backend-api/wham/rate-limit-reset-credits")).toHaveLength(1)
      yield* (yield* Quota).listDue({ force: true })
      expect(api.at("/backend-api/wham/rate-limit-reset-credits")).toHaveLength(2)
    }).pipe(Effect.provide(layerFor(api, [a, none])))
  })

  it.effect("Claude's are not listed until Claude Code has been seen", () => {
    const a = claude("a")
    const api = mockUpstream(() => reply(500))
    return Effect.gen(function* () {
      yield* (yield* Quota).listDue({ force: true })
      expect(api.seen).toHaveLength(0)
      const failed = yield* Effect.flip((yield* Quota).listResets(a))
      expect(failed._tag).toBe("NeedsAgent")
    }).pipe(Effect.provide(layerFor(api, [a])))
  })

  it.effect("a failed listing is logged, and keeps the account's list for a provider that does not count them", () => {
    const a = claude("a")
    const api = mockUpstream(() => reply(500, "down"))
    const logs = collectLogs()
    return Effect.gen(function* () {
      yield* update((m) => sawAgent(m, "claude", "claude-cli/2.1.0 (external, cli)"))
      yield* update((m, now) => recordResets(m, a.id, [new LimitReset({ id: "kept", expiresAt: ts(99_000) })], now))
      yield* TestClock.adjust("1 hour")
      yield* (yield* Quota).listDue()
      expect(logs.lines.some((line) => line.startsWith(`${a.id}: listing limit resets:`))).toBe(true)
      const health = yield* healthNow(a.id)
      expect(health.resets?.list.map((reset) => reset.id)).toEqual(["kept"])
      expect(health.resets?.listedAt).toEqual(ts(3600))
    }).pipe(Effect.provide(Layer.merge(layerFor(api, [a]), logs.layer)))
  })

  it.effect(
    "a redemption on request spends the named reset, or the first listed, and lifts the account's blocks",
    () => {
      const a = chatgpt("a")
      const api = backend({
        credits: () => json(200, { credits: [credit("first", 50_000), credit("second", 90_000)] }),
      })
      return Effect.gen(function* () {
        const q = yield* Quota
        yield* update((m) => block(m, a.id, ts(9000), undefined, "limit"))
        expect(yield* q.redeem(a, "second")).toBe("reset")
        expect(jsonBody(api.at("/backend-api/wham/rate-limit-reset-credits/consume")[0])).toMatchObject({
          credit_id: "second",
        })
        expect((yield* healthNow(a.id)).blockedUntil).toBeUndefined()
        expect(yield* q.redeem(a)).toBe("reset")
        expect(jsonBody(api.at("/backend-api/wham/rate-limit-reset-credits/consume")[1])).toMatchObject({
          credit_id: "first",
        })
      }).pipe(Effect.provide(layerFor(api, [a])))
    },
  )

  it.effect("a redemption with nothing listed has no credit, and a key or a signed-out account cannot redeem", () => {
    const a = chatgpt("a")
    const out = chatgpt("out", { authError: "revoked" })
    const key = new Account({
      id: AccountId.make("xai-key"),
      provider: "xai",
      credential: Credential.cases.Key.make({ key: Redacted.make("k") }),
      addedAt: ts(0),
    })
    const api = backend()
    return Effect.gen(function* () {
      const q = yield* Quota
      expect(yield* q.redeem(a)).toBe("no-credit")
      expect((yield* Effect.flip(q.redeem(key)))._tag).toBe("NoLimitResets")
      const notReady = yield* Effect.flip(q.redeem(out))
      expect(notReady._tag).toBe("NotReady")
      expect(notReady.message).toBe("the account needs signing in again (revoked)")
    }).pipe(Effect.provide(layerFor(api, [a, out, key])))
  })

  it.effect("only one redemption runs at a time", () => {
    const a = chatgpt("a")
    const b = chatgpt("b")
    let running = 0
    let most = 0
    const api = backend({
      consume: async () => {
        running++
        most = Math.max(most, running)
        await Bun.sleep(5)
        running--
        return json(200, { code: "reset" })
      },
    })
    return Effect.gen(function* () {
      const q = yield* Quota
      const fibers = yield* Effect.forEach([a, b, a], (account) => Effect.forkChild(q.redeem(account, "c")))
      yield* Effect.forEach(fibers, Fiber.join)
      expect(api.at("/backend-api/wham/rate-limit-reset-credits/consume")).toHaveLength(3)
      expect(most).toBe(1)
    }).pipe(Effect.provide(layerFor(api, [a, b])))
  })

  it.effect(
    "the next reset to be spent is redeemed when it expires within 3 hours, on an account with usage to reset",
    () => {
      const used = chatgpt("used")
      const idle = chatgpt("idle")
      const later = chatgpt("later")
      const api = backend({
        credits: (name) =>
          json(200, {
            credits:
              name === "later"
                ? [credit("far", 3 * 3600 + 1), credit("farther", 9 * 3600)]
                : [credit(`${name}-1`, 3 * 3600)],
          }),
      })
      const logs = collectLogs()
      return Effect.gen(function* () {
        for (const account of [used, idle, later]) {
          const windows = account === idle ? [window("5h", 0)] : [window("5h", 40, 9000)]
          yield* update((m, now) => observe(m, account.id, limits(windows, 0, { resetCredits: 2 }), now))
        }
        yield* (yield* Quota).redeemExpiring
        const consumed = api.at("/backend-api/wham/rate-limit-reset-credits/consume").map((seen) => jsonBody(seen))
        expect(consumed).toEqual([expect.objectContaining({ credit_id: "used-1" })])
        // An account with nothing used is not even asked.
        expect(api.at("/backend-api/wham/rate-limit-reset-credits").map(tokenOf).toSorted()).toEqual(["later", "used"])
        expect(logs.lines).toContain(`${used.id}: redeemed a limit reset before it expired`)
        expect((yield* healthNow(used.id)).limits.windows[0]?.used).toBe(0)
        // What was listed is kept, redeemed or not.
        expect((yield* healthNow(later.id)).resets?.list.map((reset) => reset.id)).toEqual(["far", "farther"])
      }).pipe(Effect.provide(Layer.merge(layerFor(api, [used, idle, later]), logs.layer)))
    },
  )
})

const iso = (seconds: number) => new Date(seconds * 1000).toISOString()

describe("refreshing sign-ins", () => {
  it.effect("a sign-in whose refresh fails shows why as the account's last error", () => {
    const due = oauthAccount({ id: "claude-due", access: "old", refresh: "rt", expiresAt: ts(60) })
    const api = mockUpstream((seen) => (seen.url.pathname === "/v1/oauth/token" ? reply(503, "busy") : reply(404)))
    return Effect.gen(function* () {
      yield* (yield* Quota).refreshDue
      expect(api.at("/v1/oauth/token")).toHaveLength(1)
      expect((yield* healthNow(due.id)).lastError).toStartWith("token refresh failed (503")
    }).pipe(Effect.provide(layerFor(api, [due])))
  })
})

describe("Claude's limit resets", () => {
  const org = "11111111-2222-3333-4444-555555555555"
  const agent = "claude-cli/2.1.0 (external, cli)"

  it.effect("are listed and spent as Claude Code once it has been seen, the grant Claude spends next first", () => {
    const a = new Account({ ...claude("a"), identity: new Identity({ orgId: org }) })
    const api = mockUpstream((seen) => {
      if (seen.url.pathname === "/api/oauth/usage") {
        return json(200, {
          cedar_ember: {
            next_grant_id: "next",
            grants: [
              { id: "sooner", resets_left: 1, ends_at: iso(3600) },
              { id: "next", resets_left: 1, ends_at: iso(2 * 3600) },
            ],
          },
        })
      }
      if (seen.url.pathname === `/api/organizations/${org}/reset_rate_limits`) return json(200, { result: "reset" })
      return reply(404)
    })
    return Effect.gen(function* () {
      const q = yield* Quota
      yield* update((m) => sawAgent(m, "claude", agent))
      yield* update((m, now) => observe(m, a.id, limits([window("5h", 40, 9000)], 0), now))
      yield* q.listDue()
      expect((yield* healthNow(a.id)).resets?.list.map((reset) => reset.id)).toEqual(["next", "sooner"])
      yield* q.redeemExpiring
      const spent = api.at(`/api/organizations/${org}/reset_rate_limits`)
      // The grant Claude would spend next goes first, though another expires sooner.
      expect(spent.map((seen) => jsonBody(seen))).toEqual([expect.objectContaining({ grant_id: "next" })])
      expect(api.seen.every((seen) => seen.headers.get("user-agent") === agent)).toBe(true)
      expect((yield* healthNow(a.id)).resets?.list.map((reset) => reset.id)).toEqual(["sooner"])
    }).pipe(Effect.provide(layerFor(api, [a])))
  })
})

describe("rescue", () => {
  it.effect("a spent pool is freed by redeeming on the account that would sit out longest", () => {
    const soon = chatgpt("soon")
    const long = chatgpt("long")
    const none = chatgpt("none")
    const api = backend()
    return Effect.gen(function* () {
      yield* update((m, now) => observe(m, soon.id, limits([window("5h", 100, 5000)], 0, { resetCredits: 1 }), now))
      yield* update((m, now) => observe(m, long.id, limits([window("7d", 100, 90_000)], 0, { resetCredits: 1 }), now))
      yield* update((m, now) => observe(m, none.id, limits([window("7d", 100, 99_000)], 0, { resetCredits: 0 }), now))
      yield* update((m, now) =>
        recordResets(m, long.id, [new LimitReset({ id: "listed", expiresAt: ts(80_000) })], now),
      )
      const freed = yield* (yield* Quota).rescue("codex")
      expect(Option.getOrUndefined(freed)).toBe(long.id)
      expect(
        api.at("/backend-api/wham/rate-limit-reset-credits/consume").map((seen) => [tokenOf(seen), jsonBody(seen)]),
      ).toEqual([["long", expect.objectContaining({ credit_id: "listed" })]])
      // Now an account is free, so the next rescue spends nothing.
      expect(Option.getOrUndefined(yield* (yield* Quota).rescue("codex"))).toBe(long.id)
      expect(api.at("/backend-api/wham/rate-limit-reset-credits/consume")).toHaveLength(1)
    }).pipe(Effect.provide(layerFor(api, [soon, long, none])))
  })

  it.effect(
    "an account that declines is passed over for the next, and the provider chooses when no list is known",
    () => {
      const first = chatgpt("first")
      const second = chatgpt("second")
      const api = backend({ consume: (name) => json(200, { code: name === "first" ? "declined" : "reset" }) })
      return Effect.gen(function* () {
        yield* update((m) => block(m, first.id, ts(90_000), undefined, "limit"))
        yield* update((m) => block(m, second.id, ts(50_000), undefined, "limit"))
        for (const account of [first, second]) {
          yield* update((m, now) =>
            observe(m, account.id, limits([window("5h", 100, 4000)], 0, { resetCredits: 1 }), now),
          )
        }
        expect(Option.getOrUndefined(yield* (yield* Quota).rescue("codex"))).toBe(second.id)
        const bodies = api.at("/backend-api/wham/rate-limit-reset-credits/consume").map((seen) => jsonBody(seen))
        expect(bodies.map((body) => typeof body === "object" && body !== null && "credit_id" in body)).toEqual([
          false,
          false,
        ])
      }).pipe(Effect.provide(layerFor(api, [first, second])))
    },
  )

  it.effect("a rescue cut short once the reset is being spent still records it, so no second reset is spent", () => {
    const a = chatgpt("a")
    const sent = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    const api = backend({
      consume: async () => {
        sent.resolve()
        await answer.promise
        return json(200, { code: "reset" })
      },
    })
    return Effect.gen(function* () {
      yield* update((m, now) => observe(m, a.id, limits([window("5h", 100, 5000)], 0, { resetCredits: 2 }), now))
      const rescuing = yield* Effect.forkChild((yield* Quota).rescue("codex"))
      yield* Effect.promise(() => sent.promise)
      // Interrupted while the provider is still answering, as when the client goes away.
      rescuing.interruptUnsafe()
      answer.resolve()
      yield* Fiber.await(rescuing)
      const health = yield* healthNow(a.id)
      expect(health.limits.windows[0]?.used).toBe(0)
      expect(health.limits.resetCredits).toBe(1)
      // The account is free now, so another rescue spends nothing.
      expect(Option.getOrUndefined(yield* (yield* Quota).rescue("codex"))).toBe(a.id)
      expect(api.at("/backend-api/wham/rate-limit-reset-credits/consume")).toHaveLength(1)
    }).pipe(Effect.provide(layerFor(api, [a])))
  })

  it.effect("Claude is not rescued before Claude Code has been seen, nor a provider without resets", () => {
    const a = claude("a")
    const api = mockUpstream(() => reply(500))
    return Effect.gen(function* () {
      yield* update((m) => block(m, a.id, ts(9000), undefined, "limit"))
      expect(Option.isNone(yield* (yield* Quota).rescue("claude"))).toBe(true)
      expect(Option.isNone(yield* (yield* Quota).rescue("openai"))).toBe(true)
      expect(api.seen).toHaveLength(0)
    }).pipe(Effect.provide(layerFor(api, [a])))
  })
})

describe("warming idle ChatGPT windows", () => {
  it.effect("an idle account gets one tiny request, recorded as slopmax's own, at most once per 5 hours", () => {
    const idle = chatgpt("idle")
    const busy = chatgpt("busy")
    const unread = chatgpt("unread")
    const api = backend({ responses: () => sse({ input: 8, output: 2 }) })
    const logs = collectLogs()
    return Effect.gen(function* () {
      const q = yield* Quota
      // Nothing is known of what Codex uses yet.
      yield* q.warm
      yield* update((m) => sawCodex(m, { lastModel: "gpt-6-sol" }))
      yield* update((m, now) => observe(m, idle.id, limits([window("5h", 0)], 0), now))
      yield* update((m, now) => observe(m, busy.id, limits([window("5h", 30, 99_999)], 0), now))
      yield* q.warm
      const sent = api.at("/backend-api/codex/responses")
      expect(sent.map(tokenOf)).toEqual(["idle"])
      expect(sent[0]?.body).toBe(warmupBody("gpt-6-sol"))
      expect(sent[0]?.headers.get("accept")).toBe("text/event-stream")
      expect(sent[0]?.headers.get("user-agent")).toStartWith("slopmax/")
      expect(logs.lines).toContain(`${idle.id}: started its 5-hour window early`)
      const health = yield* healthNow(idle.id)
      expect([health.served.requests, health.served.input, health.served.output]).toEqual([1, 8, 2])
      expect(health.limits.windows.map((w) => w.used)).toEqual([1])
      const ledger = yield* Ledger
      yield* ledger.flush
      const [entry] = yield* ledger.load(ts(0))
      expect(entry).toMatchObject({
        _tag: "Request",
        account: idle.id,
        agent: "slopmax",
        model: "gpt-6-sol",
        attempts: 1,
      })
      // Its window reads idle again, but it was warmed within 5 hours.
      yield* update((m, now) => observe(m, idle.id, limits([window("5h", 0)], 60), now))
      yield* q.warm
      expect(api.at("/backend-api/codex/responses")).toHaveLength(1)
      yield* TestClock.adjust("5 hours")
      yield* update((m, now) => observe(m, idle.id, limits([window("5h", 0)], 5 * 3600), now))
      yield* q.warm
      expect(api.at("/backend-api/codex/responses")).toHaveLength(2)
      expect(unread.id).toBeDefined()
    }).pipe(Effect.provide(Layer.merge(layerFor(api, [idle, busy, unread]), logs.layer)))
  })

  it.effect("a failed warmup is logged and still waits its turn", () => {
    const idle = chatgpt("idle")
    const api = backend({ responses: () => reply(429, "slow down") })
    const logs = collectLogs()
    return Effect.gen(function* () {
      const q = yield* Quota
      yield* update((m) => sawCodex(m, { lastModel: "gpt-6-sol" }))
      yield* update((m, now) => observe(m, idle.id, limits([window("5h", 0)], 0), now))
      yield* q.warm
      yield* q.warm
      expect(api.at("/backend-api/codex/responses")).toHaveLength(1)
      expect(logs.lines).toContain(`${idle.id}: warmup failed: answered 429`)
    }).pipe(Effect.provide(Layer.merge(layerFor(api, [idle]), logs.layer)))
  })

  it.effect("an account whose sign-in cannot be used is not warmed", () => {
    const idle = chatgpt("idle", { authError: "revoked" })
    const api = backend({ responses: () => sse({ input: 1, output: 1 }) })
    return Effect.gen(function* () {
      const q = yield* Quota
      yield* update((m) => sawCodex(m, { lastModel: "gpt-6-sol" }))
      yield* update((m, now) => observe(m, idle.id, limits([window("5h", 0)], 0), now))
      yield* q.warm
      expect(api.at("/backend-api/codex/responses")).toHaveLength(0)
      expect(DateTime.toEpochMillis(ts(1))).toBe(1000)
    }).pipe(Effect.provide(layerFor(api, [idle])))
  })
})

const jsonBody = (seen: Seen | undefined): unknown => (seen === undefined ? undefined : JSON.parse(seen.body))
