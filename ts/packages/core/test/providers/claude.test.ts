import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option, Queue, Redacted, Stream } from "effect"
import { type LoginEvent, PoolWindow, score, windowLabel } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Identity } from "../../src/account.ts"
import {
  authorizeUrl,
  availableResets,
  callbackPort,
  claimOutcome,
  claude,
  claudeCodeAgent,
  exchange,
  fastModeRefused,
  isUuid,
  limitsFromHeaders,
  limitsFromUsage,
  oauthBeta,
  planOf,
  profile,
  type Profile,
  redirectUri,
  refusalOf,
  scopes,
  showPoolInHeaders,
  withOauthBeta,
  withProfile,
} from "../../src/providers/claude.ts"
import { LoginUi } from "../../src/providers/oauth.ts"
import { Verdict } from "../../src/providers/provider.ts"
import { at, downUpstream, json, jsonOf, mockUpstream, oauthAccount, reply, noSpawner } from "./support.ts"

const utf8 = new TextEncoder()
const bytes = (text: string) => utf8.encode(text)
const refusal = (status: number, headers: Record<string, string>, body = "{}", model?: string) => ({
  status,
  headers: new Headers(headers),
  body: bytes(body),
  model,
  now: at(1_000),
})
const resets = Option.getOrThrow(claude.resets)
const usage = Option.getOrThrow(claude.usage)
const org = "6f1a2b3c-0000-4000-8000-123456789abc"
const agent = "claude-cli/2.1.0 (external, cli)"
const withOrg = (orgId: string) => oauthAccount({ access: "tok", identity: new Identity({ orgId }) })
const time = (text: string) => DateTime.makeUnsafe(Date.parse(text))
/** Anthropic's token endpoint answering `token`, and a Max 20x profile (or `profileStatus`). */
const anthropic = (status: number, token: unknown, profileStatus = 200) =>
  mockUpstream((seen) => {
    if (seen.url.pathname === "/v1/oauth/token") return json(status, token)
    if (seen.url.pathname === "/api/oauth/profile") {
      return profileStatus === 200
        ? json(200, {
            account: { email: "profile@x.dev" },
            organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
          })
        : reply(profileStatus)
    }
    return reply(404)
  })

const tokenAnswer = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 28_800,
  account: { uuid: "acct-1", email_address: "token@x.dev" },
  organization: { uuid: "org-1", name: "Acme" },
}

/** The usage and profile endpoints, answering a token named `good`. */
const usageApi = () =>
  mockUpstream((seen) => {
    const auth = seen.headers.get("authorization")
    if (seen.url.pathname === "/api/oauth/usage" && auth === "Bearer good") {
      return json(200, {
        five_hour: { utilization: 12.5, resets_at: "2099-01-01T00:00:00Z" },
        seven_day: { utilization: 40 },
        seven_day_opus: { utilization: 70 },
      })
    }
    if (seen.url.pathname === "/api/oauth/usage" && auth === "Bearer down") return reply(500, "x".repeat(500))
    if (seen.url.pathname === "/api/oauth/profile" && auth === "Bearer good") {
      return json(200, { account: { email: "me@x.dev" }, organization: { organization_type: "claude_pro" } })
    }
    return reply(401)
  })

