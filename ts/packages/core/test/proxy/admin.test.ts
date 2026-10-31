// slopmax's own API, endpoint by endpoint. The Rust tests it through
// `tests/proxy.rs` (ported in `test/integration/proxy.test.ts`); these check
// every endpoint's statuses, shapes, and refusals on their own.
import { describe, expect } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Deferred, Effect, Stream } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"

import { Account, Store } from "../../src/account.ts"
import { Config } from "../../src/config.ts"
import type { Entry } from "../../src/ledger.ts"
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
  status as statusOf,
  text,
} from "../integration/harness.ts"

const RUST_PAGE = join(import.meta.dir, "../../../../../crates/slopmax-core/src/proxy/dashboard.html")
const PAGE = join(import.meta.dir, "../../src/proxy/dashboard.html")

/** ChatGPT's usage, credits, and redemption, and Claude's usage, by token. */
const mock = recording((_log, request, headers) =>
  Effect.sync(() => {
    const path = request.url.split("?")[0] ?? ""
    const token = headers.get("authorization")
    switch (`${request.method} ${path}`) {
      case "GET /wham/usage":
        return token === "Bearer tok-ok"
          ? reply(
              200,
              [],
              JSON.stringify({
                plan_type: "pro",
                rate_limit: {
                  primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_at: resetIn(3600) },
                },
                rate_limit_reset_credits: { available_count: 1 },
              }),
            )
          : reply(401, [], "")
      case "GET /api/oauth/usage":
        return reply(200, [], JSON.stringify({ five_hour: { utilization: 25.0, resets_at: null } }))
      case "GET /wham/rate-limit-reset-credits":
        if (token === "Bearer tok-none") return reply(200, [], JSON.stringify({ credits: [] }))
        if (token === "Bearer tok-down") return reply(500, [], "down")
        return reply(
          200,
          [],
          JSON.stringify({
            credits: [
              {
                id: "credit-1",
                status: "available",
                expires_at: Timestamp.display(Timestamp.add(Date.now(), SignedDuration.fromHours(48))),
              },
            ],
          }),
        )
      case "POST /wham/rate-limit-reset-credits/consume":
        return token === "Bearer tok-down" ? reply(500, [], "down") : reply(200, [], JSON.stringify({ code: "reset" }))
      case "GET /local/v1/models":
        return reply(200, [], JSON.stringify({ object: "list", data: [{ id: "qwen3-coder" }] }))
      default:
        return reply(404, [], "")
    }
  }),
)

/** A port nothing listens on, so the doctor's proxy check finds none. */
const freePort = (): number => {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = listener.port
  listener.stop(true)
  return port
}

/** A harness, and the stand-in's base URL. */
const adminOf = (configure: (c: Config) => Config = (c) => c) =>
  Effect.gen(function* () {
    let upstream = ""
    const h = yield* harness({
      prefix: "slopmax-admin",
      mock,
      accounts: (url) => {
        upstream = url
        return [
          oauth("claude", "claude0", "tok-ok", "r0", 1000),
          oauth("codex", "codex0", "tok-ok", "r1", 1001),
          oauth("codex", "codex1", "tok-down", "r2", 1002),
          oauth("codex", "codex2", "tok-none", "r3", 1003, { authError: "refresh token revoked" }),
          key("xai", "key-xai"),
        ]
      },
      config: configure({
        ...Config.default(),
        listen: { ip: "127.0.0.1", port: freePort() },
        apiKey: KEY,
        refreshTokens: false,
        strategy: "fill-first",
      }),
      origins: (url) => [
        ["https://api.anthropic.com", url],
        ["https://chatgpt.com/backend-api", url],
      ],
    })
    return { ...h, upstream }
  })

const id = (h: Harness, i: number): string => h.ids[i] ?? ""

/** One call to `/slopmax/{path}` with the owner's key: its status and body as JSON (null if not JSON). */
const call = (h: Harness, method: "GET" | "POST", path: string, form = "") =>
  Effect.gen(function* () {
    const url = `${h.proxy}/slopmax/${path}`
    const request =
      method === "GET"
        ? h.client.get(url)
        : h.client.post(url).header("content-type", "application/x-www-form-urlencoded").body(form)
    const answer = yield* send(request.header("authorization", `Bearer ${KEY}`))
    let body: unknown = null
    try {
      body = JSON.parse(answer.body)
    } catch {
      // Not JSON.
    }
    return [answer.status, body] as const
  })

