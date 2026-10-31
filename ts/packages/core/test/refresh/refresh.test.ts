import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Fiber, FileSystem, type Layer, Logger, Option, Redacted, type Scope } from "effect"
import { type Account, accountText, Identity, Link } from "../../src/account.ts"
import { Accounts } from "../../src/accounts.ts"
import type { Upstream } from "../../src/upstream.ts"
import { clientId } from "../../src/providers/claude.ts"
import { applyGrant, pollUsage } from "../../src/refresh.ts"
import {
  at,
  downUpstream,
  home,
  json,
  jsonOf,
  keyAccount,
  mockUpstream,
  oauthAccount,
  reply,
  type Seen,
  stored,
  storeLayer,
} from "../providers/support.ts"

const accountsDir = `${home}/accounts`
const fileOf = (account: Account) => `${accountsDir}/${account.id}.json`
const seed = (...accounts: ReadonlyArray<Account>) => ({
  files: Object.fromEntries(accounts.map((account) => [fileOf(account), accountText(account)])),
  directories: ["/home/me/.cli-proxy-api"],
})

/** A Claude sign-in expiring `expiresIn` seconds from the test clock's start. */
const claudeAccount = (
  access: string,
  refresh: string | undefined,
  expiresIn: number,
  more: { readonly id?: string } = {},
) =>
  oauthAccount({
    access,
    ...(refresh === undefined ? {} : { refresh }),
    expiresAt: at(expiresIn),
    identity: new Identity({ orgId: "org-1" }),
    ...more,
  })

const tokenOf = (account: Account | undefined) => account?.secret
const refreshOf = (account: Account | undefined) => {
  const refresh = account === undefined ? undefined : Option.getOrUndefined(account.tokens)?.refresh
  return refresh === undefined ? undefined : Redacted.value(refresh)
}

