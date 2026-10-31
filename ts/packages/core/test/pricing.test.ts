import { describe, expect, it } from "bun:test"

import { type Custom, Price, type Price as PriceT, planMonthly, price, shares } from "../src/pricing.ts"

const list = (model: string): PriceT | undefined => price(model, {})

describe("pricing", () => {
  it("matches_a_model_or_its_dated_snapshots", () => {
    expect(list("claude-opus-5-5")?.input).toBe(4.0)
    expect(list("claude-opus-5")?.input).toBe(5.0)
    expect(list("claude-fable-5-1")?.cacheRead).toBe(0.25)
    expect(list("claude-fable-5")?.cacheRead).toBe(1.0)
    expect(list("claude-haiku-4-5-20251001")?.output).toBe(5.0)
    expect(list("claude-opus-5-5[1m]")?.input).toBe(4.0)
    // An unknown version is not priced as its predecessor.
    expect(list("claude-opus-5-6")).toBeUndefined()
    expect(list("claude-opus-5-5-fast")).toBeUndefined()
    expect(list("gpt-6-sol-pro")).toBeUndefined()
  })

  it("shares_follow_plan_sizes_only_when_every_one_is_known", () => {
    expect(shares("claude", ["max 20x", "Max 5x"])).toEqual([0.8, 0.2])
    expect(shares("claude", ["max 20x", undefined])).toBeUndefined()
    expect(shares("codex", ["pro", "plus"])).toBeUndefined()
    expect(shares("claude", [])).toBeUndefined()
  })

  it("plans_are_priced_by_provider_and_can_be_set", () => {
    expect(planMonthly("claude", "max 20x", {})).toBe(200.0)
    // "pro" is a different plan on each service.
    expect(planMonthly("claude", "Pro", {})).toBe(20.0)
    expect(planMonthly("codex", "pro", {})).toBe(200.0)
    expect(planMonthly("codex", "enterprise", {})).toBeUndefined()
    expect(planMonthly("codex", "pro", { "codex/pro": 229.0 })).toBe(229.0)
  })

  it("openai_prices_charge_nothing_extra_to_cache", () => {
    const sol = list("gpt-6-sol")
    expect(sol).toEqual({ input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.0 })
    expect(list("gpt-6-luna")?.output).toBe(0.5)
  })

  it("custom_prices_win_and_fill_in_cache_rates", () => {
    const custom: Record<string, Custom> = {
      "gpt-6-sol": { input: 2.0, output: 16.0 },
      "claude-opus-5-5": { input: 1.0, output: 2.0, cacheRead: 0.5, cacheWrite: 0.0 },
    }
    const gpt = price("gpt-6-sol", custom)
    expect([gpt?.cacheRead, gpt?.cacheWrite]).toEqual([0.2, 2.5])
    const opus = price("claude-opus-5-5", custom)
    expect([opus?.input, opus?.cacheRead, opus?.cacheWrite]).toEqual([1.0, 0.5, 0.0])
  })

  it("costs_every_kind_of_token", () => {
    const p = list("claude-sonnet-5-5")
    if (p === undefined) throw new Error("no price")
    // 1M of each: 2 + 10 + 0.20 + 2.50.
    const cost = Price.cost(p, 1_000_000, 1_000_000, 1_000_000, 1_000_000)
    expect(Math.abs(cost - 14.7)).toBeLessThan(1e-9)
  })
})

describe("pricing, beyond the Rust tests", () => {
  it("every list price, and custom prices in key order", () => {
    const rows: ReadonlyArray<readonly [string, number, number, number]> = [
      ["claude-fable-5-1", 10, 50, 0.25],
      ["claude-mythos-5-1", 10, 50, 0.25],
      ["claude-fable-5", 10, 50, 1.0],
      ["claude-mythos-5", 10, 50, 1.0],
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
    for (const [model, input, output, cacheRead] of rows) {
      expect(list(model)).toEqual({ input, output, cacheRead, cacheWrite: input * 1.25 })
    }
    expect(
      [
        ["claude", "max", 100],
        ["claude", "team", 30],
        ["codex", "plus", 20],
        ["codex", "team", 30],
        ["codex", "business", 30],
      ].every(([p, plan, fee]) => planMonthly(p as "claude" | "codex", ` ${plan} `, {}) === fee),
    ).toBe(true)
    // `[prices]` is a BTreeMap: the first key in order that matches wins.
    const custom: Record<string, Custom> = { "m-b": { input: 2, output: 2 }, m: { input: 1, output: 1 } }
    expect(price("m", custom)?.input).toBe(1)
  })
})