/** The error message of an answer in the Messages shape. */
const message = (body: unknown): unknown => pick(body, "error", "message")

const accountIn = (report: unknown, accountId: string): unknown =>
  (pick(report, "accounts") as Array<unknown>).find((a) => pick(a, "id") === accountId)

const config = (h: Harness): string => join(h.dir, "config.toml")

describe("proxy/admin", () => {
  it.live("the dashboard is the Rust's page, served without a key", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const page = yield* send(h.client.get(`${h.proxy}/slopmax/dashboard`))
      expect(page.status).toBe(200)
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
      expect(page.headers.get("content-security-policy")).toBe(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'",
      )
      expect(page.headers.get("referrer-policy")).toBe("no-referrer")
      expect(page.body).toBe(readFileSync(PAGE, "utf8"))
      if (existsSync(RUST_PAGE)) expect(readFileSync(PAGE)).toEqual(readFileSync(RUST_PAGE))
      // Only GET is the page; anything else needs the key, and is no endpoint.
      expect((yield* send(h.client.post(`${h.proxy}/slopmax/dashboard`))).status).toBe(401)
      const [status, body] = yield* call(h, "POST", "dashboard")
      expect([status, message(body)]).toEqual([404, "no such slopmax endpoint"])
    }),
  )

  it.live("everything else needs the owner's key", () =>
    Effect.gen(function* () {
      const h = yield* adminOf((c) => ({ ...c, keys: [{ name: "laptop", key: "sm-client", models: [] }] }))
      const refused = yield* send(h.client.get(`${h.proxy}/slopmax/status`))
      expect(refused.status).toBe(401)
      expect(parse(refused.body)).toEqual({
        type: "error",
        error: { type: "authentication_error", message: "missing or invalid slopmax key; see `slopmax env`" },
      })
      expect((yield* send(h.client.get(`${h.proxy}/slopmax/status`).header("x-api-key", "sm-client"))).status).toBe(401)
      expect((yield* send(h.client.get(`${h.proxy}/slopmax/status`).header("x-api-key", KEY))).status).toBe(200)
      // HEAD probes are answered before the key is asked for.
      expect(yield* statusOf(h.client.request("HEAD", `${h.proxy}/slopmax/status`))).toBe(200)
      for (const [method, path] of [
        ["GET", "nothing"],
        ["POST", "status"],
        ["GET", "refresh"],
        ["GET", ""],
        ["GET", "accounts"],
        ["GET", `accounts/${id(h, 0)}/enable`],
        ["POST", "keys/laptop"],
        ["POST", "use/claude"],
      ] as const) {
        const [status, body] = yield* call(h, method, path)
        expect([method, path, status, message(body)]).toEqual([method, path, 404, "no such slopmax endpoint"])
      }
    }),
  )

  it.live("status reports the pool; refresh reads usage and resets first", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const [status, report] = yield* call(h, "GET", "status")
      expect(status).toBe(200)
      expect(Object.keys(report as object)).toEqual([
        "version",
        "strategy",
        "live",
        "generated_at",
        "accounts",
        "pools",
      ])
      expect(pick(report, "strategy")).toBe("fill-first")
      expect(pick(report, "live")).toBe(true)
      expect(paths(h)).toEqual([])

      const [refreshed, after] = yield* call(h, "POST", "refresh")
      expect(refreshed).toBe(200)
      // Every subscription that is signed in is polled, and the resets of the
      // account whose usage counts some are listed.
      expect(paths(h).toSorted()).toEqual(
        ["/api/oauth/usage", "/wham/rate-limit-reset-credits", "/wham/usage", "/wham/usage"].toSorted(),
      )
      expect(pick(accountIn(after, id(h, 1)), "state", "limits", "windows", 0, "used")).toBe(12)
      expect(pick(accountIn(after, id(h, 1)), "state", "credits", "credits", 0, "id")).toBe("credit-1")
    }),
  )

  it.live("sync picks up accounts and config.toml from disk", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      writeFileSync(config(h), `api_key = "${KEY}"\nstrategy = "round-robin"\nrefresh_tokens = false\n`)
      yield* Store.at(join(h.dir, "accounts"))
        .update(id(h, 0), (a) => ({ ...a, priority: 3 }))
        .pipe(Effect.orDie)
      const [status, report] = yield* call(h, "POST", "sync")
      expect(status).toBe(200)
      expect(pick(report, "strategy")).toBe("round-robin")
      expect(pick(accountIn(report, id(h, 0)), "priority")).toBe(3)
      // A pins file that cannot be read fails the sync.
      writeFileSync(join(h.dir, "pins.json"), "{ nope")
      const [failed, body] = yield* call(h, "POST", "sync")
      expect(failed).toBe(500)
      expect(pick(body, "error", "type")).toBe("api_error")
    }),
  )

  it.live("shutdown signals the daemon", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      expect(yield* Deferred.isDone(h.app.shutdown)).toBe(false)
      expect(yield* call(h, "POST", "shutdown")).toEqual([200, { status: "stopping" }])
      expect(yield* Deferred.isDone(h.app.shutdown)).toBe(true)
    }),
  )

  it.live("usage and history take their ranges and refuse others", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      let [status, body] = yield* call(h, "GET", "usage")
      expect(status).toBe(200)
      expect(Object.keys(body as object)).toEqual(["since", "by", "rows", "total"])
      expect(pick(body, "by")).toBe("day")
      ;[status, body] = yield* call(h, "GET", "usage?range=all&by=account")
      expect([status, pick(body, "by"), pick(body, "since")]).toEqual([200, "account", "1970-01-01T00:00:00Z"])
      ;[status, body] = yield* call(h, "GET", "usage?range=week")
      expect([status, message(body)]).toEqual([400, "range is today, 7d, 30d, or all"])
      ;[status, body] = yield* call(h, "GET", "usage?by=hour")
      expect([status, message(body)]).toEqual([400, "by is day, model, or account"])

      ;[status, body] = yield* call(h, "GET", "history")
      expect([status, pick(body, "range")]).toEqual([200, "week"])
      ;[status, body] = yield* call(h, "GET", "history?range=30d")
      expect([status, pick(body, "range")]).toEqual([200, "month"])
      ;[status, body] = yield* call(h, "GET", "history?range=all")
      expect([status, message(body)]).toEqual([400, "range is today, 7d, or 30d"])
    }),
  )

  it.live("settings are listed, and changes are checked before anything is written", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      writeFileSync(config(h), `api_key = "${KEY}"\n# how sessions pick\nstrategy = "fill-first" # mine\n`)
      let [status, body] = yield* call(h, "GET", "settings")
      expect(status).toBe(200)
      expect(body).toEqual({
        strategy: "fill-first",
        strategies: [
          { id: "reset-first", summary: "Spend the quota that resets soonest, so none is lost" },
          { id: "fill-first", summary: "Use accounts in priority order; fail over when one is limited" },
          { id: "least-used", summary: "Balance load toward the least used account" },
          { id: "round-robin", summary: "Take turns across accounts" },
        ],
        session_affinity: true,
        session_ttl_mins: 60,
        redeem_expiring_credits: true,
        redeem_when_exhausted: false,
        warm_windows: false,
        paid_overflow: false,
        poll_mins: 5,
      })
      ;[status, body] = yield* call(h, "POST", "settings", "")
      expect([status, message(body)]).toEqual([400, "no settings to change"])
      ;[status, body] = yield* call(h, "POST", "settings", "&=x")
      expect([status, message(body)]).toEqual([400, "no settings to change"])
      ;[status, body] = yield* call(h, "POST", "settings", "strategy=least-used&listen=0.0.0.0:1")
      expect([status, message(body)]).toEqual([
        400,
        "listen is not a setting slopmax changes while it runs; those are strategy, session_affinity, " +
          "session_ttl_mins, redeem_expiring_credits, redeem_when_exhausted, warm_windows, paid_overflow, poll_mins",
      ])
      expect(readFileSync(config(h), "utf8")).toContain('strategy = "fill-first" # mine')
      ;[status, body] = yield* call(h, "POST", "settings", "x".repeat(70 * 1024))
      expect([status, message(body)]).toEqual([400, "length limit exceeded"])

      // Query and body together; comments stay; the running key and address stay.
      ;[status, body] = yield* call(h, "POST", "settings?strategy=least-used", "poll_mins=0&warm_windows=on")
      expect(status).toBe(200)
      expect([pick(body, "strategy"), pick(body, "poll_mins"), pick(body, "warm_windows")]).toEqual([
        "least-used",
        0,
        true,
      ])
      const written = readFileSync(config(h), "utf8")
      expect(written).toContain("# how sessions pick")
      expect(written).toContain('strategy = "least-used" # mine')
      const applied = yield* h.app.config
      expect([applied.strategy, applied.pollMins, applied.apiKey]).toEqual(["least-used", 0, KEY])
      expect((yield* h.app.pool.routing).strategy).toBe("least-used")
    }),
  )

  it.live("the live feed says it is connected, then sends each answered request, until the client goes", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const listeners = () => h.app["listeners"]
      expect(listeners()).toBe(0)
      // The client reads the feed in a scope of its own, and goes when it closes.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const feed = yield* h.client
            .get(`${h.proxy}/slopmax/events`)
            .header("authorization", `Bearer ${KEY}`)
            .send()
            .pipe(Effect.orDie)
          expect(feed.status).toBe(200)
          expect(feed.headers.get("content-type")).toBe("text/event-stream")
          expect(feed.headers.get("cache-control")).toBe("no-cache")
          const pull = yield* Stream.toPull(feed.intoBody())
          const first = yield* pull.pipe(Effect.orDie)
          expect(text(first[0] ?? new Uint8Array(0))).toBe(": connected\n\n")
          const entry: Entry = {
            at: Date.now(),
            account: id(h, 1),
            provider: "codex",
            model: "gpt-6-sol",
            status: 200,
            input: 3,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            ms: 9,
            attempts: 1,
          }
          // The feed subscribes before it says it is connected.
          expect(listeners()).toBe(1)
          h.app.broadcast(entry)
          const frame = yield* Effect.gen(function* () {
            for (;;) {
              for (const chunk of yield* pull.pipe(Effect.orDie)) {
                const got = text(chunk)
                if (got.startsWith("data: ")) return got
              }
            }
          }).pipe(Effect.timeout("5 seconds"), Effect.orDie)
          expect(frame.endsWith("\n\n")).toBe(true)
          expect(pick(parse(frame.slice(6)), "model")).toBe("gpt-6-sol")
          expect(pick(parse(frame.slice(6)), "account")).toBe(id(h, 1))
        }),
      )
      // The client going ends the feed and its subscription.
      yield* eventually(Effect.sync(() => listeners() === 0))
    }),
  )

  it.live("account actions change the account and report", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const codex = id(h, 1)
      const stored = () => Effect.map(h.app.store.get(codex).pipe(Effect.orDie), (a) => a as Account)
      let [status, body] = yield* call(h, "POST", "accounts/nobody/enable")
      expect([status, message(body)]).toEqual([404, "no such account"])
      ;[status, body] = yield* call(h, "POST", `accounts/${codex}/explode`)
      expect([status, message(body)]).toEqual([404, "no such account action"])

      ;[status, body] = yield* call(h, "POST", `accounts/${codex}/disable`)
      expect([status, pick(accountIn(body, codex), "disabled")]).toEqual([200, true])
      expect((yield* stored()).disabled).toBe(true)
      ;[, body] = yield* call(h, "POST", `accounts/${codex}/enable`)
      expect(pick(accountIn(body, codex), "disabled")).toBe(false)

      for (const bad of ["", "?value=", "?value=high", "?value=1.5", "?value=2147483648", "?value=%201"]) {
        ;[status, body] = yield* call(h, "POST", `accounts/${codex}/priority${bad}`)
        expect([bad, status, message(body)]).toEqual([bad, 400, "priority needs ?value=<number>"])
      }
      ;[status, body] = yield* call(h, "POST", `accounts/${codex}/priority?value=-2147483648`)
      expect([status, pick(accountIn(body, codex), "priority")]).toEqual([200, -2147483648])
      ;[, body] = yield* call(h, "POST", `accounts/${codex}/priority?value=%2B4`)
      expect(pick(accountIn(body, codex), "priority")).toBe(4)

      ;[, body] = yield* call(h, "POST", `accounts/${codex}/label?value=%20work%20`)
      expect(pick(accountIn(body, codex), "name")).toBe(" work ")
      ;[, body] = yield* call(h, "POST", `accounts/${codex}/label?value=%20%20`)
      expect(pick(accountIn(body, codex), "name")).toBe("codex0@example.com")
      expect((yield* stored()).label).toBeUndefined()

      ;[, body] = yield* call(h, "POST", `accounts/${codex}/use`)
      expect(pick(accountIn(body, codex), "pinned")).toBe(true)
      expect(JSON.parse(readFileSync(join(h.dir, "pins.json"), "utf8"))).toEqual({ codex })
      ;[, body] = yield* call(h, "POST", "use/auto")
      expect(pick(accountIn(body, codex), "pinned")).toBe(false)
      expect(JSON.parse(readFileSync(join(h.dir, "pins.json"), "utf8"))).toEqual({})

      yield* h.app.store
        .update(codex, (a) => ({ ...a, link: { tool: "cliproxyapi", path: join(h.dir, "elsewhere.json") } }))
        .pipe(Effect.orDie)
      ;[status] = yield* call(h, "POST", `accounts/${codex}/own`)
      expect(status).toBe(200)
      expect((yield* stored()).link).toBeUndefined()

      yield* call(h, "POST", `accounts/${codex}/use`)
      ;[status, body] = yield* call(h, "POST", `accounts/${codex}/remove`)
      expect(status).toBe(200)
      expect(accountIn(body, codex)).toBeUndefined()
      expect(yield* h.app.store.get(codex).pipe(Effect.orDie)).toBeUndefined()
      expect(JSON.parse(readFileSync(join(h.dir, "pins.json"), "utf8"))).toEqual({})
      // Gone from the pool, so no longer an account here.
      ;[status] = yield* call(h, "POST", `accounts/${codex}/enable`)
      expect(status).toBe(404)
    }),
  )

  it.live("redeeming answers how it went", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const [codex, down, revoked, xai] = [id(h, 1), id(h, 2), id(h, 3), id(h, 4)]
      let [status, body] = yield* call(h, "POST", `accounts/${xai}/redeem`)
      expect([status, message(body)]).toEqual([400, "this account has no limit resets"])
      ;[status, body] = yield* call(h, "POST", `accounts/${revoked}/redeem`)
      expect([status, message(body)]).toEqual([409, "the account needs signing in again"])
      // Listing fails: a bad gateway.
      ;[status] = yield* call(h, "POST", `accounts/${down}/redeem`)
      expect(status).toBe(502)
      // The named credit fails to redeem: a bad gateway too.
      ;[status] = yield* call(h, "POST", `accounts/${down}/redeem?value=credit-1`)
      expect(status).toBe(502)

      // The soonest listed now, recorded.
      ;[status, body] = yield* call(h, "POST", `accounts/${codex}/redeem`)
      expect([status, pick(body, "outcome")]).toEqual([200, "reset"])
      expect(Object.keys(body as object)).toEqual(["outcome", "report"])
      const consumed = h.log.filter((s) => s.path.endsWith("/consume")).at(-1)
      expect(pick(parse(consumed?.body ?? new Uint8Array()), "credit_id")).toBe("credit-1")
      expect((yield* h.app.pool.state(codex)).limits.windows).toEqual([])
    }),
  )

  it.live("an account with no limit reset left says so", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        prefix: "slopmax-admin",
        mock,
        accounts: () => [oauth("codex", "codex0", "tok-none", "r1", 1001)],
        config: {
          ...Config.default(),
          listen: { ip: "127.0.0.1", port: freePort() },
          apiKey: KEY,
          refreshTokens: false,
        },
        origins: (upstream) => [["https://chatgpt.com/backend-api", upstream]],
      })
      const [status, body] = yield* call(h, "POST", `accounts/${id(h, 0)}/redeem`)
      expect([status, pick(body, "outcome")]).toEqual([200, "no_credit"])
      expect(h.log.some((s) => s.path.endsWith("/consume"))).toBe(false)
      expect((yield* h.app.pool.state(id(h, 0))).credits?.credits).toEqual([])
    }),
  )

  it.live("accounts are added with a key, and checked first", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      const refusals: ReadonlyArray<readonly [string, string]> = [
        ["", "provider is anthropic, openai, xai, or compat"],
        ["provider=grok", "provider is anthropic, openai, xai, or compat"],
        ["provider=codex", "ChatGPT accounts sign in with a browser: `slopmax login codex`, or the app"],
        ["provider=compat&url=%20", "a compatible endpoint needs its url"],
        ["provider=compat&url=ftp://x", "url is an http:// or https:// base URL"],
        ["provider=compat&url=http://x&dialect=grpc", "dialect is chat, responses, or messages"],
      ]
      for (const [form, expected] of refusals) {
        const [status, body] = yield* call(h, "POST", "accounts", form)
        expect([form, status, message(body)]).toEqual([form, 400, expected])
      }
      // The fields may come in the query too; the first of a name counts.
      const [status, report] = yield* call(
        h,
        "POST",
        "accounts?provider=compat&label=box",
        `url=${encodeURIComponent(`${h.upstream}/local/v1//`)}&models=qwen3-*,%20,glm-*&dialect=messages&label=other`,
      )
      expect(status).toBe(200)
      const added = (pick(report, "accounts") as Array<unknown>).find((a) => pick(a, "provider") === "compat")
      expect(pick(added, "name")).toBe("box")
      expect(pick(added, "models")).toEqual(["qwen3-*", "glm-*"])
      expect(pick(added, "endpoint")).toBe(`${h.upstream}/local/v1`)
      const saved = (yield* h.app.store.list().pipe(Effect.orDie)).find((a) => a.provider === "compat")
      expect(saved?.endpoint?.dialect).toBe("messages")
    }),
  )

  it.live("client keys are made, listed by name, and revoked", () =>
    Effect.gen(function* () {
      const h = yield* adminOf()
      writeFileSync(config(h), `api_key = "${KEY}"\n`)
      let [status, body] = yield* call(h, "GET", "keys")
      expect([status, body]).toEqual([200, { keys: [] }])
      ;[status, body] = yield* call(h, "POST", "keys", "name=%20&models=x")
      expect([status, message(body)]).toEqual([400, "a key needs a name"])
      ;[status, body] = yield* call(h, "POST", "keys?name=ci", "models=gpt-6-*,%20,claude-*")
      expect(status).toBe(200)
      expect(Object.keys(body as object)).toEqual(["name", "key", "models"])
      expect([pick(body, "name"), pick(body, "models")]).toEqual(["ci", ["gpt-6-*", "claude-*"]])
      expect(String(pick(body, "key")).startsWith("sm-")).toBe(true)
      expect((yield* h.app.config).keys.map((k) => k.name)).toEqual(["ci"])
      ;[status, body] = yield* call(h, "POST", "keys", "name=ci")
      expect([status, message(body)]).toEqual([400, 'a key named "ci" already exists'])
      ;[, body] = yield* call(h, "GET", "keys")
      expect(body).toEqual({ keys: [{ name: "ci", models: ["gpt-6-*", "claude-*"] }] })
      ;[status, body] = yield* call(h, "POST", "keys/nobody/remove")
      expect([status, message(body)]).toEqual([404, "no such key"])
      ;[status, body] = yield* call(h, "POST", "keys/ci/remove")
      expect([status, body]).toEqual([200, { keys: [] }])
      expect((yield* h.app.config).keys).toEqual([])
    }),
  )

  it.live(
    "the doctor's sections come as JSON",
    () =>
      Effect.gen(function* () {
        const h = yield* adminOf()
        const [status, sections] = yield* call(h, "GET", "doctor")
        expect(status).toBe(200)
        const all = sections as Array<unknown>
        expect(all.map((s) => pick(s, "title"))).toContain("Accounts")
        for (const section of all) {
          expect(Object.keys(section as object)).toEqual(["title", "findings"])
          for (const f of pick(section, "findings") as Array<unknown>) {
            expect(Object.keys(f as object)).toEqual(["level", "text", "fix"])
            expect(["ok", "note", "warn", "fail"]).toContain(String(pick(f, "level")))
          }
        }
        // Nothing went to CLIProxyAPI's port: no account follows it.
        expect(all.map((s) => pick(s, "title"))).not.toContain("CLIProxyAPI")
      }),
    30_000,
  )
})
