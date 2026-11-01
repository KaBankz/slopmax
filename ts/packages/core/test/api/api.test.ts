// slopmax's own API, served by the daemon over the services the proxy uses:
// every endpoint called as the dashboard, the desktop window and the CLI
// call it.
import { describe, expect } from "bun:test"
import { AccountId, Event, LedgerRecord, Limits, NotFound, Usage, Window } from "@slopmax/domain"
import { it } from "@slopmax/test"
import {
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Account, accountText, Credential, Link, Tokens } from "../../src/account.ts"
import { AccountPatch } from "@slopmax/domain/api"
import { Shutdown } from "../../src/api/handlers.ts"
import { Accounts } from "../../src/accounts.ts"
import { Events } from "../../src/events.ts"
import { Ledger } from "../../src/ledger.ts"
import { observe, Pool } from "../../src/pool.ts"
import { Server } from "../../src/server.ts"
import { SettingsService } from "../../src/settings.ts"
import { jwt } from "../providers/support.ts"
import { apiKey, oauth, settled } from "../proxy/stack.ts"
import { chatgptApi, json, on, type Route } from "../support/memory-upstream.ts"
import { apiStack, call, client, field, home, items, key } from "./stack.ts"

const first = oauth("codex", "a", "tok-ok", 1)
const second = oauth("codex", "b", "tok-ok", 2)

/** The account of that id in a report answer. */
const accountIn = (report: unknown, id: string) =>
  items(report, "accounts").find((account) => field(account, "id") === id)

/** Reads an event stream's `data:` lines, decoded, a few at a time. */
const eventReader = (response: Response) => {
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  const ready: Array<unknown> = []
  let text = ""
  return {
    /** The next `count` events. */
    next: (count: number) =>
      Effect.promise(async () => {
        if (reader === undefined) return []
        while (ready.length < count) {
          const { value, done } = await reader.read()
          if (done) break
          text += decoder.decode(value)
          const blocks = text.split("\n\n")
          text = blocks.pop() ?? ""
          for (const block of blocks) {
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("")
            if (data !== "") ready.push(JSON.parse(data))
          }
        }
        return ready.splice(0, count)
      }),
    close: Effect.promise(async () => reader?.cancel()),
  }
}

/** Changes an account. */
const patch = (id: string, body: unknown) => call("PATCH", `/slopmax/api/accounts/${id}`, { body })

