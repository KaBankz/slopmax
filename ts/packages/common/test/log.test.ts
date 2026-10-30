import { describe, expect } from "bun:test"
import process from "node:process"
import { it } from "@slopmax/test"
import { ConfigProvider, Effect, Layer, References } from "effect"
import { TestClock } from "effect/testing"

import * as log from "../src/log.ts"

const { Level, Off } = log

// Collects what is written to stderr until `restore` is called.
const intercept = () => {
  const lines: Array<string> = []
  const original = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    text: () => lines.join(""),
    restore: () => {
      process.stderr.write = original
    },
  }
}

// What is written to stderr while `body` runs.
const capture = (body: () => void): string => {
  const c = intercept()
  try {
    body()
  } finally {
    c.restore()
  }
  return c.text()
}

// The same around an effect.
const captured = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<string, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(intercept),
    (c) => Effect.map(effect, () => c.text()),
    (c) => Effect.sync(c.restore),
  )

const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromUnknown(vars))

// Whether `init` with `vars` (empty values kept, as the Rust's `var_os`
// reads them) colors the labels.
const colored = (vars: Record<string, string>) =>
  log
    .init(Level.Warn)
    .pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(vars, { preserveEmptyStrings: true }))),
      Effect.andThen(Effect.sync(() => capture(() => log.warn("w")).includes("\x1b[33m"))),
    )

describe("log (Rust tests)", () => {
  it("reads_plain_levels_and_target_filters", () => {
    expect(log.parseFilter("debug")).toBe(Level.Debug)
    expect(log.parseFilter("off")).toBe(Off)
    expect(log.parseFilter("slopmax=info")).toBe(Level.Info)
    expect(log.parseFilter("hyper=debug,slopmax=error")).toBe(Level.Error)
    expect(log.parseFilter("hyper=debug")).toBeUndefined()
    expect(log.parseFilter("loud")).toBeUndefined()
  })

  it("levels_order_by_verbosity", () => {
    expect(Level.Error < Level.Warn && Level.Info < Level.Debug).toBe(true)
  })

  it("labels_line_up_and_colors_tell_levels_apart", () => {
    const levels = [Level.Error, Level.Warn, Level.Info, Level.Debug] as const
    expect(levels.map(log.label)).toEqual(["ERROR", "WARN ", "INFO ", "DEBUG"])
    expect(new Set(levels.map(log.color)).size).toBe(4)
  })

  it("the_default_level_writes_warnings_and_errors_only", () => {
    // Nothing before this test calls `init` or `configure`, so the default stands.
    expect(log.enabled(Level.Error)).toBe(true)
    expect(log.enabled(Level.Warn)).toBe(true)
    expect(log.enabled(Level.Info)).toBe(false)
    expect(log.enabled(Level.Debug)).toBe(false)
    // Writing, plain and colored, never fails or throws.
    log.write(Level.Warn, "a test warning")
    log.configure({ color: true })
    log.write(Level.Error, "a colored test error")
    log.configure({ color: false })
    log.warn(`through the helper: ${1}`)
    log.info(`filtered out: ${2}`)
  })

  it("levels_read_case_and_space_insensitively", () => {
    expect(log.parseLevel(" WARNING ")).toBe(Level.Warn)
    expect(log.parseLevel("Trace")).toBe(Level.Debug)
    expect(log.parseLevel("none")).toBe(Off)
    expect(log.parseLevel("error")).toBe(Level.Error)
  })
})

describe("log (contract details)", () => {
  it("lines read {time} {LABEL} {message}, colored only when asked", () => {
    const t = 1_791_098_400_250
    expect(capture(() => log.write(Level.Warn, "careful", t))).toBe("2026-10-04T07:20:00.250Z WARN  careful\n")
    log.configure({ color: true })
    try {
      expect(capture(() => log.write(Level.Error, "broke", t))).toBe(
        "2026-10-04T07:20:00.250Z \x1b[31mERROR\x1b[0m broke\n",
      )
    } finally {
      log.configure({ color: false })
    }
  })

  it("the last directive for slopmax or without a target wins", () => {
    expect(log.parseFilter("info,slopmax=debug")).toBe(Level.Debug)
    expect(log.parseFilter("slopmax=debug,warn")).toBe(Level.Warn)
    expect(log.parseFilter("slopmax=debug, other=info")).toBe(Level.Debug)
    expect(log.parseFilter(" slopmax = none ")).toBe(Off)
    expect(log.parseFilter("slopmax=loud,info")).toBe(Level.Info)
    expect(log.parseFilter("")).toBeUndefined()
  })

  it.effect("init reads SLOPMAX_LOG, falling back when unreadable", () =>
    Effect.gen(function* () {
      try {
        yield* log.init(Level.Info).pipe(Effect.provide(env({})))
        expect(log.enabled(Level.Info)).toBe(true)
        expect(log.enabled(Level.Debug)).toBe(false)
        yield* log.init(Level.Info).pipe(Effect.provide(env({ SLOPMAX_LOG: "loud" })))
        expect(log.enabled(Level.Info)).toBe(true)
        yield* log.init(Level.Warn).pipe(Effect.provide(env({ SLOPMAX_LOG: "hyper=info,slopmax=debug" })))
        expect(log.enabled(Level.Debug)).toBe(true)
        yield* log.init(Level.Warn).pipe(Effect.provide(env({ SLOPMAX_LOG: "off" })))
        expect(log.enabled(Level.Error)).toBe(false)
        // NO_COLOR, or stderr not being a terminal (as under the test runner), means plain labels.
        yield* log.init(Level.Warn).pipe(Effect.provide(env({ NO_COLOR: "1" })))
        expect(capture(() => log.warn("plain"))).toContain(" WARN  plain\n")
      } finally {
        log.configure({ level: Level.Warn, color: false })
      }
    }),
  )

  it.effect("on a terminal, NO_COLOR turns color off, empty too when the provider keeps empty values", () =>
    Effect.gen(function* () {
      const tty = process.stderr.isTTY
      try {
        process.stderr.isTTY = true
        expect(yield* colored({})).toBe(true)
        expect(yield* colored({ NO_COLOR: "1" })).toBe(false)
        expect(yield* colored({ NO_COLOR: "" })).toBe(false)
      } finally {
        process.stderr.isTTY = tty
        log.configure({ level: Level.Warn, color: false })
      }
    }),
  )

  it.effect("Effect's log calls go through the layer, with the Clock's time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_791_098_400_250)
      const program = Effect.gen(function* () {
        // Effect itself drops what the level leaves out.
        expect(yield* References.MinimumLogLevel).toBe("Info")
        yield* Effect.logDebug("hidden")
        yield* Effect.logInfo("served", 200)
        yield* Effect.logWarning("slow")
      })
      const layer = log.layer(Level.Warn).pipe(Layer.provide(env({ SLOPMAX_LOG: "info" })))
      const out = yield* captured(Effect.provide(program, layer)).pipe(
        Effect.ensuring(Effect.sync(() => log.configure({ level: Level.Warn, color: false }))),
      )
      expect(out).toBe("2026-10-04T07:20:00.250Z INFO  served 200\n2026-10-04T07:20:00.250Z WARN  slow\n")
    }),
  )
})