/** Anthropic's token endpoint answering `status` with `token`, and a Max 5x profile. */
const anthropic = (status: number, token: unknown) =>
  mockUpstream((seen) => {
    if (seen.url.pathname === "/v1/oauth/token") return json(status, token)
    if (seen.url.pathname === "/api/oauth/profile") {
      return json(200, {
        account: { uuid: "acct-1", email: "me@x.dev" },
        organization: { uuid: "org-1", organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" },
      })
    }
    return reply(404)
  })

const ready = (account: Account, options?: { readonly force?: boolean }) =>
  Effect.flatMap(Accounts, (accounts) => accounts.ready(account, options))

const run = <A, E>(
  effect: Effect.Effect<A, E, Accounts | FileSystem.FileSystem | Upstream | Scope.Scope>,
  upstream: Layer.Layer<Upstream>,
  accounts: ReadonlyArray<Account> = [],
  settings: Parameters<typeof storeLayer>[1] = {},
) => Effect.provide(effect, storeLayer(upstream, settings, seed(...accounts)))

/** Log lines, collected. */
const collectLogs = () => {
  const lines: Array<string> = []
  const layer = Logger.layer([Logger.make(({ message }) => void lines.push(String(message)))])
  return { lines, layer }
}

const cliProxyApi = `/home/me/.cli-proxy-api`
const sourceFile = `${cliProxyApi}/claude-x.json`
const writeSource = (token: string, expired: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(
      sourceFile,
      JSON.stringify({ type: "claude", access_token: token, refresh_token: "rt", expired }),
    ),
  )
const linked = (access: string, expiresIn: number, id?: string) =>
  oauthAccount({
    ...(id === undefined ? {} : { id }),
    access,
    refresh: "rt",
    expiresAt: at(expiresIn),
    identity: new Identity({ orgId: "org" }),
    follows: new Link({ tool: "cliproxyapi", path: sourceFile }),
  })

/** Waits, in real time, until the upstream has seen a call to `path`. */
const seenAt = (calls: ReadonlyArray<Seen>, path: string) =>
  Effect.promise(async () => {
    for (let tries = 0; tries < 500 && !calls.some((call) => call.url.pathname === path); tries++) await Bun.sleep(2)
  })

describe("refreshing sign-ins", () => {
  it.effect("uses a token that is not due without calling anyone", () => {
    const api = anthropic(200, {})
    return run(
      Effect.gen(function* () {
        const got = yield* ready(claudeAccount("live", "rt", 2 * 3600))
        expect(tokenOf(got)).toBe("live")
        expect(api.seen).toHaveLength(0)
      }),
      api.layer,
    )
  })

  it("clears an earlier failure and keeps tokens the provider did not rotate when a grant arrives", () => {
    const before = oauthAccount({ access: "old", refresh: "rt1", idToken: "id", authError: "earlier failure" })
    const after = applyGrant(before, { access: "new" }, at(5))
    expect(after.authError).toBeUndefined()
    expect(tokenOf(after)).toBe("new")
    expect(refreshOf(after)).toBe("rt1")
    expect(Option.getOrThrow(after.tokens).refreshedAt).toEqual(at(5))
    expect(Option.getOrThrow(after.tokens).expiresAt).toBeUndefined()
  })

  it.effect("refreshes a due token, reads who it is, and saves it before handing it out", () => {
    const api = anthropic(200, { access_token: "new", refresh_token: "rt2", expires_in: 28_800 })
    const due = claudeAccount("old", "rt1", 600)
    return run(
      Effect.gen(function* () {
        const got = yield* ready(due)
        expect(tokenOf(got)).toBe("new")
        expect(refreshOf(got)).toBe("rt2")
        const tokens = Option.getOrThrow(got.tokens)
        expect(tokens.expiresAt).toEqual(at(28_800))
        expect(tokens.refreshedAt).toEqual(at(0))
        expect(got.authError).toBeUndefined()
        expect(got.identity.email).toBe("me@x.dev")
        expect(got.identity.plan).toBe("max 5x")
        // Saved before it is handed out: the old refresh token is spent.
        const saved = yield* stored(due.id)
        expect(tokenOf(saved)).toBe("new")
        expect(refreshOf(saved)).toBe("rt2")
        expect(saved?.identity.plan).toBe("max 5x")
        const sent = api.at("/v1/oauth/token")
        expect(sent).toHaveLength(1)
        expect(jsonOf(sent[0])).toMatchObject({
          grant_type: "refresh_token",
          refresh_token: "rt1",
          client_id: clientId,
        })
        const profile = api.at("/api/oauth/profile")[0]
        expect(profile?.headers.get("authorization")).toBe("Bearer new")
        expect(profile?.headers.get("anthropic-beta")).toBe("oauth-2025-04-20")
      }),
      api.layer,
      [due],
    )
  })

  it.effect("keeps tokens the provider did not rotate on a forced refresh, and saves an account not stored yet", () => {
    // No new refresh token, no expiry, and the profile lookup fails.
    const api = mockUpstream((seen) =>
      seen.url.pathname === "/v1/oauth/token" ? json(200, { access_token: "new" }) : reply(500, "down"),
    )
    const account = oauthAccount({
      access: "old",
      refresh: "rt1",
      idToken: "id",
      expiresAt: at(6 * 3600),
      identity: new Identity({ orgId: "org-1", email: "kept@x.dev" }),
    })
    return run(
      Effect.gen(function* () {
        const got = yield* ready(account, { force: true })
        expect(tokenOf(got)).toBe("new")
        expect(refreshOf(got)).toBe("rt1")
        const tokens = Option.getOrThrow(got.tokens)
        expect(tokens.idToken === undefined ? undefined : Redacted.value(tokens.idToken)).toBe("id")
        expect(tokens.expiresAt).toBeUndefined()
        expect(got.identity.email).toBe("kept@x.dev")
        expect(tokenOf(yield* stored(account.id))).toBe("new")
      }),
      api.layer,
    )
  })

  it.effect("reuses a token another process already rotated", () => {
    const api = anthropic(200, { access_token: "unwanted" })
    const stale = claudeAccount("old", "rt1", -60)
    const theirs = claudeAccount("theirs", "rt2", 8 * 3600)
    return run(
      Effect.gen(function* () {
        const accounts = yield* Accounts
        // Another process rotated it after this one cached the stale copy.
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(fileOf(theirs), accountText(theirs)))
        const got = yield* accounts.ready(stale)
        expect(tokenOf(got)).toBe("theirs")
        expect(api.seen).toHaveLength(0)
      }),
      api.layer,
      [stale],
    )
  })

  it.effect("does not refresh a stored copy that is no longer due", () => {
    const api = anthropic(200, { access_token: "unwanted" })
    const stale = claudeAccount("same", "rt1", 60)
    const extended = claudeAccount("same", "rt1", 8 * 3600)
    return run(
      Effect.gen(function* () {
        yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.writeFileString(fileOf(extended), accountText(extended)),
        )
        const got = yield* ready(stale)
        expect(Option.getOrThrow(got.tokens).expiresAt).toEqual(at(8 * 3600))
        expect(api.seen).toHaveLength(0)
      }),
      api.layer,
      [stale],
    )
  })

  it.effect("marks an account whose refresh token was rejected, keeping its tokens", () => {
    const api = anthropic(400, { error: "invalid_grant" })
    const account = claudeAccount("old", "rt1", 60)
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(ready(account))
        expect(error._tag).toBe("RefreshRevoked")
        expect(error.message.endsWith("; sign in again")).toBe(true)
        const saved = yield* stored(account.id)
        expect(saved?.authError).toContain("400")
        expect(tokenOf(saved)).toBe("old")
        // A marked account is not tried again until it is signed in again.
        expect((yield* Effect.flip(ready(account))).message).toBe(`${saved?.authError}; sign in again`)
        expect(api.at("/v1/oauth/token")).toHaveLength(1)
      }),
      api.layer,
      [account],
    )
  })

  it.effect("leaves the account alone on a passing failure, and fails when its token has expired", () => {
    const api = mockUpstream((seen) =>
      seen.url.pathname === "/v1/oauth/token" ? reply(503, "overloaded") : reply(404),
    )
    const expired = claudeAccount("old", "rt1", -60)
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(ready(expired))
        expect(error._tag).toBe("RefreshTransient")
        expect(error.message).toContain("503")
        expect((yield* stored(expired.id))?.authError).toBeUndefined()
      }),
      api.layer,
      [expired],
    )
  })

  it.effect("hands back a token that still works when its refresh fails in passing, with a warning", () => {
    const api = mockUpstream(() => reply(200, "<html>"))
    const logs = collectLogs()
    const soon = claudeAccount("old", "rt1", 60)
    return run(
      Effect.gen(function* () {
        expect(tokenOf(yield* ready(soon))).toBe("old")
        expect(logs.lines.some((line) => line.startsWith(`${soon.id}: refresh failed, using current token:`))).toBe(
          true,
        )
        // Forced, the failure is the caller's to see.
        expect((yield* Effect.flip(ready(soon, { force: true })))._tag).toBe("RefreshTransient")
      }),
      api.layer,
      [soon],
    ).pipe(Effect.provide(logs.layer))
  })

  it.effect("treats an unreachable token endpoint as a passing failure", () =>
    run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(ready(claudeAccount("old", "rt1", -60)))
        expect(error._tag).toBe("RefreshTransient")
      }),
      downUpstream,
    ),
  )

  it.effect("asks to sign in again when no refresh token is stored, without calling anyone", () => {
    const api = anthropic(200, {})
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(ready(claudeAccount("old", undefined, 60)))
        expect(error._tag).toBe("RefreshRevoked")
        expect(error._tag === "RefreshRevoked" ? error.reason : "").toBe("no refresh token stored")
        expect(api.seen).toHaveLength(0)
      }),
      api.layer,
    )
  })

  it.effect("cannot refresh an API key", () =>
    run(
      Effect.gen(function* () {
        expect(tokenOf(yield* ready(keyAccount("openai", "sk")))).toBe("sk")
        const error = yield* Effect.flip(ready(keyAccount("openai", "sk"), { force: true }))
        expect(error.message).toBe("OpenAI API keys cannot be refreshed; sign in again")
      }),
      downUpstream,
    ),
  )

  it.effect("leaves a due token as it is while refreshing is turned off, and says so when forced", () => {
    const api = anthropic(200, { access_token: "new" })
    return run(
      Effect.gen(function* () {
        expect(tokenOf(yield* ready(claudeAccount("old", "rt", 60)))).toBe("old")
        const error = yield* Effect.flip(ready(claudeAccount("old", "rt", 60), { force: true }))
        expect(error.message).toContain("refreshing is turned off")
        expect(api.seen).toHaveLength(0)
      }),
      api.layer,
      [],
      { refreshTokens: false },
    )
  })

  it.effect("limits forced refreshes of one account to three a minute", () => {
    let issued = 0
    const api = mockUpstream((seen) =>
      seen.url.pathname === "/v1/oauth/token" ? json(200, { access_token: `new-${++issued}` }) : reply(500),
    )
    const account = claudeAccount("old", "rt", 8 * 3600)
    return run(
      Effect.gen(function* () {
        let current = account
        for (let attempt = 0; attempt < 3; attempt++) current = yield* ready(current, { force: true })
        expect(tokenOf(current)).toBe("new-3")
        const error = yield* Effect.flip(ready(current, { force: true }))
        expect(error.message).toBe("refreshed too often; waiting before the next try")
        expect(api.at("/v1/oauth/token")).toHaveLength(3)
      }),
      api.layer,
      [account],
    )
  })

  it.live("refreshes once for every caller that finds the token due at the same time", () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const api = mockUpstream(async (seen) => {
      if (seen.url.pathname !== "/v1/oauth/token") return reply(500)
      await gate
      return json(200, { access_token: "new", refresh_token: "rt2", expires_in: 28_800 })
    })
    const due = claudeAccount("old", "rt1", 60)
    return run(
      Effect.gen(function* () {
        const first = yield* Effect.forkScoped(ready(due))
        yield* seenAt(api.seen, "/v1/oauth/token")
        // The first caller hangs up mid-refresh; the others arrive while it is still in flight.
        const second = yield* Effect.forkScoped(ready(due))
        const third = yield* Effect.forkScoped(ready(due))
        yield* Effect.sleep("30 millis")
        yield* Fiber.interrupt(first)
        expect(second.pollUnsafe()).toBeUndefined()
        expect(third.pollUnsafe()).toBeUndefined()
        release()
        const results = yield* Effect.all([Fiber.await(second), Fiber.await(third)])
        expect(results.map((exit) => (exit._tag === "Success" ? tokenOf(exit.value) : exit._tag))).toEqual([
          "new",
          "new",
        ])
        expect(api.at("/v1/oauth/token")).toHaveLength(1)
      }),
      api.layer,
      [due],
    )
  })

  it.live("finishes and saves a refresh whose caller hung up after the token was sent", () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const api = mockUpstream(async (seen) => {
      if (seen.url.pathname !== "/v1/oauth/token") return reply(500)
      await gate
      return json(200, { access_token: "new", refresh_token: "rt2" })
    })
    const due = claudeAccount("old", "rt1", 60)
    return run(
      Effect.gen(function* () {
        const caller = yield* Effect.forkScoped(ready(due))
        yield* seenAt(api.seen, "/v1/oauth/token")
        yield* Fiber.interrupt(caller)
        release()
        for (let tries = 0; tries < 200 && tokenOf(yield* stored(due.id)) !== "new"; tries++) {
          yield* Effect.promise(() => Bun.sleep(2))
        }
        const saved = yield* stored(due.id)
        expect(tokenOf(saved)).toBe("new")
        expect(refreshOf(saved)).toBe("rt2")
      }),
      api.layer,
      [due],
    )
  })
})

