import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { type Cause, Effect, Fiber, Queue } from "effect"
import { TestClock } from "effect/testing"

import { Timestamp } from "@slopmax/common"
import { Client, form, Origins } from "@slopmax/net"

import { Account } from "../../../src/account.ts"
import { encodeUnsigned } from "../../../src/auth/jwt.ts"
import { LoginEvent, LoginOptions, Prompt } from "../../../src/auth/mod.ts"
import { Pkce } from "../../../src/auth/pkce.ts"
import {
  applyClaims,
  AUTH_CLAIM,
  authorizeUrl,
  CLIENT_ID,
  DEVICE_REDIRECT_URI,
  DEVICE_VERIFY_URL,
  deviceLogin,
  exchange,
  ISSUER,
  login,
  PROFILE_CLAIM,
  redirectUri,
  refresh,
} from "../../../src/provider/codex/oauth.ts"
import { ProviderId } from "../../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../../src/testkit.ts"

const tokens = () => ({
  access_token: encodeUnsigned({ exp: 1_900_000_000 }),
  refresh_token: "rt",
  id_token: encodeUnsigned({
    email: "me@x.dev",
    [AUTH_CLAIM]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "plus" },
  }),
})

/**
 * auth.openai.com: the token endpoint answers `status` with `token`;
 * device-code polls are pending until the `ready`th.
 */
const openai = (status: number, token: unknown, ready: number) => {
  let polls = 0
  return Mock.start((seen) => {
    switch (Seen.route(seen)) {
      case "/oauth/token":
        return json(status, token)
      case "/api/accounts/deviceauth/usercode":
        return json(200, { device_auth_id: "dev-1", usercode: "ABCD-1234", interval: "0" })
      case "/api/accounts/deviceauth/token": {
        const poll = ++polls
        if (poll < ready) return reply(poll % 2 === 0 ? 404 : 403, "")
        if (poll === ready) return json(200, { authorization_code: "dev-code", code_verifier: "dev-verifier" })
        return reply(500, "device flow broke")
      }
      default:
        return reply(404, "")
    }
  })
}

const formOf = (mock: Mock, route: string): Array<[string, string]> => {
  const seen = mock.seenAt(route)[0]
  return seen === undefined ? [] : form.decode(Seen.text(seen))
}

const field = (pairs: ReadonlyArray<readonly [string, string]>, name: string): string | undefined =>
  pairs.find(([k]) => k === name)?.[1]

const recording = () => {
  const events: Array<LoginEvent> = []
  return { prompt: Prompt.make((e) => events.push(e)), events }
}

