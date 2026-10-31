// Compatible endpoints: any API that speaks OpenAI Chat Completions or
// Responses, or Anthropic Messages, such as a local model server or
// another vendor's gateway. The provider is code; each endpoint, its
// format, and its models are the account's data.
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import type { Client } from "@slopmax/net"

import { Account, type Endpoint } from "../account.ts"
import type { LoginOptions } from "../auth/mod.ts"
import { Failure } from "../error.ts"
import { check, KeyHeader, meteredVerdict, withKey } from "./keys.ts"
import { Billing, Credential, defineProvider, matches, type Provider, type Spec } from "./mod.ts"

const SPEC: Spec = {
  id: "compat",
  title: "Compatible API",
  // Each account names its own endpoint, format, and models.
  api: "",
  dialects: [],
  models: [],
  billing: Billing.Metered(undefined),
  agentOnly: undefined,
  refreshLead: SignedDuration.ZERO,
  credential: Credential.Key(true),
}

/** One server under two keys is two accounts. */
export const identity = (account: Account): string | undefined =>
  account.endpoint === undefined ? undefined : `${account.endpoint.baseUrl} ${account.tokens.accessToken}`

/** Where the endpoint lists its models. */
export const modelsUrl = (endpoint: Endpoint): string => {
  let base = endpoint.baseUrl
  while (base.endsWith("/")) base = base.slice(0, -1)
  return endpoint.dialect === "messages" ? `${base}/v1/models` : `${base}/models`
}

export const Compat: Provider = defineProvider({
  spec: SPEC,
  identity,
  login: Effect.fn("compat.login")(function* (http: Client, options: LoginOptions) {
    const given = options.endpoint
    if (given === undefined) {
      return yield* Effect.fail(new Failure({ message: "a compatible endpoint needs its address: --url <base url>" }))
    }
    const key = options.key ?? ""
    const header = KeyHeader.forDialect(given.dialect)
    const listed = yield* check(http, modelsUrl(given), header, key)
    const endpoint: Endpoint = given.models.length === 0 ? { ...given, models: listed ?? [] } : given
    if (endpoint.models.length === 0) {
      return yield* Effect.fail(
        new Failure({ message: `could not list the models at ${endpoint.baseUrl}; name them with --models` }),
      )
    }
    const account = Account.make("compat", { accessToken: key }, yield* Timestamp.now)
    return Account.assignId({ ...account, endpoint })
  }),
  api: (account) => account.endpoint?.baseUrl ?? "",
  dialects: (account) => (account.endpoint === undefined ? [] : [account.endpoint.dialect]),
  // Named models; patterns cannot be listed.
  catalog: (_http, account) => Effect.succeed((account.endpoint?.models ?? []).filter((m) => !m.includes("*"))),
  serves: (account, model) => account.endpoint?.models.some((p) => matches(p, model)) ?? false,
  headers: (client, account) =>
    withKey(client, KeyHeader.forDialect(account.endpoint?.dialect ?? "chat"), account.tokens.accessToken),
  verdict: (status, headers, body, _model, now) => meteredVerdict(status, headers, body, now),
})
