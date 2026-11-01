import { describe, expect } from "bun:test"
import { Platform } from "@slopmax/core"
import { it } from "@slopmax/test"
import { Effect, Exit, FileSystem, Path } from "effect"
import { leavingAsFound, retarget } from "../src/builds.ts"
import { xzSize } from "../src/workbench.ts"

/** A scratch tree: `dist/slopmax` holding `found` when given, and a `ui-dist` that is missing. */
const tree = (found?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-builds-test-" })
    const dist = path.join(root, "dist")
    const ui = path.join(root, "ui-dist")
    const file = path.join(dist, "slopmax")
    if (found !== undefined) {
      yield* fs.makeDirectory(dist)
      yield* fs.writeFileString(file, found)
    }
    return { fs, dist, ui, file, dirs: [dist, ui] }
  })

/** What a build does: writes both directories, its binary over `file`, and files beside it. */
const writes = (t: Effect.Success<ReturnType<typeof tree>>, bytes: string) =>
  Effect.gen(function* () {
    yield* t.fs.makeDirectory(t.dist, { recursive: true })
    yield* t.fs.makeDirectory(t.ui, { recursive: true })
    yield* t.fs.writeFileString(t.file, bytes)
    yield* t.fs.writeFileString(`${t.dist}/serve.order`, "profile")
  })

describe("building", () => {
  it.live("puts back a binary it found where the build writes, and removes the directories that were missing", () =>
    Effect.gen(function* () {
      const t = yield* tree("the AOT binary")
      yield* leavingAsFound(t.dirs, writes(t, "the fallback"))
      expect(yield* t.fs.readFileString(t.file)).toBe("the AOT binary")
      expect(yield* t.fs.readDirectory(t.dist)).toEqual(["slopmax"])
      expect(yield* t.fs.exists(t.ui)).toBe(false)
      expect(yield* t.fs.exists(`${t.dist}.bench-found`)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(Platform.layer)),
  )

  it.live("leaves things as found when the build fails too", () =>
    Effect.gen(function* () {
      const t = yield* tree("the AOT binary")
      const exit = yield* Effect.exit(leavingAsFound(t.dirs, Effect.andThen(writes(t, "half"), Effect.fail("broke"))))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* t.fs.readFileString(t.file)).toBe("the AOT binary")
      expect(yield* t.fs.exists(t.ui)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(Platform.layer)),
  )

  it.live("removes everything the build made where nothing was", () =>
    Effect.gen(function* () {
      const t = yield* tree()
      yield* leavingAsFound(t.dirs, writes(t, "the fallback"))
      expect(yield* t.fs.exists(t.dist)).toBe(false)
      expect(yield* t.fs.exists(t.ui)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(Platform.layer)),
  )

  it.live("compiles another entry with the CLI's flags, its metadata kept apart", () =>
    Effect.sync(() => {
      const args = retarget(
        ["compile", "--trim", "--metafile=dist/slopmax.meta.json", "src/main.ts"],
        "rig.ts",
        "rig.json",
      )
      expect(args).toEqual(["compile", "--trim", "--metafile=rig.json", "rig.ts"])
    }),
  )

  it.live.skipIf(Bun.which("xz") === null)("counts xz's output, and fails rather than count an xz that failed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-xz-test-" })
      const file = path.join(dir, "zeros")
      yield* fs.writeFile(file, new Uint8Array(1_000_000))
      const size = yield* xzSize(file)
      expect(size).toBeGreaterThan(0)
      expect(size).toBeLessThan(10_000)
      const error = yield* Effect.flip(xzSize(path.join(dir, "missing")))
      expect(error._tag).toBe("ProgramFailed")
    }).pipe(Effect.scoped, Effect.provide(Platform.layer)),
  )
})
