import { describe, expect } from "bun:test"
import { isExhausted, LimitReset, type LoginEvent, PoolWindow } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Effect, Fiber, Layer, Option, Queue, Redacted, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Identity } from "../../src/account.ts"
import {
  authorizeUrl,
  availableCredits,
  catalogModels,
  clientId,
  clientVersion,
  codex,
  deviceLogin,
  deviceRedirectUri,
  deviceVerifyUrl,
  eventVerdict,
  exchange,
  limitsFromEvent,
  limitsFromHeaders,
  limitsFromUsage,
  pollInterval,
  rebind,
  rebindTurn,
  redirectUri,
  refusalOf,
  rejectsAccountState,
  showPoolInEvent,
  showPoolInHeaders,
  withClaims,
} from "../../src/providers/codex.ts"
import { LoginUi } from "../../src/providers/oauth.ts"
import { Verdict } from "../../src/providers/provider.ts"
import type { Upstream } from "../../src/upstream.ts"
import {
  at,
  downUpstream,
  formOf,
  json,
  jsonOf,
  jwt,
  loginUi,
  mockUpstream,
  oauthAccount,
  reply,
  noSpawner,
} from "./support.ts"

const utf8 = new TextEncoder()
const bytes = (text: string) => utf8.encode(text)
const authClaim = "https://api.openai.com/auth"
const profileClaim = "https://api.openai.com/profile"
const account = (token: string, workspace?: string) =>
  oauthAccount({
    provider: "codex",
    access: token,
    identity: new Identity(workspace === undefined ? {} : { accountId: workspace }),
  })
const usage = Option.getOrThrow(codex.usage)
const credits = Option.getOrThrow(codex.resets)
const tokens = () => ({
  access_token: jwt({ exp: 1_900_000_000 }),
  refresh_token: "rt",
  id_token: jwt({ email: "me@x.dev", [authClaim]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus" } }),
})

/** auth.openai.com: the token endpoint answers `status` with `token`; device polls are pending until the `ready`th. */
const openai = (status: number, token: unknown, ready: number) => {
  let polls = 0
  return mockUpstream((seen) => {
    switch (seen.url.pathname) {
      case "/oauth/token":
        return json(status, token)
      case "/api/accounts/deviceauth/usercode":
        return json(200, { device_auth_id: "dev-1", usercode: "ABCD-1234", interval: "0" })
      case "/api/accounts/deviceauth/token": {
        polls += 1
        if (polls < ready) return reply(polls % 2 === 0 ? 404 : 403)
        if (polls === ready) return json(200, { authorization_code: "dev-code", code_verifier: "dev-verifier" })
        return reply(500, "device flow broke")
      }
      default:
        return reply(404)
    }
  })
}

/** The ChatGPT backend, answering a token named `good`. */
const chatgpt = () =>
  mockUpstream((seen) => {
    const good = seen.headers.get("authorization") === "Bearer good"
    if (!good) return reply(401)
    if (seen.url.pathname === "/backend-api/wham/usage") {
      return json(200, {
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 60 } },
        rate_limit_reset_credits: { available_count: 2 },
      })
    }
    if (seen.url.pathname === "/backend-api/codex/models") {
      return json(200, {
        models: [
          { slug: "gpt-6-sol", visibility: "list" },
          { slug: "gpt-hidden", visibility: "hide" },
          { slug: "gpt-plain" },
          { visibility: "list" },
        ],
      })
    }
    return reply(404)
  })

/** Moves the test clock a second at a time until `fiber` is done, letting the in-process upstream answer between. */
const drive = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 100 && fiber.pollUnsafe() === undefined; step++) {
      yield* Effect.promise(() => Bun.sleep(1))
      yield* TestClock.adjust("1 second")
    }
    return yield* Fiber.join(fiber)
  })

const version = (agent: string) => clientVersion(new Headers({ "user-agent": agent }))

