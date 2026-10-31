// Compatible endpoints: any API that speaks OpenAI Chat Completions or
// Responses, or Anthropic Messages, such as a local model server or another
// vendor's gateway. The provider is code; each endpoint, its format and its
// models are the account's data.
import { matchesAny } from "@slopmax/domain"
import { DateTime, Effect, Option, Redacted } from "effect"
import { type Account, Credential } from "../account.ts"
import { checkKey, keyHeaderFor, meteredVerdict, withKey } from "./keys.ts"
import { type EndpointOptions, defineProvider, LoginFailed, newAccount, type Provider } from "./provider.ts"

/** Where an endpoint lists its models: `/v1/models` under Anthropic-style bases, `/models` under OpenAI-style ones. */
export const modelsUrl = (endpoint: Pick<EndpointOptions, "baseUrl" | "dialect">): string => {
  const base = endpoint.baseUrl.replace(/\/+$/, "")
  return endpoint.dialect === "messages" ? `${base}/v1/models` : `${base}/models`
}

const endpointOf = (account: Account) =>
  account.credential._tag === "Endpoint" ? Option.some(account.credential) : Option.none()

export const compat: Provider = defineProvider({
  id: "compat",
  // One server under two keys is two accounts.
  identity: (account) =>
    Option.match(endpointOf(account), {
      onNone: () => undefined,
      onSome: (endpoint) => `${endpoint.baseUrl} ${endpoint.key === undefined ? "" : Redacted.value(endpoint.key)}`,
    }),
  login: (options) =>
    Effect.gen(function* () {
      const endpoint = options.endpoint
      if (endpoint === undefined) {
        return yield* new LoginFailed({ message: "a compatible endpoint needs its address: --url <base url>" })
      }
      const key = options.key === undefined ? "" : Redacted.value(options.key).trim()
      const listed = yield* checkKey(modelsUrl(endpoint), keyHeaderFor(endpoint.dialect), key).pipe(
        Effect.mapError((error) => new LoginFailed({ message: error.message })),
      )
      const models = endpoint.models.length > 0 ? endpoint.models : Option.getOrElse(listed, () => [])
      if (models.length === 0) {
        return yield* new LoginFailed({
          message: `could not list the models at ${endpoint.baseUrl}; name them with --models`,
        })
      }
      return yield* newAccount({
        provider: "compat",
        credential: Credential.cases.Endpoint.make({
          baseUrl: endpoint.baseUrl,
          dialect: endpoint.dialect,
          models: [...models],
          ...(key === "" ? {} : { key: Redacted.make(key) }),
        }),
        now: yield* DateTime.now,
      })
    }),
  apiOf: (account) => Option.match(endpointOf(account), { onNone: () => "", onSome: (endpoint) => endpoint.baseUrl }),
  dialectsOf: (account) =>
    Option.match(endpointOf(account), { onNone: () => [], onSome: (endpoint) => [endpoint.dialect] }),
  serves: (account, model) => Option.exists(endpointOf(account), (endpoint) => matchesAny(endpoint.models, model)),
  headers: ({ client, account }) =>
    withKey(
      client,
      keyHeaderFor(Option.match(endpointOf(account), { onNone: () => "chat", onSome: (endpoint) => endpoint.dialect })),
      account.secret,
    ),
  // Named models only: a pattern cannot be listed.
  catalog: (account) =>
    Effect.succeed(
      Option.match(endpointOf(account), {
        onNone: () => [],
        onSome: (endpoint) => endpoint.models.filter((model) => !model.includes("*")),
      }),
    ),
  verdict: meteredVerdict,
})
