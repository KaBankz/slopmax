// ChatGPT's banked reset credits (`/wham/rate-limit-reset-credits`).
import { Effect, Schema } from "effect"

import { ids, text as texts, Timestamp } from "@slopmax/common"
import { type Client, client, type HttpError } from "@slopmax/net"

import type { Account } from "../../account.ts"
import { Failure, lift } from "../../error.ts"
import { parseTime } from "../../limits.ts"
import { opt, withDefault } from "../../serde.ts"
import { type Credit, defineResetCredits, OutcomeSchema, type ResetCredits } from "../credits.ts"

// `mod.ts`'s `BACKEND`, repeated so the two modules do not import each other.
const BACKEND = "https://chatgpt.com/backend-api"

const ListedSchema = Schema.Struct({
  id: Schema.String,
  status: withDefault(Schema.String, ""),
  /** What the credit resets; only `codex_rate_limits` resets Codex's windows. */
  resetType: opt(Schema.String),
  title: opt(Schema.String),
  grantedAt: opt(Schema.String),
  expiresAt: opt(Schema.String),
}).pipe(Schema.encodeKeys({ resetType: "reset_type", grantedAt: "granted_at", expiresAt: "expires_at" }))

/** The kind of credit that resets Codex's usage windows. */
const CODEX_RESETS = "codex_rate_limits"

/** `GET /wham/rate-limit-reset-credits`. */
export const CreditListSchema = Schema.Struct({
  credits: withDefault(Schema.Array(ListedSchema), []),
})

export type CreditList = typeof CreditListSchema.Type

const ConsumedSchema = Schema.Struct({ code: OutcomeSchema })

const authorized = (request: client.RequestBuilder, account: Account): client.RequestBuilder => {
  const authed = request.bearerAuth(account.tokens.accessToken)
  return account.accountId === undefined ? authed : authed.header("chatgpt-account-id", account.accountId)
}

const list = Effect.fn("codex.credits.list")(function* (http: Client, account: Account) {
  const url = `${BACKEND}/wham/rate-limit-reset-credits`
  const response = yield* authorized(http.get(url), account).send().pipe(Effect.mapError(lift))
  const status = response.status
  if (!client.isSuccess(status)) {
    return yield* Effect.fail(new Failure({ message: `listing reset credits failed (${client.statusText(status)})` }))
  }
  const listed = yield* response
    .json(CreditListSchema)
    .pipe(Effect.mapError((e) => new Failure({ message: "unexpected reset credit list", cause: lift(e) })))
  return available(listed)
})

/** Unspent credits that reset Codex's windows, soonest-expiring first. */
export const available = (listed: CreditList): ReadonlyArray<Credit> =>
  listed.credits
    .filter((c) => c.status === "" || texts.asciiLowercase(c.status) === "available")
    .filter((c) => c.resetType === undefined || c.resetType === CODEX_RESETS)
    .map((c): Credit => {
      const grantedAt = parseTime(c.grantedAt)
      const expiresAt = parseTime(c.expiresAt)
      return {
        id: c.id,
        ...(c.title === undefined ? {} : { title: c.title }),
        ...(grantedAt === undefined ? {} : { grantedAt }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
    })
    .toSorted((a, b) => (a.expiresAt ?? Timestamp.MAX) - (b.expiresAt ?? Timestamp.MAX))

/**
 * The request id is reused on a retry, so a lost response cannot spend
 * two credits.
 */
const redeem = Effect.fn("codex.credits.redeem")(function* (
  http: Client,
  account: Account,
  credit: string | undefined,
) {
  const url = `${BACKEND}/wham/rate-limit-reset-credits/consume`
  const body: Record<string, string> = { redeem_request_id: ids.uuidV4() }
  if (credit !== undefined) body.credit_id = credit
  let lastError: HttpError | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const sent = yield* Effect.result(authorized(http.post(url), account).json(body).send())
    if (sent._tag === "Failure") {
      lastError = sent.failure
      continue
    }
    const response = sent.success
    if (!client.isSuccess(response.status)) {
      return yield* Effect.fail(
        new Failure({ message: `redeeming a reset credit failed (${client.statusText(response.status)})` }),
      )
    }
    const consumed = yield* response
      .json(ConsumedSchema)
      .pipe(Effect.mapError((e) => new Failure({ message: "unexpected redeem response", cause: lift(e) })))
    return consumed.code
  }
  return yield* Effect.fail(lift(lastError ?? new client.HttpError({ kind: "Connect" })))
})

export const Credits: ResetCredits = defineResetCredits({
  list: (http, account) => list(http, account),
  redeem: (http, account, _agent, credit) => redeem(http, account, credit),
})
