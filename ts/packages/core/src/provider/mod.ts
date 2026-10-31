// Providers: the services slopmax holds accounts for.
//
// Each provider implements `Provider`: how to sign in and refresh, how to
// read usage, how to send a request with an account's credentials, and how
// to read the answer. The proxy, background tasks, and CLI only go through
// this interface; `provider/registry.ts` is the one place that lists the
// implementations, and installs them here, where `ProviderId.get` finds
// them. (The table is filled at load, not imported, because the
// implementations make accounts, and accounts ask their provider for their
// identity: importing both ways would be a cycle.)
//
// Subscriptions (Claude, ChatGPT) sign in with OAuth and have usage
// windows. Metered providers (API keys, compatible endpoints) take a key
// and bill per token, so by default they never quietly absorb traffic a
// subscription would serve.
import { Data, Effect, Result, Schema } from "effect"

import { type SignedDuration, text as texts, type Timestamp } from "@slopmax/common"
import { type Client, client, HttpError } from "@slopmax/net"
import { type Dialect, json } from "@slopmax/wire"

import type { Account } from "../account.ts"
import type { Grant, LoginOptions, Prompt, RefreshError } from "../auth/mod.ts"
import { Revoked } from "../auth/mod.ts"
import { Failure, lift } from "../error.ts"
import type { Limits, PoolWindow, Refusal } from "../limits.ts"
import type { ResetCredits } from "./credits.ts"

/** Which provider an account belongs to; stored in account files by its lowercase id. */
export const ProviderIdSchema = Schema.Literals(["claude", "codex", "anthropic", "openai", "xai", "compat"])

export type ProviderId = typeof ProviderIdSchema.Type

const installed = new Map<ProviderId, Provider>()

const ALL: ReadonlyArray<ProviderId> = ProviderIdSchema.literals

export const ProviderId = {
  /** Every provider, subscriptions first: the order requests try them in (and their sort order). */
  ALL,

  /** The implementation. */
  get: (id: ProviderId): Provider => {
    const provider = installed.get(id)
    if (provider === undefined) throw new Error(`provider ${id} is not registered; import provider/registry.ts`)
    return provider
  },

  spec: (id: ProviderId): Spec => ProviderId.get(id).spec,

  /** The id as account files store it. */
  asStr: (id: ProviderId): string => id,

  /** The id named `s`, or why not. */
  parse: (s: string): Result.Result<ProviderId, string> => {
    const found = ALL.find((p) => p === s)
    if (found !== undefined) return Result.succeed(found)
    return Result.fail(`expected one of ${ALL.join(", ")}, got ${texts.debug(s)}`)
  },

  /** The enum order (`Ord`): its place in `ALL`. */
  order: (id: ProviderId): number => ALL.indexOf(id),

  compare: (a: ProviderId, b: ProviderId): number => ALL.indexOf(a) - ALL.indexOf(b),
} as const

/**
 * Puts `provider` where `ProviderId.get` finds it. `provider/registry.ts`
 * installs the real ones; tests install fakes and restore what was there.
 */
export const install = (provider: Provider): Provider | undefined => {
  const previous = installed.get(provider.spec.id)
  installed.set(provider.spec.id, provider)
  return previous
}

/** What an account signs in with. */
export type Credential =
  /**
   * OAuth in a browser; `device` when a code can stand in for the
   * redirect, on machines without a browser.
   */
  | { readonly _tag: "OAuth"; readonly device: boolean }
  /** An API key; `optional` for endpoints that may need none. */
  | { readonly _tag: "Key"; readonly optional: boolean }

export const Credential = {
  OAuth: (device: boolean): Credential => ({ _tag: "OAuth", device }),
  Key: (optional: boolean): Credential => ({ _tag: "Key", optional }),
} as const

/** How a provider's accounts are paid for. */
export type Billing =
  /** A plan with usage windows that reset. */
  | { readonly _tag: "Subscription" }
  /**
   * Pay per token. `backs` is the subscription whose models these accounts
   * also serve: they take that traffic only as paid overflow, or when there
   * is no such subscription at all.
   */
  | { readonly _tag: "Metered"; readonly backs: ProviderId | undefined }

const SUBSCRIPTION: Billing = { _tag: "Subscription" }

export const Billing = {
  Subscription: SUBSCRIPTION,
  Metered: (backs: ProviderId | undefined): Billing => ({ _tag: "Metered", backs }),
} as const

