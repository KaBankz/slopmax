// Claude Pro/Max subscriptions, as used by Claude Code.
import { Effect } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import type { Client } from "@slopmax/net"

import type { Account } from "../../account.ts"
import { lift } from "../../error.ts"
import {
  Billing,
  Credential,
  defineProvider,
  type Provider,
  type Reading,
  type Spec,
  usageBody,
  Verdict,
} from "../mod.ts"
import { Credits } from "./credits.ts"
import * as limits from "./limits.ts"
import * as oauth from "./oauth.ts"
import * as wire from "./wire.ts"

/** Anthropic's API: Messages, the OAuth profile, usage, and limit resets. */
export const API = "https://api.anthropic.com"

export const SPEC: Spec = {
  id: "claude",
  title: "Claude",
  api: API,
  dialects: ["messages"],
  models: ["claude-*"],
  billing: Billing.Subscription,
  // Anthropic allows subscription logins in Claude Code alone.
  agentOnly: "claude",
  // Access tokens live 8 hours.
  refreshLead: SignedDuration.fromHours(1),
  credential: Credential.OAuth(false),
}

/** Claude's identity: the organization, else the account. */
export const identity = (account: Account): string | undefined => account.orgId ?? account.accountId

/** `GET /api/oauth/usage`. */
const usage = Effect.fn("claude.usage")(function* (http: Client, account: Account) {
  const response = yield* http
    .get(`${API}/api/oauth/usage`)
    .bearerAuth(account.tokens.accessToken)
    .header("anthropic-beta", oauth.OAUTH_BETA)
    .send()
    .pipe(Effect.mapError(lift))
  const body = yield* usageBody(response)
  const reading: Reading = { limits: limits.fromUsage(body, yield* Timestamp.now), plan: undefined }
  return reading
})

export const Claude: Provider = defineProvider({
  spec: SPEC,
  identity,
  login: oauth.login,
  refresh: oauth.refresh,
  identify: (http, account) =>
    Effect.map(Effect.result(oauth.profile(http, account.tokens.accessToken)), (profile) =>
      profile._tag === "Success" ? oauth.applyProfile(account, profile.success) : account,
    ),
  usage,
  headers: (client, account) => wire.upstreamHeaders(client, account.tokens.accessToken),
  limits: limits.fromHeaders,
  showPool: limits.poolHeaders,
  credits: () => Credits,
  verdict: (status, headers, body, model, now) => {
    if (status === 429 && limits.fastModeRefused(headers, body)) return Verdict.Final
    if (status === 429) return Verdict.fromRefusal(limits.refusal(headers, model, now))
    return Verdict.ofStatus(status)
  },
})
