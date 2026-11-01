import { describe, expect } from "bun:test"
import { Price } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { Effect, Schema } from "effect"
import { parseSettings } from "../../src/settings.ts"
import { costAt, costOf, planFee, pricingOf, ratesFor, shares } from "../../src/pricing.ts"

const price = Schema.decodeUnknownSync(Price)

describe("API prices", () => {
  it("a model is priced as itself or its dated snapshots, and never as another version", () => {
    expect(ratesFor("claude-opus-5-5")?.input).toBe(4)
    expect(ratesFor("claude-opus-5")?.input).toBe(5)
    expect(ratesFor("claude-fable-5-1")?.cacheRead).toBe(0.25)
    expect(ratesFor("claude-fable-5")?.cacheRead).toBe(1)
    expect(ratesFor("claude-haiku-4-5-20251001")?.output).toBe(5)
    // Claude Code's context tag is not part of the model.
    expect(ratesFor("claude-opus-5-5[1m]")?.input).toBe(4)
    expect(ratesFor("claude-opus-5-6")).toBeUndefined()
    expect(ratesFor("claude-opus-5-5-fast")).toBeUndefined()
    expect(ratesFor("claude-opus-5-5-2026010")).toBeUndefined()
    expect(ratesFor("gpt-6-sol-pro")).toBeUndefined()
  })

  it("Claude charges 1.25 times input to write the cache", () => {
    const sonnet = ratesFor("claude-sonnet-4-6")
    expect(sonnet).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
    expect(ratesFor("claude-mythos-5-1")).toEqual({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 })
  })

  it("OpenAI charges nothing extra to write the cache", () => {
    expect(ratesFor("gpt-6-sol")).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 })
    expect(ratesFor("gpt-6-luna")?.output).toBe(0.5)
  })

  it("prices people set win, and fill in the cache rates they leave out", () => {
    const custom = {
      "gpt-6-sol": price({ input: 2, output: 16 }),
      "claude-opus-5-5": price({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }),
      "my-model": price({ input: 1, output: 1 }),
    }
    const gpt = ratesFor("gpt-6-sol", custom)
    expect([gpt?.cacheRead, gpt?.cacheWrite]).toEqual([0.2, 2.5])
    const opus = ratesFor("claude-opus-5-5-20260101", custom)
    expect([opus?.input, opus?.cacheRead, opus?.cacheWrite]).toEqual([1, 0.5, 0])
    expect(ratesFor("my-model", custom)?.output).toBe(1)
  })

  it.effect("a price with a field slopmax does not know is refused", () =>
    Effect.gen(function* () {
      const text = JSON.stringify({ prices: { m: { input: 1, output: 1, extra: 2 } } })
      const parsed = yield* Effect.result(parseSettings("config.json", text))
      expect(parsed._tag).toBe("Failure")
      const fine = yield* parseSettings("config.json", JSON.stringify({ prices: { m: { input: 1, output: 1 } } }))
      expect(ratesFor("m", fine.settings.prices)?.cacheWrite).toBe(1.25)
    }),
  )

  it("a cost counts every kind of token", () => {
    const sonnet = ratesFor("claude-sonnet-5-5")
    if (sonnet === undefined) throw new Error("sonnet has a price")
    // A million of each: 2 + 10 + 0.20 + 2.50.
    const million = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 }
    expect(costAt(sonnet, million)).toBeCloseTo(14.7, 9)
    expect(costOf("claude-sonnet-5-5", million)).toBeCloseTo(14.7, 9)
    expect(costOf("unknown", million)).toBeUndefined()
  })
})

describe("plans", () => {
  it("plans are priced by provider, and people can set their own", () => {
    expect(planFee("claude", "max 20x")).toBe(200)
    // "pro" is a different plan at each provider.
    expect(planFee("claude", " Pro ")).toBe(20)
    expect(planFee("codex", "pro")).toBe(200)
    expect(planFee("codex", "enterprise")).toBeUndefined()
    expect(planFee("openai", "pro")).toBeUndefined()
    expect(planFee("codex", "pro", { "codex/pro": 229 })).toBe(229)
    const pricing = pricingOf({ prices: {}, planPrices: { "claude/max": 90 } })
    expect(pricing.planFee("claude", "Max")).toBe(90)
    expect(pricing.rates("gpt-6-sol")?.input).toBe(2)
  })

  it("pool shares follow plan sizes only when every one is known", () => {
    expect(shares("claude", ["max 20x", "Max 5x"])).toEqual([0.8, 0.2])
    expect(shares("claude", ["pro", "pro"])).toEqual([0.5, 0.5])
    expect(shares("claude", ["max 20x", undefined])).toBeUndefined()
    expect(shares("claude", ["max 20x", "team"])).toBeUndefined()
    expect(shares("codex", ["pro", "plus"])).toBeUndefined()
    expect(shares("claude", [])).toBeUndefined()
  })
})
