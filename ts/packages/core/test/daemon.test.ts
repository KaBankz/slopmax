// The daemon has no Rust tests of its own: `tests/proxy.rs` drives its
// tasks (`poll_all`, `list_credits`, `redeem_expiring`) directly. These
// check what the parity contract says of the loop around them.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { type Duration, Effect } from "effect"
import { TestClock } from "effect/testing"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Origins } from "@slopmax/net"

import { Account, Store } from "../src/account.ts"
import { Config } from "../src/config.ts"
import * as daemon from "../src/daemon.ts"
import { Home } from "../src/paths.ts"
import { State } from "../src/pool.ts"
import { App } from "../src/proxy/mod.ts"
import { json, Mock, noEnv, scopedTempDir, Seen } from "../src/testkit.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"

const quiet = (): Config => ({
  ...Config.default(),
  apiKey: "sm-test-key",
  pollMins: 0,
  refreshTokens: false,
  redeemExpiringCredits: false,
})

// Real time passing, for the disk work a task does once the test clock woke it.
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))

/** Moves the test clock on by `step`, then waits (in real time) until `check` holds. */
const until = (step: Duration.Input, check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(step)
    for (let i = 0; i < 100; i++) {
      if (yield* check) return
      yield* settle
    }
    return yield* Effect.die(new Error("condition not met"))
  })

const endpoint = (url: string): Account =>
  Account.assignId({
    ...Account.make("compat", { accessToken: "" }, 0),
    endpoint: { baseUrl: url, dialect: "chat", models: ["m"] },
  })