describe("Claude", () => {
  it("keys accounts by organization, then account", () => {
    expect(claude.identity(oauthAccount({ access: "t" }))).toBeUndefined()
    expect(claude.identity(oauthAccount({ access: "t", identity: new Identity({ accountId: "acct" }) }))).toBe("acct")
    expect(
      claude.identity(oauthAccount({ access: "t", identity: new Identity({ accountId: "acct", orgId: "org" }) })),
    ).toBe("org")
  })

  it("signs requests with the token and the OAuth beta, and serves Claude Code alone", () => {
    const sent = claude.headers({
      client: new Headers({ "x-api-key": "sm-key", "anthropic-beta": "a-1" }),
      account: oauthAccount({ access: "tok" }),
      moved: false,
      agents: {},
      codex: {},
    })
    expect(sent.get("authorization")).toBe("Bearer tok")
    expect(sent.get("anthropic-beta")).toBe(`a-1,${oauthBeta}`)
    expect(sent.has("x-api-key")).toBe(false)
    expect(Option.isSome(claude.resets)).toBe(true)
    expect(claude.agentOnly).toBe("claude-code")
    expect(claude.signIn).toBe("browser")
  })

  it("adds the OAuth beta once, keeping the agent's betas in order", () => {
    expect(withOauthBeta("claude-code-20250219, interleaved-thinking-2025-05-14")).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
    )
    expect(withOauthBeta(null)).toBe("oauth-2025-04-20")
    expect(withOauthBeta("oauth-2025-04-20,x")).toBe("oauth-2025-04-20,x")
  })

  it("knows Claude Code by its user agent", () => {
    expect(claudeCodeAgent(new Headers())).toBeUndefined()
    expect(claudeCodeAgent(new Headers({ "user-agent": "claude-cli/2.1.291 (external, cli)" }))).toBe(
      "claude-cli/2.1.291 (external, cli)",
    )
    expect(claudeCodeAgent(new Headers({ "user-agent": "curl/8.7.1" }))).toBeUndefined()
    expect(claudeCodeAgent(new Headers({ "user-agent": `claude-cli/${"9".repeat(200)}` }))).toBeUndefined()
  })

  it("changes only the credential of Claude Code's requests", () => {
    const out = claude.headers({
      client: new Headers({
        authorization: "Bearer sm-key",
        "user-agent": "claude-cli/2.1.287 (external, cli)",
        "accept-encoding": "gzip, br",
        "x-app": "cli",
      }),
      account: oauthAccount({ access: "account-token" }),
      moved: false,
      agents: {},
      codex: {},
    })
    expect(Object.fromEntries(out)).toEqual({
      authorization: "Bearer account-token",
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "accept-encoding": "gzip, br",
      "x-app": "cli",
    })
  })

  it("reads windows from the headers, and shows the pool's in their place", () => {
    const read = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.5",
      "anthropic-ratelimit-unified-5h-reset": "2000",
    })
    const limits = Option.getOrThrow(claude.limitsFrom(read, at(1_000)))
    expect(limits.windows[0]?.span).toBe("5h")
    expect(limits.windows[0]?.used).toBe(50)
    const shown = claude.showPool(read, [new PoolWindow({ span: "5h", used: 80, weighted: false })])
    expect(shown.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.80")
    expect(shown.has("anthropic-ratelimit-unified-5h-reset")).toBe(false)
    // Windows Claude Code has no header for are left out.
    const monthly = claude.showPool(read, [new PoolWindow({ span: "30d", used: 10, weighted: false })])
    expect([...monthly.keys()]).toEqual([])
  })

  it("converts the headers' fractions to percent", () => {
    const limits = Option.getOrThrow(
      limitsFromHeaders(
        new Headers({
          "anthropic-ratelimit-unified-5h-utilization": "0.53",
          "anthropic-ratelimit-unified-5h-reset": "2000",
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
        }),
        at(1_000),
      ),
    )
    expect(limits.windows[0]?.used).toBeCloseTo(53)
    expect(limits.windows[0]?.resetsAt).toEqual(at(2_000))
    expect(limits.windows[1]?.resetsAt).toBeUndefined()
    expect(limits.observedAt).toEqual(at(1_000))
    expect(limitsFromHeaders(new Headers(), at(0))).toEqual(Option.none())
  })

  it("replaces the account's limit headers with the pool's, warning as one account would", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-status": "allowed_warning",
      "anthropic-ratelimit-unified-5h-utilization": "0.97",
      "anthropic-ratelimit-unified-overage-status": "allowed",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "request-id": "req_1",
    })
    const shown = showPoolInHeaders(headers, [
      new PoolWindow({ span: "5h", used: 48.5, resetsAt: at(5_000), weighted: false }),
      new PoolWindow({ span: "7d", used: 30, weighted: false }),
    ])
    expect(shown.get("anthropic-ratelimit-unified-status")).toBe("allowed")
    expect(shown.get("anthropic-ratelimit-unified-5h-utilization")).toBe("0.48")
    expect(shown.get("anthropic-ratelimit-unified-5h-reset")).toBe("5000")
    expect(shown.get("anthropic-ratelimit-unified-7d-utilization")).toBe("0.30")
    expect(shown.get("anthropic-ratelimit-unified-reset")).toBe("5000")
    expect(shown.has("anthropic-ratelimit-unified-representative-claim")).toBe(false)
    expect(shown.has("anthropic-ratelimit-unified-overage-status")).toBe(false)
    expect(shown.get("request-id")).toBe("req_1")

    const low = showPoolInHeaders(shown, [
      new PoolWindow({ span: "7d", used: 96, resetsAt: at(5_000), weighted: false }),
    ])
    expect(low.get("anthropic-ratelimit-unified-status")).toBe("allowed_warning")
    expect(low.get("anthropic-ratelimit-unified-representative-claim")).toBe("seven_day")
    expect(low.get("anthropic-ratelimit-unified-7d-surpassed-threshold")).toBe("0.95")
    expect(low.get("anthropic-ratelimit-unified-7d-status")).toBe("allowed_warning")
    expect(low.has("anthropic-ratelimit-unified-5h-utilization")).toBe(false)
  })

  it("reads the usage endpoint's shared and model-scoped windows", () => {
    const limits = limitsFromUsage(
      {
        five_hour: { utilization: 33.0, resets_at: "2026-10-04T07:20:00.250378+00:00" },
        seven_day: { utilization: 47.0, resets_at: "2026-10-05T04:00:00+00:00" },
        seven_day_opus: null,
        limits: [
          { kind: "session", percent: 33 },
          {
            kind: "weekly_scoped",
            percent: 58,
            resets_at: "2026-10-05T04:00:00+00:00",
            scope: { model: { display_name: "Fable" } },
          },
        ],
      },
      at(0),
    )
    expect(limits.windows.map(windowLabel)).toEqual(["5h", "7d", "7d Fable"])
    // Scoped windows do not drive the score.
    expect(score(limits, at(0))).toBe(47)
  })

  it("tells spent windows from fast mode and from a rejected token", () => {
    expect(claude.verdict(refusal(429, {}, `{"error":{"message":"Fast request rejected"}}`))).toEqual(Verdict.Final())
    expect(
      claude.verdict(
        refusal(429, {
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "5000",
        }),
      ),
    ).toEqual(Verdict.Exhausted({ until: at(5_000) }))
    expect(claude.verdict(refusal(429, {}))).toEqual(Verdict.Throttled({}))
    expect(claude.verdict(refusal(401, {}, ""))).toEqual(Verdict.Unauthorized())
    expect(claude.verdict(refusal(400, {}, ""))).toEqual(Verdict.Final())
  })

  it("blocks a spent account until the latest of its rejected windows' resets", () => {
    const verdict = refusalOf(
      refusal(
        429,
        {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "3000",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d-reset": "9000",
          "retry-after": "60",
        },
        "{}",
        "claude-x",
      ),
    )
    expect(verdict).toEqual(Verdict.Exhausted({ until: at(3_000) }))
  })

  it("caps only the request's model when only the overage window is spent", () => {
    const verdict = refusalOf(
      refusal(
        429,
        {
          "anthropic-ratelimit-unified-status": "rejected",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
          "anthropic-ratelimit-unified-7d_oi-reset": "7000",
        },
        "{}",
        "claude-fable-5",
      ),
    )
    expect(verdict).toEqual(Verdict.Exhausted({ until: at(7_000), model: "claude-fable-5" }))
  })

  it("tells fast mode's want of usage credits from a spent window", () => {
    const body = bytes(
      `{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}`,
    )
    expect(fastModeRefused(new Headers(), body)).toBe(true)
    // A spent window comes first.
    expect(fastModeRefused(new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected" }), body)).toBe(false)
    expect(fastModeRefused(new Headers(), bytes(`{"type":"error","error":{"message":"limit"}}`))).toBe(false)
  })

  it("reads a plain 429 as throttling until retry-after", () => {
    expect(refusalOf(refusal(429, { "retry-after": "5" }))).toEqual(Verdict.Throttled({ until: at(1_005) }))
  })

  it.effect("reads both windows from the usage endpoint, and only the start of a failure", () => {
    const api = usageApi()
    return Effect.gen(function* () {
      const limits = yield* usage(oauthAccount({ access: "good" }))
      expect(limits.windows.map((window) => [window.span, window.used])).toEqual([
        ["5h", 12.5],
        ["7d", 40],
        ["7d", 70],
      ])
      // Older answers name per-model weekly windows at the top level.
      expect(limits.windows[2]?.model).toBe("Opus")
      expect(limits.plan).toBeUndefined()
      expect(api.at("/api/oauth/usage")[0]?.headers.get("anthropic-beta")).toBe(oauthBeta)
      const rejected = yield* Effect.flip(usage(oauthAccount({ access: "bad" })))
      expect(rejected._tag).toBe("ProviderUnauthorized")
      const down = yield* Effect.flip(usage(oauthAccount({ access: "down" })))
      expect(down._tag).toBe("ProviderFailed")
      expect(down.message.startsWith("usage endpoint returned 500")).toBe(true)
      expect(down.message.length).toBeLessThan(300)
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("brings the profile with new tokens, and changes nothing when it cannot", () => {
    const api = usageApi()
    return Effect.gen(function* () {
      const good = yield* claude.identify(oauthAccount({ access: "good" }))
      expect(good.identity.email).toBe("me@x.dev")
      expect(good.identity.plan).toBe("pro")
      const bad = yield* claude.identify(oauthAccount({ access: "bad" }))
      expect(bad.identity.email).toBeUndefined()
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("reports an unreachable usage endpoint as a failure, not a rejected token", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(usage(oauthAccount({ access: "good" })))
      expect(error._tag).toBe("ProviderFailed")
    }).pipe(Effect.provide(downUpstream)),
  )
})

const plan = (value: Profile) => planOf(value)

describe("Claude sign-in", () => {
  it("asks to authorize with PKCE, the scopes, and the registered redirect", () => {
    const url = authorizeUrl("the-challenge", "st")
    expect(url.startsWith("https://claude.ai/oauth/authorize?code=true&client_id=")).toBe(true)
    expect(url).toContain("code_challenge=the-challenge")
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback")
    expect(url).toContain("scope=user%3Aprofile+user%3Ainference")
    expect(url).toContain("code_challenge_method=S256")
    expect(url.endsWith("state=st")).toBe(true)
  })

  it("reads the plan, with Max's multiplier", () => {
    expect(
      plan({
        account: { has_claude_max: true },
        organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
      }),
    ).toBe("max 20x")
    expect(plan({ account: { has_claude_pro: true }, organization: {} })).toBe("pro")
  })

  it("reads the plan from the organization first, and a multiplier only for Max", () => {
    expect(plan({ organization: { organization_type: "claude_team" } })).toBe("team")
    expect(plan({ organization: { organization_type: "claude_max" } })).toBe("max")
    expect(plan({ organization: { organization_type: "claude_pro", rate_limit_tier: "x_5x" } })).toBe("pro")
    expect(plan({ organization: {} })).toBeUndefined()
    expect(plan({ account: { has_claude_max: true } })).toBe("max")
  })

  it("never erases what is known with a blank profile", () => {
    expect(withProfile(new Identity({ email: "me@x.dev" }), {}).email).toBe("me@x.dev")
  })

  it("fills the identity from a profile but skips its blanks", () => {
    const identity = withProfile(new Identity({ orgName: "Kept" }), {
      account: { uuid: "acct", email: "me@x.dev" },
      organization: { uuid: "org", name: "", organization_type: "claude_pro" },
    })
    expect({ ...identity }).toEqual({
      accountId: "acct",
      email: "me@x.dev",
      orgId: "org",
      orgName: "Kept",
      plan: "pro",
    })
  })

  it.effect("exchanges a code for an account identified by its profile", () => {
    const api = anthropic(200, tokenAnswer)
    return Effect.gen(function* () {
      const account = yield* exchange("the-code", "st", "the-verifier")
      expect(account.provider).toBe("claude")
      expect(account.secret).toBe("at")
      const tokens = Option.getOrThrow(account.tokens)
      expect(tokens.refresh === undefined ? undefined : Redacted.value(tokens.refresh)).toBe("rt")
      expect(tokens.expiresAt).toEqual(DateTime.addDuration(at(0), "8 hours"))
      expect(account.identity.accountId).toBe("acct-1")
      expect(account.identity.orgId).toBe("org-1")
      expect(account.identity.orgName).toBe("Acme")
      // The profile's email is the current one.
      expect(account.identity.email).toBe("profile@x.dev")
      expect(account.identity.plan).toBe("max 20x")
      expect(account.id).toMatch(/^claude-[0-9a-f]{8}$/)
      expect(jsonOf(api.at("/v1/oauth/token")[0])).toEqual({
        grant_type: "authorization_code",
        code: "the-code",
        redirect_uri: redirectUri,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        code_verifier: "the-verifier",
        state: "st",
      })
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("keeps the identity the token answer gave when the profile lookup fails", () => {
    const api = anthropic(200, tokenAnswer, 500)
    return Effect.gen(function* () {
      const account = yield* exchange("c", "s", "v")
      expect(account.identity.email).toBe("token@x.dev")
      expect(account.identity.plan).toBeUndefined()
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("says why an exchange failed", () =>
    Effect.gen(function* () {
      const rejected = yield* Effect.flip(
        exchange("c", "s", "v").pipe(Effect.provide(anthropic(400, { error: "invalid_grant" }).layer)),
      )
      expect(rejected.message.startsWith("token exchange failed (400 Bad Request)")).toBe(true)
      const garbled = yield* Effect.flip(
        exchange("c", "s", "v").pipe(Effect.provide(anthropic(200, { nope: true }).layer)),
      )
      expect(garbled.message).toBe("unexpected token response")
    }),
  )

  it.effect("refreshes with the scopes, telling a revoked token from a passing failure", () =>
    Effect.gen(function* () {
      const account = oauthAccount({ access: "old", refresh: "rt" })
      const ok = anthropic(200, { access_token: "new", expires_in: 60 })
      const grant = yield* claude.refresh(account).pipe(Effect.provide(ok.layer))
      expect(grant.access).toBe("new")
      expect(grant.refresh).toBeUndefined()
      expect(grant.expiresAt).toEqual(at(60))
      expect(jsonOf(ok.at("/v1/oauth/token")[0])).toEqual({
        grant_type: "refresh_token",
        refresh_token: "rt",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scope: scopes,
      })
      const revoked = yield* Effect.flip(
        claude.refresh(account).pipe(Effect.provide(anthropic(400, { error: "invalid_grant" }).layer)),
      )
      expect(revoked._tag).toBe("RefreshRevoked")
      const down = yield* Effect.flip(claude.refresh(account).pipe(Effect.provide(anthropic(502, {}).layer)))
      expect(down._tag).toBe("RefreshTransient")
      const garbled = yield* Effect.flip(claude.refresh(account).pipe(Effect.provide(anthropic(200, []).layer)))
      expect(garbled._tag).toBe("RefreshTransient")
      const unreachable = yield* Effect.flip(claude.refresh(account).pipe(Effect.provide(downUpstream)))
      expect(unreachable._tag).toBe("RefreshTransient")
    }),
  )

  it.effect("needs a working token to read a profile", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(profile("at").pipe(Effect.provide(anthropic(200, {}, 401).layer)))
      expect(error._tag).toBe("ProviderFailed")
    }),
  )

  it.live("signs in with a code and state pasted from Anthropic's page", () => {
    const api = anthropic(200, tokenAnswer)
    return Effect.gen(function* () {
      const pastes = yield* Queue.unbounded<string>()
      const told: Array<LoginEvent> = []
      const ui = Layer.succeed(LoginUi)({
        tell: (event) =>
          Effect.gen(function* () {
            told.push(event)
            if (event._tag !== "Authorize") return
            const state = new URL(event.url).searchParams.get("state")
            // Anthropic's manual page shows `code#state`.
            yield* Queue.offer(pastes, `pasted-code#${state}`)
          }),
        pasted: Stream.fromQueue(pastes),
        openBrowser: false,
      })
      const account = yield* Effect.scoped(claude.login({})).pipe(
        Effect.provide(Layer.mergeAll(api.layer, ui, noSpawner)),
      )
      expect(account.secret).toBe("at")
      const authorize = told.find((event) => event._tag === "Authorize")
      expect(authorize).toMatchObject({ opened: false, port: callbackPort, title: "Claude" })
      expect(jsonOf(api.at("/v1/oauth/token")[0])).toMatchObject({ code: "pasted-code" })
    })
  })
})

describe("Claude limit resets", () => {
  it.effect("lists one reset per one left, the grant Claude spends next first, then the soonest to expire", () =>
    Effect.gen(function* () {
      const listed = yield* Effect.fromResult(
        availableResets(
          {
            five_hour: { utilization: 4.0 },
            cedar_ember: {
              eligible: true,
              grants: [
                { id: "late", label: "Later", resets_total: 1, resets_left: 1, ends_at: "2026-12-01T00:00:00+00:00" },
                {
                  id: "opus55-launch-promax-20260921",
                  label: "Claude Opus 5.5 launch:\none usage-limit reset  for Pro and Max",
                  resets_total: 2,
                  resets_left: 2,
                  starts_at: "2026-09-22T16:00:00+00:00",
                  ends_at: "2026-10-22T16:00:00+00:00",
                },
                { id: "soon", resets_total: 1, resets_left: 1, ends_at: "2026-10-09T00:00:00+00:00" },
                { id: "spent", resets_total: 1, resets_left: 0 },
                { id: "lapsed", resets_total: 1, resets_left: 1, ends_at: "2026-10-01T00:00:00+00:00" },
                { id: "Not Valid!", resets_total: 1, resets_left: 1 },
                { id: "no-count" },
              ],
              next_grant_id: "opus55-launch-promax-20260921",
            },
          },
          time("2026-10-07T21:00:00Z"),
        ),
      )
      expect(listed.map((reset) => reset.id)).toEqual([
        "opus55-launch-promax-20260921",
        "opus55-launch-promax-20260921",
        "soon",
        "late",
      ])
      expect(listed[0]?.title).toBe("Claude Opus 5.5 launch: one usage-limit reset for Pro and Max")
      expect(listed[0]?.grantedAt).toEqual(time("2026-09-22T16:00:00Z"))
      expect(listed[0]?.expiresAt).toEqual(time("2026-10-22T16:00:00Z"))
    }),
  )

  it.effect("lists none for a refused caller or an account without any, and fails on odd answers", () =>
    Effect.gen(function* () {
      const now = time("2026-10-07T21:00:00Z")
      const list = (body: unknown) => Effect.fromResult(availableResets(body, now))
      expect(yield* list({ cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] } })).toEqual([])
      expect(yield* list({ cedar_ember: { eligible: false, ineligible_reason: "no_grant" } })).toEqual([])
      expect(yield* list({ cedar_ember: null })).toEqual([])
      expect(yield* list({ five_hour: {} })).toEqual([])
      expect((yield* Effect.flip(list(["not", "usage"]))).message).toBe("unexpected usage reply")
      expect((yield* Effect.flip(list({ cedar_ember: "odd" }))).message).toBe("unexpected limit reset status")
    }),
  )

  it("reads Claude's answers to spending a reset as outcomes", () => {
    expect(claimOutcome("reset", undefined)).toBe("reset")
    expect(claimOutcome("not_limited", "not_limited")).toBe("nothing-to-reset")
    expect(claimOutcome("already_used", "already_used")).toBe("already-redeemed")
    expect(claimOutcome("ineligible", "expired")).toBe("no-credit")
    expect(claimOutcome("cooldown", "cooldown")).toBe("declined")
    expect(claimOutcome("unavailable", "paused")).toBe("declined")
    expect(claimOutcome("something_new", undefined)).toBe("declined")
  })

  it("takes only a UUID as the organization, since it goes in the path", () => {
    expect(isUuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4")).toBe(true)
    expect(isUuid("org-claude0")).toBe(false)
    expect(isUuid("../../v1/messages?x=0b4e1f5a-9c2d-4e8f-a1")).toBe(false)
    expect(isUuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4/x")).toBe(false)
  })

  it.effect("lists and spends nothing before Claude Code has come through", () =>
    Effect.gen(function* () {
      const listing = yield* Effect.flip(resets.list(withOrg(org), undefined))
      expect(listing.message.startsWith("Claude answers limit resets to Claude Code alone")).toBe(true)
      const spending = yield* Effect.flip(resets.redeem(withOrg(org), "g", undefined))
      expect(spending.message).toContain("none of its requests")
      expect(resets.needsAgent).toBe(true)
      expect(resets.counted).toBe(false)
    }).pipe(Effect.provide(downUpstream)),
  )

  it.effect("names the step that failed", () => {
    const api = mockUpstream((seen) => {
      if (seen.url.pathname === "/api/oauth/usage" && seen.headers.get("user-agent") === agent) {
        return json(200, { cedar_ember: { eligible: true, grants: [] } })
      }
      return seen.url.pathname === "/api/oauth/usage" ? reply(503) : reply(500)
    })
    return Effect.gen(function* () {
      const listing = yield* Effect.flip(resets.list(withOrg(org), "other"))
      expect(listing.message).toBe("listing limit resets failed (503 Service Unavailable)")
      expect(api.at("/api/oauth/usage")[0]?.url.search).toBe("?cedar_ember=1&skip_spend=1")
      // Nothing listed: nothing to spend.
      expect(yield* resets.redeem(withOrg(org), undefined, agent)).toBe("no-credit")
      const spending = yield* Effect.flip(resets.redeem(withOrg(org), "grant", agent))
      expect(spending.message).toBe("using a limit reset failed (500 Internal Server Error)")
      const unknown = yield* Effect.flip(resets.redeem(withOrg("not-a-uuid"), "grant", agent))
      expect(unknown.message).toBe("the account's organization is unknown; sign in again")
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("spends a reset as Claude Code, retrying once with the same request id", () => {
    let calls = 0
    const api = mockUpstream((seen) => {
      if (seen.url.pathname !== `/api/organizations/${org}/reset_rate_limits`) return reply(404)
      calls += 1
      if (calls === 1) throw new Error("connection reset")
      return json(200, { result: "reset" })
    })
    return Effect.gen(function* () {
      expect(yield* resets.redeem(withOrg(org), "grant-1", agent)).toBe("reset")
      const [first, second] = api.seen
      expect(first?.headers.get("user-agent")).toBe(agent)
      expect(first?.headers.get("authorization")).toBe("Bearer tok")
      expect(first?.headers.get("anthropic-beta")).toBe(oauthBeta)
      expect(jsonOf(first)).toMatchObject({ program: "cedar_ember", grant_id: "grant-1" })
      expect(jsonOf(second)).toEqual(jsonOf(first))
    }).pipe(Effect.provide(api.layer))
  })

  it.effect("fails after one retry when the server cannot be reached", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resets.redeem(withOrg(org), "grant", agent))
      expect(error._tag).toBe("ProviderFailed")
    }).pipe(Effect.provide(downUpstream)),
  )
})