describe("SlopmaxApi, served by the daemon", () => {
  it.effect("answers the live report to the owner key alone: client keys and no key get 401", () => {
    const { layer } = apiStack({
      accounts: [first],
      settings: { keys: [{ name: "laptop", key: "sm-client", models: [] }] },
    })
    return Effect.gen(function* () {
      const status = yield* call("GET", "/slopmax/api/status")
      expect(status.status).toBe(200)
      expect(field(status.body, "live")).toBe(true)
      expect(field(accountIn(status.body, first.id), "name")).toBe("a@example.com")
      expect(field(status.body, "pools", 0, "provider")).toBe("codex")
      const refused = yield* call("GET", "/slopmax/api/status", { key: "sm-client" })
      expect([refused.status, field(refused.body, "message")]).toEqual([
        401,
        "missing or invalid slopmax key; see `slopmax env`",
      ])
      expect((yield* call("GET", "/slopmax/api/status", { key: null })).status).toBe(401)
      expect((yield* call("GET", "/slopmax/api/status", { key: null, headers: { "x-api-key": key } })).status).toBe(200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("answers a path no endpoint serves with 404 once the key is right", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      expect((yield* call("GET", "/slopmax/api/nope", { key: null })).status).toBe(401)
      const unknown = yield* call("DELETE", "/slopmax/api/status/now")
      expect([unknown.status, unknown.body]).toEqual([
        404,
        { _tag: "NotFound", what: "slopmax endpoint", message: "no such slopmax endpoint" },
      ])
      expect((yield* call("POST", "/slopmax/whatever")).status).toBe(404)
      expect((yield* call("POST", "/slopmax/whatever", { key: null })).status).toBe(401)
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a body over 64 KiB", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      const big = yield* call("POST", "/slopmax/api/keys", { body: { name: "x".repeat(70_000) } })
      expect(big.status).toBe(413)
    }).pipe(Effect.provide(layer))
  })

  it.effect("turns accounts off and on, orders, labels, pins and removes them, answering the report", () => {
    const { layer } = apiStack({ accounts: [first, second] })
    return Effect.gen(function* () {
      expect(field(accountIn((yield* patch(first.id, { disabled: true })).body, first.id), "disabled")).toBe(true)
      expect(field(accountIn((yield* patch(first.id, { disabled: false })).body, first.id), "disabled")).toBe(false)
      expect(field(accountIn((yield* patch(first.id, { priority: 3 })).body, first.id), "priority")).toBe(3)
      expect(field(accountIn((yield* patch(first.id, { label: "work laptop" })).body, first.id), "name")).toBe(
        "work laptop",
      )
      // A blank label clears it, and the email shows again.
      expect(field(accountIn((yield* patch(first.id, { label: " " })).body, first.id), "name")).toBe("a@example.com")
      const missing = yield* patch("codex-nope", { disabled: true })
      expect([missing.status, field(missing.body, "message")]).toEqual([404, "no such account"])

      const pinned = yield* call("POST", `/slopmax/api/accounts/${second.id}/pin`)
      expect(field(accountIn(pinned.body, second.id), "pinned")).toBe(true)
      expect((yield* Effect.flatMap(Pool, (pool) => pool.model)).pins.codex).toBe(second.id)
      const auto = yield* call("DELETE", "/slopmax/api/pins")
      expect(field(accountIn(auto.body, second.id), "pinned")).toBe(false)

      // Removing an account takes its pin with it.
      yield* call("POST", `/slopmax/api/accounts/${second.id}/pin`)
      const removed = yield* call("DELETE", `/slopmax/api/accounts/${second.id}`)
      expect(accountIn(removed.body, second.id)).toBeUndefined()
      expect((yield* Effect.flatMap(Pool, (pool) => pool.model)).pins.codex).toBeUndefined()
      expect((yield* call("DELETE", `/slopmax/api/accounts/${second.id}`)).status).toBe(404)
      expect((yield* call("POST", `/slopmax/api/accounts/${second.id}/pin`)).status).toBe(404)
    }).pipe(Effect.provide(layer))
  })

  it.effect("lets an imported account refresh its own tokens", () => {
    const linked = new Account({
      ...first,
      credential: Credential.cases.OAuth.make({
        tokens: new Tokens({ access: Redacted.make("tok-ok") }),
        follows: new Link({ tool: "cliproxyapi", path: "/home/me/.cli-proxy-api/a.json" }),
      }),
    })
    const { layer } = apiStack({ accounts: [linked] })
    return Effect.gen(function* () {
      const before = yield* call("GET", "/slopmax/api/status")
      expect(field(accountIn(before.body, linked.id), "follows")).toBe("cliproxyapi")
      const owned = yield* call("POST", `/slopmax/api/accounts/${linked.id}/own`)
      expect(owned.status).toBe(200)
      expect(field(accountIn(owned.body, linked.id), "follows")).toBeUndefined()
      const stored = yield* Effect.flatMap(Accounts, (accounts) => accounts.fresh(linked.id))
      const credential = Option.getOrThrow(stored).credential
      expect(credential._tag === "OAuth" && credential.follows === undefined).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("adds API keys and endpoints after the provider accepts them, and refuses what it rejects", () => {
    const routes: ReadonlyArray<Route> = [
      on("GET https://api.openai.com/v1/models", (seen) =>
        seen.token === "sk-good" ? json(200, { data: [{ id: "gpt-6-sol" }] }) : json(401, { error: "bad key" }),
      ),
      on("GET http://gpu.test/v1/models", () => json(200, { data: [{ id: "qwen3-coder" }] })),
    ]
    const { layer } = apiStack({ routes })
    return Effect.gen(function* () {
      const added = yield* call("POST", "/slopmax/api/accounts", {
        body: { _tag: "Key", provider: "openai", key: "sk-good", label: "work" },
      })
      expect(added.status).toBe(200)
      expect(field(added.body, "account", "name")).toBe("work")
      expect(field(added.body, "account", "provider")).toBe("openai")
      const rejected = yield* call("POST", "/slopmax/api/accounts", {
        body: { _tag: "Key", provider: "openai", key: "sk-bad" },
      })
      expect(rejected.status).toBe(502)
      expect(String(field(rejected.body, "message"))).toContain("rejected the key")

      const endpoint = yield* call("POST", "/slopmax/api/accounts", {
        body: { _tag: "Endpoint", url: "http://gpu.test/v1/", models: ["qwen3-*"], label: "box" },
      })
      expect(endpoint.status).toBe(200)
      expect(field(endpoint.body, "account", "name")).toBe("box")
      expect(field(endpoint.body, "account", "models")).toEqual(["qwen3-*"])
      const providers = items(endpoint.body, "report", "accounts").map((account) => String(field(account, "provider")))
      expect(providers.toSorted()).toEqual(["compat", "openai"])
      const subscription = yield* call("POST", "/slopmax/api/accounts", {
        body: { _tag: "Key", provider: "claude", key: "x" },
      })
      expect([subscription.status, String(field(subscription.body, "message"))]).toEqual([
        400,
        "provider: Claude accounts sign in with a browser: `slopmax login claude`, or the app",
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("redeems a limit reset on request, and says why it cannot", () => {
    const credit = oauth("codex", "c", "tok-credit", 1)
    const outOfDate = new Account({ ...oauth("codex", "d", "tok-x", 2), authError: "refresh token revoked" })
    const metered = apiKey("openai", "k", "sk-1", 3)
    const { layer, upstream } = apiStack({ accounts: [credit, outOfDate, metered], routes: chatgptApi })
    return Effect.gen(function* () {
      const redeemed = yield* call("POST", `/slopmax/api/accounts/${credit.id}/redeem`)
      expect(redeemed.status).toBe(200)
      expect(field(redeemed.body, "outcome")).toBe("reset")
      expect(accountIn(field(redeemed.body, "report"), credit.id)).toBeDefined()
      expect(upstream.at("/backend-api/wham/rate-limit-reset-credits/consume")).toHaveLength(1)
      const named = yield* call("POST", `/slopmax/api/accounts/${credit.id}/redeem`, {
        body: { reset: "credit-later" },
      })
      expect(field(named.body, "outcome")).toBe("reset")
      const none = yield* call("POST", `/slopmax/api/accounts/${metered.id}/redeem`)
      expect([none.status, field(none.body, "message")]).toEqual([400, "this account has no limit resets"])
      const signedOut = yield* call("POST", `/slopmax/api/accounts/${outOfDate.id}/redeem`)
      expect([signedOut.status, field(signedOut.body, "message")]).toEqual([409, "the account needs signing in again"])
      expect((yield* call("POST", "/slopmax/api/accounts/codex-nope/redeem")).status).toBe(404)
    }).pipe(Effect.provide(layer))
  })

  it.effect("imports the logins of the tools on this machine", () => {
    const idToken = jwt({
      email: "me@x.dev",
      "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus" },
    })
    const login = JSON.stringify({
      tokens: { access_token: jwt({ exp: 1_900_000_000 }), refresh_token: "rt", id_token: idToken },
    })
    const { layer } = apiStack({ files: { "../.codex/auth.json": login } })
    return Effect.gen(function* () {
      const imported = yield* call("POST", "/slopmax/api/imports", { body: { sources: ["codex"] } })
      expect(imported.status).toBe(200)
      const [outcome] = items(imported.body, "outcomes")
      expect(outcome).toMatchObject({
        _tag: "Saved",
        source: "codex",
        origin: "/home/me/.codex/auth.json",
        isNew: true,
      })
      expect(field(outcome, "account", "email")).toBe("me@x.dev")
      const again = yield* call("POST", "/slopmax/api/imports", { body: { sources: ["codex"], own: true } })
      expect(field(again.body, "outcomes", 0, "isNew")).toBe(false)
      // Nothing to find elsewhere is not a failure.
      const all = yield* call("POST", "/slopmax/api/imports")
      expect(field(all.body, "outcomes")).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("reads usage and lists resets now on refresh, one run for callers that ask together", () => {
    const usage = on("GET /backend-api/wham/usage", () =>
      json(200, {
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 600 } },
      }),
    )
    const { layer, upstream } = apiStack({ accounts: [first, second], routes: [usage, ...chatgptApi] })
    return Effect.gen(function* () {
      const [one, two] = yield* Effect.all(
        [call("POST", "/slopmax/api/refresh"), call("POST", "/slopmax/api/refresh")],
        { concurrency: 2 },
      )
      expect([one.status, two.status]).toEqual([200, 200])
      expect(upstream.at("/backend-api/wham/usage")).toHaveLength(2)
      expect(field(accountIn(one.body, first.id), "windows", 0, "used")).toBe(12)
      expect(field(accountIn(two.body, second.id), "windows", 0, "used")).toBe(12)
      // A refresh after that one has finished reads again.
      yield* call("POST", "/slopmax/api/refresh")
      expect(upstream.at("/backend-api/wham/usage")).toHaveLength(4)
    }).pipe(Effect.provide(layer))
  })

  it.effect("re-reads the accounts on sync", () => {
    const { layer } = apiStack({ accounts: [first] })
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${home}/accounts/${second.id}.json`, accountText(second))
      const synced = yield* call("POST", "/slopmax/api/sync")
      expect(accountIn(synced.body, second.id)).toBeDefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect("asks the daemon to stop on shutdown", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      const shutdown = yield* Shutdown
      const waiting = yield* Effect.forkScoped(shutdown.requested)
      const answer = yield* call("POST", "/slopmax/api/shutdown")
      expect(answer.body).toEqual({ status: "stopping" })
      yield* Fiber.join(waiting)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    "answers the doctor's sections",
    () => {
      const { layer } = apiStack({ accounts: [first] })
      return Effect.gen(function* () {
        const answer = yield* call("GET", "/slopmax/api/doctor")
        expect(answer.status).toBe(200)
        expect(items(answer.body).map((section) => field(section, "title"))).toContain("Accounts")
        expect(typeof field(answer.body, 0, "findings", 0, "level")).toBe("string")
      }).pipe(Effect.provide(layer))
    },
    15_000,
  )

  it.effect("shows the settings, and changes live ones at once after checking the whole change", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      const settings = yield* SettingsService
      const view = yield* call("GET", "/slopmax/api/settings")
      expect(field(view.body, "settings", "strategy")).toBe("fill-first")
      expect(JSON.stringify(view.body)).not.toContain(key)
      expect(items(view.body, "strategies").map((strategy) => field(strategy, "id"))).toEqual([
        "reset-first",
        "fill-first",
        "least-used",
        "round-robin",
      ])
      expect(field(view.body, "restartNeeded")).toEqual([])
      const changed = yield* call("PATCH", "/slopmax/api/settings", {
        body: { strategy: "round-robin", sessionAffinity: false, redeemWhenExhausted: true },
      })
      expect(changed.status).toBe(200)
      expect(field(changed.body, "settings", "strategy")).toBe("round-robin")
      const now = yield* settings.get
      expect([now.strategy, now.sessionAffinity, now.redeemWhenExhausted]).toEqual(["round-robin", false, true])
      for (const bad of [{ strategy: "fastest" }, { sessionAffinity: "maybe" }, { listen: "0.0.0.0:1" }, {}]) {
        expect((yield* call("PATCH", "/slopmax/api/settings", { body: bad })).status).toBe(400)
      }
      expect((yield* settings.get).strategy).toBe("round-robin")
    }).pipe(Effect.provide(layer))
  })

  it.effect("makes client keys shown once and working at once, lists them without the key, and revokes them", () => {
    const { layer } = apiStack({ accounts: [first], routes: chatgptApi })
    return Effect.gen(function* () {
      const made = yield* call("POST", "/slopmax/api/keys", { body: { name: "laptop", models: ["gpt-6-*"] } })
      expect(made.status).toBe(200)
      const secret = String(field(made.body, "key"))
      expect(secret.startsWith("sm-")).toBe(true)
      const listed = yield* call("GET", "/slopmax/api/keys")
      expect(listed.body).toEqual([{ name: "laptop", models: ["gpt-6-*"] }])
      expect(listed.text).not.toContain(secret)
      const proxied = yield* call("POST", "/codex/responses", {
        key: secret,
        body: { model: "gpt-6-sol", input: [], stream: true },
      })
      expect(proxied.status).toBe(200)
      const duplicate = yield* call("POST", "/slopmax/api/keys", { body: { name: "laptop" } })
      expect(duplicate.status).toBe(409)
      const revoked = yield* call("DELETE", "/slopmax/api/keys/laptop")
      expect(revoked.body).toEqual([])
      const gone = yield* call("DELETE", "/slopmax/api/keys/laptop")
      expect([gone.status, field(gone.body, "message")]).toEqual([404, 'no such key "laptop"'])
      // A name with spaces or slashes is revoked by its encoded name.
      expect((yield* call("POST", "/slopmax/api/keys", { body: { name: "work laptop/2" } })).status).toBe(200)
      expect((yield* call("DELETE", `/slopmax/api/keys/${encodeURIComponent("work laptop/2")}`)).status).toBe(200)
    }).pipe(Effect.provide(layer))
  })

  it.effect("sums usage by day, model or account, and charts history with what resets left on the table", () => {
    const { layer } = apiStack({ accounts: [first] })
    return Effect.gen(function* () {
      yield* TestClock.adjust("12 hours")
      const now = yield* DateTime.now
      const ledger = yield* Ledger
      const answer = (attempts: number) =>
        LedgerRecord.cases.Request.make({
          at: DateTime.subtract(now, { minutes: 5 }),
          account: first.id,
          provider: "codex",
          model: "gpt-6-sol",
          status: 200,
          usage: new Usage({ requests: 1, input: 40, output: 7, cacheRead: 60, cacheWrite: 0 }),
          ms: 900,
          attempts,
          via: "http",
        })
      yield* ledger.append([
        answer(2),
        answer(1),
        LedgerRecord.cases.WindowEnded.make({
          at: DateTime.subtract(now, { hours: 1 }),
          account: first.id,
          provider: "codex",
          plan: "pro",
          span: "7d",
          used: 25,
        }),
      ])
      const byAccount = yield* call("GET", "/slopmax/api/usage?range=today&by=account")
      expect(byAccount.status).toBe(200)
      expect(field(byAccount.body, "rows", 0, "key")).toBe("a@example.com")
      expect(field(byAccount.body, "total", "requests")).toBe(2)
      expect(field((yield* call("GET", "/slopmax/api/usage")).body, "range")).toBe("7d")
      expect((yield* call("GET", "/slopmax/api/usage?range=forever")).status).toBe(400)

      const history = yield* call("GET", "/slopmax/api/history?range=7d")
      expect(history.status).toBe(200)
      expect(field(history.body, "total", "requests")).toBe(2)
      expect(field(history.body, "rescued")).toBe(1)
      expect(field(history.body, "accounts", 0, "name")).toBe("a@example.com")
      const cost = Number(field(history.body, "total", "cost"))
      expect(Math.abs(cost - (2 * (40 * 2 + 60 * 0.2 + 7 * 10)) / 1e6)).toBeLessThan(1e-9)
      expect(field(history.body, "left", "windows")).toBe(1)
      expect(field(history.body, "left", "unused")).toBe(75)
      expect(Math.abs(Number(field(history.body, "left", "dollars")) - ((200 * 12) / 52) * 0.75)).toBeLessThan(1e-6)
      expect((yield* call("GET", "/slopmax/api/history?range=all")).status).toBe(400)
    }).pipe(Effect.provide(layer))
  })

  it.effect("streams hello, the report, and each request as it settles, uncached", () => {
    const { layer } = apiStack({ accounts: [first], routes: chatgptApi })
    return Effect.gen(function* () {
      const server = yield* Server
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          server.fetch(
            new Request("http://slopmax.test/slopmax/api/events", { headers: { authorization: `Bearer ${key}` } }),
          ),
        ),
      )
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(response.headers.get("cache-control")).toBe("no-cache")
      const events = eventReader(response)
      // The status publisher sees a watcher arrive and sends the report.
      expect((yield* events.next(2)).map((event) => field(event, "_tag"))).toEqual(["Hello", "Status"])
      yield* call("POST", "/codex/responses", { body: { model: "gpt-6-sol", input: [], stream: true } })
      yield* settled
      // A changed pool may bring a new report first.
      let request = (yield* events.next(1))[0]
      while (field(request, "_tag") === "Status") request = (yield* events.next(1))[0]
      expect(field(request, "_tag")).toBe("Request")
      expect(field(request, "record", "account")).toBe(first.id)
      yield* events.close
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps sending the report while the pool changes faster than a quarter second", () => {
    const { layer } = apiStack({ accounts: [first] })
    return Effect.gen(function* () {
      const events = yield* Events
      const pool = yield* Pool
      const sent = yield* Ref.make(0)
      yield* events.subscribe.pipe(
        Stream.filter((event) => event._tag === "Status"),
        Stream.runForEach(() => Ref.update(sent, (n) => n + 1)),
        Effect.forkScoped,
      )
      yield* TestClock.adjust("0 millis")
      const before = yield* Ref.get(sent)
      // A busy proxy: the pool changes every 100 ms for two seconds, never pausing.
      for (let step = 1; step <= 20; step++) {
        const now = yield* DateTime.now
        yield* pool.update((m) =>
          observe(
            m,
            first.id,
            new Limits({ windows: [Window.of("5h", step, DateTime.add(now, { hours: 4 }))], observedAt: now }),
            now,
          ),
        )
        yield* TestClock.adjust("100 millis")
      }
      // At most one report a quarter second, and still one every quarter second or so.
      const during = (yield* Ref.get(sent)) - before
      expect(during).toBeGreaterThanOrEqual(6)
      expect(during).toBeLessThanOrEqual(9)
    }).pipe(Effect.provide(layer))
  })

  it.effect("ends the event stream when the daemon stops, so the stop need not wait for it", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      const scope = yield* Scope.make()
      const context = yield* Layer.buildWithScope(layer, scope)
      const server = Context.get(context, Server)
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          server.fetch(
            new Request("http://slopmax.test/slopmax/api/events", { headers: { authorization: `Bearer ${key}` } }),
          ),
        ),
      )
      const reader = response.body?.getReader()
      expect(reader).toBeDefined()
      yield* Effect.promise(async () => reader?.read())
      yield* Scope.close(scope, Exit.void)
      // Whatever was sent before the stop is read, then the stream is done.
      const ended = yield* Effect.promise(async () => {
        for (;;) {
          const chunk = await reader?.read()
          if (chunk === undefined || chunk.done) return true
        }
      })
      expect(ended).toBe(true)
    })
  })

  it.effect("sends a test notification, or says notifications are off", () => {
    const hooks: Array<unknown> = []
    const hook = on("POST https://hooks.example/slopmax", async (seen) => {
      hooks.push(JSON.parse(seen.text))
      return json(200, {})
    })
    const off = apiStack()
    const withHook = apiStack({ routes: [hook], settings: { notify: { webhook: "https://hooks.example/slopmax" } } })
    return Effect.gen(function* () {
      const refused = yield* call("POST", "/slopmax/api/notify/test").pipe(Effect.provide(off.layer))
      expect([refused.status, field(refused.body, "message")]).toEqual([
        400,
        "notifications are off: set notify.webhook or notify.command in config.json",
      ])
      const sent = yield* call("POST", "/slopmax/api/notify/test").pipe(Effect.provide(withHook.layer))
      expect(sent.status).toBe(204)
      expect(hooks).toHaveLength(1)
    })
  })

  it.effect("lists the agents, wires one to the proxy, and undoes it", () => {
    const { layer } = apiStack()
    return Effect.gen(function* () {
      const listed = yield* call("GET", "/slopmax/api/agents")
      expect(items(listed.body).map((agent) => field(agent, "id"))).toEqual(["claude-code", "codex"])
      const connected = yield* call("POST", "/slopmax/api/agents/codex/connect")
      expect(connected.status).toBe(200)
      const path = String(field(connected.body, "path"))
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(path)).toContain("slopmax")
      const wired = yield* call("GET", "/slopmax/api/agents")
      expect(
        field(
          items(wired.body).find((agent) => field(agent, "id") === "codex"),
          "wired",
        ),
      ).toBe(true)
      expect((yield* call("POST", "/slopmax/api/agents/codex/disconnect")).body).toEqual({ path })
      const again = yield* call("POST", "/slopmax/api/agents/codex/disconnect")
      expect([again.status, field(again.body, "message")]).toEqual([409, "no Codex setup to undo"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("runs a sign-in, telling its progress on the event feed, and stops one on request", () => {
    let polls = 0
    const auth: ReadonlyArray<Route> = [
      on("POST https://auth.openai.com/api/accounts/deviceauth/usercode", () =>
        json(200, { device_auth_id: "dev-1", usercode: "ABCD-1234", interval: "1" }),
      ),
      on("POST https://auth.openai.com/api/accounts/deviceauth/token", () => {
        polls += 1
        return polls < 2 ? json(403, {}) : json(200, { authorization_code: "dev-code", code_verifier: "dev-verifier" })
      }),
      on("POST https://auth.openai.com/oauth/token", () =>
        json(200, {
          access_token: jwt({ exp: 1_900_000_000 }),
          refresh_token: "rt",
          id_token: jwt({ email: "me@x.dev", "https://api.openai.com/auth": { chatgpt_account_id: "ws-1" } }),
        }),
      ),
    ]
    const { layer } = apiStack({ routes: auth })
    return Effect.gen(function* () {
      const events = yield* Events
      const logins = yield* events.subscribe.pipe(
        Stream.filter((event) => event._tag === "Login"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* TestClock.adjust("0 millis")
      const started = yield* call("POST", "/slopmax/api/logins", { body: { provider: "codex", device: true } })
      expect(started.status).toBe(200)
      const id = String(field(started.body, "id"))
      for (let step = 0; step < 20 && logins.pollUnsafe() === undefined; step++) {
        yield* Effect.promise(() => Bun.sleep(1))
        yield* TestClock.adjust("1 second")
      }
      const told = Array.from(yield* Fiber.join(logins))
      expect(told.map((event): Array<string> => (event._tag === "Login" ? [event.id, event.event._tag] : []))).toEqual([
        [id, "DeviceCode"],
        [id, "Done"],
      ])
      const done = told[1]
      expect(done?._tag === "Login" && done.event._tag === "Done" && done.event.account.email).toBe("me@x.dev")
      expect((yield* call("POST", `/slopmax/api/logins/${id}/paste`, { body: { address: "x" } })).status).toBe(404)
      expect((yield* call("DELETE", `/slopmax/api/logins/${id}`)).status).toBe(404)

      // One waiting on its code stops when cancelled.
      polls = -1000
      const waiting = yield* call("POST", "/slopmax/api/logins", { body: { provider: "codex", device: true } })
      const pending = String(field(waiting.body, "id"))
      yield* TestClock.adjust("1 second")
      expect((yield* call("POST", `/slopmax/api/logins/${pending}/paste`, { body: { address: "x" } })).status).toBe(204)
      expect((yield* call("DELETE", `/slopmax/api/logins/${pending}`)).status).toBe(204)
      expect((yield* call("DELETE", `/slopmax/api/logins/${pending}`)).status).toBe(404)
    }).pipe(Effect.provide(layer))
  })

  it.effect("gives the typed client every front end uses typed answers and errors", () => {
    const { layer } = apiStack({ accounts: [first] })
    return Effect.gen(function* () {
      const api = yield* client
      const report = yield* api.system.status()
      expect(report.accounts.map((account) => account.id)).toEqual([first.id])
      const missing = yield* Effect.flip(
        api.accounts.update({
          params: { id: AccountId.make("codex-nope") },
          payload: new AccountPatch({ disabled: true }),
        }),
      )
      expect(missing).toBeInstanceOf(NotFound)
      const watched = yield* api.events
        .watch()
        .pipe(Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)))
      expect(Array.from(watched).map((event) => event._tag)).toEqual(["Hello"])
      expect(Schema.is(Event)(Array.from(watched)[0])).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports the same pool the proxy places requests with", () => {
    const { layer } = apiStack({ accounts: [first], routes: chatgptApi })
    return Effect.gen(function* () {
      const proxied = yield* call("POST", "/codex/responses", { body: { model: "gpt-6-sol", input: [], stream: true } })
      expect(proxied.status).toBe(200)
      yield* settled
      const report = yield* call("GET", "/slopmax/api/status")
      expect(Number(field(accountIn(report.body, first.id), "served", "requests"))).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})
