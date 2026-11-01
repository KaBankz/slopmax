// SlopmaxApi served in process by stub handlers, called both as raw HTTP
// and through the typed client every front end uses. This checks the contract
// itself: the owner key guards every endpoint, bodies and queries decode with
// words people read, errors keep their statuses, and the event stream arrives
// as events.
import { describe, expect } from "bun:test"
import { it, MemoryFileSystem } from "@slopmax/test"
import { DateTime, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApiBuilder, HttpApiTest } from "effect/http-api"
import {
  AccountAdded,
  apiPrefix,
  ImportResult,
  InputErrors,
  OwnerKey,
  ownerKeyMatches,
  SlopmaxApi,
  Stopping,
  LoginStarted,
} from "../src/api.ts"
import {
  AccountView,
  Condition,
  defaultSettings,
  Event,
  LoginId,
  NewKey,
  NotFound,
  RedeemResult,
  Report,
  settingsView,
  Summary,
  Totals,
  Usage,
} from "../src/index.ts"

const ownerKey = "sm-owner-key"
const at = DateTime.makeUnsafe(1_000_000)

const report = new Report({
  version: "0.4.0",
  live: true,
  generatedAt: at,
  strategy: "reset-first",
  accounts: [],
  pools: [],
  nudges: [],
})

const account = new AccountView({
  id: Schema.decodeSync(Schema.String.pipe(Schema.brand("AccountId")))("openai-1a2b3c4d"),
  provider: "openai",
  name: "work",
  disabled: false,
  priority: 0,
  pinned: false,
  models: ["gpt-*"],
  sessions: 0,
  condition: Condition.cases.Ready.make({}),
  notes: [],
  windows: [],
  resets: [],
  served: Usage.zero,
})

/** What the stub handlers were asked, in order. */
const received: Array<unknown> = []
const notReached = Effect.die(new Error("not reached in these tests"))

const System = HttpApiBuilder.group(SlopmaxApi, "system", (handlers) =>
  handlers
    .handle("status", () => Effect.succeed(report))
    .handle("refresh", () => Effect.succeed(report))
    .handle("sync", () => Effect.succeed(report))
    .handle("shutdown", () => Effect.succeed(new Stopping({ status: "stopping" })))
    .handle("doctor", () => Effect.succeed([])),
)

const Accounts = HttpApiBuilder.group(SlopmaxApi, "accounts", (handlers) =>
  handlers
    .handle("add", ({ payload }) =>
      Effect.sync(() => received.push(payload)).pipe(Effect.as(new AccountAdded({ account, report }))),
    )
    .handle("update", ({ params, payload }) =>
      params.id === account.id
        ? Effect.sync(() => received.push(payload)).pipe(Effect.as(report))
        : Effect.fail(NotFound.of({ what: "account" })),
    )
    .handle("pin", () => notReached)
    .handle("unpinAll", () => Effect.succeed(report))
    .handle("own", () => notReached)
    .handle("remove", () => notReached)
    .handle("redeem", ({ payload }) =>
      Effect.sync(() => received.push(payload)).pipe(Effect.as(new RedeemResult({ outcome: "no-credit", report }))),
    )
    .handle("import", ({ payload }) =>
      Effect.sync(() => received.push(payload)).pipe(Effect.as(new ImportResult({ outcomes: [], report }))),
    ),
)

const Logins = HttpApiBuilder.group(SlopmaxApi, "logins", (handlers) =>
  handlers
    .handle("start", ({ payload }) =>
      Effect.sync(() => received.push(payload)).pipe(Effect.as(new LoginStarted({ id: LoginId.make("login-1") }))),
    )
    .handle("paste", () => notReached)
    .handle("cancel", () => Effect.fail(NotFound.of({ what: "sign-in" }))),
)

const Config = HttpApiBuilder.group(SlopmaxApi, "config", (handlers) =>
  handlers
    .handle("settings", () => Effect.succeed(settingsView(defaultSettings(ownerKey))))
    .handle("change", ({ payload }) =>
      Effect.sync(() => received.push(payload)).pipe(Effect.as(settingsView(defaultSettings(ownerKey)))),
    )
    .handle("keys", () => Effect.succeed([]))
    .handle("makeKey", ({ payload }) =>
      Effect.succeed(new NewKey({ name: payload.name, key: "sm-new", models: payload.models })),
    )
    .handle("removeKey", ({ params }) => Effect.fail(NotFound.of({ what: `key ${JSON.stringify(params.name)}` }))),
)

