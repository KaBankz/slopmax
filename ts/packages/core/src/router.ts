// Routing by model: which providers and accounts may serve a request, under
// which model name, in the order to try them.
//
// A request's model picks its providers: every provider with an account
// that serves the model, subscriptions first. Pay-per-token keys that back
// a subscription (an OpenAI key behind ChatGPT) join only as paid overflow,
// unless there is no such subscription at all. On top of that:
//
// - an alias renames a model (`"fast": "gpt-6-sol"`);
// - a selector picks a provider or one account (`openai/gpt-6-sol`,
//   `work/gpt-6-sol`);
// - fallbacks name models to try once the first is spent everywhere.
//
// Routing is a pure function of the accounts and the settings, so the proxy
// plans each distinct request once and reuses the plan until either changes.
import {
  type AccountId,
  type AgentId,
  agentFacts,
  type Dialect,
  parseProviderId,
  providerFacts,
  type ProviderId,
  providerOrder,
  type Settings,
} from "@slopmax/domain"
import { canTranslate } from "@slopmax/wire"
import { Data, Result } from "effect"
import type { Account } from "./account.ts"
import { providers } from "./providers/registry.ts"

/** What routing works from: every account (turned off or not) and the settings. */
export interface Table {
  readonly accounts: ReadonlyArray<Account>
  readonly settings: Pick<Settings, "aliases" | "fallbacks" | "paidOverflow">
}

/** A request to route. */
export interface Ask {
  /** The model the client asked for; absent when its body names none. */
  readonly model?: string | undefined
  /** The format the client speaks. */
  readonly dialect: Dialect
  /** The agent the client is, when it is one slopmax knows. */
  readonly agent?: AgentId | undefined
  /** The provider the request's path belongs to (`/codex/…` is ChatGPT's), which serves models no provider claims. */
  readonly pathProvider?: ProviderId | undefined
}

/** One way to serve a request: a provider, the model to ask it for, and the accounts that may. */
export interface Step {
  readonly provider: ProviderId
  readonly model: string
  readonly accounts: ReadonlyArray<AccountId>
}

/** The steps to try, in order, or why no account may serve the request. */
export type Plan = Data.TaggedEnum<{
  Steps: { readonly steps: ReadonlyArray<Step> }
  /** Accounts serve the model, but only to another agent: Claude subscriptions serve Claude Code alone. */
  Refused: { readonly provider: ProviderId; readonly agent: AgentId }
  /** No account serves the model in the client's format. */
  Unserved: { readonly model: string }
  /** The request names no model, and its path no provider. */
  NoModel: {}
}>
export const Plan = Data.taggedEnum<Plan>()

/** Why a refused request was refused, for people: "Claude serves Claude Code only". */
export const refusedText = (provider: ProviderId, agent: AgentId): string =>
  `${providerFacts[provider].title} serves ${agentFacts[agent].title} only`

const idsOf = (accounts: ReadonlyArray<Account>): ReadonlyArray<AccountId> => accounts.map((account) => account.id)

/** The model an alias stands for: one level only, so aliases never chain. */
const resolve = (table: Table, model: string): string => table.settings.aliases[model] ?? model

/** Every provider step for `model`, before the agent and format are checked. */
const stepsFor = (table: Table, model: string, pathProvider: ProviderId | undefined): ReadonlyArray<Step> => {
  const ofProvider = (provider: ProviderId) => table.accounts.filter((account) => account.provider === provider)
  const steps: Array<Step> = []
  for (const provider of providerOrder) {
    const serving = ofProvider(provider).filter((account) => providers[provider].serves(account, model))
    if (serving.length === 0) continue
    const backs = providerFacts[provider].backs
    // A key that backs a subscription waits behind it, unless overflow is on or there is no such subscription.
    if (backs !== undefined && ofProvider(backs).length > 0 && !table.settings.paidOverflow) continue
    steps.push({ provider, model, accounts: idsOf(serving) })
  }
  if (steps.length > 0) return steps
  // A selector, tried only when no account serves the whole name, since
  // model ids such as `qwen/qwen3-coder` hold slashes too.
  const slash = model.indexOf("/")
  if (slash > 0) {
    const prefix = model.slice(0, slash)
    const rest = model.slice(slash + 1)
    const named = parseProviderId(prefix)
    if (Result.isSuccess(named)) {
      const accounts = ofProvider(named.success)
      return accounts.length === 0 ? [] : [{ provider: named.success, model: rest, accounts: idsOf(accounts) }]
    }
    const one = table.accounts.find(
      (account) => account.id === prefix || account.label === prefix || account.identity.email === prefix,
    )
    if (one !== undefined) return [{ provider: one.provider, model: rest, accounts: [one.id] }]
  }
  // Last, the path's provider takes the model as named: Codex sends models
  // no provider claims (a new `o5-mini`) to ChatGPT.
  if (pathProvider !== undefined) {
    const accounts = ofProvider(pathProvider)
    if (accounts.length > 0) return [{ provider: pathProvider, model, accounts: idsOf(accounts) }]
  }
  return []
}

