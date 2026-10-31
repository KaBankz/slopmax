import { describe, expect } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Layer, Result, Schema } from "effect"

import {
  ClientKey,
  Config,
  ConfigSchema,
  LIVE,
  liveValue,
  parse,
  SocketAddr,
  Strategy,
  template,
} from "../src/config.ts"
import { chain, Failure } from "../src/error.ts"
import * as toml from "../src/toml.ts"
import { tempDirs } from "./support/temp.ts"

const temp = tempDirs()

// A config file in a directory that does not exist yet.
const tempConfig = (name = "config"): string => join(temp(name), "home", "config.toml")

const parsed = (text: string): Config => {
  const config = parse(text)
  if (Result.isFailure(config)) throw new Error(config.failure.message)
  return config.success
}

const value = (name: string, v: string): toml.Value => {
  const r = liveValue(name, v)
  if (Result.isFailure(r)) throw new Error(r.failure)
  return r.success[1]
}

const error = (name: string, v: string): string => {
  const r = liveValue(name, v)
  if (Result.isSuccess(r)) throw new Error(`${name} = ${v} was accepted`)
  return r.failure
}

const env = (vars: Record<string, string>) => Layer.fresh(ConfigProvider.layer(ConfigProvider.fromUnknown(vars)))

describe("config", () => {
  it.live("first_load_writes_the_template_with_a_fresh_key", () =>
    Effect.gen(function* () {
      const path = tempConfig()
      const first = yield* Config.loadFrom(path)
      expect(first.apiKey.startsWith("sm-")).toBe(true)
      expect(first.apiKey.length).toBe(46)
      const text = readFileSync(path, "utf8")
      expect(text).toBe(template(first.apiKey))
      const second = yield* Config.loadFrom(path)
      expect(second).toEqual(first)
      // Private: the file 0600, a new directory 0700.
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700)
    }),
  )

  it.live("a_missing_key_is_added_without_rewriting_the_file", () =>
    Effect.gen(function* () {
      const path = tempConfig()
      mkdirSync(dirname(path), { recursive: true })
      const mine = '# my setup\nstrategy = "fill-first" # drain in order\n'
      writeFileSync(path, mine)
      const config = yield* Config.loadFrom(path)
      expect(config.strategy).toBe("fill-first")
      const text = readFileSync(path, "utf8")
      expect(text).toBe(`${mine}api_key = "${config.apiKey}"\n`)
    }),
  )

  it("live_settings_are_checked_before_they_are_written", () => {
    expect(value("strategy", "round-robin").asStr()).toBe("round-robin")
    expect(value("session_affinity", "off").asBool()).toBe(false)
    expect(value("poll_mins", "0").asInteger()).toBe(0n)
    error("session_ttl_mins", "0")
    expect(error("strategy", "fastest")).toContain("round-robin")
    expect(error("listen", "0.0.0.0:1")).toContain("not a setting")
    error("warm_windows", "maybe")
    const config = Config.default()
    for (const [name] of LIVE) {
      const current = Config.live(config, name)
      expect(current).toBeDefined()
      expect(Result.isSuccess(liveValue(name, current ?? ""))).toBe(true)
    }
    expect(Config.live(config, "api_key")).toBeUndefined()
    // The exact texts people read.
    expect(error("listen", "x")).toBe(
      "listen is not a setting slopmax changes while it runs; those are strategy, session_affinity, session_ttl_mins, redeem_expiring_credits, redeem_when_exhausted, warm_windows, paid_overflow, poll_mins",
    )
    expect(error("strategy", "x")).toBe("strategy is one of reset-first, fill-first, least-used, round-robin")
    expect(error("poll_mins", "-1")).toBe("poll_mins is a number of minutes")
    expect(error("warm_windows", "On")).toBe("warm_windows is on or off")
    expect(value("session_ttl_mins", " 30 ").asInteger()).toBe(30n)
  })

  it.live("processes_started_together_agree_on_the_key", () =>
    Effect.gen(function* () {
      const path = tempConfig("race")
      const keys = yield* Effect.all(
        Array.from({ length: 8 }, () => Effect.map(Config.loadFrom(path), (c) => c.apiKey)),
        { concurrency: "unbounded" },
      )
      expect(new Set(keys).size).toBe(1)
      expect((yield* Config.loadFrom(path)).apiKey).toBe(keys[0] ?? "")
      // And as separate processes, which take turns on the same lock file.
      const other = tempConfig("race")
      const script = `
        import { Effect } from "effect"
        import { Config } from ${JSON.stringify(join(import.meta.dir, "../src/config.ts"))}
        const config = await Effect.runPromise(Config.loadFrom(process.env.RACE_CONFIG ?? ""))
        console.log(config.apiKey)
      `
      const children = Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, "-e", script], {
          cwd: join(import.meta.dir, ".."),
          env: { ...process.env, RACE_CONFIG: other },
          stdout: "pipe",
          stderr: "inherit",
        }),
      )
      const printed = yield* Effect.promise(() =>
        Promise.all(children.map(async (child) => (await new Response(child.stdout).text()).trim())),
      )
      expect(new Set(printed).size).toBe(1)
      expect((yield* Config.loadFrom(other)).apiKey).toBe(printed[0] ?? "")
    }),
  )

  it("template_lists_every_setting_at_its_default", () => {
    const expected: Config = { ...Config.default(), apiKey: "sm-key" }
    const text = template("sm-key")
    expect(parsed(text)).toEqual(expected)

    const uncommented = text
      .split("\n")
      .map((line) => {
        // Settings start the line; indented ones are examples.
        if (!line.startsWith("# ")) return line
        const setting = line.slice(2)
        return setting.includes(" = ") && !setting.startsWith(" ") ? setting : line
      })
      .join("\n")
    expect(parsed(uncommented)).toEqual(expected)
    const listed = toml.Document.parse(uncommented)
    if (Result.isFailure(listed)) throw new Error(listed.failure.message)
    const fields = Schema.encodeSync(ConfigSchema)(expected)
    expect(new Set(Object.keys(listed.success.data))).toEqual(new Set(Object.keys(fields)))
  })

  it("parses_partial_config", () => {
    const config = parsed('strategy = "fill-first"\nlisten = "0.0.0.0:9000"')
    expect(config.strategy).toBe("fill-first")
    expect(Config.baseUrl(config)).toBe("http://127.0.0.1:9000")
    expect(config.sessionTtlMins).toBe(60)
  })

  it("parses_custom_prices", () => {
    const config = parsed('[prices."my-model"]\ninput = 2.0\noutput = 8\n')
    const price = config.prices["my-model"]
    expect([price?.input, price?.output, price?.cacheRead]).toEqual([2.0, 8.0, undefined])
    expect(Result.isFailure(parse("[prices.m]\ninput = 1\n"))).toBe(true)
  })

  it.live("client_keys_are_added_and_removed_in_place", () =>
    Effect.gen(function* () {
      const path = tempConfig()
      const first = yield* Config.loadFrom(path)
      const laptop = yield* Config.addKey(path, "laptop", ["gpt-*"])
      const ci = yield* Config.addKey(path, "ci", [])
      const again = yield* Effect.flip(Config.addKey(path, "ci", []))
      expect(again.message).toBe('a key named "ci" already exists')
      const config = yield* Config.loadFrom(path)
      expect(config.apiKey).toBe(first.apiKey)
      expect(config.keys.length).toBe(2)
      const [own, other] = config.keys
      expect(own?.key).toBe(laptop)
      expect(own !== undefined && ClientKey.allows(own, "gpt-6-sol") && !ClientKey.allows(own, "claude-opus-5-5")).toBe(
        true,
      )
      expect(other !== undefined && ClientKey.allows(other, "anything")).toBe(true)
      expect(laptop).not.toBe(ci)
      // The template's comments survive.
      const text = readFileSync(path, "utf8")
      expect(text).toContain("# slopmax settings.")
      expect(yield* Config.removeKey(path, "laptop")).toBe(true)
      expect(yield* Config.removeKey(path, "laptop")).toBe(false)
      expect((yield* Config.loadFrom(path)).keys.length).toBe(1)
    }),
  )

  it("rejects_unknown_keys", () => {
    expect(Result.isFailure(parse('lisen = "x"'))).toBe(true)
    // In tables too.
    expect(Result.isFailure(parse('[[keys]]\nname = "a"\nkey = "b"\nmodel = []\n'))).toBe(true)
    expect(Result.isFailure(parse('[notify]\nhook = "x"\n'))).toBe(true)
    expect(Result.isFailure(parse("[prices.m]\ninput = 1\noutput = 2\ncache = 3\n"))).toBe(true)
  })
})