describe("following another tool's login", () => {
  it.effect("adopts the tokens the source rotated, and waits while it has not", () =>
    run(
      Effect.gen(function* () {
        const account = linked("old", -60)
        yield* writeSource("old", "1969-12-31T00:00:00Z")
        // Not rotated yet: slopmax waits for the source rather than refreshing.
        const waiting = yield* Effect.flip(ready(account))
        expect(waiting._tag).toBe("RefreshTransient")
        yield* writeSource("new", "2099-01-01T00:00:00Z")
        const fresh = yield* ready(account)
        expect(tokenOf(fresh)).toBe("new")
        const saved = yield* stored(account.id)
        expect(tokenOf(saved)).toBe("new")
        expect(saved?.credential._tag === "OAuth" ? saved.credential.follows?.path : undefined).toBe(sourceFile)
      }),
      downUpstream,
      [linked("old", -60)],
    ),
  )

  it.effect("waits for the source when forced, and serves the copy in hand while its token works", () =>
    run(
      Effect.gen(function* () {
        yield* writeSource("same", "2099-01-01T00:00:00Z")
        const error = yield* Effect.flip(ready(linked("same", 4 * 3600), { force: true }))
        expect(error.message).toContain("cliproxyapi has not refreshed this login yet")
        // Due but not expired, for an account removed meanwhile.
        expect(tokenOf(yield* ready(linked("older", 30 * 60, "claude-00000009")))).toBe("older")
      }),
      downUpstream,
      [linked("same", 4 * 3600)],
    ),
  )

  it.effect("follows even while refreshing is turned off, since following only reads", () =>
    run(
      Effect.gen(function* () {
        yield* writeSource("new", "2099-01-01T00:00:00Z")
        expect(tokenOf(yield* ready(linked("old", -60)))).toBe("new")
      }),
      downUpstream,
      [linked("old", -60)],
      { refreshTokens: false },
    ),
  )
})