/** What a provider declares about itself. */
export interface Spec {
  /** Stable id, stored in account files: `claude`, `codex`. */
  readonly id: ProviderId
  /** For people: "your Claude account". */
  readonly title: string
  /** Base URL of the API agents talk to; their request path is appended. */
  readonly api: string
  /** The formats that API speaks, preferred first. */
  readonly dialects: ReadonlyArray<Dialect>
  /** The models it serves, as patterns where `*` matches anything. */
  readonly models: ReadonlyArray<string>
  /** How its accounts are paid for. */
  readonly billing: Billing
  /** The one agent that may use these accounts, by id. */
  readonly agentOnly: string | undefined
  /** How long before expiry an access token is refreshed. */
  readonly refreshLead: SignedDuration
  /** What its accounts sign in with. */
  readonly credential: Credential
}

export const Spec = {
  /** Whether the provider has usage windows to poll. */
  isSubscription: (self: Spec): boolean => self.billing._tag === "Subscription",

  /** Whether a code can stand in for the browser redirect when signing in. */
  deviceLogin: (self: Spec): boolean => self.credential._tag === "OAuth" && self.credential.device,
} as const

/** Whether `model` matches `pattern`, where `*` matches any run of characters. */
export const matches = (pattern: string, model: string): boolean => {
  const parts = pattern.split("*")
  const first = parts[0] ?? ""
  if (!model.startsWith(first)) return false
  let rest = model.slice(first.length)
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i] ?? ""
    if (i === parts.length - 1) {
      // The last part anchors at the end.
      return rest.length >= part.length && rest.endsWith(part)
    }
    const at = rest.indexOf(part)
    if (at < 0) return false
    rest = rest.slice(at + part.length)
  }
  return rest === ""
}

/** A usage reading, plus the plan when the endpoint reports one. */
export interface Reading {
  readonly limits: Limits
  readonly plan: string | undefined
}

/** The token was rejected; a refresh may help. */
export class Unauthorized extends Data.TaggedError("Unauthorized")<{}> {
  override get message(): string {
    return "unauthorized"
  }
}

/** Why a usage read failed: the token was rejected, or something else went wrong. */
export type UsageError = Unauthorized | Failure

/**
 * Reads a usage endpoint's JSON answer: a 401 means the token needs a
 * refresh; other failures carry the start of the body.
 */
export const usageBody = Effect.fn("provider.usageBody")(function* (
  response: client.Response,
): Effect.fn.Return<json.Json, UsageError> {
  const status = response.status
  if (status === 401) return yield* Effect.fail(new Unauthorized())
  if (status < 200 || status >= 300) {
    const body = yield* response.text().pipe(Effect.orElseSucceed(() => ""))
    const snippet = Array.from(body).slice(0, 200).join("")
    return yield* Effect.fail(
      new Failure({ message: `usage endpoint returned ${client.statusText(status)}: ${snippet}` }),
    )
  }
  return yield* jsonBody(response).pipe(Effect.mapError(lift))
})

/**
 * `Response::json::<Value>`: the body as serde_json reads it, so `3.0`
 * stays a float that `as_i64` and `as_u64` refuse.
 */
export const jsonBody = (response: client.Response): Effect.Effect<json.Json, HttpError> =>
  Effect.flatMap(response.bytes(), (bytes) => {
    const value = json.read(bytes)
    return Result.isSuccess(value)
      ? Effect.succeed(value.success)
      : Effect.fail(new HttpError({ kind: "Decode", reason: value.failure }))
  })

/** How the proxy treats a response that was not a success. */
export type Verdict =
  /** Hand the response to the agent unchanged. */
  | { readonly _tag: "Final" }
  /** The token was rejected: refresh it once, else set the account aside. */
  | { readonly _tag: "Unauthorized" }
  /** The account may not serve this request. */
  | { readonly _tag: "Forbidden" }
  /**
   * The request carried conversation state another account minted; retry
   * once without it.
   */
  | { readonly _tag: "StaleState" }
  /** The account's quota is spent until `until`, for `model` only if set. */
  | { readonly _tag: "Exhausted"; readonly until: Timestamp | undefined; readonly model: string | undefined }
  /** Briefly throttled; the account itself is fine. */
  | { readonly _tag: "Throttled"; readonly until: Timestamp | undefined }

const FINAL: Verdict = { _tag: "Final" }
const UNAUTHORIZED: Verdict = { _tag: "Unauthorized" }
const FORBIDDEN: Verdict = { _tag: "Forbidden" }
const STALE_STATE: Verdict = { _tag: "StaleState" }

