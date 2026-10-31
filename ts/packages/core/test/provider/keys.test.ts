import { describe, expect, it as plain } from "bun:test"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Client } from "@slopmax/net"
import type { json as Json } from "@slopmax/wire"

import { Account } from "../../src/account.ts"
import { type LoginOptions, LoginOptions as Options, Prompt } from "../../src/auth/mod.ts"
import { ANTHROPIC, check, KeyHeader, meteredVerdict, modelIds, OPENAI, withKey, XAI } from "../../src/provider/keys.ts"
import { Verdict } from "../../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { json, Mock, noEnv, reply, Seen } from "../../src/testkit.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const plainClient = () => Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))

/** A model list for the right credential, 401 for any other, and 500 for the key `flaky`. */
const vendor = () =>
  Mock.start((seen) => {
    const route = Seen.route(seen)
    const bearer = Seen.header(seen, "authorization")
    const xKey = Seen.header(seen, "x-api-key")
    const list = { data: [{ id: "m-1" }, { id: "m-2" }] }
    if (route !== "/v1/models") return reply(401, "")
    if (bearer === "Bearer sk-good" && xKey === undefined) return json(200, list)
    if (bearer === undefined && xKey === "sk-ant-good" && Seen.header(seen, "anthropic-version") === "2023-06-01") {
      return json(200, list)
    }
    if (bearer === "Bearer flaky") return reply(500, "")
    if (bearer === "Bearer garbled") return reply(200, "not json")
    if (bearer === undefined && xKey === undefined) return json(200, { data: [] })
    return reply(401, "")
  })

const VENDORS = ["https://api.openai.com", "https://api.anthropic.com", "https://api.x.ai"]

const keyOptions = (key: string | undefined): LoginOptions =>
  key === undefined ? Options.default() : { ...Options.default(), key }

const key = (k: string) => Account.make("openai", { accessToken: k }, 0)

const prompt = () => Prompt.make(() => {})

