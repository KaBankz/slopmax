import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { type Cause, Effect, Queue, Schema } from "effect"

import { Account } from "../../../src/account.ts"
import { type LoginEvent, LoginOptions, Prompt } from "../../../src/auth/mod.ts"
import { Pkce } from "../../../src/auth/pkce.ts"
import {
  applyProfile,
  authorizeUrl,
  CALLBACK_PORT,
  exchange,
  Profile,
  ProfileSchema,
  profile,
  redirectUri,
  refresh,
  SCOPES,
} from "../../../src/provider/claude/oauth.ts"
import { ProviderId } from "../../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json, Mock, reply, Seen } from "../../../src/testkit.ts"

const ORIGINS = ["https://platform.claude.com", "https://api.anthropic.com"]

const profileOf = (value: unknown): Profile => Schema.decodeUnknownSync(ProfileSchema)(value)

const blank = (): Account => Account.make("claude", { accessToken: "" }, 0)

/** Anthropic's token endpoint answering `token`, and a Max 20x profile. */
const anthropic = (status: number, token: unknown, profileStatus: number) =>
  Mock.start((seen) => {
    switch (Seen.route(seen)) {
      case "/v1/oauth/token":
        return json(status, token)
      case "/api/oauth/profile":
        return profileStatus === 200
          ? json(200, {
              account: { email: "profile@x.dev" },
              organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
            })
          : reply(profileStatus, "")
      default:
        return reply(404, "")
    }
  })

const tokenAnswer = () => ({
  access_token: "at",
  refresh_token: "rt",
  expires_in: 28800,
  account: { uuid: "acct-1", email_address: "token@x.dev" },
  organization: { uuid: "org-1", name: "Acme" },
})

const sentJson = (mock: Mock, route: string): Record<string, unknown> => {
  const seen = mock.seenAt(route)[0]
  if (seen === undefined) throw new Error(`nothing sent to ${route}`)
  return Seen.json(seen) as Record<string, unknown>
}

