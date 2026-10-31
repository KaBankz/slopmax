import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { AccountId, LimitReset, Report, Settings, slopmaxVersion, Usage } from "@slopmax/domain"
import { DateTime, Duration, Redacted, Schema } from "effect"
import { Account, Credential, Link, Tokens } from "../../src/account.ts"
import { block, observe, pin, recordResets, succeeded, sync, emptyModel } from "../../src/pool.ts"
import { accountView, buildReport } from "../../src/report.ts"
import { claude, Driver, limits, subscription, ts, window } from "../pool/fixtures.ts"

const settings = (given: Partial<typeof Settings.Encoded> = {}) =>
  Schema.decodeUnknownSync(Settings)({ apiKey: "sm-test", strategy: "fill-first", ...given })
const utc = DateTime.zoneMakeOffset(0)

const reportOf = (driver: Driver, at = 1000, more: { readonly live?: boolean; readonly settings?: Settings } = {}) =>
  buildReport({
    model: driver.m,
    settings: more.settings ?? settings(),
    now: ts(at),
    live: more.live ?? true,
    zone: utc,
  })

const key = new Account({
  id: AccountId.make("xai-1234abcd"),
  provider: "xai",
  credential: Credential.cases.Key.make({ key: Redacted.make("xai-secret") }),
  addedAt: ts(0),
})
const endpoint = new Account({
  id: AccountId.make("compat-1234abcd"),
  provider: "compat",
  credential: Credential.cases.Endpoint.make({
    baseUrl: "http://localhost:1234/v1",
    dialect: "chat",
    models: ["llama-*"],
  }),
  addedAt: ts(0),
})

