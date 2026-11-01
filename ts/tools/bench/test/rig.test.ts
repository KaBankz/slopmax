import { describe, expect, test } from "bun:test"
import { Platform } from "@slopmax/core"
import { Settings } from "@slopmax/domain"
import { it, TestHome } from "@slopmax/test"
import { DateTime, Duration, Effect, Fiber, FileSystem, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { freePort } from "slopmax/build"
import { untilHealthy } from "../src/measure.ts"
import { serveMock } from "../src/mock.ts"
import { benchAccounts, benchKey, benchOrigins, rigSettings, serveRig } from "../src/rig.ts"

const services = Layer.merge(Platform.layer, FetchHttpClient.layer)
const decodeSettings = Schema.decodeUnknownSync(Settings)

describe("the bench rig's accounts and settings", () => {
  const now = DateTime.makeUnsafe("2026-11-01T00:00:00Z")

  test("are two Claude and two ChatGPT sign-ins with bench tokens, emails, plans and UUID organizations", () => {
    const accounts = benchAccounts(now)
    expect(accounts.map((account) => account.secret)).toEqual([
      "bench-claude-0",
      "bench-claude-1",
      "bench-codex-0",
      "bench-codex-1",
    ])
    expect(accounts.map((account) => account.identity.email)).toEqual([
      "claude0@bench.invalid",
      "claude1@bench.invalid",
      "codex0@bench.invalid",
      "codex1@bench.invalid",
    ])
    expect(accounts.map((account) => account.identity.plan)).toEqual(["max 20x", "max 5x", "pro", "plus"])
    expect(accounts[0]?.identity.orgId).toBe("00000000-0000-4000-8000-000000000000")
    expect(accounts[3]?.identity.orgId).toBe("00000000-0000-4000-8000-000000000101")
    expect(accounts.every((account) => !account.expiresWithin(Duration.days(29), now))).toBe(true)
    expect(accounts.every((account) => account.expiresWithin(Duration.days(31), now))).toBe(true)
  })

  test("are added in a fixed order, so the order they are tried in never changes", () => {
    const added = benchAccounts(now).map((account) => DateTime.toEpochMillis(account.addedAt))
    expect(added).toEqual(added.toSorted((a, b) => a - b))
    expect(new Set(added).size).toBe(4)
  })

  test("keep the home's own settings but for the key, the address, and no refreshing or polling", () => {
    const before = decodeSettings({ apiKey: "sm-x", strategy: "fill-first", pollMinutes: 5 })
    const after = rigSettings("127.0.0.1:9101")(before)
    expect(Redacted.value(after.apiKey)).toBe(benchKey)
    expect(after.listen).toBe("127.0.0.1:9101")
    expect(after.strategy).toBe("fill-first")
    expect(after.pollMinutes).toBe(0)
    expect(after.refreshTokens).toBe(false)
    expect(after.redeemExpiring).toBe(true)
    expect(rigSettings("127.0.0.1:9101", { redeemExpiring: false })(before).redeemExpiring).toBe(false)
  })

  test("send Claude's and ChatGPT's traffic to the mock", () => {
    expect(benchOrigins("http://127.0.0.1:9100")).toEqual({
      "https://api.anthropic.com": "http://127.0.0.1:9100",
      "https://chatgpt.com/backend-api": "http://127.0.0.1:9100",
    })
  })
})

describe("the bench rig", () => {
  it.live(
    "serves Claude Code and Codex from the mock through the real daemon, over a home it prepares",
    () =>
      Effect.gen(function* () {
        const home = yield* TestHome.make("rig")
        const upstream = yield* serveMock({ hostname: "127.0.0.1", port: 0 })
        const listen = `127.0.0.1:${yield* freePort}`
        const rig = yield* Effect.forkChild(serveRig({ listen, upstream, root: home.slopmax }))
        yield* untilHealthy(`http://${listen}/healthz`)
        const claude = yield* Effect.promise(() =>
          fetch(`http://${listen}/claude/v1/messages?beta=true`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${benchKey}`,
              "content-type": "application/json",
              "user-agent": "claude-cli/2.1.287 (external, cli)",
            },
            body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8, stream: true, messages: [] }),
          }),
        )
        expect(claude.status).toBe(200)
        expect(yield* Effect.promise(() => claude.text())).toContain("message_stop")
        const codex = yield* Effect.promise(() =>
          fetch(`http://${listen}/codex/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${benchKey}`, "content-type": "application/json", session_id: "bench" },
            body: JSON.stringify({ model: "gpt-6-sol", input: [], stream: true, store: false }),
          }),
        )
        expect(codex.status).toBe(200)
        expect(yield* Effect.promise(() => codex.text())).toContain("response.completed")
        const refused = yield* Effect.promise(() =>
          fetch(`http://${listen}/claude/v1/messages`, { method: "POST", headers: { authorization: "Bearer nope" } }),
        )
        expect(refused.status).toBe(401)
        yield* Fiber.interrupt(rig)
        const fs = yield* FileSystem.FileSystem
        expect((yield* fs.readDirectory(home.path(".slopmax", "accounts"))).toSorted()).toHaveLength(4)
        const config = JSON.parse(yield* fs.readFileString(home.path(".slopmax", "config.json")))
        expect(config).toMatchObject({ apiKey: benchKey, listen, refreshTokens: false, pollMinutes: 0 })
      }).pipe(Effect.provide(services)),
    30_000,
  )
})
