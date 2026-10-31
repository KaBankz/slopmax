import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { it, MemoryFileSystem, TestHome } from "@slopmax/test"
import { Cause, ConfigProvider, Effect, FileSystem, Layer, Option } from "effect"
import { TestConsole } from "effect/testing"
import { colors, formatLine, labels, layer, parseLevel, parseLogFilter } from "../../src/log.ts"

const withEnv = (env: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))

/** The log lines written while `body` runs under slopmax's logger, as stderr gets them. */
const linesOf = (
  body: Effect.Effect<void>,
  env: Record<string, string> = {},
  terminal = false,
): Effect.Effect<ReadonlyArray<string>, unknown> =>
  Effect.gen(function* () {
    yield* body.pipe(
      Effect.provide(layer({ terminal }).pipe(Layer.provide(Layer.merge(withEnv(env), MemoryFileSystem.layer)))),
    )
    return (yield* TestConsole.errorLines).map(String)
  })

describe("log", () => {
  it("reads plain levels and filters naming slopmax", () => {
    expect(parseLogFilter("debug")).toEqual(Option.some("All"))
    expect(parseLogFilter("off")).toEqual(Option.some("None"))
    expect(parseLogFilter("slopmax=info")).toEqual(Option.some("Info"))
    expect(parseLogFilter("hyper=debug,slopmax=error")).toEqual(Option.some("Error"))
    // The last directive for slopmax wins, and one without a target counts as slopmax's.
    expect(parseLogFilter("slopmax=error,warn")).toEqual(Option.some("Warn"))
    expect(parseLogFilter("hyper=debug")).toEqual(Option.none())
    expect(parseLogFilter("loud")).toEqual(Option.none())
  })

  it.effect("shows each level and every level more severe, from off to debug", () =>
    Effect.gen(function* () {
      const each = Effect.all(
        [Effect.logError("e"), Effect.logWarning("w"), Effect.logInfo("i"), Effect.logDebug("d")],
        { discard: true },
      )
      // The test console keeps every line, so each level's are the ones after the last.
      let before = 0
      const shown = (level: string) =>
        Effect.map(linesOf(each, { SLOPMAX_LOG: level }), (lines) => {
          const added = lines.slice(before).map((line) => line.split(" ").at(-1))
          before = lines.length
          return added
        })
      expect(yield* shown("off")).toEqual([])
      expect(yield* shown("error")).toEqual(["e"])
      expect(yield* shown("warn")).toEqual(["e", "w"])
      expect(yield* shown("info")).toEqual(["e", "w", "i"])
      expect(yield* shown("debug")).toEqual(["e", "w", "i", "d"])
    }),
  )

  it("lines labels up and tells levels apart by color", () => {
    expect(Object.values(labels)).toEqual(["ERROR", "WARN ", "INFO ", "DEBUG"])
    for (const label of Object.values(labels)) expect(label.length).toBe(5)
    expect(new Set(Object.values(colors)).size).toBe(4)
    const date = new Date(Date.UTC(2026, 9, 9, 21, 13, 9, 250))
    expect(formatLine({ date, level: "Warn", message: ["account", "claude-1", "is limited"], color: false })).toBe(
      "2026-10-09T21:13:09.250Z WARN  account claude-1 is limited",
    )
    expect(formatLine({ date, level: "Error", message: "boom", color: true })).toBe(
      "2026-10-09T21:13:09.250Z \u001b[31mERROR\u001b[0m boom",
    )
    expect(formatLine({ date, level: "Trace", message: "fine", color: false })).toContain(" DEBUG fine")
    const withCause = formatLine({
      date,
      level: "Error",
      message: "failed",
      cause: Cause.fail("disk full"),
      color: false,
    })
    expect(withCause.split("\n")[0]).toBe("2026-10-09T21:13:09.250Z ERROR failed")
    expect(withCause).toContain("disk full")
  })

  it.effect("writes warnings and errors only, unless SLOPMAX_LOG says otherwise", () =>
    Effect.gen(function* () {
      const quiet = yield* linesOf(
        Effect.all([Effect.logError("e"), Effect.logWarning("w"), Effect.logInfo("i"), Effect.logDebug("d")], {
          discard: true,
        }),
      )
      expect(quiet.map((line) => line.split(" ").slice(1).join(" "))).toEqual(["ERROR e", "WARN  w"])
      expect(quiet[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ERROR e$/)
    }),
  )

  it.effect("reads SLOPMAX_LOG for the level, and falls back to the default when it is unreadable", () =>
    Effect.gen(function* () {
      const all = Effect.all([Effect.logWarning("w"), Effect.logInfo("i"), Effect.logDebug("d")], { discard: true })
      expect((yield* linesOf(all, { SLOPMAX_LOG: " Info " })).length).toBe(2)
      expect((yield* linesOf(all, { SLOPMAX_LOG: "slopmax=debug" })).length).toBe(2 + 3)
      expect((yield* linesOf(all, { SLOPMAX_LOG: "loud" })).length).toBe(2 + 3 + 1)
    }),
  )

  it.effect("turns logging off, and colors labels only on a terminal without NO_COLOR", () =>
    Effect.gen(function* () {
      expect(yield* linesOf(Effect.logError("e"), { SLOPMAX_LOG: "off" })).toEqual([])
      expect((yield* linesOf(Effect.logError("plain"), { NO_COLOR: "1" }, true)).at(-1)).toContain(" ERROR plain")
      expect((yield* linesOf(Effect.logError("colored"), {}, true)).at(-1)).toContain(
        "\u001b[31mERROR\u001b[0m colored",
      )
      expect((yield* linesOf(Effect.logError("piped"), {}, false)).at(-1)).toContain(" ERROR piped")
    }),
  )

  it("reads levels in any case and with spaces around", () => {
    expect(parseLevel(" WARNING ")).toEqual(Option.some("Warn"))
    expect(parseLevel("Trace")).toEqual(Option.some("All"))
    expect(parseLevel("DEBUG")).toEqual(Option.some("All"))
    expect(parseLevel("none")).toEqual(Option.some("None"))
    expect(parseLevel("error")).toEqual(Option.some("Error"))
    expect(parseLevel("INFO")).toEqual(Option.some("Info"))
  })

  it.live("appends the background daemon's lines to its log file, created private", () =>
    Effect.gen(function* () {
      const test = yield* TestHome.make("log-file")
      const fs = yield* FileSystem.FileSystem
      const file = `${test.root}/slopmax.log`
      yield* Effect.logWarning("slopmax listening").pipe(
        Effect.provide(layer({ file, fallback: "Info" }).pipe(Layer.provide(withEnv({})))),
        Effect.scoped,
      )
      const text = yield* fs.readFileString(file)
      expect(text).toMatch(/^\S+ WARN {2}slopmax listening\n$/)
      expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
