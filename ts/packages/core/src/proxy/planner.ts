// Which steps may serve a request: routing by model, or by the path alone.
//
// Agents send the same few requests over and over (one model, one format,
// one agent), so each distinct one is planned once and its plan reused until
// the accounts or the settings change. Both are immutable values replaced
// whole on a change, so a new value is the signal to plan afresh.
import { providerFacts, type Settings } from "@slopmax/domain"
import { Context, Effect, Layer } from "effect"
import type { Account } from "../account.ts"
import { Accounts } from "../accounts.ts"
import { Plan, planner as routerPlanner } from "../router.ts"
import { SettingsService } from "../settings.ts"
import type { Inbound } from "./inbound.ts"

/**
 * The plan for a request whose path, not its model, picks the provider (a
 * model list, a body slopmax cannot read): the path's provider as one step,
 * with every account of it and the body's model if any. A provider that
 * serves one agent alone refuses the rest here, before anything is sent.
 */
export const pathPlan = (accounts: ReadonlyArray<Account>, inbound: Inbound): Plan => {
  const provider = inbound.route.pathProvider
  if (provider === undefined) return Plan.NoModel()
  const only = providerFacts[provider].agentOnly
  if (only !== undefined && inbound.agent?.id !== only) return Plan.Refused({ provider, agent: only })
  const ids = accounts.filter((account) => account.provider === provider).map((account) => account.id)
  return Plan.Steps({ steps: [{ provider, model: inbound.model ?? "", accounts: ids }] })
}

interface Memo {
  readonly accounts: ReadonlyArray<Account>
  readonly settings: Settings
  readonly plan: ReturnType<typeof routerPlanner>
}

export interface Shape {
  /** The steps that may serve the request, or why none may. */
  readonly plan: (inbound: Inbound) => Effect.Effect<Plan>
}

const make = Effect.gen(function* () {
  const accounts = yield* Accounts
  const settings = yield* SettingsService
  let memo: Memo | undefined

  const current = (list: ReadonlyArray<Account>, values: Settings): Memo => {
    if (memo !== undefined && memo.accounts === list && memo.settings === values) return memo
    memo = { accounts: list, settings: values, plan: routerPlanner({ accounts: list, settings: values }) }
    return memo
  }

  const plan = (inbound: Inbound): Effect.Effect<Plan> =>
    Effect.flatMap(accounts.list, (list) =>
      Effect.map(settings.get, (values) => {
        const { route, model } = inbound
        if (model === undefined || !route.byModel) return pathPlan(list, inbound)
        return current(list, values).plan({
          model,
          dialect: route.dialect,
          agent: inbound.agent?.id,
          pathProvider: route.pathProvider,
        })
      }),
    )

  return { plan } satisfies Shape
})

/** Routing for the proxy, remembered per distinct request. */
export class Planner extends Context.Service<Planner, Shape>()("@slopmax/core/proxy/Planner", { make }) {
  static readonly layer: Layer.Layer<Planner, never, Accounts | SettingsService> = Layer.effect(Planner, Planner.make)
}