/**
 * The step as far as the agent and the format allow: a provider for one
 * agent refuses the rest, and only accounts that speak the client's format,
 * or one it can be translated into, stay.
 */
const permitted = (table: Table, step: Step, ask: Ask): Result.Result<Step, Plan> => {
  const provider = providers[step.provider]
  const only = provider.agentOnly
  if (only !== undefined && ask.agent !== only)
    return Result.fail(Plan.Refused({ provider: step.provider, agent: only }))
  const byId = new Map(table.accounts.map((account) => [account.id, account]))
  const accounts = step.accounts.filter((id) => {
    const account = byId.get(id)
    return (
      account !== undefined &&
      provider.dialectsOf(account).some((dialect) => dialect === ask.dialect || canTranslate(ask.dialect, dialect))
    )
  })
  return accounts.length === 0
    ? Result.fail(Plan.Unserved({ model: step.model }))
    : Result.succeed({ ...step, accounts })
}

const sameStep = (a: Step, b: Step): boolean =>
  a.provider === b.provider &&
  a.model === b.model &&
  a.accounts.length === b.accounts.length &&
  a.accounts.every((id, index) => b.accounts[index] === id)

/**
 * The steps that may serve `ask`, in order: the model (after its alias),
 * then its fallbacks (the client's name's, else the alias target's), each
 * alias-resolved. The path's provider serves only the first model. When
 * nothing survives, the first refusal seen says why, else the client's own
 * model name is unserved.
 */
export const plan = (table: Table, ask: Ask): Plan => {
  if (ask.model === undefined && ask.pathProvider === undefined) return Plan.NoModel()
  const asked = ask.model ?? ""
  const primary = resolve(table, asked)
  const fallbacks = (table.settings.fallbacks[asked] ?? table.settings.fallbacks[primary] ?? []).map((model) =>
    resolve(table, model),
  )
  const steps: Array<Step> = []
  let refused: Plan | undefined
  for (const [index, model] of [primary, ...fallbacks].entries()) {
    for (const candidate of stepsFor(table, model, index === 0 ? ask.pathProvider : undefined)) {
      const allowed = permitted(table, candidate, ask)
      if (Result.isFailure(allowed)) refused ??= allowed.failure
      else if (!steps.some((step) => sameStep(step, allowed.success))) steps.push(allowed.success)
    }
  }
  if (steps.length > 0) return Plan.Steps({ steps })
  return refused ?? Plan.Unserved({ model: asked })
}

/** Keys an ask, for remembering its plan. */
const askKey = (ask: Ask): string =>
  `${ask.model ?? ""}\u0000${ask.dialect}\u0000${ask.agent ?? ""}\u0000${ask.pathProvider ?? ""}`

/**
 * {@link plan} over one table, remembering each distinct ask's plan. Agents
 * send the same few asks over and over, so a request plans nothing new; a
 * new table (accounts or settings changed) needs a new planner. At most
 * `capacity` plans are kept, the oldest forgotten first.
 */
export const planner = (table: Table, capacity = 1024): ((ask: Ask) => Plan) => {
  const plans = new Map<string, Plan>()
  return (ask) => {
    const key = askKey(ask)
    const known = plans.get(key)
    if (known !== undefined) return known
    const made = plan(table, ask)
    if (plans.size >= capacity) {
      const oldest = plans.keys().next()
      if (oldest.done !== true) plans.delete(oldest.value)
    }
    plans.set(key, made)
    return made
  }
}
