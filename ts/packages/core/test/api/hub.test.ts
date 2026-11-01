// The hub: T3 Code and tools like it reading usage and limit resets through
// CLIProxyAPI's management calls, answered from slopmax's own readings.
import { describe, expect } from "bun:test"
import { Limits, Window } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Effect, Layer, Logger } from "effect"
import { TestClock } from "effect/testing"
import { Account } from "../../src/account.ts"
import {
  callAnswer,
  claudeUsage,
  claudeUsageUrl,
  codexConsumeUrl,
  codexCreditsUrl,
  codexUsage,
  codexUsageUrl,
  creditIdOf,
} from "../../src/api/hub.ts"
import { block, healthOf, observe, Pool } from "../../src/pool.ts"
import { apiKey, followClock, oauth } from "../proxy/stack.ts"
import { chatgptApi, json, on } from "../support/memory-upstream.ts"
import { apiStack, call, field, items, key } from "./stack.ts"

const parse = (text: string): unknown => JSON.parse(text)

const at = (hours: number) => DateTime.makeUnsafe(1_000_000_000 + hours * 3_600_000)

const claude = oauth("claude", "c", "tok-ok", 1)
const codex = oauth("codex", "x", "tok-ok", 2)
const signedOut = new Account({ ...oauth("codex", "gone", "tok-gone", 3), authError: "refresh token revoked" })
const metered = apiKey("openai", "k", "sk-1", 4)

/** A management call. */
const hub = (method: string, path: string, options: Parameters<typeof call>[2] = {}) =>
  call(method, `/v0/management/${path}`, options)

/** An `api-call` for an account, answering the inner status and the inner body as JSON. */
const apiCall = (authIndex: string, method: string, url: string, data?: unknown) =>
  Effect.map(
    hub("POST", "api-call", {
      body: {
        auth_index: authIndex,
        method,
        url,
        header: { Authorization: "Bearer $TOKEN$" },
        ...(data === undefined ? {} : { data: JSON.stringify(data) }),
      },
    }),
    (answer) => {
      const inner = field(answer.body, "status_code")
      const text = field(answer.body, "body")
      return {
        status: answer.status,
        inner,
        body: typeof text === "string" ? parse(text) : undefined,
        raw: answer.body,
      }
    },
  )

const reading = (windows: ReadonlyArray<Window>, now: DateTime.Utc, resetCredits?: number) =>
  new Limits({ windows, observedAt: now, ...(resetCredits === undefined ? {} : { resetCredits }) })

describe("hub readings", () => {
  it("take the providers' shapes, and read a window whose reset passed as unused", () => {
    const now = at(0)
    const limits = reading(
      [Window.of("7d", 49, at(70)), Window.of("5h", 43, at(2)), Window.of("7d", 58, at(70), "Fable")],
      now,
      2,
    )
    const shaped = claudeUsage(limits, now)
    expect(shaped.five_hour).toEqual({ utilization: 43, resets_at: DateTime.formatIso(at(2)) })
    expect(shaped.seven_day?.utilization).toBe(49)
    expect(shaped.limits).toEqual([
      {
        kind: "weekly_scoped",
        percent: 58,
        resets_at: DateTime.formatIso(at(70)),
        scope: { model: { display_name: "Fable" } },
      },
    ])
    const chatgpt = codexUsage(undefined, limits, now)
    // A missing plan is left out: clients reject a null one.
    expect("plan_type" in chatgpt).toBe(false)
    expect(chatgpt.rate_limit.primary_window).toEqual({
      used_percent: 43,
      reset_at: Math.floor(DateTime.toEpochMillis(at(2)) / 1000),
      limit_window_seconds: 18_000,
    })
    expect(chatgpt.rate_limit.secondary_window?.limit_window_seconds).toBe(604_800)
    expect(chatgpt.rate_limit_reset_credits).toEqual({ available_count: 2 })
    expect(codexUsage("pro", limits, now).plan_type).toBe("pro")

    const later = at(3)
    expect(claudeUsage(limits, later).five_hour).toEqual({ utilization: 0, resets_at: null })
    expect(codexUsage(undefined, limits, later).rate_limit.primary_window?.reset_at).toBeNull()
  })

  it("answer a call with HTTP 200 and the call's own status and JSON body inside", () => {
    expect(callAnswer(503, { error: { message: "later" } })).toEqual({
      status_code: 503,
      header: { "Content-Type": ["application/json"] },
      body: '{"error":{"message":"later"}}',
    })
    expect(creditIdOf('{"credit_id":"c-1","redeem_request_id":"r"}')).toBe("c-1")
    expect(creditIdOf("{}")).toBeUndefined()
    expect(creditIdOf("not json")).toBeUndefined()
  })
})