describe("config, beyond the Rust tests", () => {
  it.live("set keeps comments, checks the result, and starts a missing file", () =>
    Effect.gen(function* () {
      const path = tempConfig()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '# top\nstrategy = "fill-first"   # mine\npoll_mins = 5\n')
      const set = (pairs: ReadonlyArray<readonly [string, string]>) =>
        Config.set(
          path,
          pairs.map(([name, raw]) => {
            const r = liveValue(name, raw)
            if (Result.isFailure(r)) throw new Error(r.failure)
            return r.success
          }),
        )
      const config = yield* set([
        ["strategy", "round-robin"],
        ["poll_mins", "0"],
        ["warm_windows", "on"],
      ])
      expect(config.strategy).toBe("round-robin")
      expect(config.warmWindows).toBe(true)
      expect(readFileSync(path, "utf8")).toBe(
        '# top\nstrategy = "round-robin"   # mine\npoll_mins = 0\nwarm_windows = true\n',
      )
      // A setting that makes no config is not written.
      const bad = yield* Effect.flip(Config.set(path, [["strategy", toml.Value.of("fastest")]]))
      expect(bad).toBeInstanceOf(Failure)
      expect(bad.message).toBe(`invalid setting for ${path}`)
      expect(readFileSync(path, "utf8")).toContain("round-robin")
      const fresh = tempConfig()
      const made = yield* Config.set(fresh, [["paid_overflow", toml.Value.of(true)]])
      expect(made.paidOverflow).toBe(true)
      expect(readFileSync(fresh, "utf8")).toBe("paid_overflow = true\n")
    }),
  )

  it.live("errors say which file", () =>
    Effect.gen(function* () {
      const path = tempConfig()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "listen = 5\n")
      const invalid = yield* Effect.flip(Config.loadFrom(path))
      expect(invalid.message).toBe(`invalid config ${path}`)
      const missing = yield* Effect.flip(Config.removeKey(join(dirname(path), "absent.toml"), "x"))
      expect(missing.message).toBe(`reading ${join(dirname(path), "absent.toml")}`)
      // An inline list of keys is a valid config, but no place for a [[keys]] table.
      writeFileSync(path, 'api_key = "k"\nkeys = []\n')
      const notTables = yield* Effect.flip(Config.addKey(path, "x", []))
      expect(notTables.message).toBe("`keys` in config.toml is not a list of [[keys]] tables")
    }),
  )

  it.live("SLOPMAX_LISTEN overrides listen, and load reads SLOPMAX_HOME", () =>
    Effect.gen(function* () {
      const home = join(temp("home"), "home")
      const config = yield* Config.load().pipe(Effect.provide(env({ SLOPMAX_HOME: home, SLOPMAX_LISTEN: "[::]:9001" })))
      expect(config.listen).toEqual({ ip: "::", port: 9001 })
      expect(Config.baseUrl(config)).toBe("http://127.0.0.1:9001")
      expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("api_key")
      const bad = yield* Effect.flip(
        Config.load().pipe(Effect.provide(env({ SLOPMAX_HOME: home, SLOPMAX_LISTEN: "x" }))),
      )
      expect(bad.message).toBe('SLOPMAX_LISTEN="x" is not an address')
      expect(chain(bad)).toBe('SLOPMAX_LISTEN="x" is not an address: invalid socket address syntax')
    }),
  )

  it("strategies, addresses, and URLs read as the Rust's", () => {
    expect(Strategy.ALL).toEqual(["reset-first", "fill-first", "least-used", "round-robin"])
    expect(Strategy.ALL.map(Strategy.summary)).toEqual([
      "Spend the quota that resets soonest, so none is lost",
      "Use accounts in priority order; fail over when one is limited",
      "Balance load toward the least used account",
      "Take turns across accounts",
    ])
    expect(SocketAddr.parse("[0:0:0:0:0:0:0:1]:80")).toEqual({ ip: "::1", port: 80 })
    expect(SocketAddr.parse("[2001:db8:0:0:1:0:0:1]:1")).toEqual({ ip: "2001:db8::1:0:0:1", port: 1 })
    expect(SocketAddr.parse("01.2.3.4:1")).toBeUndefined()
    expect(SocketAddr.parse("1.2.3.4:65536")).toBeUndefined()
    expect(SocketAddr.parse("localhost:80")).toBeUndefined()
    // A scope id other than 0 is kept, as `SocketAddrV6` keeps it.
    for (const [text, shown] of [
      ["[fe80::1%2]:80", "[fe80::1%2]:80"],
      ["[::%1]:2", "[::%1]:2"],
      ["[::1%0]:2", "[::1]:2"],
      ["[::1%007]:2", "[::1%7]:2"],
    ] as const) {
      const addr = SocketAddr.parse(text)
      expect(addr === undefined ? undefined : SocketAddr.display(addr)).toBe(shown)
    }
    expect(SocketAddr.parse("[::1%4294967296]:2")).toBeUndefined()
    expect(SocketAddr.parse("[::1%]:2")).toBeUndefined()
    expect(SocketAddr.parse("[::1%x]:2")).toBeUndefined()
    expect(Config.baseUrl(parsed('listen = "[fe80::1%2]:7000"\napi_key = "k"'))).toBe("http://[fe80::1]:7000")
    const v6 = parsed('listen = "[::1]:7000"\napi_key = "k"')
    expect(Config.baseUrl(v6)).toBe("http://[::1]:7000")
    expect(Config.dashboardUrl(v6)).toBe("http://[::1]:7000/slopmax/dashboard#key=k")
    expect(Config.baseUrl(Config.default())).toBe("http://127.0.0.1:7567")
  })

  it.effect("apply sets the process-wide proxy, or says what is wrong with it", () =>
    Effect.gen(function* () {
      const bad = yield* Effect.flip(Config.apply({ ...Config.default(), proxy: "ftp://x" }))
      expect(bad.message).toBe('config `proxy`: unsupported proxy scheme "ftp"')
      yield* Config.apply(Config.default())
    }),
  )
})
