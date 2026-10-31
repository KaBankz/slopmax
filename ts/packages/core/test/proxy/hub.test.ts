import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import { Account, Tokens } from "../../src/account.ts"
import { Config } from "../../src/config.ts"
import { type Limits, Window } from "../../src/limits.ts"
import { claudeUsage, codexUsage } from "../../src/proxy/hub.ts"
import {
  eventually,
  type Harness,
  harness,
  KEY,
  key,
  oauth,
  parse,
  paths,
  pick,
  recording,
  reply,
  resetIn,
  send,
} from "../integration/harness.ts"

/** A value as JSON text and back, as a client reads it. */
const read = (value: json.Json): unknown => JSON.parse(json.stringify(value))

describe("proxy/hub", () => {
  plain("readings_take_the_providers_shapes", () => {
    const now = Timestamp.fromSecond(1_000_000) ?? 0
    const at = (hours: number) => Timestamp.add(now, SignedDuration.fromHours(hours))
    const limits: Limits = {
      windows: [
        Window.make("7d", 49.0, at(70)),
        Window.make("5h", 43.0, at(2)),
        { ...Window.make("7d", 58.0, at(70)), model: "Fable" },
      ],
      observedAt: now,
      resetCredits: 2,
    }

    let claude = read(claudeUsage(limits, now))
    expect(pick(claude, "five_hour", "utilization")).toBe(43.0)
    expect(pick(claude, "five_hour", "resets_at")).toBe(Timestamp.display(at(2)))
    expect(pick(claude, "seven_day", "utilization")).toBe(49.0)
    expect(pick(claude, "limits", 0, "kind")).toBe("weekly_scoped")
    expect(pick(claude, "limits", 0, "percent")).toBe(58.0)
    expect(pick(claude, "limits", 0, "scope", "model", "display_name")).toBe("Fable")

    let account = Account.make("codex", Tokens.empty(), now)
    let codex = read(codexUsage(account, limits, now))
    // A missing plan is left out: clients reject a null one.
    expect(pick(codex, "plan_type")).toBeUndefined()
    expect(pick(codex, "rate_limit", "primary_window", "used_percent")).toBe(43.0)
    expect(pick(codex, "rate_limit", "primary_window", "reset_at")).toBe(Timestamp.asSecond(at(2)))
    expect(pick(codex, "rate_limit", "primary_window", "limit_window_seconds")).toBe(18_000)
    expect(pick(codex, "rate_limit", "secondary_window", "limit_window_seconds")).toBe(604_800)
    expect(pick(codex, "rate_limit_reset_credits", "available_count")).toBe(2)
    account = { ...account, plan: "pro" }
    expect(pick(read(codexUsage(account, limits, now)), "plan_type")).toBe("pro")

    // Once a window resets, it reads as unused with no reset ahead.
    const later = at(3)
    claude = read(claudeUsage(limits, later))
    expect(pick(claude, "five_hour", "utilization")).toBe(0.0)
    expect(pick(claude, "five_hour", "resets_at")).toBeNull()
    codex = read(codexUsage(account, limits, later))
    expect(pick(codex, "rate_limit", "primary_window", "reset_at")).toBeNull()
  })
})

/** ChatGPT's usage and credits, for the token `tok-ok`. */
const mock = recording((_log, request, headers) =>
  Effect.sync(() => {
    const path = request.url.split("?")[0] ?? ""
    const ok = headers.get("authorization") === "Bearer tok-ok"
    switch (`${request.method} ${path}`) {
      case "GET /wham/usage":
        return ok
          ? reply(
              200,
              [],
              JSON.stringify({
                rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_at: resetIn(60) } },
              }),
            )
          : reply(401, [], "")
      case "GET /wham/rate-limit-reset-credits":
        return ok ? reply(200, [], JSON.stringify({ credits: [] })) : reply(500, [], "down")
      case "POST /wham/rate-limit-reset-credits/consume":
        return ok ? reply(200, [], JSON.stringify({ code: "nothing_to_reset" })) : reply(500, [], "down")
      default:
        return reply(404, [], "")
    }
  }),
)