export const Verdict = {
  Final: FINAL,
  Unauthorized: UNAUTHORIZED,
  Forbidden: FORBIDDEN,
  StaleState: STALE_STATE,
  Exhausted: (until: Timestamp | undefined, model: string | undefined): Verdict => ({
    _tag: "Exhausted",
    until,
    model,
  }),
  Throttled: (until: Timestamp | undefined): Verdict => ({ _tag: "Throttled", until }),

  /** The answer for statuses every provider treats the same way. */
  ofStatus: (status: number): Verdict =>
    status === 401 ? Verdict.Unauthorized : status === 403 ? Verdict.Forbidden : Verdict.Final,

  /** A refusal, as the verdict it becomes. */
  fromRefusal: (refusal: Refusal): Verdict =>
    refusal._tag === "Exhausted" ? Verdict.Exhausted(refusal.until, refusal.model) : Verdict.Throttled(refusal.until),
} as const

/** A service slopmax can hold accounts for and forward requests to. */
export interface Provider {
  readonly spec: Spec

  /**
   * The provider-side identity accounts are keyed by (an organization or
   * workspace), so one email in two of them stays two accounts.
   */
  identity(account: Account): string | undefined

  /** Connects an account, telling the person signing in what to do through `prompt`. */
  login(http: Client, options: LoginOptions, prompt: Prompt): Effect.Effect<Account, Failure>

  /** Redeems a refresh token for new tokens. */
  refresh(http: Client, refreshToken: string): Effect.Effect<Grant, RefreshError>

  /** Updates email, plan, and organization once new tokens arrive. */
  identify(http: Client, account: Account): Effect.Effect<Account>

  /** Reads the account's usage windows (subscriptions only). */
  usage(http: Client, account: Account): Effect.Effect<Reading, UsageError>

  /** Where the account's requests go; the request path is appended. */
  api(account: Account): string

  /** The formats the account's API speaks, preferred first. */
  dialects(account: Account): ReadonlyArray<Dialect>

  /** Whether the account serves `model`. */
  serves(account: Account, model: string): boolean

  /**
   * The agent's request headers with the account's credentials in place of
   * the slopmax key. `moved` says the session just left another account.
   */
  headers(client: Headers, account: Account, moved: boolean): Headers

  /** A body without conversation state bound to another account, or undefined when there is nothing to drop. */
  rebind(body: Uint8Array): Uint8Array | undefined

  /** Adjusts a request slopmax translated into `dialect` for this API (in place). */
  shape(dialect: Dialect, body: json.Json): void

  /** Usage windows reported in response headers. */
  limits(headers: Headers, now: Timestamp): Limits | undefined

  /** Classifies a response that was not a success. */
  verdict(status: number, headers: Headers, body: Uint8Array, model: string | undefined, now: Timestamp): Verdict

  /**
   * Puts the pool's usage windows in place of the serving account's in the
   * response headers the agent reads (in place), so it sees one account.
   */
  showPool(windows: ReadonlyArray<PoolWindow>, headers: Headers): void

  /** Banked reset credits, for providers that grant them. */
  credits(): ResetCredits | undefined

  /**
   * The models the account offers, for model lists. `version` is the
   * newest Codex release slopmax has seen, which ChatGPT's catalog wants.
   */
  catalog(http: Client, account: Account, version: string): Effect.Effect<ReadonlyArray<string>, Failure>
}

/** What a provider must say for itself; the rest have the defaults below. */
export type ProviderParts = Pick<Provider, "spec" | "identity" | "login" | "headers" | "verdict"> &
  Partial<Omit<Provider, "spec" | "identity" | "login" | "headers" | "verdict">>

/** A provider from its parts, with the trait's defaults for what it leaves out. */
export const defineProvider = (parts: ProviderParts): Provider => {
  const spec = parts.spec
  return {
    refresh: () => Effect.fail(new Revoked({ reason: `${spec.title} keys cannot be refreshed` })),
    identify: (_http, account) => Effect.succeed(account),
    usage: () => Effect.fail(new Failure({ message: `${spec.title} has no usage windows` })),
    api: () => spec.api,
    dialects: () => spec.dialects,
    serves: (_account, model) => spec.models.some((p) => matches(p, model)),
    rebind: () => undefined,
    shape: () => {},
    limits: () => undefined,
    showPool: () => {},
    credits: () => undefined,
    catalog: () => Effect.succeed([]),
    ...parts,
  }
}
