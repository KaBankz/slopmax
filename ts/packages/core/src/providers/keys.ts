// API keys, paid per token: Anthropic, OpenAI and xAI. Each is the same
// provider over different data, built by `keyProvider`.
//
// A key never expires and is never refreshed. Requests keep the agent's
// own headers with the key in place of slopmax's. A new key is checked
// against the vendor's model list, so a mistyped or revoked key fails when
// it is added rather than on the first request.
import { type Dialect, type ProviderId, providerFacts } from "@slopmax/domain"
import { DateTime, Effect, Option, Redacted, Schema } from "effect"
import { HttpClientRequest } from "effect/http"
import { Credential } from "../account.ts"
import type { Upstream } from "../upstream.ts"
import {
  bodyText,
  callText,
  defineProvider,
  exhausted,
  forwardable,
  listOf,
  LoginFailed,
  newAccount,
  optionalField,
  type Provider,
  ProviderFailed,
  type Refusal,
  retryAfter,
  send,
  statusLine,
  throttled,
  type Verdict,
  verdictOfStatus,
} from "./provider.ts"

/** How an API takes a key: `x-api-key` (Anthropic-style) or `authorization: Bearer` (OpenAI-style). */
export type KeyHeader = "x-api-key" | "bearer"

/** The usual header for an API that speaks `dialect`. */
export const keyHeaderFor = (dialect: Dialect): KeyHeader => (dialect === "messages" ? "x-api-key" : "bearer")

/** The agent's headers with `key` as the credential; none when the key is empty. */
export const withKey = (client: Headers, header: KeyHeader, key: string): Headers => {
  const out = forwardable(client)
  if (key === "") return out
  if (header === "x-api-key") out.set("x-api-key", key)
  else out.set("authorization", `Bearer ${key}`)
  return out
}

const decodeModelList = Schema.decodeUnknownOption(
  Schema.Struct({ data: optionalField(listOf(Schema.Struct({ id: Schema.String }))) }),
)

/** The ids in a model list, `{"data": [{"id": …}]}`, as OpenAI- and Anthropic-style APIs both answer. */
export const modelIds = (list: unknown): ReadonlyArray<string> =>
  Option.match(decodeModelList(list), {
    onNone: () => [],
    onSome: ({ data }) => (data ?? []).map((model) => model.id),
  })

/**
 * Lists the models at `url` with `key`. A refused key fails; an outage or
 * an odd answer is only a warning, so a vendor having a bad minute never
 * stops someone adding a key. Gives the ids when the list could be read.
 */
export const checkKey = (
  url: string,
  header: KeyHeader,
  key: string,
): Effect.Effect<Option.Option<ReadonlyArray<string>>, ProviderFailed, Upstream> =>
  Effect.gen(function* () {
    const base = HttpClientRequest.get(url)
    const request =
      key === ""
        ? base
        : header === "x-api-key"
          ? base.pipe(
              HttpClientRequest.setHeader("x-api-key", key),
              HttpClientRequest.setHeader("anthropic-version", "2023-06-01"),
            )
          : HttpClientRequest.bearerToken(base, key)
    const reply = yield* Effect.result(send(request))
    if (reply._tag === "Failure") {
      yield* Effect.logWarning(`could not check the key against ${url}: ${callText(reply.failure)}`)
      return Option.none()
    }
    const { status, ok, json } = reply.success
    if (ok) return Option.map(json, modelIds)
    if (status === 401 || status === 403) {
      return yield* new ProviderFailed({ message: `${url} rejected the key (${statusLine(status)})`, status })
    }
    yield* Effect.logWarning(`could not check the key: ${url} answered ${statusLine(status)}`)
    return Option.none()
  })

const outOfFunds = ["insufficient_quota", "credit balance", "exceeded your current quota"]

/**
 * How pay-per-token APIs refuse: a key out of funds sits out, rate limits
 * and overload briefly throttle it, and anything else is the request's.
 */
export const meteredVerdict = ({ status, headers, body, now }: Refusal): Verdict => {
  const text = bodyText(body.subarray(0, 4096))
  const broke = outOfFunds.some((needle) => text.includes(needle))
  if (status === 402 || ((status === 400 || status === 429) && broke)) return exhausted(Option.none())
  if (status === 429 || status === 503 || status === 529) return throttled(retryAfter(headers, now))
  return verdictOfStatus(status)
}

/** A provider whose accounts are API keys, checked against `modelsUrl`. */
export const keyProvider = (id: Extract<ProviderId, "anthropic" | "openai" | "xai">, modelsUrl: string): Provider => {
  const facts = providerFacts[id]
  const header = keyHeaderFor(facts.dialects[0] ?? "chat")
  return defineProvider({
    id,
    identity: (account) => (account.credential._tag === "Key" ? Redacted.value(account.credential.key) : undefined),
    login: (options) =>
      Effect.gen(function* () {
        const key = options.key === undefined ? "" : Redacted.value(options.key).trim()
        if (key === "") return yield* new LoginFailed({ message: `no ${facts.title} key entered` })
        yield* checkKey(modelsUrl, header, key).pipe(
          Effect.mapError((error) => new LoginFailed({ message: error.message })),
        )
        return yield* newAccount({
          provider: id,
          credential: Credential.cases.Key.make({ key: Redacted.make(key) }),
          now: yield* DateTime.now,
        })
      }),
    headers: ({ client, account }) => withKey(client, header, account.secret),
    catalog: (account) =>
      Effect.map(
        checkKey(modelsUrl, header, account.secret),
        Option.getOrElse(() => []),
      ),
    verdict: meteredVerdict,
  })
}

export const anthropic: Provider = keyProvider("anthropic", "https://api.anthropic.com/v1/models")
export const openai: Provider = keyProvider("openai", "https://api.openai.com/v1/models")
export const xai: Provider = keyProvider("xai", "https://api.x.ai/v1/models")