const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage"
const CREDITS = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
const CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume"

const hubOf = (configure: (c: Config) => Config = (c) => c) =>
  harness({
    prefix: "slopmax-hub",
    mock,
    accounts: () => [
      oauth("claude", "claude0", "tok-ok", "r0", 1000),
      oauth("codex", "codex0", "tok-ok", "r1", 1001, { plan: "plus" }),
      oauth("codex", "codex1", "tok-down", "r2", 1002, { authError: "refresh token revoked" }),
      oauth("codex", "codex2", "tok-down", "r3", 1003, { disabled: true }),
      key("xai", "key-xai"),
    ],
    config: configure({ ...Config.default(), apiKey: KEY, refreshTokens: false, pollMins: 0 }),
    origins: (upstream) => [["https://chatgpt.com/backend-api", upstream]],
  })

const id = (h: Harness, i: number): string => h.ids[i] ?? ""

const management = (h: Harness, method: "GET" | "POST", path: string) =>
  h.client.request(method, `${h.proxy}/v0/management/${path}`).header("authorization", `Bearer ${KEY}`)

/** An `api-call`: the answer's own status, the status it relays, and the relayed body. */
const apiCall = (h: Harness, call: unknown) =>
  Effect.gen(function* () {
    const answer = yield* send(management(h, "POST", "api-call").json(call))
    if (answer.status !== 200) return [answer.status, 0, parse(answer.body)] as const
    const relayed = parse(answer.body)
    return [200, Number(pick(relayed, "status_code")), parse(String(pick(relayed, "body")))] as const
  })

