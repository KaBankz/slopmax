import { describe, expect, test } from "bun:test"
import { Effect, Fiber, FileSystem, Layer, Stream } from "effect"
import { Bounds, DesktopPrefs } from "@slopmax/domain/desktop"
import { it, MemoryFileSystem } from "@slopmax/test"
import { mergePrefs } from "../src/main/bridge.ts"
import { Prefs, readPrefs, writePrefs } from "../src/main/prefs.ts"

const file = "/home/someone/.config/slopmax-desktop/prefs.json"

const prefsOn = (options: MemoryFileSystem.Options) =>
  Prefs.layer(file).pipe(Layer.provideMerge(MemoryFileSystem.layerWith(options)))

describe("the window's preferences", () => {
  test("missing settings take their defaults", () => {
    expect(readPrefs("{}")).toEqual(DesktopPrefs.defaults)
    expect(readPrefs('{"sidebarHidden": true}')).toMatchObject({
      sidebarWidth: 220,
      sidebarHidden: true,
      appearance: "system",
      notifications: true,
    })
  })

  test("a file that is not valid reads as every default", () => {
    expect(readPrefs("not json")).toEqual(DesktopPrefs.defaults)
    expect(readPrefs('{"appearance": "sepia"}')).toEqual(DesktopPrefs.defaults)
  })

  test("are written so a person can read them, and read back the same", () => {
    const prefs = new DesktopPrefs({
      ...DesktopPrefs.defaults,
      appearance: "dark",
      bounds: new Bounds({ width: 1200, height: 820, x: 40, y: 60 }),
    })
    const text = writePrefs(prefs)
    expect(text).toContain('\n  "appearance": "dark"')
    expect(readPrefs(text)).toEqual(prefs)
  })

  it.effect("a missing file opens with the defaults, and a change is saved, making the directory", () =>
    Effect.gen(function* () {
      const prefs = yield* Prefs
      expect(yield* prefs.get).toEqual(DesktopPrefs.defaults)
      yield* prefs.update((now) => new DesktopPrefs({ ...now, sidebarHidden: true }))
      const fs = yield* FileSystem.FileSystem
      expect(readPrefs(yield* fs.readFileString(file)).sidebarHidden).toBe(true)
    }).pipe(Effect.provide(prefsOn({}))),
  )

  it.effect("loads what an earlier run saved", () =>
    Effect.gen(function* () {
      const prefs = yield* Prefs
      expect((yield* prefs.get).appearance).toBe("light")
    }).pipe(Effect.provide(prefsOn({ files: { [file]: '{"appearance":"light"}' } }))),
  )

  it.effect("a save that fails is logged, and the change still holds for this run", () =>
    Effect.gen(function* () {
      const prefs = yield* Prefs
      yield* prefs.update((now) => new DesktopPrefs({ ...now, notifications: false }))
      expect((yield* prefs.get).notifications).toBe(false)
    }).pipe(
      Effect.provide(prefsOn({ fault: (call) => (call.method === "writeFile" ? "PermissionDenied" : undefined) })),
    ),
  )

  it.effect("changes made at once leave the file holding what memory holds", () =>
    Effect.gen(function* () {
      const prefs = yield* Prefs
      yield* Effect.all(
        [
          prefs.update((now) => new DesktopPrefs({ ...now, appearance: "dark" })),
          prefs.update((now) => new DesktopPrefs({ ...now, sidebarHidden: true })),
          prefs.update((now) => new DesktopPrefs({ ...now, sidebarWidth: 300 })),
        ],
        { concurrency: "unbounded" },
      )
      const fs = yield* FileSystem.FileSystem
      expect(readPrefs(yield* fs.readFileString(file))).toEqual(yield* prefs.get)
      expect(yield* prefs.get).toMatchObject({ appearance: "dark", sidebarHidden: true, sidebarWidth: 300 })
    }).pipe(Effect.provide(prefsOn({}))),
  )

  it.effect("those watching hear each change", () =>
    Effect.gen(function* () {
      const prefs = yield* Prefs
      const seen = yield* prefs.changes.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* prefs.update((now) => new DesktopPrefs({ ...now, appearance: "dark" }))
      const changes = yield* Fiber.join(seen)
      expect(changes.map((told) => told.appearance)).toEqual(["system", "dark"])
    }).pipe(Effect.provide(prefsOn({}))),
  )

  test("what the window sends keeps the window's bounds, which only main records", () => {
    const held = new DesktopPrefs({ ...DesktopPrefs.defaults, bounds: new Bounds({ width: 900, height: 600 }) })
    const sent = new DesktopPrefs({ ...DesktopPrefs.defaults, sidebarWidth: 260, appearance: "dark" })
    expect(mergePrefs(sent, held)).toEqual(
      new DesktopPrefs({ ...sent, bounds: new Bounds({ width: 900, height: 600 }) }),
    )
  })
})
