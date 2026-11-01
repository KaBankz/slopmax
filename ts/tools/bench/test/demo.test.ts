import { describe, expect, test } from "bun:test"
import { Platform, SavedState } from "@slopmax/core"
import { type LedgerRecord, Report, type RequestRecord } from "@slopmax/domain"
import { it, TestHome } from "@slopmax/test"
import { ConfigProvider, DateTime, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { freePort } from "slopmax/build"
import {
  demo,
  demoClaudeAgent,
  demoPorts,
  demoRequests,
  demoState,
  demoWindowsEnded,
  exportsText,
  PortBusy,
  PortRefused,
  seedDemo,
  servedBy,
} from "../src/demo.ts"
import { untilHealthy } from "../src/measure.ts"
import { serveMock } from "../src/mock.ts"
import { benchAccounts, benchKey, prepareHome, serveRig } from "../src/rig.ts"

const services = Layer.merge(Platform.layer, FetchHttpClient.layer)
const now = DateTime.makeUnsafe("2026-11-04T15:30:00Z")
const utc = DateTime.zoneMakeOffset(0)
// The ids the store gives them do not matter to the seed: it goes by provider and age.
const accounts = benchAccounts(now)
const requestsOf = (records: ReadonlyArray<LedgerRecord>) =>
  records.filter((record): record is RequestRecord => record._tag === "Request")

describe("the demo's history", () => {
  test("is the same month every time, for the same moment", async () => {
    const once = await Effect.runPromise(demoRequests(accounts, now, utc))
    const again = await Effect.runPromise(demoRequests(accounts, now, utc))
    expect(again).toEqual(once)
    expect(once.length).toBeGreaterThan(2_000)
  })

  test("covers thirty days up to now, oldest first, busier on weekdays", async () => {
    const records = await Effect.runPromise(demoRequests(accounts, now, utc))
    const times = records.map((record) => DateTime.toEpochMillis(record.at))
    expect(times).toEqual(times.toSorted((a, b) => a - b))
    expect(Math.max(...times)).toBeLessThanOrEqual(DateTime.toEpochMillis(now))
    expect(Math.min(...times)).toBeGreaterThan(DateTime.toEpochMillis(DateTime.subtract(now, { days: 31 })))
    const weekend = records.filter((record) => [0, 6].includes(DateTime.getPartUtc(record.at, "weekDay"))).length
    const weekdays = records.length - weekend
    // Five weekdays at about 70 sessions' worth against two weekend days at about 25.
    expect(weekdays / 5).toBeGreaterThan((weekend / 2) * 1.5)
  })

  test("has daily ChatGPT warmups, model listings, requests no account could take, provider errors and failovers", async () => {
    const records = requestsOf(await Effect.runPromise(demoRequests(accounts, now, utc)))
    const warmups = records.filter((record) => record.agent === "slopmax")
    expect(warmups.length).toBeGreaterThanOrEqual(58)
    expect(warmups.every((record) => record.provider === "codex" && record.usage.input === 9)).toBe(true)
    const listings = records.filter((record) => record.status === 200 && record.usage.requests === 0)
    expect(listings.length).toBeGreaterThan(50)
    const spent = records.filter((record) => record.status === 429)
    expect(spent.length).toBeGreaterThan(0)
    expect(spent.every((record) => record.account === undefined && record.attempts === 0)).toBe(true)
    expect(records.some((record) => [500, 529, 400].includes(record.status))).toBe(true)
    expect(records.some((record) => record.attempts === 2)).toBe(true)
    expect(records.filter((record) => record.agent === "claude-code").length).toBeGreaterThan(500)
  })

  test("has four weeks of weekly windows that ended for each account, under its plan", () => {
    const ended = demoWindowsEnded(accounts, now)
    expect(ended).toHaveLength(16)
    const first = ended[0]
    expect(first?._tag === "WindowEnded" ? [first.plan, first.span, first.used] : []).toEqual(["max 20x", "7d", 62])
  })
})

describe("the demo's state", () => {
  test("gives each account its look: one ChatGPT account spent and blocked, resets on ChatGPT, Claude's agent seen", async () => {
    const records = await Effect.runPromise(demoRequests(accounts, now, utc))
    const state = demoState(accounts, now, records)
    const [claude0, , codex0, codex1] = accounts.map((account) => state.health[account.id])
    expect(claude0?.limits.windows.map((window) => [window.span, window.model, window.used])).toEqual([
      ["5h", undefined, 82],
      ["7d", undefined, 47],
      ["7d", "Fable", 64],
    ])
    expect(codex0?.blockedUntil).toEqual(DateTime.add(now, { seconds: 4_800 }))
    expect(codex0?.limits.resetCredits).toBe(2)
    expect(codex1?.blockedUntil).toBeUndefined()
    expect(claude0?.limits.resetCredits).toBeUndefined()
    expect(state.agents["claude"]).toBe(demoClaudeAgent)
    expect(claude0?.lastUsed).toEqual(DateTime.subtract(now, { seconds: 180 }))
  })

  test("counts what each account served from the history it was given", async () => {
    const records = await Effect.runPromise(demoRequests(accounts, now, utc))
    const state = demoState(accounts, now, records)
    const served = servedBy(records)
    for (const account of accounts) {
      const answers = requestsOf(records).filter(
        (record) => record.account === account.id && record.status === 200 && record.usage.input > 0,
      )
      expect(state.health[account.id]?.served.requests).toBe(answers.length)
      expect(served.get(account.id)?.input).toBe(answers.reduce((sum, record) => sum + record.usage.input, 0))
    }
  })
})

describe("the demo", () => {
  it.live(
    "seeds files the daemon serves its dashboard from",
    () =>
      Effect.gen(function* () {
        const home = yield* TestHome.make("demo-seed")
        const upstream = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
        const listen = `127.0.0.1:${yield* freePort}`
        const options = { listen, upstream, root: home.slopmax, keepExpiring: true }
        yield* prepareHome(options)
        const seeded = yield* seedDemo(home.slopmax, upstream)
        expect(seeded.accounts).toBe(4)
        const fs = yield* FileSystem.FileSystem
        const state = yield* Schema.decodeEffect(Schema.fromJsonString(SavedState))(
          yield* fs.readFileString(home.path(".slopmax", "state.json")),
        )
        expect(Object.keys(state.health)).toHaveLength(4)
        const months = yield* fs.readDirectory(home.path(".slopmax", "usage"))
        expect(months.every((name) => /^\d{4}-\d{2}\.ndjson$/.test(name))).toBe(true)
        const config = JSON.parse(yield* fs.readFileString(home.path(".slopmax", "config.json")))
        expect(config).toMatchObject({ redeemExpiring: false, apiKey: benchKey })

        const rig = yield* Effect.forkChild(serveRig(options))
        yield* untilHealthy(`http://${listen}/healthz`)
        const ask = (path: string) =>
          Effect.promise(() =>
            fetch(`http://${listen}/slopmax/api${path}`, { headers: { authorization: `Bearer ${benchKey}` } }).then(
              (answer) => answer.json(),
            ),
          )
        const views = (yield* Schema.decodeUnknownEffect(Report)(yield* ask("/status"))).accounts
        expect(views).toHaveLength(4)
        expect(views.every((view) => view.served.requests > 0)).toBe(true)
        expect(views.some((view) => view.provider === "codex" && view.condition._tag === "Limited")).toBe(true)
        const usage = yield* ask("/usage?range=30d&by=account")
        expect(JSON.stringify(usage)).toContain("claude")
        yield* Fiber.interrupt(rig)
      }).pipe(Effect.provide(services)),
    30_000,
  )

  it.live("takes its ports from UPSTREAM_PORT and DEMO_PORT, else 9200 and 9201", () =>
    Effect.gen(function* () {
      expect(yield* demoPorts).toEqual({ upstream: 9200, demo: 9201 })
      const given = yield* demoPorts.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { UPSTREAM_PORT: "9300", DEMO_PORT: "9301" } })),
        ),
      )
      expect(given).toEqual({ upstream: 9300, demo: 9301 })
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  )

  it.live("refuses CLIProxyAPI's port", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(demo)
      expect(error).toBeInstanceOf(PortRefused)
    }).pipe(
      Effect.provide(
        Layer.merge(
          services,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { UPSTREAM_PORT: "9300", DEMO_PORT: "8317" } })),
        ),
      ),
    ),
  )

  it.live("refuses to start where something already answers a health check", () =>
    Effect.gen(function* () {
      const busy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ status: "ok" }) })
      yield* Effect.addFinalizer(() => Effect.promise(() => busy.stop(true)))
      const free = yield* freePort
      const error = yield* Effect.flip(
        demo.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({ env: { UPSTREAM_PORT: String(free), DEMO_PORT: String(busy.port) } }),
            ),
          ),
        ),
      )
      expect(error).toBeInstanceOf(PortBusy)
      expect(error.message).toBe(
        `something already listens on 127.0.0.1:${busy.port}; stop it, or set UPSTREAM_PORT and DEMO_PORT`,
      )
    }).pipe(Effect.provide(services)),
  )

  test("says what to export to use it", () => {
    const text = exportsText(
      {
        SLOPMAX_HOME: "/d/.slopmax",
        CLAUDE_CONFIG_DIR: "/d/.claude",
        CODEX_HOME: "/d/.codex",
        XDG_CONFIG_HOME: "/d/.config",
      },
      "127.0.0.1:9201",
    )
    expect(text).toContain("export SLOPMAX_HOME=/d/.slopmax SLOPMAX_LISTEN=127.0.0.1:9201")
    expect(text).toContain("export CLAUDE_CONFIG_DIR=/d/.claude CODEX_HOME=/d/.codex XDG_CONFIG_HOME=/d/.config")
    expect(text).toContain("export SLOPMAX_NO_SERVICE=1")
  })
})
