import { describe, expect } from "bun:test"
import { tmpdir } from "node:os"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Layer, Path, type Scope } from "effect"
import { it, MemoryFileSystem, TestHome } from "../src/index.ts"

const onDisk = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  Effect.provide(effect, BunServices.layer)

describe("TestHome", () => {
  it.live("is a fresh directory named for the test, under the OS temp directory", () =>
    onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* TestHome.make("locks")
        expect(path.basename(home.root)).toMatch(/^slopmax-locks-.+/)
        expect(path.dirname(home.root)).toBe(yield* fs.realPath(tmpdir()))
        expect(yield* fs.readDirectory(home.root)).toEqual([])
      }),
    ),
  )

  it.live("is private to the user who runs the tests", () =>
    onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* TestHome.make("modes")
        expect((yield* fs.stat(home.root)).mode & 0o777).toBe(0o700)
      }),
    ),
  )

  it.live("is removed with everything in it when its scope closes", () =>
    onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* Effect.scoped(
          Effect.gen(function* () {
            const home = yield* TestHome.make("cleanup")
            yield* fs.makeDirectory(home.slopmax, { mode: 0o700 })
            yield* fs.writeFileString(home.path(".slopmax", "state.json"), "{}")
            return home.root
          }),
        )
        expect(yield* fs.exists(root)).toBe(false)
      }),
    ),
  )

  it.live("points slopmax and every agent at directories inside it, without creating them", () =>
    onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* TestHome.make("env")
        expect(home.env).toEqual({
          HOME: home.root,
          SLOPMAX_HOME: `${home.root}/.slopmax`,
          CLAUDE_CONFIG_DIR: `${home.root}/.claude`,
          CODEX_HOME: `${home.root}/.codex`,
          XDG_CONFIG_HOME: `${home.root}/.config`,
        })
        expect(home.path("accounts", "a.json")).toBe(`${home.root}/accounts/a.json`)
        for (const dir of [home.slopmax, home.claude, home.codex, home.config])
          expect(yield* fs.exists(dir)).toBe(false)
      }),
    ),
  )

  it.live("gives two homes in one test two different directories", () =>
    onDisk(
      Effect.gen(function* () {
        const first = yield* TestHome.make("pair")
        const second = yield* TestHome.make("pair")
        expect(first.root).not.toBe(second.root)
      }),
    ),
  )

  it.live("keeps odd characters in a name out of the path", () =>
    onDisk(
      Effect.gen(function* () {
        const path = yield* Path.Path
        const home = yield* TestHome.make("../two words/")
        expect(path.basename(home.root)).toMatch(/^slopmax-\.\.-two-words-.+/)
      }),
    ),
  )

  it.effect("also works over MemoryFileSystem, for a home that never touches the disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* TestHome.make("memory")
      expect(home.root.startsWith("/tmp/slopmax-memory-")).toBe(true)
      yield* fs.makeDirectory(home.codex)
      expect(yield* fs.exists(home.codex)).toBe(true)
    }).pipe(Effect.provide(MemoryFileSystem.layer)),
  )

  const shared = TestHome.layer("block").pipe(Layer.provideMerge(BunServices.layer))
  let seen = ""
  it.layer(shared, { excludeTestServices: true })("as a layer", (it) => {
    it.effect("gives every test in the block the same home", () =>
      Effect.gen(function* () {
        const home = yield* TestHome
        const fs = yield* FileSystem.FileSystem
        seen = home.root
        yield* fs.writeFileString(home.path("marker"), "x")
      }),
    )
    it.effect("so what one test wrote, the next one sees", () =>
      Effect.gen(function* () {
        const home = yield* TestHome
        const fs = yield* FileSystem.FileSystem
        expect(home.root).toBe(seen)
        expect(yield* fs.readFileString(home.path("marker"))).toBe("x")
      }),
    )
  })

  it.live("as a layer is removed once its block is done", () =>
    onDisk(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        expect(seen).not.toBe("")
        expect(yield* fs.exists(seen)).toBe(false)
      }),
    ),
  )
})