describe("the status report", () => {
  it("keys report where their requests go and the models they serve, and get no pool", () => {
    const sub = claude("a")
    const report = reportOf(new Driver([key, endpoint, sub]))
    const [xai, compat, signedIn] = report.accounts
    expect([xai?.endpoint, xai?.models]).toEqual(["https://api.x.ai/v1", ["grok-*"]])
    expect([compat?.endpoint, compat?.models]).toEqual(["http://localhost:1234/v1", ["llama-*"]])
    expect([signedIn?.endpoint, signedIn?.models]).toEqual([undefined, []])
    // Only subscriptions with an account are pooled.
    expect(report.pools.map((pool) => pool.provider)).toEqual(["claude"])
    expect(report.live).toBe(true)
    expect(report.version).toBe(slopmaxVersion)
    expect(report.strategy).toBe("fill-first")
  })

  it("pools average working accounts and their model windows", () => {
    const a = claude("a", 1)
    const b = claude("b", 2)
    const off = claude("off", 3, { disabled: true })
    const out = claude("out", 4, { authError: "revoked" })
    const driver = new Driver([a, b, off, out])
    driver.apply((m) =>
      observe(
        m,
        a.id,
        limits([window("5h", 20, 5000), window("7d", 50, 90_000), window("7d", 60, 80_000, "opus")]),
        ts(1000),
      ),
    )
    driver.apply((m) =>
      // b's opus window already reset: it counts as unused, and its reset is past.
      observe(
        m,
        b.id,
        limits([window("5h", 40, 3000), window("7d", 30, 70_000), window("7d", 90, 500, "opus")]),
        ts(1000),
      ),
    )
    // Neither of these may sway the pool.
    driver.apply((m) => observe(m, off.id, limits([window("5h", 100)]), ts(1000)))
    driver.apply((m) => observe(m, out.id, limits([window("5h", 100)]), ts(1000)))
    const [pool] = reportOf(driver).pools
    expect(pool?.accounts).toBe(2)
    expect(pool?.windows.find((w) => w.span === "5h")?.used).toBe(30)
    expect(pool?.windows.find((w) => w.span === "7d")?.used).toBe(40)
    expect(pool?.scoped.map((w) => [w.span, w.model, w.used, w.resetsAt])).toEqual([["7d", "opus", 30, ts(80_000)]])
    expect(pool?.shares).toEqual({})
    // A pool with only a monthly window reports it.
    const monthly = new Driver([subscription("codex", "c")])
    monthly.apply((m) =>
      observe(m, monthly.m.accounts[0]?.id ?? AccountId.make(""), limits([window("30d", 10)]), ts(1000)),
    )
    expect(reportOf(monthly).pools[0]?.windows.map((w) => w.span)).toEqual(["30d"])
  })

  it("a pool with no working account is left out", () => {
    expect(reportOf(new Driver([subscription("codex", "off", 0, { disabled: true })])).pools).toEqual([])
  })

  it("each pool names the account a new session gets, and why", () => {
    const a = claude("a")
    const [pool] = reportOf(new Driver([a])).pools
    expect([pool?.next?.account, pool?.next?.reason, pool?.next?.why]).toEqual([
      a.id,
      "only-one",
      "the only account ready",
    ])
    const blocked = new Driver([a]).apply((m) => block(m, a.id, ts(5000), undefined, "limit"))
    expect(reportOf(blocked).pools[0]?.next).toBeUndefined()
  })

  it("an account shows its condition, notes, sessions and what it served", () => {
    const followed = new Account({
      ...claude("a"),
      priority: 2,
      credential: Credential.cases.OAuth.make({
        tokens: new Tokens({ access: Redacted.make("t"), expiresAt: ts(9000) }),
        follows: new Link({ tool: "cliproxyapi", path: "/x.json" }),
      }),
    })
    const driver = new Driver([followed])
    // Pinning lets go of the provider's sessions, so it comes first.
    driver.apply((m) => pin(m, "claude", followed.id))
    driver.pick(900, "s1")
    driver.pick(900, "s2")
    driver.apply((m) =>
      succeeded(
        m,
        followed.id,
        new Usage({ requests: 12, input: 1_000_000, output: 500_000, cacheRead: 0, cacheWrite: 0 }),
        ts(950),
      ),
    )
    driver.apply((m) =>
      recordResets(
        m,
        followed.id,
        [new LimitReset({ id: "r1", expiresAt: ts(99_000) }), new LimitReset({ id: "old", expiresAt: ts(10) })],
        ts(950),
      ),
    )
    const view = reportOf(driver).accounts[0]
    expect(view?.condition).toEqual(expect.objectContaining({ _tag: "Active", sessions: 2 }))
    expect(view?.notes.map((note) => note._tag)).toEqual(["Pinned", "Priority", "Follows", "Resets", "Served"])
    expect([view?.pinned, view?.follows, view?.tokenExpiresAt, view?.lastUsed]).toEqual([
      true,
      "cliproxyapi",
      ts(9000),
      ts(950),
    ])
    expect(view?.resets.map((reset) => reset.id)).toEqual(["r1"])
    expect(view?.served.tokens).toBe(1_500_000)
    // From disk, nothing is live.
    expect(reportOf(driver, 1000, { live: false }).accounts[0]?.sessions).toBe(0)
  })

  it("a limited account says until when, and its last error is left to the condition", () => {
    const a = claude("a")
    const driver = new Driver([a]).apply((m) => block(m, a.id, ts(5000), undefined, "usage limit reached"))
    const view = reportOf(driver).accounts[0]
    expect(view?.condition).toEqual(expect.objectContaining({ _tag: "Limited", until: ts(5000) }))
    expect(view?.notes).toEqual([])
  })

  it("nudges come from the accounts: a week about to reset with quota unused is worth a word", () => {
    const a = claude("a", 0, { plan: "max 20x" })
    const driver = new Driver([a]).apply((m) =>
      observe(m, a.id, limits([window("7d", 20, 1000 + 3600), window("5h", 0)]), ts(1000)),
    )
    const [nudge] = reportOf(driver).nudges
    expect(nudge?.kind).toBe("quota-unused")
    // A week is a twelfth of 52 weeks' fee.
    expect(nudge?.worth).toBeCloseTo(((200 * 12) / 52) * 0.8, 6)
    expect(nudge?.message).toContain("80% of it unused")
    // A plan price people set wins.
    const cheap = reportOf(driver, 1000, { settings: settings({ planPrices: { "claude/max 20x": 0 } }) }).nudges[0]
    expect(cheap?.worth).toBe(0)
  })

  it("reports survive a JSON round trip", () => {
    const a = claude("a")
    const driver = new Driver([a]).apply((m) =>
      observe(m, a.id, limits([window("5h", 25, 5000), window("7d", 60, undefined, "opus")]), ts(1000)),
    )
    const report = reportOf(driver)
    const json = Schema.encodeSync(Schema.fromJsonString(Report))(report)
    const back = Schema.decodeUnknownSync(Schema.fromJsonString(Report))(json)
    expect(back.accounts[0]?.windows).toHaveLength(2)
    expect(back.pools[0]?.windows).toHaveLength(report.pools[0]?.windows.length ?? -1)
    expect(Schema.encodeSync(Schema.fromJsonString(Report))(back)).toBe(json)
  })

  it("an account no pool knows yet is shown as ready with nothing learned", () => {
    const view = accountView(sync(emptyModel, []), claude("new"), 0, ts(Duration.toSeconds(Duration.hours(1))))
    expect(view.condition._tag).toBe("Ready")
    expect([view.windows, view.notes, view.resets]).toEqual([[], [], []])
  })
})
