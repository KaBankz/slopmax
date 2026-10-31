import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { ConfigProvider, Effect } from "effect"
import { desktop, hasBrowser, open, opener } from "../../src/browser.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))

describe("opening a browser", () => {
  it("counts on one on macOS and Windows, and elsewhere only in a graphical session", () => {
    expect(hasBrowser({ platform: "darwin", display: false })).toBe(true)
    expect(hasBrowser({ platform: "win32", display: false })).toBe(true)
    expect(hasBrowser({ platform: "linux", display: false })).toBe(false)
    expect(hasBrowser({ platform: "linux", display: true })).toBe(true)
    expect(hasBrowser({ platform: "freebsd", display: true })).toBe(true)
  })

  it("uses each system's own opener", () => {
    expect(opener("darwin")).toBe("open")
    expect(opener("win32")).toBe("explorer")
    expect(opener("linux")).toBe("xdg-open")
  })

  it.effect("sees a graphical session in DISPLAY or WAYLAND_DISPLAY, but not when they are empty", () =>
    Effect.gen(function* () {
      expect((yield* desktop.pipe(withEnv({ DISPLAY: ":0" }))).display).toBe(true)
      expect((yield* desktop.pipe(withEnv({ WAYLAND_DISPLAY: "wayland-0" }))).display).toBe(true)
      expect((yield* desktop.pipe(withEnv({ DISPLAY: "" }))).display).toBe(false)
      expect((yield* desktop.pipe(withEnv({}))).display).toBe(false)
    }),
  )

  it.effect("starts the opener detached and says so", () => {
    const spawner = recordingSpawner()
    return Effect.gen(function* () {
      expect(yield* open("https://claude.ai/oauth/authorize?x=1", { platform: "linux", display: true })).toBe(true)
      expect(spawner.calls).toEqual([
        {
          line: "xdg-open https://claude.ai/oauth/authorize?x=1",
          program: "xdg-open",
          args: ["https://claude.ai/oauth/authorize?x=1"],
          detached: true,
        },
      ])
      expect(yield* open("https://x", { platform: "darwin", display: false })).toBe(true)
      expect(spawner.calls[1]?.program).toBe("open")
    }).pipe(Effect.provide(spawner.layer))
  })

  it.effect("opens nothing without a browser, and says so when the opener is missing", () => {
    const spawner = recordingSpawner(() => "missing")
    return Effect.gen(function* () {
      expect(yield* open("https://x", { platform: "linux", display: false })).toBe(false)
      expect(spawner.calls).toHaveLength(0)
      expect(yield* open("https://x", { platform: "linux", display: true })).toBe(false)
      expect(spawner.calls).toHaveLength(1)
      // Without a machine given, the environment decides.
      expect(yield* open("https://x").pipe(withEnv({}))).toBe(false)
    }).pipe(Effect.provide(spawner.layer))
  })
})
