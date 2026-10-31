// API keys, billed per token: Anthropic, OpenAI, and xAI.
//
// A key is stored as an access token that never expires. Requests keep the
// agent's own headers, with the key in place of the slopmax key.
import { Effect } from "effect"

import { log, SignedDuration, Timestamp } from "@slopmax/common"
import { type Client, client } from "@slopmax/net"
import { type Dialect, json } from "@slopmax/wire"

import { Account } from "../account.ts"
import type { LoginOptions } from "../auth/mod.ts"
import { Failure } from "../error.ts"
import { retryAfter } from "../limits.ts"
import { forwardable, insert } from "../proxy/headers.ts"
import { API } from "./claude/mod.ts"
import { MODELS } from "./codex/mod.ts"
import {
  Billing,
  Credential,
  defineProvider,
  jsonBody,
  type Provider,
  type ProviderId,
  type Spec,
  Verdict,
} from "./mod.ts"

/** How a key is presented. */
export type KeyHeader =
  /** `x-api-key`, as Anthropic-style APIs expect. */
  | "XApiKey"
  /** `authorization: Bearer`, as OpenAI-style APIs expect. */
  | "Bearer"

export const KeyHeader = {
  /** The usual header for an API speaking `dialect`. */
  forDialect: (dialect: Dialect): KeyHeader => (dialect === "messages" ? "XApiKey" : "Bearer"),
} as const

const ANTHROPIC_SPEC: Spec = {
  id: "anthropic",
  title: "Anthropic API",
  api: API,
  dialects: ["messages"],
  models: ["claude-*"],
  billing: Billing.Metered("claude"),
  // slopmax serves Claude models to Claude Code only.
  agentOnly: "claude",
  refreshLead: SignedDuration.ZERO,
  credential: Credential.Key(false),
}

const OPENAI_SPEC: Spec = {
  id: "openai",
  title: "OpenAI API",
  api: "https://api.openai.com/v1",
  dialects: ["responses", "chat"],
  models: MODELS,
  billing: Billing.Metered("codex"),
  agentOnly: undefined,
  refreshLead: SignedDuration.ZERO,
  credential: Credential.Key(false),
}

const XAI_SPEC: Spec = {
  id: "xai",
  title: "xAI API",
  api: "https://api.x.ai/v1",
  dialects: ["chat"],
  models: ["grok-*"],
  billing: Billing.Metered(undefined),
  agentOnly: undefined,
  refreshLead: SignedDuration.ZERO,
  credential: Credential.Key(false),
}

/** A key's identity: the key itself. */
export const identity = (account: Account): string | undefined => account.tokens.accessToken

/**
 * A provider whose accounts are API keys. `modelsUrl` is where the API
 * lists its models, which checks a new key.
 */
const keyProvider = (id: ProviderId, spec: Spec, modelsUrl: string): Provider => {
  const keyHeader = (): KeyHeader => KeyHeader.forDialect(spec.dialects[0] ?? "chat")
  return defineProvider({
    spec,
    identity,
    login: Effect.fn("keys.login")(function* (http: Client, options: LoginOptions) {
      const key = options.key
      if (key === undefined || key === "") {
        return yield* Effect.fail(new Failure({ message: `no ${spec.title} key entered` }))
      }
      yield* check(http, modelsUrl, keyHeader(), key)
      return Account.make(id, { accessToken: key }, yield* Timestamp.now)
    }),
    headers: (incoming, account) => withKey(incoming, keyHeader(), account.tokens.accessToken),
    catalog: (http, account) =>
      Effect.map(
        check(http, modelsUrl, keyHeader(), account.tokens.accessToken),
        (listed): ReadonlyArray<string> => listed ?? [],
      ),
    verdict: (status, headers, body, _model, now) => meteredVerdict(status, headers, body, now),
  })
}

export const ANTHROPIC: Provider = keyProvider("anthropic", ANTHROPIC_SPEC, "https://api.anthropic.com/v1/models")

export const OPENAI: Provider = keyProvider("openai", OPENAI_SPEC, "https://api.openai.com/v1/models")

export const XAI: Provider = keyProvider("xai", XAI_SPEC, "https://api.x.ai/v1/models")

/** The agent's headers with `key` as the credential (none when empty). */
export const withKey = (incoming: Headers, header: KeyHeader, key: string): Headers => {
  const headers = forwardable(incoming)
  if (key === "") return headers
  if (header === "XApiKey") insert(headers, "x-api-key", key)
  else insert(headers, "authorization", `Bearer ${key}`)
  return headers
}

/**
 * Lists models at `url` with `key`, so a mistyped or revoked key fails now
 * rather than on the first request. Returns the model ids when the list
 * could be read; a network failure is only a warning.
 */
export const check = Effect.fn("keys.check")(function* (http: Client, url: string, header: KeyHeader, key: string) {
  const request = http.get(url)
  if (key !== "") {
    if (header === "XApiKey") request.header("x-api-key", key).header("anthropic-version", "2023-06-01")
    else request.bearerAuth(key)
  }
  const sent = yield* Effect.result(request.send())
  if (sent._tag === "Failure") {
    log.warn(`could not check the key against ${url}: ${sent.failure.message}`)
    return undefined
  }
  const response = sent.success
  const status = response.status
  if (client.isSuccess(status)) {
    const list = yield* Effect.option(jsonBody(response))
    return list._tag === "Some" ? modelIds(list.value) : undefined
  }
  if (status === 401 || status === 403) {
    return yield* Effect.fail(new Failure({ message: `${url} rejected the key (${client.statusText(status)})` }))
  }
  log.warn(`could not check the key: ${url} answered ${client.statusText(status)}`)
  return undefined
})

/**
 * The ids in a model list (`{"data": [{"id": …}]}`, as OpenAI- and
 * Anthropic-style APIs both answer).
 */
export const modelIds = (list: json.Json): Array<string> => {
  const ids: Array<string> = []
  for (const m of json.array(json.get(list, "data")) ?? []) {
    const id = json.str(json.get(m, "id"))
    if (id !== undefined) ids.push(id)
  }
  return ids
}

const decoder = new TextDecoder()

const OUT_OF_FUNDS = ["insufficient_quota", "credit balance", "exceeded your current quota"]

/**
 * How pay-per-token APIs refuse: a key out of funds sits out, rate limits
 * and overload briefly throttle it, and anything else is the request's.
 */
export const meteredVerdict = (status: number, headers: Headers, body: Uint8Array, now: Timestamp): Verdict => {
  const text = decoder.decode(body.subarray(0, 4096))
  const outOfFunds = OUT_OF_FUNDS.some((needle) => text.includes(needle))
  if (status === 402) return Verdict.Exhausted(undefined, undefined)
  if ((status === 400 || status === 429) && outOfFunds) return Verdict.Exhausted(undefined, undefined)
  if (status === 429 || status === 503 || status === 529) return Verdict.Throttled(retryAfter(headers, now))
  return Verdict.ofStatus(status)
}