const Agents = HttpApiBuilder.group(SlopmaxApi, "agents", (handlers) =>
  handlers
    .handle("list", () => Effect.succeed([]))
    .handle("connect", () => notReached)
    .handle("disconnect", () => notReached),
)

const UsageGroup = HttpApiBuilder.group(SlopmaxApi, "usage", (handlers) =>
  handlers
    .handle("summary", ({ query }) =>
      Effect.succeed(new Summary({ range: query.range, by: query.by, since: at, rows: [], total: Totals.zero })),
    )
    .handle("history", () => notReached),
)

const Events = HttpApiBuilder.group(SlopmaxApi, "events", (handlers) =>
  handlers.handle("watch", () =>
    Effect.succeed(
      Stream.make(
        Event.cases.Hello.make({ version: "0.4.0" }),
        Event.cases.Status.make({ report }),
        Event.cases.Ping.make({}),
      ),
    ),
  ),
)

const Notify = HttpApiBuilder.group(SlopmaxApi, "notify", (handlers) => handlers.handle("test", () => Effect.void))

const handlers = Layer.mergeAll(System, Accounts, Logins, Config, Agents, UsageGroup, Events, Notify)
const platform = Layer.mergeAll(HttpPlatform.layer, Etag.layer).pipe(Layer.provideMerge(MemoryFileSystem.layer))

const ApiLive = HttpApiBuilder.layer(SlopmaxApi).pipe(
  Layer.provide(handlers),
  Layer.provide([OwnerKey.layer(Effect.succeed(Redacted.make(ownerKey))), InputErrors.layer]),
  Layer.provide(platform),
)

/** The API's web handler, with no server or socket. */
const served = Effect.acquireRelease(
  Effect.sync(() => HttpRouter.toWebHandler(ApiLive, { disableLogger: true })),
  ({ dispose }) => Effect.promise(dispose),
)

const call = (path: string, init?: RequestInit) =>
  Effect.gen(function* () {
    const { handler } = yield* served
    const response = yield* Effect.promise(() => handler(new Request(`http://slopmax.test${path}`, init)))
    return { status: response.status, body: yield* Effect.promise(() => response.text()) }
  })

/** Lets every call through: the in-process client sends no key, and the key is checked over raw HTTP above. */
const anyKey = Layer.succeed(OwnerKey, { bearer: (effect) => effect, header: (effect) => effect })

/** The typed client over the in-process API. */
const typedClient = HttpApiTest.groups(SlopmaxApi, [
  "system",
  "accounts",
  "logins",
  "config",
  "agents",
  "usage",
  "events",
  "notify",
]).pipe(Effect.provide(Layer.mergeAll(handlers, platform)))

/** The middleware the typed client's calls run through. */
const clientMiddleware = Layer.mergeAll(anyKey, InputErrors.layer)

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})

const addAnswer = (body: unknown) =>
  call("/slopmax/api/accounts", json(body)).pipe(
    Effect.map((answer) => [answer.status, JSON.parse(answer.body).message ?? "added"]),
  )