describe("ChatGPT", () => {
  it("signs requests with the token and workspace, and drops the turn state of a moved session", () => {
    const client = new Headers({ authorization: "Bearer sm", "x-codex-turn-state": "turn" })
    const input = { client, account: account("tok", "ws-1"), agents: {}, codex: {} }
    const stay = codex.headers({ ...input, moved: false })
    expect(stay.get("authorization")).toBe("Bearer tok")
    expect(stay.get("chatgpt-account-id")).toBe("ws-1")
    expect(stay.get("x-codex-turn-state")).toBe("turn")
    expect(codex.headers({ ...input, moved: true }).has("x-codex-turn-state")).toBe(false)
    expect(codex.identity(account("tok", "ws-1"))).toBe("ws-1")
    expect(codex.signIn).toBe("browser-or-device")
    expect(Option.isSome(codex.resets)).toBe(true)
  })

  it("swaps the credential, asks for an uncompressed stream, and adds Codex's version", () => {
    const out = codex.headers({
      client: new Headers({
        authorization: "Bearer sm-local",
        "user-agent": "codex_exec/0.159.3 (Amazon Linux; x86_64) unknown (codex_exec; 0.159.3)",
        "x-codex-turn-state": "sticky",
        "session-id": "s",
        host: "127.0.0.1:7567",
        "accept-encoding": "gzip",
      }),
      account: account("tok", "ws-1"),
      moved: true,
      agents: {},
      codex: {},
    })
    expect(out.get("authorization")).toBe("Bearer tok")
    expect(out.get("chatgpt-account-id")).toBe("ws-1")
    expect(out.get("version")).toBe("0.159.3")
    expect(out.get("session-id")).toBe("s")
    expect(out.has("x-codex-turn-state")).toBe(false)
    expect(out.has("host")).toBe(false)
    expect(out.get("accept-encoding")).toBe("identity")
    // Another agent's request takes the newest Codex version seen; a client's own version header stays.
    const translated = codex.headers({
      client: new Headers({ "user-agent": "claude-cli/2.1.0" }),
      account: account("tok"),
      moved: false,
      agents: {},
      codex: { version: "0.160.0" },
    })
    expect(translated.get("version")).toBe("0.160.0")
    expect(translated.has("chatgpt-account-id")).toBe(false)
    const own = codex.headers({
      client: new Headers({ "user-agent": "codex_exec/0.159.3", version: "9.9.9" }),
      account: account("tok"),
      moved: false,
      agents: {},
      codex: {},
    })
    expect(own.get("version")).toBe("9.9.9")
  })

  it("reads Codex's version only from its own user agent, as three parts", () => {
    expect(version("codex_cli_rs/0.160.0 (Mac OS)")).toBe("0.160.0")
    expect(version("curl/8.0.1")).toBeUndefined()
    expect(version("codex/1.2")).toBeUndefined()
    expect(clientVersion(new Headers())).toBeUndefined()
  })

  it("drops output limits from translated requests, and state a moved session cannot use", () => {
    expect(codex.shape({ model: "gpt-6", max_output_tokens: 100 })).toEqual({ model: "gpt-6" })
    const rebound = Option.getOrThrow(rebind(bytes(`{"previous_response_id":"r1","input":[]}`)))
    expect(new TextDecoder().decode(rebound)).not.toContain("r1")
    expect(rebind(bytes(`{"input":[]}`))).toEqual(Option.none())
    expect(rebind(bytes("not json"))).toEqual(Option.none())
  })

  it("strips encrypted reasoning but keeps its summaries and the body's key order", () => {
    const body = bytes(
      `{"model":"m","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"s"}],"encrypted_content":"gAAA"},{"type":"message","role":"user","content":[]}],"stream":true}`,
    )
    const out = JSON.parse(new TextDecoder().decode(Option.getOrThrow(rebind(body))))
    expect(out.input[0].encrypted_content).toBeUndefined()
    expect(out.input[0].summary[0].text).toBe("s")
    expect(Object.keys(out)).toEqual(["model", "input", "stream"])
  })

  it("recognizes refusals of state another account minted", () => {
    expect(rejectsAccountState(bytes(`{"error":{"code":"invalid_encrypted_content"}}`))).toBe(true)
    expect(rejectsAccountState(bytes("reasoning `encrypted_content` was not issued to this caller"))).toBe(true)
    expect(rejectsAccountState(bytes("Item with id 'rs_123' not found."))).toBe(true)
    expect(rejectsAccountState(bytes(`{"error":{"code":"context_length_exceeded"}}`))).toBe(false)
  })

  it("reads spent quotas, stale state, and limits disguised as server errors", () => {
    const now = at(1_000)
    const verdict = (status: number, body: string, headers: Record<string, string> = {}) =>
      codex.verdict({ status, headers: new Headers(headers), body: bytes(body), now })
    const limit = `{"error":{"type":"usage_limit_reached","resets_at":5000}}`
    expect(verdict(429, limit)).toEqual(Verdict.Exhausted({ until: at(5_000) }))
    expect(verdict(402, limit)._tag).toBe("Exhausted")
    expect(verdict(400, `{"error":{"code":"invalid_encrypted_content"}}`)).toEqual(Verdict.StaleState())
    expect(verdict(400, "bad request")).toEqual(Verdict.Final())
    expect(verdict(502, "Your usage limit has been reached")).toEqual(Verdict.Exhausted({}))
    expect(verdict(502, "gateway")).toEqual(Verdict.Final())
    expect(verdict(403, "")).toEqual(Verdict.Forbidden())
    // Without a reset in the body, the headers say when, else retry-after.
    const spent = `{"error":{"type":"usage_limit_reached"}}`
    expect(verdict(429, spent, { "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": "4000" })).toEqual(
      Verdict.Exhausted({ until: at(4_000) }),
    )
    expect(verdict(429, spent, { "retry-after": "30" })).toEqual(Verdict.Exhausted({ until: at(1_030) }))
  })

  it("takes a spent quota's end from its body, absolute or relative", () => {
    const now = at(1_000)
    expect(
      refusalOf(
        429,
        new Headers(),
        bytes(`{"error":{"type":"usage_limit_reached","message":"x","resets_at":4000}}`),
        now,
      ),
    ).toEqual(Verdict.Exhausted({ until: at(4_000) }))
    expect(
      refusalOf(429, new Headers(), bytes(`{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}`), now),
    ).toEqual(Verdict.Exhausted({ until: at(1_060) }))
  })

  it("reads a plain rate limit as throttling", () => {
    expect(refusalOf(429, new Headers(), bytes(`{"error":{"type":"rate_limit_exceeded"}}`), at(0))._tag).toBe(
      "Throttled",
    )
  })

  it("reads windows from the headers and shows the pool's in their place", () => {
    const headers = new Headers({ "x-codex-primary-used-percent": "25", "x-codex-primary-window-minutes": "300" })
    const limits = Option.getOrThrow(codex.limitsFrom(headers, at(1_000)))
    expect([limits.windows[0]?.span, limits.windows[0]?.used]).toEqual(["5h", 25])
    const shown = codex.showPool(headers, [new PoolWindow({ span: "5h", used: 60, weighted: false })])
    expect(shown.get("x-codex-primary-used-percent")).toBe("60.0")
    // Socket events without limits are left alone.
    const event = { type: "codex.rate_limits" }
    expect(showPoolInEvent(event, [new PoolWindow({ span: "5h", used: 60, weighted: false })])).toEqual(event)
  })

  it("names header windows by their length", () => {
    const limits = Option.getOrThrow(
      limitsFromHeaders(
        new Headers({
          "x-codex-primary-used-percent": "29",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": "5000",
          "x-codex-secondary-used-percent": "100",
          "x-codex-secondary-window-minutes": "300",
        }),
        at(1_000),
      ),
    )
    expect(limits.windows.map((window) => window.span)).toEqual(["7d", "5h"])
    expect(isExhausted(limits, at(1_000))).toBe(true)
    // A window without its length is a week.
    const bare = limitsFromHeaders(new Headers({ "x-codex-primary-used-percent": "1" }), at(0))
    expect(Option.map(bare, (found) => found.windows[0]?.span)).toEqual(Option.some("7d"))
  })

  it("describes the pool in the headers and socket events Codex reads, keeping the rest", () => {
    const pool = [
      new PoolWindow({ span: "5h", used: 22.5, resetsAt: at(4_000), weighted: false }),
      new PoolWindow({ span: "7d", used: 35, weighted: false }),
    ]
    const shown = showPoolInHeaders(
      new Headers({
        "x-codex-primary-used-percent": "95",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1234",
        "x-codex-secondary-used-percent": "70",
        "x-codex-credits-has-credits": "true",
      }),
      pool,
    )
    expect(shown.get("x-codex-primary-used-percent")).toBe("22.5")
    expect(shown.get("x-codex-primary-window-minutes")).toBe("300")
    expect(shown.get("x-codex-primary-reset-at")).toBe("4000")
    expect(shown.get("x-codex-secondary-used-percent")).toBe("35.0")
    expect(shown.get("x-codex-secondary-window-minutes")).toBe("10080")
    expect(shown.has("x-codex-secondary-reset-at")).toBe(false)
    expect(shown.get("x-codex-credits-has-credits")).toBe("true")

    const event = showPoolInEvent(
      {
        type: "codex.rate_limits",
        plan_type: "pro",
        rate_limits: {
          allowed: true,
          limit_reached: true,
          primary: { used_percent: 100, window_minutes: 300, reset_at: 9 },
        },
      },
      pool,
    )
    expect(event).toEqual({
      type: "codex.rate_limits",
      plan_type: "pro",
      rate_limits: {
        allowed: true,
        limit_reached: false,
        primary: { used_percent: 22.5, window_minutes: 300, reset_at: 4000 },
        secondary: { used_percent: 35, window_minutes: 10080, reset_at: null },
      },
    })
  })

  it("reads the windows a socket's rate-limit event reports", () => {
    const limits = Option.getOrThrow(
      limitsFromEvent(
        {
          type: "codex.rate_limits",
          plan_type: "pro",
          rate_limits: {
            allowed: true,
            limit_reached: false,
            primary: { used_percent: 42, window_minutes: 300, reset_at: 9000 },
            secondary: { used_percent: 7, window_minutes: 10080, reset_at: 99000 },
          },
        },
        at(1_000),
      ),
    )
    expect(limits.windows.map((window) => [window.span, window.used])).toEqual([
      ["5h", 42],
      ["7d", 7],
    ])
    expect(limits.windows[0]?.resetsAt).toEqual(at(9_000))
    expect(limitsFromEvent({ type: "codex.rate_limits", rate_limits: { primary: null } }, at(0))).toEqual(Option.none())
  })

  it("drops a moved socket's turn state, previous response and encrypted reasoning, and nothing else", () => {
    const turn = {
      type: "response.create",
      model: "gpt-6",
      client_metadata: { "x-codex-turn-state": "t", other: "kept" },
      previous_response_id: "r1",
      input: [{ type: "reasoning", encrypted_content: "e", summary: [] }],
    }
    expect(Option.getOrThrow(rebindTurn(turn))).toEqual({
      type: "response.create",
      model: "gpt-6",
      client_metadata: { other: "kept" },
      input: [{ type: "reasoning", summary: [] }],
    })
    expect(rebindTurn({ type: "response.create", input: [] })).toEqual(Option.none())
    expect(Option.getOrThrow(rebindTurn({ client_metadata: { "x-codex-turn-state": "t" } }))).toEqual({
      client_metadata: {},
    })
  })

  it("tells a socket's spent or throttled account from a failed request", () => {
    const now = at(1_000)
    expect(
      eventVerdict(
        { type: "response.failed", response: { error: { code: "usage_limit_reached", resets_in_seconds: 60 } } },
        now,
      ),
    ).toEqual(Option.some(Verdict.Exhausted({ until: at(1_060) })))
    expect(eventVerdict({ type: "error", error: { type: "slow_down" } }, now)).toEqual(
      Option.some(Verdict.Throttled({})),
    )
    expect(eventVerdict({ type: "error", error: { code: "context_length_exceeded" } }, now)).toEqual(Option.none())
    expect(eventVerdict({ type: "response.completed" }, now)).toEqual(Option.none())
  })

  it("reads windows, the plan and banked reset credits from the usage endpoint's answer", () => {
    const limits = limitsFromUsage(
      {
        plan_type: "pro",
        rate_limit: {
          allowed: true,
          primary_window: {
            used_percent: 29,
            limit_window_seconds: 604_800,
            reset_after_seconds: 498_039,
            reset_at: 1_791_580_389,
          },
          secondary_window: null,
        },
        rate_limit_reset_credits: { available_count: 3 },
      },
      at(0),
    )
    expect(limits.plan).toBe("pro")
    expect(limits.windows).toHaveLength(1)
    expect(limits.windows[0]?.span).toBe("7d")
    expect(limits.windows[0]?.resetsAt).toEqual(at(1_791_580_389))
    expect(limits.resetCredits).toBe(3)
  })

  it.effect("reads usage with the workspace when it is known", () => {
    const api = chatgpt()
    return Effect.gen(function* () {
      const limits = yield* usage(account("good", "ws-1"))
      expect(limits.plan).toBe("pro")
      expect([limits.windows[0]?.span, limits.windows[0]?.used]).toEqual(["5h", 20])
      expect(limits.windows[0]?.resetsAt).toEqual(at(60))
      expect(limits.resetCredits).toBe(2)
      expect(api.at("/backend-api/wham/usage")[0]?.headers.get("chatgpt-account-id")).toBe("ws-1")
      expect((yield* usage(account("good"))).plan).toBe("pro")
      expect(api.at("/backend-api/wham/usage")[1]?.headers.has("chatgpt-account-id")).toBe(false)
      expect((yield* Effect.flip(usage(account("bad"))))._tag).toBe("ProviderUnauthorized")
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("lists the models the plan offers Codex, except hidden ones", () => {
    const api = chatgpt()
    return Effect.gen(function* () {
      expect(yield* codex.catalog(account("good", "ws-1"), { codexVersion: "0.160.0" })).toEqual([
        "gpt-6-sol",
        "gpt-plain",
      ])
      const sent = api.at("/backend-api/codex/models")[0]
      expect(sent?.url.search).toBe("?client_version=0.160.0")
      expect(sent?.headers.get("chatgpt-account-id")).toBe("ws-1")
      expect(yield* codex.catalog(account("good"), { codexVersion: "1" })).toHaveLength(2)
      expect((yield* Effect.flip(codex.catalog(account("bad"), {})))._tag).toBe("ProviderFailed")
      expect(catalogModels({})).toEqual([])
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("reads who the account is from new tokens, without a network call", () =>
    Effect.gen(function* () {
      const access = jwt({ [authClaim]: { chatgpt_account_id: "ws-9", chatgpt_plan_type: "pro" } })
      const identified = yield* codex.identify(account(access))
      expect(identified.identity.accountId).toBe("ws-9")
      expect(identified.identity.plan).toBe("pro")
    }).pipe(Effect.provide(downUpstream)),
  )
})

describe("ChatGPT sign-in", () => {
  it("asks to authorize at the redirect registered for Codex", () => {
    const url = authorizeUrl("ch", "st")
    expect(url.startsWith("https://auth.openai.com/oauth/authorize?response_type=code")).toBe(true)
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback")
    expect(url).toContain("codex_cli_simplified_flow=true")
    expect(url).toContain("prompt=login")
    expect(url.endsWith("state=st&originator=codex_cli_rs")).toBe(true)
  })

  it("fills the identity from the tokens' claims, leniently", () => {
    const identity = withClaims(new Identity({}), {
      access: jwt({ exp: 1_900_000_000 }),
      idToken: jwt({
        email: "me@x.dev",
        aud: "single-string-audience",
        [authClaim]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "pro" },
      }),
    })
    expect({ ...identity }).toEqual({ email: "me@x.dev", accountId: "ws-1", plan: "pro" })
    // Blank or missing claims keep what is known.
    expect(
      withClaims(new Identity({ plan: "plus" }), { access: jwt({ [authClaim]: { chatgpt_plan_type: "" } }) }).plan,
    ).toBe("plus")
  })

  it("takes the email from the access token's profile claim when the id token has none", () => {
    const identity = withClaims(new Identity({}), {
      access: jwt({ [profileClaim]: { email: "p@x.dev" }, [authClaim]: { chatgpt_account_id: "ws-2" } }),
    })
    expect(identity.email).toBe("p@x.dev")
    expect(identity.accountId).toBe("ws-2")
  })

  it.effect("exchanges a code for an account named by its claims", () => {
    const api = openai(200, tokens(), 1)
    return Effect.gen(function* () {
      const signedIn = yield* exchange("code-1", "verifier", "http://cb")
      expect(signedIn.provider).toBe("codex")
      expect({ ...signedIn.identity }).toEqual({ email: "me@x.dev", accountId: "ws-1", plan: "plus" })
      const saved = Option.getOrThrow(signedIn.tokens)
      expect(saved.expiresAt).toEqual(at(1_900_000_000))
      expect(saved.refresh === undefined ? undefined : Redacted.value(saved.refresh)).toBe("rt")
      expect(signedIn.id).toMatch(/^codex-[0-9a-f]{8}$/)
      expect(formOf(api.at("/oauth/token")[0])).toEqual({
        grant_type: "authorization_code",
        code: "code-1",
        redirect_uri: "http://cb",
        client_id: clientId,
        code_verifier: "verifier",
      })
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("says why an exchange failed", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.flip(
        exchange("c", "v", "r").pipe(Effect.provide(openai(403, { error: "denied" }, 1).layer)),
      )
      expect(rejected.message.startsWith("token exchange failed (403")).toBe(true)
      const garbled = yield* Effect.flip(
        exchange("c", "v", "r").pipe(Effect.provide(openai(200, { id_token: "x" }, 1).layer)),
      )
      expect(garbled.message).toBe("unexpected token response")
    }),
  )

  it.effect("refreshes with exactly the JSON Codex sends, telling revoked from passing failures", () =>
    Effect.gen(function* () {
      const saved = oauthAccount({ provider: "codex", access: "old", refresh: "rt-old" })
      const ok = openai(200, tokens(), 1)
      const grant = yield* codex.refresh(saved).pipe(Effect.provide(ok.layer))
      expect(grant.idToken).toBeDefined()
      expect(grant.expiresAt).toEqual(at(1_900_000_000))
      expect(jsonOf(ok.at("/oauth/token")[0])).toEqual({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: "rt-old",
      })
      const refresh = (layer: Layer.Layer<Upstream>) => Effect.flip(codex.refresh(saved).pipe(Effect.provide(layer)))
      expect((yield* refresh(openai(400, { error: { code: "refresh_token_reused" } }, 1).layer))._tag).toBe(
        "RefreshRevoked",
      )
      expect((yield* refresh(openai(500, {}, 1).layer))._tag).toBe("RefreshTransient")
      expect((yield* refresh(openai(200, {}, 1).layer))._tag).toBe("RefreshTransient")
      expect((yield* refresh(downUpstream))._tag).toBe("RefreshTransient")
    }),
  )

  it("polls every few seconds as told, at least one", () => {
    expect(pollInterval(undefined)).toBe(5)
    expect(pollInterval("0")).toBe(1)
    expect(pollInterval(7)).toBe(7)
    expect(pollInterval("x")).toBe(5)
  })

  it.effect("signs in with a device code once it is approved", () => {
    // Two pending polls (403, then 404), then approval.
    const api = openai(200, tokens(), 3)
    const ui = loginUi()
    return Effect.gen(function* () {
      const fiber = yield* codex
        .login({ device: true })
        .pipe(Effect.scoped, Effect.provide(Layer.mergeAll(api.layer, ui.layer, noSpawner)), Effect.forkScoped)
      const signedIn = yield* drive(fiber)
      expect(signedIn.identity.accountId).toBe("ws-1")
      expect(ui.events).toEqual([{ _tag: "DeviceCode", url: deviceVerifyUrl, code: "ABCD-1234" }])
      const polls = api.at("/api/accounts/deviceauth/token")
      expect(polls).toHaveLength(3)
      expect(jsonOf(polls[0])).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" })
      expect(formOf(api.at("/oauth/token")[0])).toMatchObject({
        code: "dev-code",
        code_verifier: "dev-verifier",
        redirect_uri: deviceRedirectUri,
      })
    })
  })

  it.effect("reports a device sign-in that failed, could not start, or ran out of time", () =>
    Effect.gen(function* () {
      const broken = openai(200, tokens(), 0)
      const failed = yield* deviceLogin.pipe(
        Effect.provide(Layer.merge(broken.layer, loginUi().layer)),
        Effect.flip,
        Effect.forkScoped,
      )
      expect((yield* drive(failed)).message).toBe("device login failed (500 Internal Server Error): device flow broke")
      const missing = yield* deviceLogin.pipe(
        Effect.provide(Layer.merge(mockUpstream(() => reply(404)).layer, loginUi().layer)),
        Effect.flip,
      )
      expect(missing.message).toBe("device login is unavailable")
      const pending = openai(200, tokens(), 10_000)
      const expired = yield* deviceLogin.pipe(
        Effect.provide(Layer.merge(pending.layer, loginUi().layer)),
        Effect.flip,
        Effect.forkScoped,
      )
      for (let minute = 0; minute < 16 && expired.pollUnsafe() === undefined; minute++) {
        yield* Effect.promise(() => Bun.sleep(1))
        yield* TestClock.adjust("1 minute")
      }
      expect((yield* drive(expired)).message).toBe("device code expired; run login again")
    }),
  )

  it.live("signs in through the browser with a pasted redirect address", () => {
    const api = openai(200, tokens(), 1)
    return Effect.gen(function* () {
      const pastes = yield* Queue.unbounded<string>()
      const told: Array<LoginEvent> = []
      const ui = Layer.succeed(LoginUi)({
        tell: (event) =>
          Effect.gen(function* () {
            told.push(event)
            if (event._tag !== "Authorize") return
            const state = new URL(event.url).searchParams.get("state")
            yield* Queue.offer(pastes, `${redirectUri}?code=browser-code&state=${state}`)
          }),
        pasted: Stream.fromQueue(pastes),
        openBrowser: false,
      })
      const signedIn = yield* Effect.scoped(codex.login({})).pipe(
        Effect.provide(Layer.mergeAll(api.layer, ui, noSpawner)),
      )
      expect(signedIn.identity.email).toBe("me@x.dev")
      expect(told[0]).toMatchObject({ _tag: "Authorize", title: "ChatGPT", opened: false })
      expect(formOf(api.at("/oauth/token")[0])).toMatchObject({ code: "browser-code", redirect_uri: redirectUri })
    })
  })
})

describe("ChatGPT reset credits", () => {
  it("count only unspent credits that reset Codex's windows, soonest to expire first", () => {
    const listed = Option.getOrThrow(
      availableCredits({
        credits: [
          {
            id: "late",
            status: "available",
            reset_type: "codex_rate_limits",
            granted_at: "2026-11-01T09:30:00Z",
            expires_at: "2026-12-01T00:00:00Z",
          },
          {
            id: "review",
            status: "available",
            reset_type: "code_review_rate_limits",
            expires_at: "2026-10-05T00:00:00Z",
          },
          { id: "spent", status: "redeemed", reset_type: "codex_rate_limits", expires_at: "2026-10-06T00:00:00Z" },
          { id: "soon", status: "AVAILABLE", reset_type: "codex_rate_limits", expires_at: "2026-10-07T00:00:00Z" },
          { id: "untyped", expires_at: "2026-11-01T00:00:00Z" },
        ],
      }),
    )
    expect(listed.map((reset: LimitReset) => reset.id)).toEqual(["soon", "untyped", "late"])
    expect(listed[2]?.grantedAt).toEqual(DateTime.makeUnsafe(Date.parse("2026-11-01T09:30:00Z")))
    expect(availableCredits([])).toEqual(Option.none())
  })

  it.effect("say which step failed when listing or redeeming", () => {
    const api = mockUpstream((seen) => {
      if (seen.url.pathname === "/backend-api/wham/rate-limit-reset-credits") return reply(502)
      const body = jsonOf(seen)
      if (typeof body === "object" && body !== null && "credit_id" in body) return reply(409)
      return json(200, { code: "nothing_to_reset" })
    })
    return Effect.gen(function* () {
      const listing = yield* Effect.flip(credits.list(account("tok"), undefined))
      expect(listing.message).toBe("listing reset credits failed (502 Bad Gateway)")
      expect(api.seen[0]?.headers.has("chatgpt-account-id")).toBe(false)
      expect(api.seen[0]?.headers.get("authorization")).toBe("Bearer tok")
      const redeeming = yield* Effect.flip(credits.redeem(account("tok", "ws"), "c1", undefined))
      expect(redeeming.message).toBe("redeeming a reset credit failed (409 Conflict)")
      expect(yield* credits.redeem(account("tok", "ws"), undefined, undefined)).toBe("nothing-to-reset")
      const sent = jsonOf(api.seen.at(-1))
      expect(sent).toEqual({ redeem_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) })
      expect(credits.counted).toBe(true)
      expect(credits.needsAgent).toBe(false)
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("fail when the backend cannot be reached, after a retry", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(credits.redeem(account("tok"), undefined, undefined)))._tag).toBe("ProviderFailed")
    }).pipe(Effect.provide(downUpstream)),
  )
})
