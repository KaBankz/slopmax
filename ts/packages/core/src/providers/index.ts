// The providers slopmax pools accounts of, as values: what the proxy calls
// on every attempt, and the Effects for signing in, refreshing, usage,
// catalogs and limit resets. Adding a provider is one file, one literal in
// `ProviderId`, one entry in `providerFacts`, and one entry in `providers`.
import type { ProviderId } from "@slopmax/domain"
import { Effect } from "effect"
import { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import { providers } from "./registry.ts"
import type { LoginOptions } from "./provider.ts"

export * as claude from "./claude.ts"
export * as codex from "./codex.ts"
export * as compat from "./compat.ts"
export * as keys from "./keys.ts"
export * as oauth from "./oauth.ts"
export { LoginUi } from "./oauth.ts"
export {
  defineProvider,
  type EndpointOptions,
  forwardable,
  type Grant,
  type HeaderInput,
  LoginFailed,
  type LoginOptions,
  type LoginServices,
  LoginTimedOut,
  NeedsAgent,
  type Provider,
  ProviderFailed,
  type ProviderParts,
  ProviderUnauthorized,
  type Refusal,
  RefreshRevoked,
  RefreshTransient,
  type Resets,
  retryAfter,
  type SocketHooks,
  StateMismatch,
  statusLine,
  tokensOf,
  Verdict,
} from "./provider.ts"
export { providerOf, providers } from "./registry.ts"

/**
 * Signs in to `provider` and saves the account, merged into an earlier
 * sign-in of the same account: a later sign-in keeps the label, priority and
 * whether it is turned off, and takes a new label only when given one.
 */
export const signIn = Effect.fn("signIn")(function* (provider: ProviderId, options: LoginOptions) {
  const accounts = yield* Accounts
  const account = yield* Effect.scoped(providers[provider].login(options))
  const labeled = options.label === undefined ? account : new Account({ ...account, label: options.label })
  return yield* accounts.upsert(labeled)
})
