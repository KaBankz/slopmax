// What usage would have cost on the pay-per-token APIs, what each
// subscription plan costs a month, and how much of a pool each plan holds.
//
// The figures are estimates: cache writes are priced at the 5-minute rate,
// and a model slopmax has no price for stays unpriced rather than guessed.
// People can set their own prices and plan fees in `config.json`; theirs
// always win over the built-in lists.
import { type ProviderId, type Price, type Settings, type SubscriptionId, type Usage } from "@slopmax/domain"

/** API prices for one model, in dollars per million tokens, with the cache rates filled in. */
export interface Rates {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** What usage is valued at. The list prices and the settings' own prices are behind these. */
export interface Pricing {
  /** A model's API prices, or nothing when slopmax cannot price it. */
  readonly rates: (model: string) => Rates | undefined
  /** What a plan costs a month, or nothing when its price is not known. */
  readonly planFee: (provider: ProviderId, plan: string) => number | undefined
}

/** What a set of tokens costs at `rates`. */
export const costAt = (
  rates: Rates,
  usage: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number },
): number =>
  (usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * rates.cacheRead +
    usage.cacheWrite * rates.cacheWrite) /
  1e6

/** A model's list prices in dollars per million tokens: input, output, cache read. */
type Listed = readonly [model: string, input: number, output: number, cacheRead: number]

/**
 * Anthropic's API list prices (2026-09-25). A dated id such as
 * `claude-haiku-4-5-20251001` takes its model's price. Writing to the cache
 * costs 1.25 times input.
 */
const claudePrices: ReadonlyArray<Listed> = [
  ["claude-fable-5-1", 10, 50, 0.25],
  ["claude-mythos-5-1", 10, 50, 0.25],
  ["claude-fable-5", 10, 50, 1],
  ["claude-mythos-5", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.2],
  ["claude-opus-5", 5, 25, 0.5],
  ["claude-opus-4-8", 5, 25, 0.5],
  ["claude-opus-4-7", 5, 25, 0.5],
  ["claude-opus-4-6", 5, 25, 0.5],
  ["claude-sonnet-5-5", 2, 10, 0.2],
  ["claude-sonnet-5", 2, 10, 0.2],
  ["claude-sonnet-4-6", 3, 15, 0.3],
  ["claude-haiku-4-5", 1, 5, 0.1],
]

/** OpenAI's API list prices (2026-09-22, when GPT-6's were halved). Caching costs nothing extra. */
const openaiPrices: ReadonlyArray<Listed> = [
  ["gpt-6-sol", 2, 10, 0.2],
  ["gpt-6-luna", 0.1, 0.5, 0.01],
]

/** The list prices, searched in this order, with what a cache write costs against input. */
const listedPrices: ReadonlyArray<{ readonly rows: ReadonlyArray<Listed>; readonly cacheWrite: number }> = [
  { rows: claudePrices, cacheWrite: 1.25 },
  { rows: openaiPrices, cacheWrite: 1 },
]

/**
 * Subscription list prices in dollars a month, by the plan an account
 * reports. What a plan really costs varies by country and with tax, so
 * `planPrices` in the settings may say otherwise.
 */
const planFees: { readonly [K in SubscriptionId]: Readonly<Record<string, number>> } = {
  claude: { pro: 20, max: 100, "max 5x": 100, "max 20x": 200, team: 30 },
  codex: { plus: 20, pro: 200, team: 30, business: 30 },
}

/**
 * How much usage each plan allows against its provider's smallest: Claude's
 * Max plans are sold as 5 and 20 times Pro. ChatGPT states no such ratio, so
 * its plans have no size here.
 */
const planSizes: { readonly [K in SubscriptionId]: Readonly<Record<string, number>> } = {
  claude: { pro: 1, "max 5x": 5, "max 20x": 20 },
  codex: {},
}

const planName = (plan: string): string => plan.trim().toLowerCase()

const listFor = <T>(table: { readonly [K in SubscriptionId]: T }, provider: ProviderId): T | undefined =>
  provider === "claude" ? table.claude : provider === "codex" ? table.codex : undefined

/**
 * Whether `model` is the model `id` or a dated snapshot of it
 * (`claude-haiku-4-5-20251001`). Any other suffix names another model, so an
 * unknown version is never priced as the one before it.
 */
export const isModel = (model: string, id: string): boolean => {
  if (!model.startsWith(id)) return false
  const rest = model.slice(id.length)
  return rest === "" || /^-\d{8}$/.test(rest)
}

/** A price people set, with the cache rates they left out at the usual ratios: reads a tenth of input, writes 1.25 times. */
export const ratesOf = (price: Price): Rates => ({
  input: price.input,
  output: price.output,
  cacheRead: price.cacheRead ?? price.input * 0.1,
  cacheWrite: price.cacheWrite ?? price.input * 1.25,
})

/**
 * A model's prices: the settings' own (in the order they are written), else
 * the list prices. Claude Code may tag a model with its context window
 * (`claude-opus-5-5[1m]`); the tag is not part of the model.
 */
export const ratesFor = (model: string, custom: Readonly<Record<string, Price>> = {}): Rates | undefined => {
  const name = model.split("[")[0] ?? model
  for (const [id, price] of Object.entries(custom)) if (isModel(name, id)) return ratesOf(price)
  for (const { rows, cacheWrite } of listedPrices) {
    const row = rows.find(([id]) => isModel(name, id))
    if (row !== undefined) {
      const [, input, output, cacheRead] = row
      return { input, output, cacheRead, cacheWrite: input * cacheWrite }
    }
  }
  return undefined
}

/**
 * What a subscription plan costs a month: the settings' own figure, keyed
 * `"<provider>/<plan>"` (such as `"claude/max 20x"`), else the list price.
 * "pro" is a different plan at each provider.
 */
export const planFee = (
  provider: ProviderId,
  plan: string,
  custom: Readonly<Record<string, number>> = {},
): number | undefined => {
  const name = planName(plan)
  return custom[`${provider}/${name}`] ?? listFor(planFees, provider)?.[name]
}

/**
 * Each account's share of its pool's capacity, by plan, in the order given,
 * summing to 1. Nothing unless every plan's size is known: a mean weighted
 * by guesses would mislead more than a plain one.
 */
export const shares = (
  provider: ProviderId,
  plans: ReadonlyArray<string | undefined>,
): ReadonlyArray<number> | undefined => {
  const sizes = listFor(planSizes, provider)
  if (sizes === undefined) return undefined
  const known: Array<number> = []
  for (const plan of plans) {
    const size = plan === undefined ? undefined : sizes[planName(plan)]
    if (size === undefined) return undefined
    known.push(size)
  }
  const total = known.reduce((sum, size) => sum + size, 0)
  return total > 0 ? known.map((size) => size / total) : undefined
}

/** How usage is valued under these settings: their prices and plan fees over the built-in lists. */
export const pricingOf = (settings: Pick<Settings, "prices" | "planPrices">): Pricing => ({
  rates: (model) => ratesFor(model, settings.prices),
  planFee: (provider, plan) => planFee(provider, plan, settings.planPrices),
})

/** What a request's tokens cost at a model's prices, when it has them. */
export const costOf = (
  model: string,
  usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">,
  custom: Readonly<Record<string, Price>> = {},
): number | undefined => {
  const rates = ratesFor(model, custom)
  return rates === undefined ? undefined : costAt(rates, usage)
}