describe("provider/keys", () => {
  plain("keys_replace_the_slopmax_key", () => {
    const client = new Headers({ authorization: "Bearer sm-key", "user-agent": "codex_exec/0.160.0" })
    const bearer = withKey(client, "Bearer", "sk-test")
    expect(bearer.get("authorization")).toBe("Bearer sk-test")
    expect(bearer.get("user-agent")).toBe("codex_exec/0.160.0")
    const anthropic = withKey(client, "XApiKey", "sk-ant-test")
    expect(anthropic.get("x-api-key")).toBe("sk-ant-test")
    expect(anthropic.has("authorization")).toBe(false)
    const open = withKey(client, "Bearer", "")
    expect(open.has("authorization")).toBe(false)
  })

  plain("verdicts_tell_funds_from_rate_limits", () => {
    const now = Timestamp.fromSecond(1_000) ?? 0
    const headers = new Headers({ "retry-after": "20" })
    const verdict = (status: number, body: string) => meteredVerdict(status, headers, bytes(body), now)
    expect(verdict(429, '{"error":{"code":"rate_limit_exceeded"}}')).toEqual(
      Verdict.Throttled(Timestamp.add(now, SignedDuration.fromSecs(20))),
    )
    const broke = Verdict.Exhausted(undefined, undefined)
    expect(verdict(429, '{"error":{"code":"insufficient_quota"}}')).toEqual(broke)
    expect(verdict(400, "Your credit balance is too low to access the API")).toEqual(broke)
    expect(verdict(401, "")).toEqual(Verdict.Unauthorized)
    expect(verdict(400, "max_tokens too large")).toEqual(Verdict.Final)
  })

  plain("model_lists_read_either_shape", () => {
    const list: Json.Json = { object: "list", data: [{ id: "grok-4" }, { id: "grok-code-fast-1" }] }
    expect(modelIds(list)).toEqual(["grok-4", "grok-code-fast-1"])
    expect(modelIds({})).toEqual([])
  })

  plain("key_accounts_are_named_by_their_tail", () => {
    const account = Account.make("openai", { accessToken: "sk-proj-abcdWXYZ" }, 0)
    expect(Account.name(account)).toBe("OpenAI API key …WXYZ")
    expect(account.id.startsWith("openai-")).toBe(true)
  })

  it.live("logging_in_checks_the_key_with_the_vendor", () =>
    Effect.gen(function* () {
      const mock = yield* vendor()
      const http = yield* mock.client(VENDORS)
      const account = yield* OPENAI.login(http, keyOptions("sk-good"), prompt())
      expect(account.provider).toBe("openai")
      expect(account.tokens.accessToken).toBe("sk-good")
      expect(OPENAI.identity(account)).toBe("sk-good")

      const anthropic = yield* ANTHROPIC.login(http, keyOptions("sk-ant-good"), prompt())
      expect(anthropic.provider).toBe("anthropic")

      const err = yield* Effect.flip(XAI.login(http, keyOptions("sk-wrong"), prompt()))
      expect(err.message).toContain("rejected the key (401 Unauthorized)")
      for (const missing of [undefined, ""]) {
        const none = yield* Effect.flip(OPENAI.login(http, keyOptions(missing), prompt()))
        expect(none.message).toBe("no OpenAI API key entered")
      }
      // A vendor that cannot answer right now does not block the login.
      const flaky = yield* OPENAI.login(http, keyOptions("flaky"), prompt())
      expect(flaky.tokens.accessToken).toBe("flaky")
    }),
  )

  it.live("checks_tolerate_outages_and_open_endpoints", () =>
    Effect.gen(function* () {
      const mock = yield* vendor()
      const url = `${mock.url}/v1/models`
      const http = yield* plainClient()
      expect(yield* check(http, url, "Bearer", "sk-good")).toEqual(["m-1", "m-2"])
      // No key, no credential header.
      expect(yield* check(http, url, "XApiKey", "")).toEqual([])
      expect(yield* check(http, url, "Bearer", "garbled")).toBeUndefined()
      expect(yield* check(http, "http://127.0.0.1:9/v1/models", "Bearer", "k")).toBeUndefined()
      const forbidden = yield* Mock.start(() => reply(403, ""))
      const err = yield* Effect.flip(check(http, `${forbidden.url}/models`, "Bearer", "k"))
      expect(err.message.endsWith("rejected the key (403 Forbidden)")).toBe(true)
    }),
  )

  it.live("catalogs_list_what_the_key_can_use", () =>
    Effect.gen(function* () {
      const mock = yield* vendor()
      const http = yield* mock.client(VENDORS)
      expect(yield* OPENAI.catalog(http, key("sk-good"), "")).toEqual(["m-1", "m-2"])
      expect(yield* OPENAI.catalog(http, key("flaky"), "")).toEqual([])
      expect((yield* Effect.result(OPENAI.catalog(http, key("revoked"), "")))._tag).toBe("Failure")
    }),
  )

  it.live("keys_have_no_windows_refreshes_or_state", () =>
    Effect.gen(function* () {
      const account = Account.make("xai", { accessToken: "xai-key" }, 0)
      const http = yield* plainClient()
      const usage = yield* Effect.flip(XAI.usage(http, account))
      expect(usage._tag).toBe("Failure")
      expect(usage.message).toBe("xAI API has no usage windows")
      const refreshed = yield* Effect.flip(XAI.refresh(http, "rt"))
      expect(refreshed.message).toBe("xAI API keys cannot be refreshed; log in again")
      const identified = yield* XAI.identify(http, account)
      expect(identified.email).toBeUndefined()
      expect(XAI.api(account)).toBe("https://api.x.ai/v1")
      expect(XAI.dialects(account)).toEqual(["chat"])
      expect(XAI.serves(account, "grok-4")).toBe(true)
      expect(XAI.serves(account, "gpt-6")).toBe(false)
      expect(XAI.rebind(bytes("{}"))).toBeUndefined()
      const body: Json.Json = { max_tokens: 5 }
      XAI.shape("chat", body)
      expect(body).toEqual({ max_tokens: 5 })
      expect(XAI.limits(new Headers(), Timestamp.nowUnsafe())).toBeUndefined()
      const headers = new Headers()
      XAI.showPool([], headers)
      expect([...headers.keys()]).toEqual([])
      expect(XAI.credits()).toBeUndefined()

      expect(XAI.headers(new Headers(), account, false).get("authorization")).toBe("Bearer xai-key")
      expect(ANTHROPIC.headers(new Headers(), account, false).get("x-api-key")).toBe("xai-key")
      expect(XAI.verdict(402, new Headers(), bytes(""), undefined, Timestamp.nowUnsafe())).toEqual(
        Verdict.Exhausted(undefined, undefined),
      )
    }),
  )

  plain("overload_throttles_briefly", () => {
    const now = Timestamp.fromSecond(1_000) ?? 0
    for (const status of [503, 529]) {
      expect(meteredVerdict(status, new Headers(), bytes("overloaded"), now)).toEqual(Verdict.Throttled(undefined))
    }
    expect(meteredVerdict(403, new Headers(), bytes(""), now)).toEqual(Verdict.Forbidden)
    expect(KeyHeader.forDialect("responses")).toBe("Bearer")
    expect(KeyHeader.forDialect("messages")).toBe("XApiKey")
  })
})

describe("provider/keys, beyond the Rust tests", () => {
  plain("only the start of a body is read for funds, and the vendors' ids are their keys", () => {
    const late = `${" ".repeat(4096)}insufficient_quota`
    expect(meteredVerdict(400, new Headers(), bytes(late), 0)).toEqual(Verdict.Final)
    expect(meteredVerdict(402, new Headers(), bytes(""), 0)).toEqual(Verdict.Exhausted(undefined, undefined))
    expect(Account.make("anthropic", { accessToken: "k" }, 0).id.startsWith("anthropic-")).toBe(true)
    expect(Account.make("xai", { accessToken: "k" }, 0).id.startsWith("xai-")).toBe(true)
    expect(KeyHeader.forDialect("chat")).toBe("Bearer")
  })
})
