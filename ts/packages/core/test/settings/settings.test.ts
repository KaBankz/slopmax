import { describe, expect } from "bun:test"
import { KeyName, restartNeeded, SettingRejected, SettingsInvalid } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import {
  Array,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Redacted,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { Home } from "../../src/home.ts"
import { type Liveness, Lock } from "../../src/lock.ts"
import { baseUrlOf, dashboardUrl, schemaStamp, SettingsService } from "../../src/settings.ts"

const root = "/home/me/.slopmax"
const config = `${root}/config.json`
const schemaFile = `${root}/config.schema.json`

/** Every simulated process is alive and keeps its own start time. */
const liveness: Liveness = {
  alive: () => Effect.succeed(true),
  startedAt: (pid) => Effect.succeed(Option.some(`started-${pid}`)),
}

/** One slopmax process on a shared disk: its own locks and settings, the disk's files. */
const processOn = (fs: FileSystem.FileSystem, pid: number, env: Record<string, string> = {}) =>
  SettingsService.layer.pipe(
    Layer.provideMerge(Lock.layerWith(liveness, pid)),
    Layer.provideMerge(Home.layerAt(root)),
    Layer.provideMerge(Layer.merge(Layer.succeed(FileSystem.FileSystem)(fs), Path.layer)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
  )

const disk = (files: Record<string, string> = {}) => MemoryFileSystem.make({ files })

const settingsIn = (fs: FileSystem.FileSystem, pid = 1001, env: Record<string, string> = {}) =>
  Effect.provide(SettingsService, processOn(fs, pid, env))

const jsonOf = (fs: FileSystem.FileSystem, file: string) =>
  Effect.map(fs.readFileString(file), (text): unknown => JSON.parse(text))

const keyIn = (fs: FileSystem.FileSystem) =>
  Effect.map(jsonOf(fs, config), (json) =>
    typeof json === "object" && json !== null && "apiKey" in json ? json.apiKey : undefined,
  )

describe("Settings", () => {
  it.effect("writes the settings with a fresh key on first run, and their schema beside them", () =>
    Effect.gen(function* () {
      const fs = yield* disk()
      const settings = yield* settingsIn(fs)
      const current = yield* settings.get
      const key = Redacted.value(current.apiKey)
      expect(key).toMatch(/^sm-[A-Za-z0-9_-]{43}$/)
      expect(yield* jsonOf(fs, config)).toEqual({ $schema: "./config.schema.json", apiKey: key })
      expect((yield* fs.stat(config)).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(root)).mode & 0o777).toBe(0o700)
      const schema = yield* jsonOf(fs, schemaFile)
      expect(schema).toMatchObject({ $comment: schemaStamp, title: "slopmax settings" })
      // Loading again finds the same key and the same settings.
      const again = yield* settingsIn(fs)
      expect(Redacted.value((yield* again.get).apiKey)).toBe(key)
      expect(yield* again.get).toEqual(current)
    }),
  )

  it.effect("adds a missing key and keeps every other setting as it was", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "strategy": "fill-first", "pollMinutes": 0 }\n' })
      const settings = yield* settingsIn(fs)
      const current = yield* settings.get
      expect([current.strategy, current.pollMinutes]).toEqual(["fill-first", 0])
      expect(yield* jsonOf(fs, config)).toEqual({
        $schema: "./config.schema.json",
        apiKey: Redacted.value(current.apiKey),
        strategy: "fill-first",
        pollMinutes: 0,
      })
    }),
  )

  it.effect("gives processes started together one key", () =>
    Effect.gen(function* () {
      const fs = yield* disk()
      const loaded = yield* Effect.all(
        [1001, 1002, 1003, 1004].map((pid) => Effect.flatMap(settingsIn(fs, pid), (s) => s.get)),
        { concurrency: "unbounded" },
      )
      const keys = new Set(loaded.map((s) => Redacted.value(s.apiKey)))
      expect(keys.size).toBe(1)
      expect(yield* keyIn(fs)).toBe([...keys][0])
    }),
  )

  it.effect("refuses a file that does not load, and never rewrites it", () =>
    Effect.gen(function* () {
      const broken = '{ "strategy": "fastest", "apiKey": "" }\n'
      const fs = yield* disk({ [config]: broken })
      const exit = yield* Effect.exit(settingsIn(fs))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons[0]
        const error = reason?._tag === "Fail" ? reason.error : undefined
        expect(error).toBeInstanceOf(SettingsInvalid)
        expect(error?.message).toContain("strategy is one of reset-first, fill-first, least-used, round-robin")
      }
      expect(yield* fs.readFileString(config)).toBe(broken)
      const notJson = yield* disk({ [config]: "listen = 1" })
      const error = yield* Effect.flip(settingsIn(notJson))
      expect(error.message).toContain("not JSON")
    }),
  )

  it.effect("lets SLOPMAX_LISTEN choose where to listen, without changing the file", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k", "listen": "127.0.0.1:7000" }\n' })
      const settings = yield* settingsIn(fs, 1001, { SLOPMAX_LISTEN: "0.0.0.0:9100" })
      expect(settings.running.listen).toBe("0.0.0.0:9100")
      expect(yield* settings.baseUrl).toBe("http://127.0.0.1:9100")
      expect((yield* settings.get).listen).toBe("127.0.0.1:7000")
      expect(yield* jsonOf(fs, config)).toMatchObject({ listen: "127.0.0.1:7000" })
      // Empty counts as not set.
      expect((yield* settingsIn(fs, 1002, { SLOPMAX_LISTEN: "" })).running.listen).toBe("127.0.0.1:7000")
      const error = yield* Effect.flip(settingsIn(fs, 1003, { SLOPMAX_LISTEN: "nowhere" }))
      expect(error.message).toBe('SLOPMAX_LISTEN="nowhere" is not an address')
    }),
  )

  it.effect("checks live settings before anything is written", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k" }\n' })
      const settings = yield* settingsIn(fs)
      const before = yield* fs.readFileString(config)
      const refused = yield* Effect.flip(settings.setLive({ sessionMinutes: 0 }))
      expect(refused).toBeInstanceOf(SettingRejected)
      expect(refused.message).toBe("sessionMinutes is a number of minutes")
      expect(yield* fs.readFileString(config)).toBe(before)
      const changed = yield* settings.setLive({ strategy: "round-robin", websockets: false })
      expect([changed.strategy, changed.websockets]).toEqual(["round-robin", false])
      expect(yield* jsonOf(fs, config)).toMatchObject({ strategy: "round-robin", websockets: false, apiKey: "sm-k" })
      expect((yield* settings.get).strategy).toBe("round-robin")
    }),
  )

  it.effect("adds and removes client keys, keeping the rest of the file", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k", "strategy": "least-used" }\n' })
      const settings = yield* settingsIn(fs)
      const laptop = KeyName.make("laptop")
      const made = yield* settings.addKey(laptop, ["gpt-*"])
      expect(Redacted.value(made.key)).toMatch(/^sm-[A-Za-z0-9_-]{43}$/)
      expect(made.models).toEqual(["gpt-*"])
      const duplicate = yield* Effect.flip(settings.addKey(laptop, []))
      expect(duplicate.message).toBe('a key named "laptop" already exists')
      const ci = yield* settings.addKey(KeyName.make("ci"), [])
      expect(yield* jsonOf(fs, config)).toMatchObject({
        strategy: "least-used",
        keys: [
          { name: "laptop", key: Redacted.value(made.key), models: ["gpt-*"] },
          { name: "ci", key: Redacted.value(ci.key), models: [] },
        ],
      })
      expect(yield* settings.removeKey(laptop)).toBe(true)
      expect(yield* settings.removeKey(laptop)).toBe(false)
      expect(yield* settings.removeKey(KeyName.make("ci"))).toBe(true)
      // With the last key gone, the list leaves the file.
      expect(yield* jsonOf(fs, config)).toEqual({
        $schema: "./config.schema.json",
        apiKey: "sm-k",
        strategy: "least-used",
      })
      expect((yield* settings.get).keys).toEqual([])
      // Removing a key that is not there leaves the file exactly as written.
      const written = '{"apiKey":"sm-k",  "strategy": "least-used"}\n'
      yield* fs.writeFileString(config, written)
      expect(yield* settings.removeKey(laptop)).toBe(false)
      expect(yield* fs.readFileString(config)).toBe(written)
    }),
  )

  it.effect("applies a changed file at once, keeping the running key when the file's is emptied", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k" }\n' })
      const settings = yield* settingsIn(fs)
      expect(yield* settings.reload).toBe("unchanged")
      yield* fs.writeFileString(config, '{ "apiKey": "", "strategy": "fill-first", "aliases": { "fast": "x" } }\n')
      expect(yield* settings.reload).toBe("applied")
      const now = yield* settings.get
      expect([Redacted.value(now.apiKey), now.strategy, now.aliases]).toEqual(["sm-k", "fill-first", { fast: "x" }])
      expect(yield* settings.reload).toBe("unchanged")
    }),
  )

  it.effect("keeps the last good settings when the file turns invalid, and warns once per mistake", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k", "strategy": "fill-first" }\n' })
      const settings = yield* settingsIn(fs)
      const warnings: Array<string> = []
      const capture = Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn") warnings.push(Array.ensure(message).map(String).join(" "))
        }),
      ])
      const reload = settings.reload.pipe(Effect.provide(capture))
      yield* fs.writeFileString(config, '{ "apiKey": "sm-k", "strategy": "fastest" }\n')
      expect(yield* reload).toBe("invalid")
      expect(yield* reload).toBe("invalid")
      expect((yield* settings.get).strategy).toBe("fill-first")
      expect(warnings).toEqual([
        "config.json is invalid, keeping the last good one: strategy: strategy is one of reset-first, fill-first, least-used, round-robin",
      ])
      yield* fs.writeFileString(config, '{ "apiKey": "sm-k", "strategy": "least-used" }\n')
      expect(yield* settings.reload).toBe("applied")
      expect((yield* settings.get).strategy).toBe("least-used")
    }),
  )

  it.effect("waits for a restart to change where it listens or which proxy it uses, and says so", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k", "upstreamProxy": "http://proxy:3128" }\n' })
      const settings = yield* settingsIn(fs)
      const started = yield* settings.get
      yield* fs.writeFileString(
        config,
        '{ "apiKey": "sm-k", "listen": "127.0.0.1:9999", "upstreamProxy": "socks5h://127.0.0.1:1080" }\n',
      )
      expect(yield* settings.reload).toBe("applied")
      expect(settings.running).toEqual({ listen: "127.0.0.1:7567", upstreamProxy: Option.some("http://proxy:3128") })
      expect(yield* settings.baseUrl).toBe("http://127.0.0.1:7567")
      expect(restartNeeded(started, yield* settings.get)).toEqual(["listen", "upstreamProxy"])
    }),
  )

  it.effect("reloads within moments of the file changing", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k" }\n' })
      const settings = yield* settingsIn(fs)
      const changed = yield* settings.changes.pipe(Stream.drop(1), Stream.take(1), Stream.runHead, Effect.forkScoped)
      yield* settings.follow
      for (let turn = 0; turn < 5; turn++) yield* TestClock.adjust("10 millis")
      yield* fs.writeFileString(config, '{ "apiKey": "sm-k", "pollMinutes": 1 }\n')
      yield* TestClock.adjust("150 millis")
      const seen = yield* Fiber.join(changed)
      expect(Option.map(seen, (s) => s.pollMinutes)).toEqual(Option.some(1))
    }),
  )

  it.effect("writes the schema again for a new release, and leaves it alone otherwise", () =>
    Effect.gen(function* () {
      const fs = yield* disk({ [config]: '{ "apiKey": "sm-k" }\n', [schemaFile]: '{ "$comment": "slopmax 0.0.1" }\n' })
      yield* settingsIn(fs)
      expect(yield* jsonOf(fs, schemaFile)).toMatchObject({ $comment: schemaStamp })
      yield* fs.writeFileString(schemaFile, `{ "$comment": "${schemaStamp}", "mine": true }\n`)
      yield* settingsIn(fs, 1002)
      expect(yield* jsonOf(fs, schemaFile)).toEqual({ $comment: schemaStamp, mine: true })
    }),
  )

  it.effect("holds settings in memory for tests, with no file", () =>
    Effect.gen(function* () {
      const settings = yield* SettingsService
      expect(Redacted.value((yield* settings.get).apiKey)).toBe("sm-test-key")
      expect((yield* settings.get).strategy).toBe("fill-first")
      expect(yield* settings.reload).toBe("unchanged")
      yield* settings.setLive({ paidOverflow: true })
      expect((yield* settings.get).paidOverflow).toBe(true)
      const key = yield* settings.addKey(KeyName.make("x"), [])
      expect((yield* settings.get).keys.map((k) => k.name)).toEqual([key.name])
      expect(yield* settings.removeKey(KeyName.make("x"))).toBe(true)
    }).pipe(Effect.provide(SettingsService.layerValue({ strategy: "fill-first", refreshTokens: false }))),
  )

  it("puts the proxy's address for agents on loopback when it listens everywhere", () => {
    expect(baseUrlOf("127.0.0.1:7567")).toBe("http://127.0.0.1:7567")
    expect(baseUrlOf("0.0.0.0:7567")).toBe("http://127.0.0.1:7567")
    expect(baseUrlOf("[::]:7567")).toBe("http://127.0.0.1:7567")
    expect(baseUrlOf("[::1]:7567")).toBe("http://[::1]:7567")
    expect(baseUrlOf("localhost:80")).toBe("http://localhost:80")
    expect(dashboardUrl("http://127.0.0.1:7567", "sm-k")).toBe("http://127.0.0.1:7567/slopmax/#key=sm-k")
  })
})