describe("provider/codex/oauth", () => {
  plain("authorize_url_uses_registered_redirect", () => {
    const url = authorizeUrl(Pkce.generate(), "st")
    expect(url.startsWith("https://auth.openai.com/oauth/authorize?response_type=code")).toBe(true)
    expect(url).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback")
    expect(url).toContain("codex_cli_simplified_flow=true")
    expect(url).toContain("prompt=login")
  })

  plain("claims_fill_identity_leniently", () => {
    const idToken = encodeUnsigned({
      email: "me@x.dev",
      aud: "single-string-audience",
      [AUTH_CLAIM]: { chatgpt_account_id: "ws-1", chatgpt_plan_type: "pro" },
    })
    const access = encodeUnsigned({ exp: 1_900_000_000 })
    const account = applyClaims(Account.make("codex", { accessToken: access, idToken }, 0))
    expect(account.email).toBe("me@x.dev")
    expect(account.accountId).toBe("ws-1")
    expect(account.plan).toBe("pro")
    expect(account.id.startsWith("codex-")).toBe(true)
  })

  plain("email_falls_back_to_access_token_profile_claim", () => {
    const access = encodeUnsigned({
      [PROFILE_CLAIM]: { email: "p@x.dev" },
      [AUTH_CLAIM]: { chatgpt_account_id: "ws-2" },
    })
    const account = applyClaims(Account.make("codex", { accessToken: access }, 0))
    expect(account.email).toBe("p@x.dev")
    expect(account.accountId).toBe("ws-2")
  })

  it.live("exchanges_codes_for_an_account_named_by_its_claims", () =>
    Effect.gen(function* () {
      const mock = yield* openai(200, tokens(), 1)
      const account = yield* exchange(yield* mock.client([ISSUER]), "code-1", "verifier", "http://cb")
      expect(account.provider).toBe("codex")
      expect(account.email).toBe("me@x.dev")
      expect(account.accountId).toBe("ws-1")
      expect(account.plan).toBe("plus")
      expect(account.tokens.expiresAt).toBe(Timestamp.fromSecond(1_900_000_000))
      expect(account.tokens.refreshToken).toBe("rt")

      const sent = formOf(mock, "/oauth/token")
      expect(field(sent, "grant_type")).toBe("authorization_code")
      expect(field(sent, "code")).toBe("code-1")
      expect(field(sent, "code_verifier")).toBe("verifier")
      expect(field(sent, "redirect_uri")).toBe("http://cb")
      expect(field(sent, "client_id")).toBe(CLIENT_ID)
    }),
  )

  it.live("failed_exchanges_say_why", () =>
    Effect.gen(function* () {
      const rejected = yield* openai(403, { error: "denied" }, 1)
      const err = yield* Effect.flip(exchange(yield* rejected.client([ISSUER]), "c", "v", "r"))
      expect(err.message.startsWith("token exchange failed (403")).toBe(true)
      const garbled = yield* openai(200, { id_token: "x" }, 1)
      const again = yield* Effect.flip(exchange(yield* garbled.client([ISSUER]), "c", "v", "r"))
      expect(again.message).toBe("unexpected token response")
    }),
  )

  it.live("refresh_sends_json_and_classifies_failures", () =>
    Effect.gen(function* () {
      const ok = yield* openai(200, tokens(), 1)
      const grant = yield* ProviderId.get("codex").refresh(yield* ok.client([ISSUER]), "rt-old")
      expect(grant.idToken).toBeDefined()
      expect(grant.expiresAt).toBe(Timestamp.fromSecond(1_900_000_000))
      const sent = ok.seenAt("/oauth/token")[0]
      expect(sent && Seen.json(sent)).toEqual({
        client_id: CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "rt-old",
      })

      const reused = yield* openai(400, { error: { code: "refresh_token_reused" } }, 1)
      expect((yield* Effect.flip(refresh(yield* reused.client([ISSUER]), "rt")))._tag).toBe("Revoked")
      const down = yield* openai(500, {}, 1)
      expect((yield* Effect.flip(refresh(yield* down.client([ISSUER]), "rt")))._tag).toBe("Transient")
      const garbled = yield* openai(200, {}, 1)
      expect((yield* Effect.flip(refresh(yield* garbled.client([ISSUER]), "rt")))._tag).toBe("Transient")
      const nowhere = yield* Client.builder()
        .plainHttp()
        .origins(new Origins([[ISSUER, "http://127.0.0.1:9"]]))
        .build()
        .pipe(Effect.provide(noEnv))
      expect((yield* Effect.flip(refresh(nowhere, "rt")))._tag).toBe("Transient")
    }),
  )

  it.live(
    "device_codes_sign_in_once_approved",
    () =>
      Effect.gen(function* () {
        // Two pending polls (403, then 404), then approval.
        const mock = yield* openai(200, tokens(), 3)
        const { prompt, events } = recording()
        const options: LoginOptions = { ...LoginOptions.default(), device: true }
        const account = yield* login(yield* mock.client([ISSUER]), options, prompt)
        expect(account.accountId).toBe("ws-1")
        expect(events).toEqual([LoginEvent.DeviceCode(DEVICE_VERIFY_URL, "ABCD-1234")])
        const polls = mock.seenAt("/api/accounts/deviceauth/token")
        expect(polls.length).toBe(3)
        expect(polls[0] && Seen.json(polls[0])).toEqual({ device_auth_id: "dev-1", user_code: "ABCD-1234" })
        const exchanged = formOf(mock, "/oauth/token")
        expect(exchanged).toContainEqual(["code", "dev-code"])
        expect(exchanged).toContainEqual(["code_verifier", "dev-verifier"])
        expect(exchanged).toContainEqual(["redirect_uri", DEVICE_REDIRECT_URI])
      }),
    10_000,
  )

  it.live("device_logins_report_failures", () =>
    Effect.gen(function* () {
      // Approval never comes: the first poll fails outright.
      const mock = yield* openai(200, tokens(), 0)
      const err = yield* Effect.flip(
        deviceLogin(
          yield* mock.client([ISSUER]),
          Prompt.make(() => {}),
        ),
      )
      expect(err.message).toBe("device login failed (500 Internal Server Error): device flow broke")

      const missing = yield* Mock.start(() => reply(404, ""))
      const unavailable = yield* Effect.flip(
        deviceLogin(
          yield* missing.client([ISSUER]),
          Prompt.make(() => {}),
        ),
      )
      expect(unavailable.message).toBe("device login is unavailable")
    }),
  )

  it.live("browser_logins_accept_a_pasted_redirect", () =>
    Effect.gen(function* () {
      const mock = yield* openai(200, tokens(), 1)
      const lines = yield* Queue.unbounded<string, Cause.Done>()
      let title: string | undefined
      const prompt = Prompt.make((event) => {
        if (event._tag === "Authorize") {
          title = event.title
          const state = event.url
            .split("&")
            .find((p) => p.startsWith("state="))
            ?.slice("state=".length)
          Queue.offerUnsafe(lines, `${redirectUri()}?code=browser-code&state=${state}`)
        }
      }).withPasted(lines)
      const options: LoginOptions = { ...LoginOptions.default(), noBrowser: true }
      const account = yield* ProviderId.get("codex").login(yield* mock.client([ISSUER]), options, prompt)
      expect(title).toBe("ChatGPT")
      expect(account.email).toBe("me@x.dev")
      const sent = formOf(mock, "/oauth/token")
      expect(sent).toContainEqual(["code", "browser-code"])
      expect(sent).toContainEqual(["redirect_uri", redirectUri()])
    }),
  )
})

describe("provider/codex/oauth, beyond the Rust tests", () => {
  it.effect("device codes expire after fifteen minutes", () =>
    Effect.gen(function* () {
      // Every poll is pending; the clock runs past the deadline.
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/api/accounts/deviceauth/usercode"
          ? json(200, { device_auth_id: "d", user_code: "U", interval: 600 })
          : reply(403, ""),
      )
      const http = yield* mock.client([ISSUER])
      const fiber = yield* Effect.forkChild(
        deviceLogin(
          http,
          Prompt.make(() => {}),
        ),
      )
      for (let i = 0; i < 4; i++) {
        // Real time for the mock to answer, then the clock jumps a poll ahead.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
        yield* TestClock.adjust("10 minutes")
      }
      const err = yield* Effect.flip(Fiber.join(fiber))
      expect(err.message).toBe("device code expired; run login again")
      expect(mock.seenAt("/api/accounts/deviceauth/token").length).toBe(2)
    }),
  )
})
