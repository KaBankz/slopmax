// Claude's banked limit resets: the full resets claude.ai lists under
// Limit resets, such as the one Pro and Max accounts got at a model's
// launch. Anthropic's API calls them the `cedar_ember` program. The usage
// endpoint lists them when asked, as grants that each hold a few resets,
// and the organization's `reset_rate_limits` spends one.
//
// Claude answers both to Claude Code alone: called as anything else, the
// listing comes back ineligible and empty. So these two calls carry Claude
// Code's user agent as slopmax last saw it in a request, and nothing else
// slopmax sends does.
import { Effect, Result, Schema } from "effect"

import { ids, log, Timestamp } from "@slopmax/common"
import { type Client, client, type HttpError } from "@slopmax/net"
import { json } from "@slopmax/wire"

import type { Account } from "../../account.ts"
import { Failure, lift } from "../../error.ts"
import { parseTime } from "../../limits.ts"
import { opt, withDefault } from "../../serde.ts"
import { type Credit, defineResetCredits, type Outcome, type ResetCredits } from "../credits.ts"
import { jsonBody } from "../mod.ts"
import { OAUTH_BETA } from "./oauth.ts"

// `mod.ts`'s `API`, repeated so the two modules do not import each other.
const API = "https://api.anthropic.com"

/** The program the resets belong to, as Claude's API names it. */
const PROGRAM = "cedar_ember"

/** The usage endpoint, asked to list the resets as Claude Code asks it. */
const LISTING = "/api/oauth/usage?cedar_ember=1&skip_spend=1"

/** More resets than one grant could sensibly hold. */
const MOST_PER_GRANT = 20

const unseen = (): Failure =>
  new Failure({
    message: "Claude answers limit resets to Claude Code alone, and none of its requests has come through slopmax yet",
  })

/** A call as Claude Code makes it, with the account's token. */
const asClaudeCode = (request: client.RequestBuilder, account: Account, agent: string): client.RequestBuilder =>
  request.bearerAuth(account.tokens.accessToken).header("anthropic-beta", OAUTH_BETA).header("user-agent", agent)

const list = Effect.fn("claude.credits.list")(function* (http: Client, account: Account, agent: string) {
  const response = yield* asClaudeCode(http.get(`${API}${LISTING}`), account, agent)
    .send()
    .pipe(Effect.mapError(lift))
  const status = response.status
  if (!client.isSuccess(status)) {
    return yield* Effect.fail(new Failure({ message: `listing limit resets failed (${client.statusText(status)})` }))
  }
  const body = yield* jsonBody(response).pipe(
    Effect.mapError((e) => new Failure({ message: "unexpected usage reply", cause: lift(e) })),
  )
  const listed = yield* Effect.fromResult(available(body, yield* Timestamp.now))
  const reason = refusedCaller(body)
  if (reason !== undefined) log.info(`${account.id}: Claude would not list its limit resets (${reason})`)
  return listed
})

/**
 * The resets left in the usage `body`, one credit per reset: the grant
 * Claude would spend next first, then soonest-expiring. None when the
 * account has none or may not use them.
 */
export const available = (body: json.Json, now: Timestamp): Result.Result<ReadonlyArray<Credit>, Failure> => {
  if (!json.isObject(body)) return Result.fail(new Failure({ message: "unexpected usage reply" }))
  const status = json.get(body, PROGRAM)
  if (status === undefined || status === null) return Result.succeed([])
  if (!json.isObject(status)) return Result.fail(new Failure({ message: "unexpected limit reset status" }))
  const next = json.str(json.get(status, "next_grant_id"))
  const grants = (json.array(json.get(status, "grants")) ?? [])
    .map(grant)
    .filter((g): g is readonly [Credit, number] => g !== undefined)
    .filter(([credit, left]) => left > 0 && (credit.expiresAt === undefined || credit.expiresAt > now))
  const key = (credit: Credit): readonly [number, Timestamp] => [
    credit.id !== next ? 1 : 0,
    credit.expiresAt ?? Timestamp.MAX,
  ]
  const sorted = grants.toSorted(([a], [b]) => {
    const [x, y] = [key(a), key(b)]
    return x[0] - y[0] || x[1] - y[1]
  })
  return Result.succeed(
    sorted.flatMap(([credit, left]) => Array.from({ length: Math.min(left, MOST_PER_GRANT) }, () => credit)),
  )
}

const GRANT_ID = /^[a-z0-9_-]{1,40}$/

// `char::is_whitespace`, Unicode's White_Space.
const WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

// `char::is_control`: the C0 and C1 controls.
const isControl = (c: string): boolean => {
  const code = c.codePointAt(0) ?? 0
  return code < 0x20 || (code >= 0x7f && code < 0xa0)
}