describe("proxy/hub, beyond the Rust tests", () => {
  it.live("only the owner's key opens the management API, in either header", () =>
    Effect.gen(function* () {
      const h = yield* hubOf((c) => ({ ...c, keys: [{ name: "laptop", key: "sm-client", models: [] }] }))
      const files = (name: string, value: string) =>
        send(h.client.get(`${h.proxy}/v0/management/auth-files`).header(name, value))
      const refused = yield* files("authorization", "Bearer sm-client")
      expect(refused.status).toBe(401)
      expect(parse(refused.body)).toEqual({ error: "missing or invalid management key; use slopmax's api_key" })
      expect((yield* files("x-management-key", "sm-client")).status).toBe(401)
      expect((yield* files("x-management-key", ` ${KEY} `)).status).toBe(200)
      expect((yield* files("x-api-key", KEY)).status).toBe(200)
      const unknown = yield* send(management(h, "GET", "config"))
      expect(unknown.status).toBe(404)
      expect(parse(unknown.body)).toEqual({
        error: "slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API",
      })
      // The routes take their own methods only.
      expect((yield* send(management(h, "POST", "auth-files"))).status).toBe(404)
      expect((yield* send(management(h, "GET", "api-call"))).status).toBe(404)
    }),
  )

  it.live("auth files list subscriptions in CLIProxyAPI's shape", () =>
    Effect.gen(function* () {
      const h = yield* hubOf()
      yield* h.app.pool.block(id(h, 0), Timestamp.add(Date.now(), SignedDuration.fromHours(1)), undefined, "spent")
      const answer = yield* send(management(h, "GET", "auth-files"))
      expect(answer.status).toBe(200)
      expect(answer.headers.get("content-type")).toBe("application/json")
      const files = pick(parse(answer.body), "files") as Array<unknown>
      // The API key is no auth file.
      expect(files.map((f) => pick(f, "provider"))).toEqual(["claude", "codex", "codex", "codex"])
      expect(files[0]).toEqual({
        id: id(h, 0),
        auth_index: id(h, 0),
        name: `${id(h, 0)}.json`,
        type: "claude",
        provider: "claude",
        label: "claude0@example.com",
        status: "active",
        disabled: false,
        unavailable: true,
        priority: 0,
        email: "claude0@example.com",
      })
      expect(Object.keys(files[1] as object)).toEqual([
        "id",
        "auth_index",
        "name",
        "type",
        "provider",
        "label",
        "status",
        "disabled",
        "unavailable",
        "priority",
        "email",
        "id_token",
      ])
      expect(pick(files[1], "id_token")).toEqual({ chatgpt_account_id: "acct-codex0", chatgpt_plan_type: "plus" })
      expect(pick(files[2], "status")).toBe("error")
      expect(pick(files[2], "status_message")).toBe("refresh token revoked")
      expect(pick(files[2], "unavailable")).toBe(true)
      expect(pick(files[3], "status")).toBe("disabled")
      expect(pick(files[3], "disabled")).toBe(true)
      expect(pick(files[3], "unavailable")).toBe(false)
    }),
  )

  it.live("api-call bodies are read as serde reads them", () =>
    Effect.gen(function* () {
      const h = yield* hubOf()
      const codex = id(h, 1)
      // A field given twice is refused, under one name or two, as serde's
      // `duplicate field`; an ignored key may repeat.
      const twice = [
        `{"auth_index":"a","authIndex":"b"}`,
        `{"url":"a","url":"b"}`,
        `{"auth_\\u0069ndex":"a","auth_index":"b"}`,
      ]
      for (const body of ["not json", "[1]", `{"auth_index":5}`, ...twice]) {
        const answer = yield* send(management(h, "POST", "api-call").body(body))
        expect(answer.status).toBe(400)
        expect(parse(answer.body)).toEqual({ error: "invalid body" })
      }
      // Aliases, an array in field order, and extra keys all name the account.
      const reads = [
        { authIndex: codex, method: "get", url: ` ${CREDITS} `, header: {} },
        { AuthIndex: ` ${codex}`, method: " GET ", url: CREDITS },
        [codex, "GET", CREDITS],
      ]
      for (const call of reads) expect((yield* apiCall(h, call)).slice(0, 2)).toEqual([200, 200])
      const repeated = `{"header":{},"header":1,"auth_index":"${codex}","method":"GET","url":"${CREDITS}"}`
      const answer = yield* send(management(h, "POST", "api-call").body(repeated))
      expect(Number(pick(parse(answer.body), "status_code"))).toBe(200)
      // An empty body has no account to name.
      const missing = yield* send(management(h, "POST", "api-call").json({}))
      expect([missing.status, parse(missing.body)]).toEqual([400, { error: "no account has this auth_index" }])
      // Nor does an API key, which is no auth file.
      expect((yield* apiCall(h, { auth_index: id(h, 4), method: "GET", url: CODEX_USAGE }))[0]).toBe(400)
    }),
  )

  it.live("signed-out, unread, and listing accounts answer with the provider's status", () =>
    Effect.gen(function* () {
      const h = yield* hubOf()
      const [codex, revoked] = [id(h, 1), id(h, 2)]
      // A revoked sign-in reads as the provider's 401.
      let [status, inner, body] = yield* apiCall(h, { auth_index: revoked, method: "GET", url: CODEX_USAGE })
      expect([status, inner, body]).toEqual([200, 401, { error: { message: "the account needs signing in again" } }])
      ;[, inner] = yield* apiCall(h, { auth_index: revoked, method: "GET", url: CREDITS })
      expect(inner).toBe(401)
      ;[, inner, body] = yield* apiCall(h, { auth_index: codex, method: "GET", url: CODEX_USAGE })
      expect([inner, body]).toEqual([503, { error: { message: "slopmax has not read this account's usage yet" } }])

      // A usage reading that counts no credits saves asking for them.
      const now = yield* Timestamp.now
      yield* h.app.pool.observe(codex, { windows: [], observedAt: now, resetCredits: 0 }, now)
      ;[, inner, body] = yield* apiCall(h, { auth_index: codex, method: "GET", url: CREDITS })
      expect([inner, body]).toEqual([200, { credits: [] }])
      expect(paths(h)).toEqual([])
      ;[, inner, body] = yield* apiCall(h, { auth_index: codex, method: "GET", url: CODEX_USAGE })
      expect(inner).toBe(200)
      expect(body).toEqual({
        rate_limit: { primary_window: null, secondary_window: null },
        plan_type: "plus",
        rate_limit_reset_credits: { available_count: 0 },
      })
    }),
  )

  it.live("consume needs a credit id and answers ChatGPT's code", () =>
    Effect.gen(function* () {
      const h = yield* hubOf()
      const codex = id(h, 1)
      for (const data of [undefined, "nope", `{"id":"c"}`, `{"credit_id":1}`, `{"credit_id":"a","credit_id":"b"}`]) {
        const call =
          data === undefined
            ? { auth_index: codex, method: "POST", url: CONSUME }
            : { auth_index: codex, method: "POST", url: CONSUME, data }
        const [, inner, body] = yield* apiCall(h, call)
        expect([inner, body]).toEqual([400, { error: { message: "no credit_id to redeem" } }])
      }
      expect(paths(h)).toEqual([])
      const data = JSON.stringify({ credit_id: "c-1" })
      let [, inner, body] = yield* apiCall(h, { auth_index: codex, method: "POST", url: CONSUME, data })
      expect([inner, body]).toEqual([200, { code: "nothing_to_reset" }])
      // A refusal upstream is a bad gateway.
      ;[, inner] = yield* apiCall(h, { auth_index: id(h, 3), method: "POST", url: CONSUME, data })
      expect(inner).toBe(502)
      // Claude has no ChatGPT credits to spend.
      expect((yield* apiCall(h, { auth_index: id(h, 0), method: "POST", url: CONSUME, data }))[0]).toBe(403)
    }),
  )

  it.live("reset-quota needs an index, and polls only when polls are on", () =>
    Effect.gen(function* () {
      let h = yield* hubOf()
      const reset = (body: string) => send(management(h, "POST", "reset-quota").body(body))
      let answer = yield* reset("{}")
      expect([answer.status, parse(answer.body)]).toEqual([400, { error: "auth_index is required" }])
      answer = yield* reset(`{"auth_index":"${id(h, 1)}","AuthIndex":"${id(h, 1)}"}`)
      expect([answer.status, parse(answer.body)]).toEqual([400, { error: "auth_index is required" }])
      answer = yield* reset(`{"auth_index":"nobody"}`)
      expect([answer.status, parse(answer.body)]).toEqual([404, { error: "no account has this auth_index" }])
      yield* h.app.pool.block(id(h, 1), Timestamp.add(Date.now(), SignedDuration.fromHours(1)), "gpt-6-sol", "spent")
      answer = yield* reset(JSON.stringify({ authIndex: id(h, 1) }))
      expect(parse(answer.body)).toEqual({ status: "ok", auth_index: id(h, 1), models: ["gpt-6-sol"] })
      expect((yield* h.app.pool.state(id(h, 1))).modelBlocks).toEqual([])
      // `poll_mins = 0`: nothing is read.
      yield* Effect.sleep("50 millis")
      expect(paths(h)).toEqual([])

      h = yield* hubOf((c) => ({ ...c, pollMins: 5 }))
      answer = yield* send(management(h, "POST", "reset-quota").json({ auth_index: id(h, 1) }))
      expect(pick(parse(answer.body), "models")).toEqual([])
      yield* eventually(Effect.sync(() => paths(h).includes("/wham/usage")))
      // A signed-out account is not polled.
      yield* send(management(h, "POST", "reset-quota").json({ auth_index: id(h, 2) }))
      yield* Effect.sleep("50 millis")
      expect(paths(h).filter((p) => p === "/wham/usage").length).toBe(1)
    }),
  )
})
