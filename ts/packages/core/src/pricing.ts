// API list prices, for estimating what subscription usage would have cost
// on the pay-as-you-go API. Estimates only: cache writes are priced at the
// 5-minute rate, and models without a known price are left unpriced.
import { Schema } from "effect"

import { text } from "@slopmax/common"

import type { ProviderId } from "./provider/mod.ts"
import { byteOrder, opt } from "./serde.ts"
import * as toml from "./toml.ts"

/** Prices in US dollars per million tokens. */
export interface Price {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/**
 * A price set under `[prices]` in config.toml. Cache prices default to the
 * usual ratios: reads at a tenth of input, writes at 1.25×.
 */
export const CustomSchema = Schema.Struct({
  input: toml.F64,
  output: toml.F64,
  cacheRead: opt(toml.F64),
  cacheWrite: opt(toml.F64),
}).pipe(Schema.encodeKeys({ cacheRead: "cache_read", cacheWrite: "cache_write" }))

export type Custom = typeof CustomSchema.Type

export const Price = {
  fromCustom: (c: Custom): Price => ({
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead ?? c.input * 0.1,
    cacheWrite: c.cacheWrite ?? c.input * 1.25,
  }),

  /** The cost in dollars of these token counts. */
  cost: (self: Price, input: number, output: number, cacheRead: number, cacheWrite: number): number =>
    (input * self.input + output * self.output + cacheRead * self.cacheRead + cacheWrite * self.cacheWrite) / 1_000_000,
} as const

type Row = readonly [model: string, input: number, output: number, cacheRead: number]

/**
 * Anthropic first-party API list prices as of 2026-09-25, by model id
 * prefix (dated ids such as `claude-haiku-4-5-20251001` match too). Cache
 * writes are 1.25× input; cache reads vary by model.
 */
const CLAUDE: ReadonlyArray<Row> = [
  // (model, input, output, cache read)
  ["claude-fable-5-1", 10.0, 50.0, 0.25],
  ["claude-mythos-5-1", 10.0, 50.0, 0.25],
  ["claude-fable-5", 10.0, 50.0, 1.0],
  ["claude-mythos-5", 10.0, 50.0, 1.0],
  ["claude-opus-5-5", 4.0, 20.0, 0.2],
  ["claude-opus-5", 5.0, 25.0, 0.5],
  ["claude-opus-4-8", 5.0, 25.0, 0.5],
  ["claude-opus-4-7", 5.0, 25.0, 0.5],
  ["claude-opus-4-6", 5.0, 25.0, 0.5],
  ["claude-sonnet-5-5", 2.0, 10.0, 0.2],
  ["claude-sonnet-5", 2.0, 10.0, 0.2],
  ["claude-sonnet-4-6", 3.0, 15.0, 0.3],
  ["claude-haiku-4-5", 1.0, 5.0, 0.1],
]

/**
 * OpenAI API list prices as of 2026-09-22, when GPT-6's were halved.
 * Cached input is a tenth of input, and caching costs nothing extra.
 */
const OPENAI: ReadonlyArray<Row> = [
  // (model, input, output, cache read)
  ["gpt-6-sol", 2.0, 10.0, 0.2],
  ["gpt-6-luna", 0.1, 0.5, 0.01],
]

/**
 * Subscription list prices in US dollars a month, by provider and the plan
 * its accounts report. What a plan costs varies by country and with tax;
 * `[plan_prices]` in config.toml sets the real figure.
 */
const PLANS: ReadonlyArray<readonly [ProviderId, string, number]> = [
  ["claude", "pro", 20.0],
  ["claude", "max", 100.0],
  ["claude", "max 5x", 100.0],
  ["claude", "max 20x", 200.0],
  ["claude", "team", 30.0],
  ["codex", "plus", 20.0],
  ["codex", "pro", 200.0],
  ["codex", "team", 30.0],
  ["codex", "business", 30.0],
]

const normalize = (plan: string): string => text.asciiLowercase(text.trim(plan))

/**
 * What a subscription plan costs a month: the user's own figure, set as
 * `"claude/max 20x" = 200` under `[plan_prices]`, else the list price.
 */
export const planMonthly = (
  provider: ProviderId,
  plan: string,
  custom: Readonly<Record<string, number>>,
): number | undefined => {
  const name = normalize(plan)
  const key = `${provider}/${name}`
  if (Object.hasOwn(custom, key)) return custom[key]
  return PLANS.find(([p, n]) => p === provider && n === name)?.[2]
}

/**
 * How much usage each plan allows, against the smallest of its provider:
 * Claude's Max plans are sold as 5 and 20 times Pro. ChatGPT states no such
 * ratio, so its plans have none here.
 */
const CAPACITY: ReadonlyArray<readonly [ProviderId, string, number]> = [
  ["claude", "pro", 1.0],
  ["claude", "max 5x", 5.0],
  ["claude", "max 20x", 20.0],
]

/**
 * Each account's share of its pool's capacity, by plan, in the order given;
 * undefined unless every plan's size is known, as a mean weighted by guesses
 * would mislead more than a plain one.
 */
export const shares = (
  provider: ProviderId,
  plans: ReadonlyArray<string | undefined>,
): ReadonlyArray<number> | undefined => {
  const sizes: Array<number> = []
  for (const plan of plans) {
    if (plan === undefined) return undefined
    const name = normalize(plan)
    const size = CAPACITY.find(([p, n]) => p === provider && n === name)?.[2]
    if (size === undefined) return undefined
    sizes.push(size)
  }
  const total = sizes.reduce((sum, s) => sum + s, 0)
  return total > 0 ? sizes.map((s) => s / total) : undefined
}

// The custom prices in their BTreeMap order, sorted once per map: `usage`
// prices every ledger entry against the same one.
const sortedIds = new WeakMap<Readonly<Record<string, Custom>>, ReadonlyArray<string>>()

const idsOf = (custom: Readonly<Record<string, Custom>>): ReadonlyArray<string> => {
  let ids = sortedIds.get(custom)
  if (ids === undefined) {
    ids = Object.keys(custom).toSorted(byteOrder)
    sortedIds.set(custom, ids)
  }
  return ids
}

/** The price of `model`: the user's own if they set one, else the list price. */
export const price = (model: string, custom: Readonly<Record<string, Custom>>): Price | undefined => {
  // Claude Code may tag a model with its context window, e.g. `[1m]`.
  const bare = model.split("[")[0] ?? model
  for (const id of idsOf(custom)) {
    const own = custom[id]
    if (own !== undefined && isModel(bare, id)) return Price.fromCustom(own)
  }
  for (const [rows, write] of [
    [CLAUDE, 1.25],
    [OPENAI, 1.0],
  ] as const) {
    const row = rows.find(([id]) => isModel(bare, id))
    if (row !== undefined) {
      const [, input, output, cacheRead] = row
      return { input, output, cacheRead, cacheWrite: input * write }
    }
  }
  return undefined
}

/**
 * Whether `model` is `id` or a dated snapshot of it, such as
 * `claude-haiku-4-5-20251001`. Any other suffix is a different model.
 */
const isModel = (model: string, id: string): boolean => {
  if (!model.startsWith(id)) return false
  const rest = model.slice(id.length)
  return rest === "" || /^-[0-9]{8}$/.test(rest)
}