describe("provider/claude/oauth", () => {
  plain("authorize_url_carries_pkce_and_scopes", () => {
    const pkce = Pkce.generate()
    const url = authorizeUrl(pkce, "st")
    expect(url.startsWith("https://claude.ai/oauth/authorize?code=true&client_id=")).toBe(true)
    expect(url).toContain(`code_challenge=${pkce.challenge}`)
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback")
    expect(url).toContain("scope=user%3Aprofile+user%3Ainference")
    expect(url).toContain("state=st")
  })

  plain("plan_from_profile", () => {
    const max = profileOf({
      account: { has_claude_max: true },
      organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" },
    })
    expect(Profile.plan(max)).toBe("max 20x")
    const pro = profileOf({ account: { has_claude_pro: true }, organization: {} })
    expect(Profile.plan(pro)).toBe("pro")
  })

  plain("apply_profile_never_erases_identity", () => {
    const account = { ...blank(), email: "me@x.dev" }
    expect(applyProfile(account, Profile.default()).email).toBe("me@x.dev")
  })

  plain("plans_read_the_organization_first", () => {
    const plan = (org: unknown) => Profile.plan(profileOf({ organization: org }))
    expect(plan({ organization_type: "claude_team" })).toBe("team")
    expect(plan({ organization_type: "claude_max" })).toBe("max")
    // Multipliers only qualify Max.
    expect(plan({ organization_type: "claude_pro", rate_limit_tier: "x_5x" })).toBe("pro")
    expect(plan({})).toBeUndefined()
    expect(Profile.plan(profileOf({ account: { has_claude_max: true } }))).toBe("max")
  })

  plain("profiles_fill_identity_but_skip_blanks", () => {
    const account = { ...blank(), orgName: "Kept" }
    const found = profileOf({
      account: { uuid: "acct", email: "me@x.dev" },
      organization: { uuid: "org", name: "", organization_type: "claude_pro" },
    })
    const applied = applyProfile(account, found)
    expect(applied.accountId).toBe("acct")
    expect(applied.email).toBe("me@x.dev")
    expect(applied.orgId).toBe("org")
    expect(applied.orgName).toBe("Kept")
    expect(applied.plan).toBe("pro")
  })

  it.live("exchanges_codes_for_an_identified_account", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, tokenAnswer(), 200)
      const pkce = Pkce.generate()
      const account = yield* exchange(yield* mock.client(ORIGINS), "the-code", "st", pkce)
      expect(account.provider).toBe("claude")
      expect(account.tokens.accessToken).toBe("at")
      expect(account.tokens.refreshToken).toBe("rt")
      expect(account.tokens.expiresAt).toBeDefined()
      expect(account.accountId).toBe("acct-1")
      expect(account.orgId).toBe("org-1")
      expect(account.orgName).toBe("Acme")
      // The profile's email is the current one.
      expect(account.email).toBe("profile@x.dev")
      expect(account.plan).toBe("max 20x")
      expect(account.id.startsWith("claude-")).toBe(true)

      const sent = sentJson(mock, "/v1/oauth/token")
      expect(sent.grant_type).toBe("authorization_code")
      expect(sent.code).toBe("the-code")
      expect(sent.state).toBe("st")
      expect(sent.code_verifier).toBe(pkce.verifier)
      expect(sent.redirect_uri).toBe(redirectUri())
    }),
  )

  it.live("a_failed_profile_lookup_keeps_the_token_identity", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, tokenAnswer(), 500)
      const account = yield* exchange(yield* mock.client(ORIGINS), "c", "s", Pkce.generate())
      expect(account.email).toBe("token@x.dev")
      expect(account.plan).toBeUndefined()
    }),
  )

  it.live("failed_exchanges_say_why", () =>
    Effect.gen(function* () {
      const rejected = yield* anthropic(400, { error: "invalid_grant" }, 200)
      const err = yield* Effect.flip(exchange(yield* rejected.client(ORIGINS), "c", "s", Pkce.generate()))
      expect(err.message.startsWith("token exchange failed (400 Bad Request)")).toBe(true)
      const garbled = yield* anthropic(200, { nope: true }, 200)
      const again = yield* Effect.flip(exchange(yield* garbled.client(ORIGINS), "c", "s", Pkce.generate()))
      expect(again.message).toBe("unexpected token response")
    }),
  )

  it.live("refresh_classifies_the_token_endpoints_answer", () =>
    Effect.gen(function* () {
      const ok = yield* anthropic(200, { access_token: "new", expires_in: 60 }, 200)
      const grant = yield* refresh(yield* ok.client(ORIGINS), "rt")
      expect(grant.accessToken).toBe("new")
      expect(grant.refreshToken).toBeUndefined()
      expect(grant.expiresAt).toBeDefined()
      const sent = sentJson(ok, "/v1/oauth/token")
      expect(sent.grant_type).toBe("refresh_token")
      expect(sent.scope).toBe(SCOPES)

      const revoked = yield* anthropic(400, { error: "invalid_grant" }, 200)
      expect((yield* Effect.flip(refresh(yield* revoked.client(ORIGINS), "rt")))._tag).toBe("Revoked")
      const down = yield* anthropic(502, {}, 200)
      expect((yield* Effect.flip(refresh(yield* down.client(ORIGINS), "rt")))._tag).toBe("Transient")
      const garbled = yield* anthropic(200, [], 200)
      expect((yield* Effect.flip(refresh(yield* garbled.client(ORIGINS), "rt")))._tag).toBe("Transient")
    }),
  )

  it.live("profiles_need_a_working_token", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, {}, 401)
      const result = yield* Effect.result(profile(yield* mock.client(ORIGINS), "at"))
      expect(result._tag).toBe("Failure")
    }),
  )

  it.live("logs_in_with_a_pasted_code_and_state", () =>
    Effect.gen(function* () {
      const mock = yield* anthropic(200, tokenAnswer(), 200)
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      let authorized: readonly [boolean, number] | undefined
      const prompt = Prompt.make((event: LoginEvent) => {
        if (event._tag === "Authorize") {
          const state = event.url.split("state=").at(-1) ?? ""
          // Anthropic's manual page shows `code#state`.
          Queue.offerUnsafe(lines, `pasted-code#${state}`)
          authorized = [event.opened, event.port]
        }
      }).withPasted(lines)
      const options: LoginOptions = { ...LoginOptions.default(), noBrowser: true }
      const account = yield* ProviderId.get("claude").login(yield* mock.client(ORIGINS), options, prompt)
      expect(account.tokens.accessToken).toBe("at")
      expect(authorized).toEqual([false, CALLBACK_PORT])
      expect(sentJson(mock, "/v1/oauth/token").code).toBe("pasted-code")
    }),
  )
})

describe("provider/claude/oauth, beyond the Rust tests", () => {
  plain("profiles that serde would refuse fail to decode", () => {
    expect(() => profileOf({ account: null })).toThrow()
    expect(() => profileOf({ account: { has_claude_max: "yes" } })).toThrow()
    expect(Profile.plan(profileOf({ organization: { organization_type: "claude_claude_max" } }))).toBe("max")
  })
})