/**
 * A grant as a credit, with how many resets it has left; undefined for one
 * whose id Claude Code would not accept either.
 */
export const grant = (value: json.Json): readonly [Credit, number] | undefined => {
  const id = json.str(json.get(value, "id"))
  if (id === undefined || !GRANT_ID.test(id)) return undefined
  const left = json.u64(json.get(value, "resets_left"))
  if (left === undefined) return undefined
  const label = json.str(json.get(value, "label"))
  const words = label?.split(WHITESPACE).filter((w) => w !== "")
  const title =
    words === undefined
      ? undefined
      : Array.from(words.join(" "))
          .filter((c) => !isControl(c))
          .slice(0, 120)
          .join("")
  const grantedAt = parseTime(json.get(value, "starts_at"))
  const expiresAt = parseTime(json.get(value, "ends_at"))
  const credit: Credit = {
    id,
    ...(title === undefined || title === "" ? {} : { title }),
    ...(grantedAt === undefined ? {} : { grantedAt }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
  return [credit, left]
}

/**
 * Why Claude would not list the resets to this caller, if it is the
 * caller it refused rather than the account.
 */
export const refusedCaller = (body: json.Json): string | undefined => {
  const status = json.get(body, PROGRAM)
  const reason = json.str(json.get(status, "ineligible_reason"))
  if (reason === undefined) return undefined
  return json.get(status, "eligible") === false && (reason === "surface" || reason === "cli_version")
    ? reason
    : undefined
}

const ClaimedSchema = Schema.Struct({
  result: withDefault(Schema.String, ""),
  reason: opt(Schema.String),
})

/** What spending a reset answered. */
export type Claimed = typeof ClaimedSchema.Type

export const Claimed = {
  outcome: (self: Claimed): Outcome => {
    switch (self.result) {
      case "reset":
        return "reset"
      case "not_limited":
        return "nothing_to_reset"
      case "already_used":
        return "already_redeemed"
    }
    switch (self.reason) {
      case "no_grant":
      case "unknown_grant":
      case "expired":
        return "no_credit"
      default:
        // Paused, cooling down, or not offered to the account now.
        return "declined"
    }
  },
} as const

/**
 * Spends one reset of `credit`, the grant it names, or of the grant Claude
 * would spend next. The request id is reused on a retry, so a lost
 * response cannot spend two.
 */
const redeem = Effect.fn("claude.credits.redeem")(function* (
  http: Client,
  account: Account,
  agent: string,
  credit: string | undefined,
) {
  const org = account.orgId
  if (org === undefined || !isUuid(org)) {
    return yield* Effect.fail(new Failure({ message: "the account's organization is unknown; sign in again" }))
  }
  let grantId: string
  if (credit !== undefined) grantId = credit
  else {
    const next = (yield* list(http, account, agent))[0]
    if (next === undefined) return "no_credit" as Outcome
    grantId = next.id
  }
  const url = `${API}/api/organizations/${org}/reset_rate_limits`
  const body = { program: PROGRAM, grant_id: grantId, request_id: ids.uuidV4() }
  let lastError: HttpError | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = yield* Effect.result(asClaudeCode(http.post(url), account, agent).json(body).send())
    if (sent._tag === "Failure") {
      lastError = sent.failure
      continue
    }
    const response = sent.success
    if (!client.isSuccess(response.status)) {
      return yield* Effect.fail(
        new Failure({ message: `using a limit reset failed (${client.statusText(response.status)})` }),
      )
    }
    const claimed = yield* response
      .json(ClaimedSchema)
      .pipe(Effect.mapError((e) => new Failure({ message: "unexpected reply to using a limit reset", cause: lift(e) })))
    const outcome = Claimed.outcome(claimed)
    if (outcome === "declined") {
      log.info(`${account.id}: Claude kept its limit reset (${claimed.result}, ${claimed.reason ?? "no reason given"})`)
    }
    return outcome
  }
  return yield* Effect.fail(lift(lastError ?? new client.HttpError({ kind: "Connect" })))
})

/** Whether `id` is a UUID, as an organization's is: it goes in the path. */
export const isUuid = (id: string): boolean =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)

export const Credits: ResetCredits = defineResetCredits({
  /** Claude's usage reports none of them unless asked for the list. */
  counted: false,
  needsAgent: true,
  list: (http, account, agent) => (agent === undefined ? Effect.fail(unseen()) : list(http, account, agent)),
  redeem: (http, account, agent, credit) =>
    agent === undefined ? Effect.fail(unseen()) : redeem(http, account, agent, credit),
})