describe("SlopmaxApi", () => {
  it.live("lives under /slopmax/api and needs the owner key, as a bearer token or x-api-key", () =>
    Effect.gen(function* () {
      expect(apiPrefix).toBe("/slopmax/api")
      const none = yield* call("/slopmax/api/status")
      expect(none.status).toBe(401)
      expect(JSON.parse(none.body)).toEqual({
        _tag: "Unauthorized",
        message: "missing or invalid slopmax key; see `slopmax env`",
      })
      expect((yield* call("/slopmax/api/status", { headers: { authorization: "Bearer sm-client-key" } })).status).toBe(
        401,
      )
      expect((yield* call("/slopmax/api/status", { headers: { authorization: `Bearer ${ownerKey}` } })).status).toBe(
        200,
      )
      expect((yield* call("/slopmax/api/status", { headers: { "x-api-key": ownerKey } })).status).toBe(200)
      expect((yield* call("/status", { headers: { "x-api-key": ownerKey } })).status).toBe(404)
    }),
  )

  it("compares keys in full, and never matches an empty key", () => {
    const key = Redacted.make("sm-abc")
    expect(ownerKeyMatches(Redacted.make("sm-abc"), key)).toBe(true)
    expect(ownerKeyMatches(Redacted.make("sm-ab"), key)).toBe(false)
    expect(ownerKeyMatches(Redacted.make("sm-abd"), key)).toBe(false)
    expect(ownerKeyMatches(Redacted.make("sm-abcd"), key)).toBe(false)
    expect(ownerKeyMatches(Redacted.make(""), Redacted.make(""))).toBe(false)
  })

  it.live("gives typed clients the report, settings and usage, and the errors they declare", () =>
    Effect.gen(function* () {
      const client = yield* typedClient
      expect(yield* client.system.status()).toEqual(report)
      expect(yield* client.system.shutdown()).toEqual(new Stopping({ status: "stopping" }))
      const view = yield* client.config.settings()
      expect(view.strategies.map((strategy) => strategy.id)).toEqual([
        "reset-first",
        "fill-first",
        "least-used",
        "round-robin",
      ])
      expect(JSON.stringify(view)).not.toContain(ownerKey)
      const summary = yield* client.usage.summary({ query: { range: "today", by: "account" } })
      expect([summary.range, summary.by]).toEqual(["today", "account"])
      const missing = yield* Effect.flip(
        client.config.removeKey({
          params: { name: Schema.decodeSync(Schema.NonEmptyString.pipe(Schema.brand("KeyName")))("ci") },
        }),
      )
      expect(missing).toBeInstanceOf(NotFound)
      expect(missing.message).toBe('no such key "ci"')
    }).pipe(Effect.provide(clientMiddleware)),
  )

  it.live("streams events, beginning with hello", () =>
    Effect.gen(function* () {
      const client = yield* typedClient
      const events = yield* client.events.watch().pipe(Effect.flatMap(Stream.runCollect))
      expect(Array.from(events).map((event) => event._tag)).toEqual(["Hello", "Status", "Ping"])
      const raw = yield* call("/slopmax/api/events", { headers: { authorization: `Bearer ${ownerKey}` } })
      expect(raw.body).toContain('"_tag":"Hello"')
    }).pipe(Effect.provide(clientMiddleware)),
  )

  it.live("uses defaults for a usage query it is not given, and words a bad one for people", () =>
    Effect.gen(function* () {
      const plain = yield* call("/slopmax/api/usage", { headers: { authorization: `Bearer ${ownerKey}` } })
      expect(JSON.parse(plain.body)).toMatchObject({ range: "7d", by: "day" })
      const bad = yield* call("/slopmax/api/usage?range=1y", { headers: { authorization: `Bearer ${ownerKey}` } })
      expect(bad.status).toBe(400)
      expect(JSON.parse(bad.body)).toEqual({ _tag: "BadRequest", message: "range: range is today, 7d, 30d, or all" })
      const by = yield* call("/slopmax/api/usage?by=week", { headers: { authorization: `Bearer ${ownerKey}` } })
      expect(JSON.parse(by.body).message).toBe("by: by is day, model, or account")
      const history = yield* call("/slopmax/api/history?range=all", {
        headers: { authorization: `Bearer ${ownerKey}` },
      })
      expect(JSON.parse(history.body).message).toBe("range: range is today, 7d, or 30d")
    }),
  )

  it.live("checks a settings change whole before it reaches the handler", () =>
    Effect.gen(function* () {
      received.length = 0
      const ok = yield* call("/slopmax/api/settings", json({ strategy: "least-used", pollMinutes: 0 }, "PATCH"))
      expect(ok.status).toBe(200)
      expect(received).toEqual([{ strategy: "least-used", pollMinutes: 0 }])
      const message = (body: unknown) =>
        call("/slopmax/api/settings", json(body, "PATCH")).pipe(
          Effect.map((answer) => [answer.status, JSON.parse(answer.body).message]),
        )
      expect(yield* message({})).toEqual([400, "no settings to change"])
      expect(yield* message({ listen: "0.0.0.0:1" })).toEqual([
        400,
        "listen is not a setting slopmax changes while it runs; those are strategy, sessionAffinity, sessionMinutes, redeemExpiring, redeemWhenExhausted, warmWindows, paidOverflow, pollMinutes, refreshTokens, websockets",
      ])
      expect(yield* message({ strategy: "fastest" })).toEqual([
        400,
        "strategy: strategy is one of reset-first, fill-first, least-used, round-robin",
      ])
      expect(yield* message({ sessionMinutes: 0 })).toEqual([
        400,
        "sessionMinutes: sessionMinutes is a number of minutes",
      ])
      expect(received).toHaveLength(1)
    }),
  )

  it.live("adds keys and endpoints, refusing subscriptions and incomplete endpoints in plain words", () =>
    Effect.gen(function* () {
      received.length = 0
      expect(yield* addAnswer({ _tag: "Key", provider: "openai", key: "sk-1", label: "work" })).toEqual([200, "added"])
      expect(yield* addAnswer({ _tag: "Key", provider: "claude", key: "sk-1" })).toEqual([
        400,
        "provider: Claude accounts sign in with a browser: `slopmax login claude`, or the app",
      ])
      expect(yield* addAnswer({ _tag: "Key", provider: "gemini", key: "sk-1" })).toEqual([
        400,
        "provider: provider is anthropic, openai, xai, or compat",
      ])
      expect(yield* addAnswer({ _tag: "Endpoint" })).toEqual([400, "url: a compatible endpoint needs its url"])
      expect(yield* addAnswer({ _tag: "Endpoint", url: "localhost:11434" })).toEqual([
        400,
        "url: url is an http:// or https:// base URL",
      ])
      expect(yield* addAnswer({ _tag: "Endpoint", url: "http://localhost:11434/v1", dialect: "grpc" })).toEqual([
        400,
        "dialect: dialect is chat, responses, or messages",
      ])
      expect(
        yield* addAnswer({ _tag: "Endpoint", url: " http://localhost:11434/v1/ ", models: [" qwen3 ", "", "llama*"] }),
      ).toEqual([200, "added"])
      expect(yield* addAnswer({ _tag: "Key", provider: "openai", key: "sk-1", extra: true })).toEqual([
        400,
        "extra: Expected no excess property",
      ])
      expect(received).toEqual([
        { _tag: "Key", provider: "openai", key: "sk-1", label: "work" },
        { _tag: "Endpoint", url: "http://localhost:11434/v1", dialect: "chat", models: ["qwen3", "llama*"] },
      ])
    }),
  )

  it.live("clears a blank label, and needs a name for a new key", () =>
    Effect.gen(function* () {
      received.length = 0
      expect((yield* call(`/slopmax/api/accounts/${account.id}`, json({ label: "  " }, "PATCH"))).status).toBe(200)
      expect(
        (yield* call(`/slopmax/api/accounts/${account.id}`, json({ label: " work ", priority: 2 }, "PATCH"))).status,
      ).toBe(200)
      expect(received).toEqual([{ label: null }, { label: "work", priority: 2 }])
      const unknown = yield* call("/slopmax/api/accounts/codex-0", json({ disabled: true }, "PATCH"))
      expect([unknown.status, JSON.parse(unknown.body)]).toEqual([
        404,
        { _tag: "NotFound", what: "account", message: "no such account" },
      ])
      const priority = yield* call(`/slopmax/api/accounts/${account.id}`, json({ priority: "high" }, "PATCH"))
      expect(JSON.parse(priority.body).message).toBe("priority: priority is a whole number")
      const unnamed = yield* call("/slopmax/api/keys", json({ models: ["gpt-*"] }))
      expect([unnamed.status, JSON.parse(unnamed.body).message]).toEqual([400, "name: a key needs a name"])
      const blank = yield* call("/slopmax/api/keys", json({ name: "  " }))
      expect(JSON.parse(blank.body).message).toBe("name: a key needs a name")
      const made = yield* call("/slopmax/api/keys", json({ name: "laptop", models: ["gpt-*"] }))
      expect(JSON.parse(made.body)).toEqual({ name: "laptop", key: "sm-new", models: ["gpt-*"] })
    }),
  )

  it.live("takes a bare POST for actions whose every option may be left out", () =>
    Effect.gen(function* () {
      received.length = 0
      const bare = { method: "POST", headers: { authorization: `Bearer ${ownerKey}` } }
      const redeemed = yield* call(`/slopmax/api/accounts/${account.id}/redeem`, bare)
      expect([redeemed.status, JSON.parse(redeemed.body).outcome]).toEqual([200, "no-credit"])
      expect((yield* call("/slopmax/api/imports", bare)).status).toBe(200)
      expect((yield* call(`/slopmax/api/accounts/${account.id}/redeem`, json({ reset: "r-1" }))).status).toBe(200)
      expect(received).toEqual([{}, { own: false }, { reset: "r-1" }])
    }),
  )

  it.live("starts sign-ins for subscriptions only", () =>
    Effect.gen(function* () {
      received.length = 0
      const started = yield* call("/slopmax/api/logins", json({ provider: "codex", device: true }))
      expect(JSON.parse(started.body)).toEqual({ id: "login-1" })
      const key = yield* call("/slopmax/api/logins", json({ provider: "openai" }))
      expect(JSON.parse(key.body).message).toBe("provider: only claude and codex accounts sign in")
      expect(received).toEqual([{ provider: "codex", device: true }])
    }),
  )
})
