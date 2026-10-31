// ChatGPT Plus/Pro/Team subscriptions, as used by Codex.
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import type { Client } from "@slopmax/net"
import { json } from "@slopmax/wire"

import type { Account } from "../../account.ts"
import { lift } from "../../error.ts"
import { swapRemove } from "../../serde.ts"
import {
  Billing,
  Credential,
  defineProvider,
  type Provider,
  type Reading,
  jsonBody,
  type Spec,
  usageBody,
  Verdict,
} from "../mod.ts"
import { Credits } from "./credits.ts"
import * as limits from "./limits.ts"
import * as oauth from "./oauth.ts"
import * as wire from "./wire.ts"

/** The ChatGPT backend: the Codex API, usage, and reset credits. */
export const BACKEND = "https://chatgpt.com/backend-api"

/** The models ChatGPT plans serve through Codex. */
export const MODELS: ReadonlyArray<string> = ["gpt-*", "codex-*", "o1*", "o3*", "o4*"]

export const SPEC: Spec = {
  id: "codex",
  title: "ChatGPT",
  api: "https://chatgpt.com/backend-api/codex",
  dialects: ["responses"],
  models: MODELS,
  billing: Billing.Subscription,
  // OpenAI allows ChatGPT plans in third-party apps.
  agentOnly: undefined,
  // Access tokens live about ten days.
  refreshLead: SignedDuration.fromHours(24),
  credential: Credential.OAuth(true),
}

/** ChatGPT's identity: the workspace. */
export const identity = (account: Account): string | undefined => account.accountId

/** `GET /codex/models`: the models the account's plan offers Codex. */
const catalog = Effect.fn("codex.catalog")(function* (http: Client, account: Account, version: string) {
  const request = http.get(`${BACKEND}/codex/models?client_version=${version}`).bearerAuth(account.tokens.accessToken)
  if (account.accountId !== undefined) request.header("chatgpt-account-id", account.accountId)
  const response = yield* request.send().pipe(
    Effect.flatMap((r) => r.errorForStatus()),
    Effect.mapError(lift),
  )
  const body = yield* jsonBody(response).pipe(Effect.mapError(lift))
  const models: Array<string> = []
  for (const m of json.array(json.get(body, "models")) ?? []) {
    if (json.str(json.get(m, "visibility")) === "hide") continue
    const slug = json.str(json.get(m, "slug"))
    if (slug !== undefined) models.push(slug)
  }
  return models
})

/** `GET /wham/usage`, which also reports the plan and banked reset credits. */
const usage = Effect.fn("codex.usage")(function* (http: Client, account: Account) {
  const request = http.get(`${BACKEND}/wham/usage`).bearerAuth(account.tokens.accessToken)
  if (account.accountId !== undefined) request.header("chatgpt-account-id", account.accountId)
  const response = yield* request.send().pipe(Effect.mapError(lift))
  const body = yield* usageBody(response)
  const [read, plan] = limits.fromUsage(body, yield* Timestamp.now)
  const reading: Reading = { limits: read, plan }
  return reading
})

export const Codex: Provider = defineProvider({
  spec: SPEC,
  identity,
  login: oauth.login,
  refresh: oauth.refresh,
  identify: (_http, account) => Effect.sync(() => oauth.applyClaims(account)),
  usage,
  headers: (client, account, moved) =>
    wire.upstreamHeaders(client, account.tokens.accessToken, account.accountId, moved),
  rebind: wire.stripAccountState,
  shape: (_dialect, body) => {
    // The ChatGPT backend sets output limits itself and rejects them.
    if (json.isObject(body)) swapRemove(body, "max_output_tokens")
  },
  limits: limits.fromHeaders,
  showPool: limits.poolHeaders,
  verdict: (status, headers, body, _model, now) => {
    if (status === 429 || status === 402) return Verdict.fromRefusal(limits.refusal(status, headers, body, now))
    if (status === 400 && wire.rejectsAccountState(body)) return Verdict.StaleState
    // The backend sometimes reports an exhausted window as a 5xx.
    if (status >= 500 && status < 600 && wire.reportsUsageLimit(body)) return Verdict.Exhausted(undefined, undefined)
    return Verdict.ofStatus(status)
  },
  credits: () => Credits,
  catalog,
})
