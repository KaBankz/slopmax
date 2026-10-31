import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Exit, Redacted, Result, Schema } from "effect"
import {
  ClientKey,
  decodeSettings,
  defaultListen,
  defaultPort,
  defaultSettings,
  issueText,
  liveKeys,
  liveOf,
  LiveSettings,
  liveTable,
  liveText,
  NotifySettings,
  parseLive,
  restartNeeded,
  type Settings,
  Settings as SettingsSchema,
  settingsFile,
  settingsJsonSchema,
  SettingsPatch,
  settingsView,
  strategySummaries,
  Strategy,
  toPublic,
} from "../src/index.ts"

const load = (input: unknown): Settings => Effect.runSync(decodeSettings(input))

const refusal = (input: unknown): string => {
  const exit = Effect.runSyncExit(decodeSettings(input))
  if (Exit.isSuccess(exit)) throw new Error(`expected ${JSON.stringify(input)} to be refused`)
  const error = exit.cause.reasons[0]
  if (error?._tag !== "Fail") throw new Error("expected a schema failure")
  return issueText(error.error.issue)
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

describe("Settings", () => {
  it("loads a partial file with every missing setting at its default", () => {
    const settings = load({ strategy: "fill-first", listen: "0.0.0.0:9000" })
    expect(settings.strategy).toBe("fill-first")
    expect(settings.listen).toBe("0.0.0.0:9000")
    expect(settings.sessionMinutes).toBe(60)
    const empty = load({})
    expect([empty.listen, empty.strategy, empty.sessionMinutes, empty.pollMinutes]).toEqual([
      "127.0.0.1:7567",
      "reset-first",
      60,
      5,
    ])
    expect([empty.sessionAffinity, empty.refreshTokens, empty.redeemExpiring, empty.websockets]).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect([empty.redeemWhenExhausted, empty.warmWindows, empty.paidOverflow]).toEqual([false, false, false])
    expect(empty.upstreamProxy).toBeUndefined()
    expect([empty.aliases, empty.fallbacks, empty.prices, empty.planPrices, empty.keys]).toEqual([{}, {}, {}, {}, []])
    expect(empty.notify).toEqual(NotifySettings.empty)
    expect(Redacted.value(empty.apiKey)).toBe("")
  })

  it("listens on port 7567 of this machine unless told otherwise", () => {
    expect(defaultPort).toBe(7567)
    expect(defaultListen).toBe("127.0.0.1:7567")
    expect(Redacted.value(defaultSettings("sm-key").apiKey)).toBe("sm-key")
  })

  it("reads custom prices, whole numbers included, and needs both input and output", () => {
    const price = load({ prices: { "my-model": { input: 2.0, output: 8 } } }).prices["my-model"]
    expect([price?.input, price?.output, price?.cacheRead]).toEqual([2, 8, undefined])
    expect(refusal({ prices: { m: { input: 1 } } })).toBe("prices.m.output: Missing key")
  })

  it("refuses settings it does not know, at any depth", () => {
    expect(refusal({ lisen: "x" })).toBe("lisen: Expected no excess property")
    expect(refusal({ keys: [{ name: "laptop", key: "sm-1", modles: [] }] })).toBe(
      "keys.0.modles: Expected no excess property",
    )
    expect(refusal({ prices: { m: { input: 1, output: 2, cached: 1 } } })).toBe(
      "prices.m.cached: Expected no excess property",
    )
    expect(refusal({ notify: { hook: "https://x" } })).toBe("notify.hook: Expected no excess property")
    expect(refusal({ keys: [{ key: "sm-1" }] })).toBe("keys.0.name: Missing key")
  })

  it("refuses an address or a proxy it cannot use, saying why", () => {
    expect(refusal({ listen: "localhost" })).toBe('listen: "localhost" is not an address, like 127.0.0.1:7567')
    expect(refusal({ listen: "127.0.0.1:70000" })).toContain("is not an address")
    expect(load({ listen: "[::1]:8080" }).listen).toBe("[::1]:8080")
    expect(refusal({ upstreamProxy: "x" })).toBe('upstreamProxy: proxy "x" needs a scheme, like http:// or socks5://')
    expect(refusal({ upstreamProxy: "ftp://x" })).toBe('upstreamProxy: unsupported proxy scheme "ftp"')
    expect(load({ upstreamProxy: "socks5h://127.0.0.1:1080" }).upstreamProxy).toBe("socks5h://127.0.0.1:1080")
    expect(refusal({ strategy: "fastest" })).toBe(
      "strategy: strategy is one of reset-first, fill-first, least-used, round-robin",
    )
  })

  it("lets a client key use the models it names, or every model when it names none", () => {
    const [laptop, ci] = load({
      keys: [
        { name: "laptop", key: "sm-1", models: ["gpt-*"] },
        { name: "ci", key: "sm-2" },
      ],
    }).keys
    expect(laptop?.allows("gpt-6-sol")).toBe(true)
    expect(laptop?.allows("claude-opus-5-5")).toBe(false)
    expect(ci?.allows("anything")).toBe(true)
    expect(ci).toBeInstanceOf(ClientKey)
    expect(String(ci?.key)).not.toContain("sm-2")
  })

  it("sends the default notice kinds when none are named, and the test notice always", () => {
    const defaults = NotifySettings.empty
    expect(defaults.enabled).toBe(false)
    expect(defaults.wants("exhausted")).toBe(true)
    expect(defaults.wants("limited")).toBe(false)
    const picked = load({ notify: { command: "true", events: ["limited"] } }).notify
    expect(picked.enabled).toBe(true)
    expect(picked.wants("limited")).toBe(true)
    expect(picked.wants("exhausted")).toBe(false)
    expect(picked.wants("test")).toBe(true)
    expect(load({ notify: { events: ["signed-out"] } }).notify.events).toEqual(["signed-out"])
    expect(new NotifySettings({ events: [] }).wants("recovered")).toBe(true)
  })
})

describe("config.schema.json", () => {
  it("describes every setting and gives each one a default its file may leave out", () => {
    const document = settingsJsonSchema()
    expect(document["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(document["additionalProperties"]).toBe(false)
    const properties = document["properties"]
    if (!isObject(properties)) throw new Error("the schema has no properties")
    expect(Object.keys(properties).toSorted()).toEqual(Object.keys(SettingsSchema.fields).toSorted())
    for (const [name, property] of Object.entries(properties)) {
      if (!isObject(property)) throw new Error(`${name} has no schema`)
      expect(typeof property["description"]).toBe("string")
    }
    // Only the owner key is needed, and slopmax makes it on first run.
    expect(document["required"]).toBeUndefined()
    const defaults = settingsFile(defaultSettings("sm-key"))
    for (const [name, value] of Object.entries(defaults)) {
      if (name === "$schema" || name === "apiKey") continue
      const property = properties[name]
      expect([name, isObject(property) ? property["default"] : undefined]).toEqual([name, value])
    }
  })

  it("is plain JSON an editor can load", () => {
    const text = JSON.stringify(settingsJsonSchema())
    expect(JSON.parse(text)).toEqual(settingsJsonSchema())
    // The settings themselves are at the root, not behind a reference.
    expect(text).not.toContain('"#/$defs/SettingsEncoded"')
  })
})

describe("settings files", () => {
  it("are written with their schema link, and without lists and tables nobody filled in", () => {
    const file = settingsFile(defaultSettings("sm-key"))
    expect(Object.keys(file)[0]).toBe("$schema")
    expect(file["$schema"]).toBe("./config.schema.json")
    expect(file["apiKey"]).toBe("sm-key")
    for (const name of ["aliases", "fallbacks", "prices", "planPrices", "keys", "notify", "upstreamProxy"]) {
      expect(name in file).toBe(false)
    }
    const set = settingsFile(
      load({ apiKey: "sm-key", aliases: { fast: "gpt-6-sol-mini" }, notify: { webhook: "https://hook" } }),
    )
    expect(set["aliases"]).toEqual({ fast: "gpt-6-sol-mini" })
    expect(set["notify"]).toEqual({ webhook: "https://hook", events: NotifySettings.empty.events })
    // What is written reads back as the same settings.
    expect(Schema.encodeSync(SettingsSchema)(load(set))).toEqual(
      Schema.encodeSync(SettingsSchema)(
        load({
          $schema: "./config.schema.json",
          apiKey: "sm-key",
          aliases: { fast: "gpt-6-sol-mini" },
          notify: { webhook: "https://hook" },
        }),
      ),
    )
  })
})

describe("live settings", () => {
  it("are exactly the settings annotated live, each with a summary", () => {
    const annotated = Object.entries(SettingsSchema.fields)
      .filter(([, field]) => Schema.resolveAnnotations(field)?.live !== undefined)
      .map(([name]) => name)
    expect(annotated.toSorted()).toEqual(Object.keys(LiveSettings.fields).toSorted())
    expect(liveTable.map((row) => row.name)).toEqual([...liveKeys])
    for (const row of liveTable) expect(row.summary).not.toBe(row.name)
    expect(liveTable.find((row) => row.name === "sessionAffinity")?.summary).toBe(
      "Keep a session on its account, for the prompt cache",
    )
    expect(liveTable.map((row) => row.kind)).toEqual([
      "choice",
      "switch",
      "minutes",
      "switch",
      "switch",
      "switch",
      "switch",
      "minutes",
      "switch",
      "switch",
    ])
  })

  it("are read as people type them and checked before they are written", () => {
    expect(parseLive("strategy", "round-robin")).toEqual(Result.succeed({ strategy: "round-robin" }))
    expect(parseLive("sessionAffinity", "off")).toEqual(Result.succeed({ sessionAffinity: false }))
    expect(parseLive("websockets", " yes ")).toEqual(Result.succeed({ websockets: true }))
    expect(parseLive("pollMinutes", "0")).toEqual(Result.succeed({ pollMinutes: 0 }))
    expect(parseLive("sessionMinutes", "45")).toEqual(Result.succeed({ sessionMinutes: 45 }))
    expect(parseLive("sessionMinutes", "0")).toEqual(Result.fail("sessionMinutes is a number of minutes"))
    expect(parseLive("pollMinutes", "-1")).toEqual(Result.fail("pollMinutes is a number of minutes"))
    expect(parseLive("pollMinutes", "1.5")).toEqual(Result.fail("pollMinutes is a number of minutes"))
    expect(parseLive("strategy", "fastest")).toEqual(
      Result.fail("strategy is one of reset-first, fill-first, least-used, round-robin"),
    )
    expect(parseLive("warmWindows", "maybe")).toEqual(Result.fail("warmWindows is on or off"))
    // Words are case-sensitive, as they are documented.
    expect(parseLive("warmWindows", "ON")).toEqual(Result.fail("warmWindows is on or off"))
    expect(parseLive("listen", "0.0.0.0:1")).toEqual(
      Result.fail(
        "listen is not a setting slopmax changes while it runs; those are strategy, sessionAffinity, sessionMinutes, redeemExpiring, redeemWhenExhausted, warmWindows, paidOverflow, pollMinutes, refreshTokens, websockets",
      ),
    )
  })

  it("read back as they are typed, and every default reads in again", () => {
    const settings = load({})
    expect(liveText(settings, "strategy")).toBe("reset-first")
    expect(liveText(settings, "sessionMinutes")).toBe("60")
    expect(liveText(settings, "sessionAffinity")).toBe("on")
    expect(liveText(settings, "warmWindows")).toBe("off")
    const live = liveOf(settings)
    for (const row of liveTable) {
      expect(row.parse(liveText(live, row.name))).toEqual(Result.succeed({ [row.name]: live[row.name] }))
    }
  })

  it("change through a patch that names only live settings, and at least one", () => {
    const decode = Schema.decodeUnknownResult(SettingsPatch)
    expect(decode({ strategy: "least-used", pollMinutes: 0 })).toEqual(
      Result.succeed({ strategy: "least-used", pollMinutes: 0 }),
    )
    const message = (body: unknown) => {
      const result = decode(body)
      return Result.isFailure(result) ? issueText(result.failure.issue) : "accepted"
    }
    expect(message({})).toBe("no settings to change")
    expect(message({ listen: "0.0.0.0:1" })).toContain("listen is not a setting slopmax changes while it runs")
    expect(message({ sessionMinutes: 0 })).toBe("sessionMinutes: sessionMinutes is a number of minutes")
    expect(message({ paidOverflow: "on" })).toBe("paidOverflow: paidOverflow is on or off")
  })
})

describe("strategies", () => {
  it("are offered in order with their summaries", () => {
    expect(Strategy.literals).toEqual(["reset-first", "fill-first", "least-used", "round-robin"])
    expect(strategySummaries).toEqual({
      "reset-first": "Spend the quota that resets soonest, so none is lost",
      "fill-first": "Use accounts in priority order; fail over when one is limited",
      "least-used": "Balance load toward the least used account",
      "round-robin": "Take turns across accounts",
    })
    expect(Schema.decodeUnknownResult(Strategy)("reset-first")).toEqual(Result.succeed("reset-first"))
    expect(Result.isFailure(Schema.decodeUnknownResult(Strategy)("Reset-First"))).toBe(true)
  })
})

describe("SettingsView", () => {
  it("serves the settings without the owner key or any client key's secret", () => {
    const settings = load({ apiKey: "sm-owner", keys: [{ name: "laptop", key: "sm-laptop", models: ["gpt-*"] }] })
    const view = settingsView(settings)
    expect(JSON.stringify(Schema.encodeSync(SettingsSchema)(settings))).toContain("sm-owner")
    const served = JSON.stringify(view)
    expect(served).not.toContain("sm-owner")
    expect(served).not.toContain("sm-laptop")
    expect(toPublic(settings).keys.map((key) => [String(key.name), key.models])).toEqual([["laptop", ["gpt-*"]]])
    expect(view.strategies.map((s) => s.id)).toEqual([...Strategy.literals])
    expect(view.live.map((row) => row.name)).toEqual([...liveKeys])
    expect(view.restartNeeded).toEqual([])
  })

  it("says which settings wait for a restart when the file differs from what runs", () => {
    const running = load({ listen: "127.0.0.1:7567" })
    const file = load({ listen: "0.0.0.0:7567", upstreamProxy: "http://proxy:3128", strategy: "fill-first" })
    expect(restartNeeded(running, file)).toEqual(["listen", "upstreamProxy"])
    expect(settingsView(running, file).restartNeeded).toEqual(["listen", "upstreamProxy"])
    expect(restartNeeded(running, running)).toEqual([])
  })
})