/** The hub's account list, with only `headers` to authorize it. */
const files = (headers: Record<string, string>) => hub("GET", "auth-files", { key: null, headers })

describe("hub", () => {
  it.effect("takes the owner key as a bearer token, x-api-key or x-management-key, and nothing else", () => {
    const { layer } = apiStack({
      accounts: [claude],
      settings: { keys: [{ name: "laptop", key: "sm-client", models: [] }] },
    })
    return Effect.gen(function* () {
      const refused = yield* files({ authorization: "Bearer wrong" })
      expect([refused.status, refused.body]).toEqual([
        401,
        { error: "missing or invalid management key; use slopmax's api_key" },
      ])
      expect((yield* files({ authorization: "Bearer sm-client" })).status).toBe(401)
      expect((yield* files({})).status).toBe(401)
      expect((yield* files({ authorization: `Bearer ${key}` })).status).toBe(200)
      expect((yield* files({ "x-api-key": key })).status).toBe(200)
      expect((yield* files({ "x-management-key": ` ${key} ` })).status).toBe(200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("names the three calls it serves to anything else, once the key is right", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      expect((yield* hub("GET", "config", { key: null })).status).toBe(401)
      const unknown = yield* hub("GET", "config")
      expect([unknown.status, unknown.body]).toEqual([
        404,
        { error: "slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API" },
      ])
      expect((yield* hub("POST", "auth-files")).status).toBe(404)
    }).pipe(Effect.provide(layer))
  })

  it.effect("lists subscription accounts as CLIProxyAPI's auth files, leaving out what is unknown", () => {
    const { layer } = apiStack({ accounts: [claude, codex, signedOut, metered] })
    return Effect.gen(function* () {
      const pool = yield* Pool
      yield* pool.update((m, now) => block(m, codex.id, DateTime.add(now, { hours: 1 }), undefined, "spent"))
      const listed = yield* hub("GET", "auth-files")
      const listedFiles = items(listed.body, "files")
      expect(listedFiles.map((file) => field(file, "auth_index"))).toEqual([claude.id, codex.id, signedOut.id])
      const [first, second, third] = listedFiles
      expect(first).toEqual({
        id: claude.id,
        auth_index: claude.id,
        name: `${claude.id}.json`,
        type: "claude",
        provider: "claude",
        label: "c@example.com",
        status: "active",
        disabled: false,
        unavailable: false,
        priority: 0,
        email: "c@example.com",
      })
      expect(field(second, "unavailable")).toBe(true)
      // Clients read these as strings when present, so an unknown plan is left out, not null.
      expect(field(second, "id_token")).toEqual({ chatgpt_account_id: "acct-x" })
      expect([field(third, "status"), field(third, "status_message"), field(third, "unavailable")]).toEqual([
        "error",
        "refresh token revoked",
        true,
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("checks a call's body and account, and answers only the usage and reset calls of its accounts", () => {
    const { layer, upstream } = apiStack({ accounts: [claude, codex, metered] })
    return Effect.gen(function* () {
      const invalid = yield* hub("POST", "api-call", { body: "{not json" })
      expect([invalid.status, invalid.body]).toEqual([400, { error: "invalid body" }])
      const wrongType = yield* hub("POST", "api-call", { body: { auth_index: 7 } })
      expect(wrongType.body).toEqual({ error: "invalid body" })
      const nobody = yield* apiCall("claude-nope", "GET", claudeUsageUrl)
      expect([nobody.status, nobody.raw]).toEqual([400, { error: "no account has this auth_index" }])
      // API keys are not hub accounts.
      expect((yield* apiCall(metered.id, "GET", codexUsageUrl)).status).toBe(400)
      // The index may be written three ways, and is trimmed.
      const aliased = yield* hub("POST", "api-call", {
        body: { authIndex: ` ${claude.id} `, method: "get", url: ` ${claudeUsageUrl} ` },
      })
      expect(field(aliased.body, "status_code")).toBe(503)
      const pascal = yield* hub("POST", "api-call", {
        body: { AuthIndex: claude.id, method: "GET", url: claudeUsageUrl },
      })
      expect(field(pascal.body, "status_code")).toBe(503)
      for (const [index, url] of [
        [codex.id, "https://example.com/collect"],
        [codex.id, claudeUsageUrl],
        [claude.id, codexUsageUrl],
      ] as const) {
        const refused = yield* apiCall(index, "GET", url)
        expect([refused.status, refused.raw]).toEqual([
          403,
          {
            error:
              "slopmax answers only the usage and reset-credit calls of its accounts; it does not send their tokens elsewhere",
          },
        ])
      }
      expect((yield* apiCall(codex.id, "POST", codexUsageUrl)).status).toBe(403)
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers usage from slopmax's own readings, never from the provider", () => {
    const { layer, upstream } = apiStack({
      accounts: [claude, codex, new Account({ ...oauth("claude", "out", "tok-x", 5), authError: "revoked" })],
    })
    return Effect.gen(function* () {
      const pool = yield* Pool
      const before = yield* apiCall(claude.id, "GET", claudeUsageUrl)
      expect([before.status, before.inner, before.body]).toEqual([
        200,
        503,
        { error: { message: "slopmax has not read this account's usage yet" } },
      ])
      const out = yield* apiCall("claude-out", "GET", claudeUsageUrl)
      expect([out.inner, out.body]).toEqual([401, { error: { message: "the account needs signing in again" } }])

      const now = yield* DateTime.now
      const resets = DateTime.add(now, { hours: 2 })
      yield* pool.update((m) =>
        observe(m, claude.id, reading([Window.of("5h", 30, resets), Window.of("7d", 58, resets, "Fable")], now), now),
      )
      const usage = yield* apiCall(claude.id, "GET", claudeUsageUrl)
      expect(usage.inner).toBe(200)
      expect(usage.body).toEqual({
        five_hour: { utilization: 30, resets_at: DateTime.formatIso(resets) },
        seven_day: null,
        limits: [
          {
            kind: "weekly_scoped",
            percent: 58,
            resets_at: DateTime.formatIso(resets),
            scope: { model: { display_name: "Fable" } },
          },
        ],
      })

      yield* pool.update((m) => observe(m, codex.id, reading([Window.of("5h", 40, resets)], now), now))
      const chatgpt = yield* apiCall(codex.id, "GET", codexUsageUrl)
      expect(field(chatgpt.body, "rate_limit", "primary_window")).toEqual({
        used_percent: 40,
        reset_at: Math.floor(DateTime.toEpochMillis(resets) / 1000),
        limit_window_seconds: 18_000,
      })
      expect(field(chatgpt.body, "rate_limit", "secondary_window")).toBeNull()
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("lists limit resets from ChatGPT, reuses the list for 5 minutes, and redeems one by its id", () => {
    const { layer, upstream } = apiStack({ accounts: [codex], routes: chatgptApi })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const credits = "/backend-api/wham/rate-limit-reset-credits"
      const listed = yield* apiCall(codex.id, "GET", codexCreditsUrl)
      expect(listed.inner).toBe(200)
      const [credit] = items(listed.body, "credits")
      expect(credit).toMatchObject({ id: "credit-later", status: "available", reset_type: "codex_rate_limits" })
      expect(typeof field(credit, "expires_at")).toBe("string")
      yield* apiCall(codex.id, "GET", codexCreditsUrl)
      expect(upstream.at(credits)).toHaveLength(1)
      yield* TestClock.adjust(Duration.minutes(6))
      yield* apiCall(codex.id, "GET", codexCreditsUrl)
      expect(upstream.at(credits)).toHaveLength(2)

      const noId = yield* apiCall(codex.id, "POST", codexConsumeUrl, { redeem_request_id: "r-1" })
      expect([noId.status, noId.inner, noId.body]).toEqual([200, 400, { error: { message: "no credit_id to redeem" } }])
      const consumed = yield* apiCall(codex.id, "POST", codexConsumeUrl, {
        redeem_request_id: "r-1",
        credit_id: "credit-later",
      })
      expect([consumed.inner, consumed.body]).toEqual([200, { code: "reset" }])
      const sent = upstream.at(`${credits}/consume`)
      expect(sent).toHaveLength(1)
      expect(JSON.parse(sent[0]?.text ?? "{}")).toMatchObject({ credit_id: "credit-later" })
    }).pipe(Effect.provide(layer))
  })

  it.effect("logs a reset a hub client redeems once, naming the hub client", () => {
    const lines: Array<string> = []
    const logs = Logger.layer([Logger.make(({ message }) => void lines.push(String(message)))])
    const { layer, upstream } = apiStack({ accounts: [codex], routes: chatgptApi })
    return Effect.gen(function* () {
      yield* followClock(upstream)
      const consumed = yield* apiCall(codex.id, "POST", codexConsumeUrl, { credit_id: "credit-later" })
      expect([consumed.inner, consumed.body]).toEqual([200, { code: "reset" }])
      expect(lines.filter((line) => line.includes("redeemed a limit reset"))).toEqual([
        `${codex.id}: redeemed a limit reset for a hub client`,
      ])
    }).pipe(Effect.provide(layer.pipe(Layer.provide(logs))))
  })

  it.effect("lists no resets for an account whose usage counts none, without asking", () => {
    const { layer, upstream } = apiStack({ accounts: [codex], routes: chatgptApi })
    return Effect.gen(function* () {
      const pool = yield* Pool
      const now = yield* DateTime.now
      yield* pool.update((m) => observe(m, codex.id, reading([Window.of("5h", 10, at(1))], now, 0), now))
      const listed = yield* apiCall(codex.id, "GET", codexCreditsUrl)
      expect(listed.body).toEqual({ credits: [] })
      expect(upstream.seen).toHaveLength(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("clears an account's cooldown and reads its usage again in the background", () => {
    const usage = on("GET /backend-api/wham/usage", () =>
      json(200, {
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
      }),
    )
    const { layer, upstream } = apiStack({ accounts: [codex], routes: [usage], settings: { pollMinutes: 5 } })
    return Effect.gen(function* () {
      const pool = yield* Pool
      const missing = yield* hub("POST", "reset-quota", { body: {} })
      expect([missing.status, missing.body]).toEqual([400, { error: "auth_index is required" }])
      const unknown = yield* hub("POST", "reset-quota", { body: { auth_index: "codex-nope" } })
      expect([unknown.status, unknown.body]).toEqual([404, { error: "no account has this auth_index" }])

      yield* pool.update((m, now) => block(m, codex.id, DateTime.add(now, { hours: 1 }), "gpt-6-sol", "capped"))
      yield* pool.update((m, now) => block(m, codex.id, DateTime.add(now, { hours: 1 }), undefined, "spent"))
      const reset = yield* hub("POST", "reset-quota", { body: { authIndex: codex.id } })
      expect(reset.body).toEqual({ status: "ok", auth_index: codex.id, models: ["gpt-6-sol"] })
      const health = healthOf(yield* pool.model, codex.id)
      expect(health.blockedUntil).toBeUndefined()
      expect(health.modelBlocks).toEqual({})
      // The poll runs after the answer.
      for (let tries = 0; tries < 50 && upstream.at("/backend-api/wham/usage").length === 0; tries++) {
        yield* Effect.yieldNow
        yield* TestClock.adjust("0 millis")
      }
      for (let tries = 0; tries < 50; tries++) {
        const read = healthOf(yield* pool.model, codex.id).limits.windows
        if (read.some((window) => window.used === 5)) break
        yield* Effect.promise(() => Bun.sleep(1))
      }
      expect(healthOf(yield* pool.model, codex.id).limits.windows.map((window) => window.used)).toEqual([5])
    }).pipe(Effect.provide(layer))
  })
})