describe("refreshing every due sign-in", () => {
  it.effect("reports each one tried, skipping keys, signed-out accounts and tokens not due", () => {
    const api = mockUpstream((seen) => {
      if (seen.url.pathname !== "/v1/oauth/token") return reply(404)
      return jsonOf(seen) !== null && JSON.stringify(jsonOf(seen)).includes("rt-good")
        ? json(200, { access_token: "new" })
        : reply(503, "down")
    })
    const good = claudeAccount("a", "rt-good", 60, { id: "claude-00000001" })
    const failing = claudeAccount("b", "rt-bad", -60, { id: "claude-00000002" })
    const fresh = claudeAccount("c", "rt", 8 * 3600, { id: "claude-00000003" })
    const signedOut = oauthAccount({
      id: "claude-00000004",
      access: "d",
      refresh: "rt",
      expiresAt: at(60),
      authError: "gone",
    })
    return run(
      Effect.gen(function* () {
        const accounts = yield* Accounts
        const tried = yield* accounts.refreshDue
        expect(tried.map((entry) => entry.id)).toEqual([
          AccountId.make("claude-00000001"),
          AccountId.make("claude-00000002"),
        ])
        expect(tried[0]?.error).toBeUndefined()
        expect(tried[1]?.error).toContain("503")
        expect(api.at("/v1/oauth/token")).toHaveLength(2)
      }),
      api.layer,
      [good, failing, fresh, signedOut, keyAccount("openai", "sk")],
    )
  })

  it.effect("does nothing while refreshing is turned off", () =>
    run(
      Effect.gen(function* () {
        expect(yield* Effect.flatMap(Accounts, (accounts) => accounts.refreshDue)).toEqual([])
      }),
      downUpstream,
      [claudeAccount("a", "rt", 60)],
      { refreshTokens: false },
    ),
  )
})

