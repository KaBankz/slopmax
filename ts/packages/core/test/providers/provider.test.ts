import { describe, expect } from "bun:test"
import { providerFacts, providerOrder } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Effect, Option, Redacted } from "effect"
import { Account, Credential, Identity, identityKey } from "../../src/account.ts"
import {
  forwardable,
  headerNumber,
  headerTime,
  type LoginOptions,
  parseTime,
  refreshRefused,
  retryAfter,
  tokensOf,
  Verdict,
  verdictOfStatus,
} from "../../src/providers/provider.ts"
import { providers } from "../../src/providers/registry.ts"
import { at, downUpstream, keyAccount, oauthAccount } from "./support.ts"

const revoked = (status: number, body: string) => refreshRefused(status, body)._tag === "RefreshRevoked"

describe("providers", () => {
  it("keep the answers every provider treats alike: 401 is the token, 403 the account, the rest the request's", () => {
    expect(verdictOfStatus(401)).toEqual(Verdict.Unauthorized())
    expect(verdictOfStatus(403)).toEqual(Verdict.Forbidden())
    expect(verdictOfStatus(400)).toEqual(Verdict.Final())
    expect(verdictOfStatus(500)).toEqual(Verdict.Final())
    const refusal = { status: 401, headers: new Headers(), body: new Uint8Array(), now: at(0) }
    for (const id of providerOrder) expect(providers[id].verdict(refusal)).toEqual(Verdict.Unauthorized())
  })

  it.effect("list no models for a subscription without a catalog", () =>
    Effect.gen(function* () {
      const models = yield* providers.claude.catalog(oauthAccount({ access: "t" }), {})
      expect(models).toEqual([])
    }).pipe(Effect.provide(downUpstream)),
  )

  it("have one entry per provider id, in registry order, each with its own facts", () => {
    expect(Object.keys(providers)).toEqual([...providerOrder])
    for (const id of providerOrder) {
      expect(providers[id].id).toBe(id)
      expect(providers[id].title).toBe(providerFacts[id].title)
    }
  })

  it("let each metered provider back only a subscription", () => {
    for (const id of providerOrder) {
      const backs = providers[id].backs
      if (backs !== undefined) expect(providers[backs].billing).toBe("subscription")
    }
  })

  it("name accounts by the same identity their ids are assigned from", () => {
    const claude = oauthAccount({ access: "t", refresh: "r", identity: new Identity({ orgId: "org", accountId: "a" }) })
    expect(providers.claude.identity(claude)).toBe(identityKey(claude))
    const codex = oauthAccount({ provider: "codex", access: "t", identity: new Identity({ accountId: "ws" }) })
    expect(providers.codex.identity(codex)).toBe(identityKey(codex))
    const key = keyAccount("openai", "sk-1")
    expect(providers.openai.identity(key)).toBe(identityKey(key))
    const endpoint = new Account({
      ...keyAccount("compat", "k"),
      credential: Credential.cases.Endpoint.make({
        baseUrl: "http://localhost:11434/v1",
        dialect: "chat",
        models: ["qwen*"],
        key: Redacted.make("k"),
      }),
    })
    expect(providers.compat.identity(endpoint)).toBe(identityKey(endpoint))
  })

  it("forward everything but hop-by-hop headers, the agent's credentials, cookies and slopmax's own", () => {
    const out = forwardable(
      new Headers({
        authorization: "Bearer sm-key",
        "x-api-key": "sm-key",
        connection: "keep-alive",
        cookie: "a=b",
        host: "127.0.0.1",
        "content-length": "12",
        "x-slopmax-affinity": "off",
        "accept-encoding": "gzip, br",
        "x-app": "cli",
      }),
    )
    expect([...out.keys()].toSorted()).toEqual(["accept-encoding", "x-app"])
    expect(out.get("accept-encoding")).toBe("gzip, br")
  })

  it("read header numbers trimmed and finite, and times as unix seconds without the fraction", () => {
    const headers = new Headers({ a: " 0.5 ", b: "NaN", c: "1700000000.9", d: "soon" })
    expect(headerNumber(headers, "a")).toEqual(Option.some(0.5))
    expect(headerNumber(headers, "b")).toEqual(Option.none())
    expect(headerNumber(headers, "missing")).toEqual(Option.none())
    expect(headerTime(headers, "c")).toEqual(Option.some(at(1_700_000_000)))
    expect(headerTime(headers, "d")).toEqual(Option.none())
  })

  it("read retry-after as seconds from now, never negative, or as an HTTP date", () => {
    const now = at(1_000)
    expect(retryAfter(new Headers({ "retry-after": "20" }), now)).toEqual(Option.some(at(1_020)))
    expect(retryAfter(new Headers({ "retry-after": "1.5" }), now)).toEqual(Option.some(DateTime.makeUnsafe(1_001_500)))
    expect(retryAfter(new Headers({ "retry-after": "-5" }), now)).toEqual(Option.some(now))
    expect(retryAfter(new Headers({ "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT" }), now)).toEqual(
      Option.some(DateTime.makeUnsafe(Date.UTC(2015, 9, 21, 7, 28))),
    )
    expect(retryAfter(new Headers(), now)).toEqual(Option.none())
  })

  it("read times in answers as RFC 3339 with any offset, or as unix seconds", () => {
    expect(parseTime("2026-01-01T02:00:00+02:00")).toEqual(Option.some(DateTime.makeUnsafe(Date.UTC(2026, 0, 1))))
    expect(parseTime(1_700_000_000.7)).toEqual(Option.some(at(1_700_000_000)))
    expect(parseTime("tomorrow")).toEqual(Option.none())
    expect(parseTime(undefined)).toEqual(Option.none())
  })

  it("tell a revoked refresh token from a passing failure", () => {
    expect(revoked(400, `{"error": "invalid_grant"}`)).toBe(true)
    expect(revoked(401, `{"error":{"code":"token_expired"}}`)).toBe(true)
    expect(revoked(400, `{"error":{"code":"refresh_token_reused"}}`)).toBe(true)
    expect(revoked(429, "slow down")).toBe(false)
    expect(revoked(502, "invalid_grant")).toBe(false)
    expect(revoked(400, "malformed")).toBe(false)
  })

  it("word refresh failures as what to do about them", () => {
    expect(refreshRefused(401, "").message).toBe("refresh token rejected (401 Unauthorized); sign in again")
    expect(refreshRefused(502, "upstream").message).toBe("token refresh failed (502 Bad Gateway): upstream")
  })

  it("turn grants into tokens stamped as refreshed now", () => {
    const now = at(1_000)
    const tokens = tokensOf({ access: "a", refresh: "r", idToken: "i", expiresAt: at(1_060) }, now)
    expect(Redacted.value(tokens.access)).toBe("a")
    expect(tokens.refresh === undefined ? undefined : Redacted.value(tokens.refresh)).toBe("r")
    expect(tokens.idToken === undefined ? undefined : Redacted.value(tokens.idToken)).toBe("i")
    expect(tokens.refreshedAt).toEqual(now)
    expect(tokens.isExpired(now)).toBe(false)
  })

  it("never show a sign-in's key when its options are printed", () => {
    const options: LoginOptions = { key: Redacted.make("sk-secret"), device: true }
    const shown = [String(options.key), JSON.stringify(options), Bun.inspect(options)].join(" ")
    expect(shown).not.toContain("sk-secret")
    expect(shown).toContain("<redacted>")
    expect(shown).toContain("device")
  })
})
