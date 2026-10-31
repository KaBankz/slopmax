// Routing by model: which providers and accounts may serve a request, and
// under which model name, in the order to try them.
//
// A request's model picks its providers: every provider with an account
// that serves the model, subscriptions first. Pay-per-token accounts that
// back up a subscription (an OpenAI key behind ChatGPT) join only as paid
// overflow, unless there is no such subscription at all. On top of that:
//
// - an alias renames a model (`fast = "gpt-6-sol"`);
// - a selector picks a provider or one account (`openai/gpt-6-sol`,
//   `work/gpt-6-sol`);
// - fallbacks name models to try once the first is spent everywhere.
import { Result } from "effect"

import { type Dialect, translate } from "@slopmax/wire"

import type { Account } from "./account.ts"
import { find } from "./agent/registry.ts"
import { ProviderId } from "./provider/mod.ts"

/** One way to serve a request: a provider, the model to ask it for, and the accounts that may. */
export interface Step {
  readonly provider: ProviderId
  readonly model: string
  readonly accounts: ReadonlyArray<string>
}

/** The configuration and accounts routing works from. */
export interface Table {
  readonly accounts: ReadonlyArray<Account>
  readonly aliases: Readonly<Record<string, string>>
  readonly fallbacks: Readonly<Record<string, ReadonlyArray<string>>>
  readonly paidOverflow: boolean
}

/** A request to route. */
export interface Request {
  readonly model: string
  /** The format the client speaks. */
  readonly dialect: Dialect
  /** The agent the client identified itself as, by id. */
  readonly agent: string | undefined
  /**
   * Serves models no provider claims: the API the request's path belongs
   * to (`/codex/…` is ChatGPT's).
   */
  readonly default: ProviderId | undefined
}

/** Why no account may serve a request. */
export type NoRoute =
  /** Accounts serve the model, but only to another agent. */
  | { readonly _tag: "Refused"; readonly provider: ProviderId; readonly agent: string }
  /** No account serves the model in the client's format. */
  | { readonly _tag: "Unserved"; readonly model: string }
  /** The request names no model, and its path no provider. */
  | { readonly _tag: "NoModel" }

const NO_MODEL: NoRoute = { _tag: "NoModel" }

export const NoRoute = {
  Refused: (provider: ProviderId, agent: string): NoRoute => ({ _tag: "Refused", provider, agent }),
  Unserved: (model: string): NoRoute => ({ _tag: "Unserved", model }),
  NoModel: NO_MODEL,
} as const

const lookup = <A>(map: Readonly<Record<string, A>>, key: string): A | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined

const sameStep = (a: Step, b: Step): boolean =>
  a.provider === b.provider &&
  a.model === b.model &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((id, i) => id === b.accounts[i])

/** The steps that may serve `request`, in order. */
export const plan = (table: Table, request: Request): Result.Result<ReadonlyArray<Step>, NoRoute> => {
  const steps: Array<Step> = []
  let refused: NoRoute | undefined
  const primary = resolve(table, request.model)
  const fallbacks = (lookup(table.fallbacks, request.model) ?? lookup(table.fallbacks, primary) ?? []).map((m) =>
    resolve(table, m),
  )
  const models = [primary, ...fallbacks]
  for (let i = 0; i < models.length; i++) {
    const model = models[i] ?? primary
    const pathDefault = i === 0 ? request.default : undefined
    for (const step of stepsFor(table, model, pathDefault)) {
      const allowed = permitted(table, step, request)
      if (Result.isSuccess(allowed)) {
        if (!steps.some((s) => sameStep(s, allowed.success))) steps.push(allowed.success)
      } else {
        refused ??= allowed.failure
      }
    }
  }
  if (steps.length === 0) return Result.fail(refused ?? NoRoute.Unserved(request.model))
  return Result.succeed(steps)
}

/** The model an alias stands for. */
const resolve = (table: Table, model: string): string => lookup(table.aliases, model) ?? model

/** Every provider step for `model`, before policy. */
const stepsFor = (table: Table, model: string, pathDefault: ProviderId | undefined): Array<Step> => {
  const ofProvider = (provider: ProviderId): Array<string> =>
    table.accounts.filter((a) => a.provider === provider).map((a) => a.id)
  const hasAccounts = (provider: ProviderId): boolean => table.accounts.some((a) => a.provider === provider)

  const steps: Array<Step> = []
  for (const provider of ProviderId.ALL) {
    const implementation = ProviderId.get(provider)
    const accounts = table.accounts
      .filter((a) => a.provider === provider && implementation.serves(a, model))
      .map((a) => a.id)
    if (accounts.length === 0) continue
    const billing = implementation.spec.billing
    if (
      billing._tag === "Metered" &&
      billing.backs !== undefined &&
      hasAccounts(billing.backs) &&
      !table.paidOverflow
    ) {
      continue
    }
    steps.push({ provider, model, accounts })
  }
  if (steps.length > 0) return steps
  // A selector: `openai/gpt-6-sol` or `work/gpt-6-sol`. Checked only when
  // no account serves the whole name, since model ids such as
  // `qwen/qwen3-coder` contain slashes too.
  const slash = model.indexOf("/")
  if (slash >= 0) {
    const prefix = model.slice(0, slash)
    const rest = model.slice(slash + 1)
    const provider = ProviderId.parse(prefix)
    if (Result.isSuccess(provider)) {
      const accounts = ofProvider(provider.success)
      if (accounts.length > 0) steps.push({ provider: provider.success, model: rest, accounts })
      return steps
    }
    const account = table.accounts.find((a) => a.id === prefix || a.label === prefix || a.email === prefix)
    if (account !== undefined) {
      steps.push({ provider: account.provider, model: rest, accounts: [account.id] })
      return steps
    }
  }
  if (pathDefault !== undefined && hasAccounts(pathDefault)) {
    steps.push({ provider: pathDefault, model, accounts: ofProvider(pathDefault) })
  }
  return steps
}

/**
 * The step as far as policy and format allow: accounts that may serve this
 * client, in its own format or by translation.
 */
const permitted = (table: Table, step: Step, request: Request): Result.Result<Step, NoRoute> => {
  const provider = ProviderId.get(step.provider)
  const only = provider.spec.agentOnly
  if (only !== undefined && request.agent !== only) {
    return Result.fail(NoRoute.Refused(step.provider, find(only)?.title ?? only))
  }
  const accounts = step.accounts.filter((id) => {
    const account = table.accounts.find((a) => a.id === id)
    return (
      account !== undefined &&
      provider.dialects(account).some((d) => d === request.dialect || translate.canTranslate(request.dialect, d))
    )
  })
  if (accounts.length === 0) return Result.fail(NoRoute.Unserved(step.model))
  return Result.succeed({ ...step, accounts })
}