/** Usage answers the token `accepted` (500 for `down`), and the token endpoint answers `refresh` with `fresh`. */
const usageApi = (accepted: string, refresh: number) =>
  mockUpstream((seen) => {
    if (seen.url.pathname === "/api/oauth/usage") {
      const auth = seen.headers.get("authorization")
      if (auth === `Bearer ${accepted}`) return json(200, { five_hour: { utilization: 30 } })
      return auth === "Bearer down" ? reply(500, "broken") : reply(401)
    }
    if (seen.url.pathname === "/v1/oauth/token") {
      return refresh === 200
        ? json(200, { access_token: "fresh", expires_in: 28_800 })
        : json(refresh, { error: "invalid_grant" })
    }
    return reply(404)
  })
const poll = (account: Account, refresh = true) =>
  Effect.flatMap(Accounts, (accounts) => pollUsage(accounts.ready, account, { refresh }))
const refreshes = (api: ReturnType<typeof usageApi>) => api.at("/v1/oauth/token").length

describe("polling one account's usage", () => {
  it.effect("reads usage with a working token", () => {
    const api = usageApi("live", 200)
    return run(
      Effect.gen(function* () {
        const { account, limits } = yield* poll(claudeAccount("live", "rt", 7200))
        expect(tokenOf(account)).toBe("live")
        expect(limits.windows[0]?.used).toBe(30)
        expect(refreshes(api)).toBe(0)
      }),
      api.layer,
    )
  })

  it.effect("refreshes a due token before reading", () => {
    const api = usageApi("fresh", 200)
    const due = claudeAccount("old", "rt", 60)
    return run(
      Effect.gen(function* () {
        const { account } = yield* poll(due)
        expect(tokenOf(account)).toBe("fresh")
        expect(refreshes(api)).toBe(1)
        expect(tokenOf(yield* stored(due.id))).toBe("fresh")
      }),
      api.layer,
      [due],
    )
  })

  it.effect("refreshes a rejected token once and reads again", () => {
    const api = usageApi("fresh", 200)
    return run(
      Effect.gen(function* () {
        const { account, limits } = yield* poll(claudeAccount("old", "rt", 7200))
        expect(tokenOf(account)).toBe("fresh")
        expect(limits.windows).toHaveLength(1)
        expect(refreshes(api)).toBe(1)
        expect(api.at("/api/oauth/usage")).toHaveLength(2)
      }),
      api.layer,
    )
  })

  it.effect("fails when the refreshed token is rejected too", () => {
    const api = usageApi("nobody", 200)
    return run(
      Effect.gen(function* () {
        expect((yield* Effect.flip(poll(claudeAccount("old", "rt", 7200)))).message).toBe(
          "token rejected after refresh",
        )
      }),
      api.layer,
    )
  })

  it.effect("reports a rejected token without refreshing when refreshing is not allowed", () => {
    const api = usageApi("nobody", 200)
    return run(
      Effect.gen(function* () {
        expect((yield* Effect.flip(poll(claudeAccount("old", "rt", 60), false))).message).toBe(
          "token rejected (refresh disabled)",
        )
        expect(refreshes(api)).toBe(0)
      }),
      api.layer,
    )
  })

  it.effect("says how to sign in again when the sign-in was revoked", () => {
    const api = usageApi("nobody", 400)
    return run(
      Effect.gen(function* () {
        const error = yield* Effect.flip(poll(claudeAccount("old", "rt", 60)))
        expect(error.message.endsWith("; run `slopmax login claude`")).toBe(true)
      }),
      api.layer,
    )
  })

  it.effect("keeps a passing refresh failure's own reason", () => {
    const api = usageApi("nobody", 503)
    return run(
      Effect.gen(function* () {
        expect((yield* Effect.flip(poll(claudeAccount("old", "rt", 7200)))).message).toContain(
          "token refresh failed (503 Service Unavailable)",
        )
      }),
      api.layer,
    )
  })

  it.effect("passes other failures through, before and after a refresh", () => {
    const failing = mockUpstream((seen) => {
      if (seen.url.pathname === "/api/oauth/usage") {
        const auth = seen.headers.get("authorization")
        return auth === "Bearer fresh"
          ? reply(502, "bad gateway")
          : auth === "Bearer down"
            ? reply(500, "broken")
            : reply(401)
      }
      return json(200, { access_token: "fresh" })
    })
    return run(
      Effect.gen(function* () {
        expect(
          (yield* Effect.flip(poll(claudeAccount("down", "rt", 7200)))).message.startsWith(
            "usage endpoint returned 500",
          ),
        ).toBe(true)
        // The refreshed token reads a failing endpoint.
        expect(
          (yield* Effect.flip(poll(claudeAccount("old", "rt", 7200)))).message.startsWith(
            "usage endpoint returned 502",
          ),
        ).toBe(true)
      }),
      failing.layer,
    )
  })

  it.effect("says when a provider has no usage windows", () =>
    run(
      Effect.gen(function* () {
        expect((yield* Effect.flip(poll(keyAccount("xai", "k")))).message).toBe("xAI API has no usage windows")
      }),
      downUpstream,
    ),
  )
})