describe("daemon, beyond the Rust tests", () => {
  it.effect("accounts and config.toml are picked up every 2 s, without a restart", () =>
    Effect.gen(function* () {
      const dir = yield* scopedTempDir("daemon")
      const app = yield* App.make(quiet(), Home.at(dir), State.empty(), new Origins()).pipe(Effect.provide(noEnv))
      yield* daemon.start(app)
      // Each task runs at once.
      yield* until(
        "0 millis",
        Effect.map(app.pool.accounts, (a) => a.length === 0),
      )

      yield* Store.at(join(dir, "accounts")).save(endpoint("http://127.0.0.1:9/v1"))
      writeFileSync(join(dir, "config.toml"), `api_key = "sm-test-key"\nstrategy = "least-used"\n`)
      yield* settle
      // Not before the next run.
      expect((yield* app.config).strategy).toBe("reset-first")
      yield* until(
        "2 seconds",
        Effect.map(app.config, (c) => c.strategy === "least-used"),
      )
      yield* until(
        "0 millis",
        Effect.map(app.pool.accounts, (a) => a.length === 1),
      )
    }),
  )

  it.effect("state.json is written every 10 s, only when the pool changed", () =>
    Effect.gen(function* () {
      const dir = yield* scopedTempDir("daemon")
      const app = yield* App.make(quiet(), Home.at(dir), State.empty(), new Origins()).pipe(Effect.provide(noEnv))
      const file = join(dir, "state.json")
      yield* daemon.start(app)
      yield* TestClock.adjust("10 seconds")
      yield* settle
      expect(existsSync(file)).toBe(false)
      const now = yield* Timestamp.now
      yield* app.pool.block("compat-1", Timestamp.add(now, SignedDuration.fromMins(5)), undefined, "test")
      yield* until(
        "10 seconds",
        Effect.sync(() => existsSync(file)),
      )
    }),
  )

  it.live("a port that is taken says so, naming who holds it when the system says", () =>
    Effect.gen(function* () {
      const holder = createServer()
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            holder.listen(0, "127.0.0.1", () => {
              const address = holder.address()
              resolve(typeof address === "object" && address !== null ? address.port : 0)
            })
          }),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => holder.close()))
      const dir = yield* scopedTempDir("daemon")
      const config: Config = { ...quiet(), listen: { ip: "127.0.0.1", port } }
      const failure = yield* Effect.flip(daemon.serve(config, Home.at(dir), new Origins()))
      expect(failure.message).toMatch(
        new RegExp(`^cannot listen on 127\\.0\\.0\\.1:${port}(: .+ is using that port)?$`),
      )
    }),
  )

  it.live("usage is polled when due: never read, then not again until the interval, unless forced", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start(() =>
        json(200, {
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      )
      const dir = yield* scopedTempDir("daemon")
      const store = Store.at(join(dir, "accounts"))
      const account = Account.assignId({
        ...Account.make("codex", { accessToken: "tok-ok" }, 0),
        accountId: "acct-a",
        email: "a@example.com",
      })
      yield* store.save(account)
      const origins = new Origins([["https://chatgpt.com/backend-api", mock.url]])
      const app = yield* App.make({ ...quiet(), pollMins: 5 }, Home.at(dir), State.empty(), origins).pipe(
        Effect.provide(noEnv),
      )
      yield* app.sync
      yield* daemon.pollAll(app, false)
      expect(mock.seenAt("/wham/usage").length).toBe(1)
      expect((yield* app.pool.state(account.id)).limits.windows[0]?.used).toBe(5)
      // The plan the usage reported is saved to the account's file.
      expect((yield* store.get(account.id))?.plan).toBe("pro")
      yield* daemon.pollAll(app, false)
      expect(mock.seenAt("/wham/usage").length).toBe(1)
      yield* daemon.pollAll(app, true)
      expect(mock.seenAt("/wham/usage").length).toBe(2)
    }),
  )

  it.effect("tokens due are refreshed at once and every 300 s, disabled accounts too, signed-out ones not", () =>
    Effect.gen(function* () {
      let issued = 0
      const mock = yield* Mock.start((seen) => {
        if (Seen.route(seen) === "/v1/oauth/token") {
          if (Seen.text(seen).includes("refresh-revoked")) {
            return json(400, { error: "invalid_grant", error_description: "refresh token revoked" })
          }
          issued++
          return json(200, { access_token: `tok-${issued}`, refresh_token: "refresh-good", expires_in: 60 })
        }
        return json(Seen.route(seen) === "/api/oauth/profile" ? 200 : 404, {})
      })
      const dir = yield* scopedTempDir("daemon")
      const store = Store.at(join(dir, "accounts"))
      const now = yield* Timestamp.now
      const claude = (name: string, refresh: string, fields: Partial<Account>): Account =>
        Account.assignId({
          ...Account.make(
            "claude",
            {
              accessToken: `tok-${name}`,
              refreshToken: refresh,
              expiresAt: Timestamp.add(now, SignedDuration.fromMins(1)),
            },
            now,
          ),
          email: `${name}@example.com`,
          accountId: `acct-${name}`,
          ...fields,
        })
      const off = claude("a", "refresh-good", { disabled: true })
      const revoked = claude("b", "refresh-revoked", {})
      const signedOut = claude("c", "refresh-signed-out", { authError: "sign in again" })
      for (const account of [off, revoked, signedOut]) yield* store.save(account)
      const origins = new Origins([
        ["https://platform.claude.com", mock.url],
        ["https://api.anthropic.com", mock.url],
      ])
      const app = yield* App.make({ ...quiet(), refreshTokens: true }, Home.at(dir), State.empty(), origins).pipe(
        Effect.provide(noEnv),
      )
      yield* app.sync
      yield* daemon.start(app)
      yield* until(
        "0 millis",
        Effect.gen(function* () {
          const saved = yield* Effect.orDie(store.get(off.id))
          return saved?.tokens.accessToken === "tok-1" && (yield* app.pool.state(revoked.id)).lastError !== undefined
        }),
      )
      expect(issued).toBe(1)
      expect(mock.seen().some((s) => Seen.text(s).includes("refresh-signed-out"))).toBe(false)
      // Due again a minute later, but not refreshed before the next run.
      yield* TestClock.adjust("290 seconds")
      yield* settle
      expect(issued).toBe(1)
      yield* until(
        "10 seconds",
        Effect.map(Effect.orDie(store.get(off.id)), (saved) => saved?.tokens.accessToken === "tok-2"),
      )
    }),
  )

  it.effect("new nudges are told once and kept in nudged.json beside those told before", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start(() => json(404, {}))
      const dir = yield* scopedTempDir("daemon")
      const file = join(dir, "nudged.json")
      writeFileSync(file, JSON.stringify(["reset:gone:told-before"]))
      const store = Store.at(join(dir, "accounts"))
      const account = Account.assignId({
        ...Account.make("codex", { accessToken: "tok-ok" }, 0),
        accountId: "acct-a",
        email: "a@example.com",
      })
      yield* store.save(account)
      const origins = new Origins([
        ["https://chatgpt.com", mock.url],
        ["https://auth.openai.com", mock.url],
      ])
      const app = yield* App.make(quiet(), Home.at(dir), State.empty(), origins).pipe(Effect.provide(noEnv))
      yield* app.sync
      const now = yield* Timestamp.now
      // A reset that lapses within the day, with redeeming off.
      yield* app.pool.recordCredits(
        account.id,
        [{ id: "credit-1", expiresAt: Timestamp.add(now, SignedDuration.fromHours(2)) }],
        now,
      )
      yield* daemon.start(app)
      const told = (): unknown => JSON.parse(readFileSync(file, "utf8"))
      const expected = [`reset:${account.id}:credit-1`, "reset:gone:told-before"].toSorted()
      yield* until(
        "0 millis",
        Effect.sync(() => JSON.stringify(told()) === JSON.stringify(expected)),
      )
      expect(told()).toEqual(expected)
      expect(mock.seen()).toEqual([])
    }),
  )
})
