import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { it, MemoryFileSystem, TestHome } from "@slopmax/test"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { dirsFromEnv, FileError, Home, pathsFor, prettyJson } from "../../src/home.ts"

const root = "/home/me/.slopmax"

const inMemory = (options: MemoryFileSystem.Options = {}) =>
  Home.layerAt(root).pipe(Layer.provideMerge(MemoryFileSystem.layerWith(options)))

const Note = Schema.Struct({ text: Schema.String, count: Schema.Int })

const modeOf = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => Effect.map(fs.stat(path), (info) => info.mode & 0o777))

const readDirs = (env: Record<string, string>) =>
  Effect.provide(dirsFromEnv, ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))

describe("Home", () => {
  it.effect("writes JSON pretty-printed with a trailing newline, private, and reads it back", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const file = `${root}/notes/a.json`
      yield* home.write(file, Note, { text: "hi", count: 2 })
      expect(yield* fs.readFileString(file)).toBe('{\n  "text": "hi",\n  "count": 2\n}\n')
      expect(yield* modeOf(file)).toBe(0o600)
      expect(yield* modeOf(`${root}/notes`)).toBe(0o700)
      expect(yield* home.read(file, Note)).toEqual(Option.some({ text: "hi", count: 2 }))
      // Nothing but the file itself is left in its directory.
      expect(yield* fs.readDirectory(`${root}/notes`)).toEqual(["a.json"])
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("creates new directories private and leaves the modes of existing ones alone", () =>
    Effect.gen(function* () {
      const home = yield* Home
      yield* home.writeText("/home/me/shared/deep/inner/file.txt", "x")
      expect(yield* modeOf("/home/me/shared")).toBe(0o755)
      expect(yield* modeOf("/home/me/shared/deep")).toBe(0o700)
      expect(yield* modeOf("/home/me/shared/deep/inner")).toBe(0o700)
    }).pipe(Effect.provide(inMemory({ directories: ["/home/me/shared"] }))),
  )

  it.effect("replaces a file whole, so a reader sees the old contents or the new", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const file = `${root}/state.json`
      yield* home.writeText(file, "old and long contents\n")
      yield* home.writeText(file, "new\n")
      expect(yield* fs.readFileString(file)).toBe("new\n")
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("streams a file's bytes, and a missing file as nothing", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const text = (path: string) => Stream.mkString(Stream.decodeText(home.stream(path)))
      expect(yield* text(`${root}/usage/2026-10.ndjson`)).toBe("one\ntwo\n")
      expect(yield* text(`${root}/usage/missing.ndjson`)).toBe("")
    }).pipe(Effect.provide(inMemory({ files: { [`${root}/usage/2026-10.ndjson`]: "one\ntwo\n" } }))),
  )

  it.effect("reads a missing file as nothing", () =>
    Effect.gen(function* () {
      const home = yield* Home
      expect(yield* home.read(`${root}/missing.json`, Note)).toEqual(Option.none())
      expect(yield* home.readText(`${root}/missing.json`)).toEqual(Option.none())
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("reports a file that is not JSON, or does not fit, as one it cannot make sense of", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const broken = yield* Effect.flip(home.read(`${root}/broken.json`, Note))
      expect(broken).toBeInstanceOf(FileError)
      expect(broken.action).toBe("parse")
      expect(broken.message).toStartWith(`could not make sense of ${root}/broken.json: `)
      const wrong = yield* Effect.flip(home.read(`${root}/wrong.json`, Note))
      expect(wrong.action).toBe("parse")
      expect(wrong.message).toContain("count")
    }).pipe(
      Effect.provide(
        inMemory({ files: { [`${root}/broken.json`]: "{ nope", [`${root}/wrong.json`]: '{ "text": "x" }' } }),
      ),
    ),
  )

  it.effect("removes its temp file when a write fails, and says which file it was writing", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const error = yield* Effect.flip(home.writeText(`${root}/config.json`, "{}\n"))
      expect(error.action).toBe("write")
      expect(error.path).toBe(`${root}/config.json`)
      expect(yield* fs.readDirectory(root)).toEqual([])
    }).pipe(
      Effect.provide(inMemory({ fault: ({ method }) => (method === "rename" ? "PermissionDenied" : undefined) })),
    ),
  )

  it.effect("appends to a file created private, and lists and removes files", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const fs = yield* FileSystem.FileSystem
      const log = `${root}/usage/2026-10.ndjson`
      yield* home.append(log, "one\n")
      yield* home.append(log, "two\n")
      expect(yield* fs.readFileString(log)).toBe("one\ntwo\n")
      expect(yield* modeOf(log)).toBe(0o600)
      expect(yield* home.list(`${root}/usage`)).toEqual(["2026-10.ndjson"])
      expect(yield* home.list(`${root}/nowhere`)).toEqual([])
      expect(yield* home.remove(log)).toBe(true)
      expect(yield* home.remove(log)).toBe(false)
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("reports each changed path at most once per 100 ms, seeing files that do not exist yet", () =>
    Effect.gen(function* () {
      const home = yield* Home
      const config = home.paths.config
      const accounts = home.paths.accounts
      const seen = yield* Stream.merge(home.watch([config]), home.watchDir(accounts)).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped,
      )
      // Lets the watchers start before anything changes.
      for (let turn = 0; turn < 5; turn++) yield* TestClock.adjust("10 millis")
      // Several writes in a burst are one change; the temp files beside config.json are not.
      yield* home.writeText(config, "{}\n")
      yield* home.writeText(config, '{ "strategy": "fill-first" }\n')
      yield* home.writeText(`${accounts}/claude-1.json`, "{}\n")
      yield* TestClock.adjust("150 millis")
      const changed = yield* Fiber.join(seen)
      expect([...changed].toSorted()).toEqual([accounts, config].toSorted())
    }).pipe(Effect.provide(inMemory())),
  )

  it.effect("finds slopmax's home and the agents' directories from the environment", () =>
    Effect.gen(function* () {
      expect(yield* readDirs({ HOME: "/home/me" })).toEqual({
        root: "/home/me/.slopmax",
        user: "/home/me",
        claudeDir: undefined,
        codexDir: undefined,
      })
      // Set but empty counts as not set.
      expect(yield* readDirs({ HOME: "/home/me", SLOPMAX_HOME: "", CLAUDE_CONFIG_DIR: " " })).toEqual({
        root: "/home/me/.slopmax",
        user: "/home/me",
        claudeDir: undefined,
        codexDir: undefined,
      })
      expect(
        yield* readDirs({ HOME: "/home/me", SLOPMAX_HOME: "/srv/sm", CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }),
      ).toEqual({ root: "/srv/sm", user: "/home/me", claudeDir: "/c", codexDir: "/x" })
      // With no home directory at all, the current one stands in.
      expect((yield* readDirs({})).root).toBe("./.slopmax")
    }).pipe(Effect.provide(MemoryFileSystem.layer)),
  )

  it.effect("puts every file under the home and each agent's directory where the agent keeps it", () =>
    Effect.gen(function* () {
      const home = yield* Home
      expect(home.paths).toEqual(pathsFor(yield* Path.Path, { root, user: "/home/me" }))
      expect(home.paths.config).toBe(`${root}/config.json`)
      expect(home.paths.configSchema).toBe(`${root}/config.schema.json`)
      expect(home.paths.accounts).toBe(`${root}/accounts`)
      expect(home.paths.state).toBe(`${root}/state.json`)
      expect(home.paths.usage).toBe(`${root}/usage`)
      expect(home.paths.log).toBe(`${root}/slopmax.log`)
      expect(home.paths.locks).toBe(`${root}/locks`)
      expect(home.paths.claudeDir).toBe("/home/me/.claude")
      expect(home.paths.codexDir).toBe("/home/me/.codex")
      expect(home.paths.cliProxyApiDir).toBe("/home/me/.cli-proxy-api")
    }).pipe(Effect.provide(inMemory())),
  )

  it.live("keeps files 0600 and new directories 0700 on a real disk", () =>
    Effect.gen(function* () {
      const test = yield* TestHome.make("home-modes")
      const fs = yield* FileSystem.FileSystem
      const home = yield* Effect.provide(Home, Home.layerAt(test.slopmax))
      yield* home.writeText(home.paths.config, prettyJson({ a: 1 }))
      yield* home.append(home.paths.log, "line\n")
      const mode = (file: string) => Effect.map(fs.stat(file), (info) => info.mode & 0o777)
      expect(yield* mode(test.slopmax)).toBe(0o700)
      expect(yield* mode(home.paths.config)).toBe(0o600)
      expect(yield* mode(home.paths.log)).toBe(0o600)
      expect(yield* fs.readDirectory(test.slopmax)).toEqual(expect.arrayContaining(["config.json", "slopmax.log"]))
      expect((yield* fs.readDirectory(test.slopmax)).length).toBe(2)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})
