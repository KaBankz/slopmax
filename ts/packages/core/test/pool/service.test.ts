import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Effect, Fiber, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { type Account, accountText } from "../../src/account.ts"
import { Accounts } from "../../src/accounts.ts"
import { Told } from "../../src/notifier.ts"
import { observe, Pool, SavedState, sawAgent, succeeded, throttle } from "../../src/pool.ts"
import { home, mockUpstream, reply, storeLayer } from "../providers/support.ts"
import { claude, limits, ts, window } from "./fixtures.ts"

const stateFile = `${home}/state.json`
const accountFile = (account: Account) => `${home}/accounts/${account.id}.json`

const filesOf = (accounts: ReadonlyArray<Account>, state?: string) => ({
  files: {
    ...Object.fromEntries(accounts.map((account) => [accountFile(account), accountText(account)])),
    ...(state === undefined ? {} : { [stateFile]: state }),
  },
})

const layerWith = (accounts: ReadonlyArray<Account>, state?: string) =>
  Pool.layer.pipe(Layer.provideMerge(storeLayer(mockUpstream(() => reply(404)).layer, {}, filesOf(accounts, state))))

const pool = Effect.flatMap(Pool, Effect.succeed)

/** Lets forked fibers (the pool following the store) run until `done` holds. */
const until = (done: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 1000 && !(yield* done); tries++) yield* Effect.yieldNow
  })

const readState = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return Schema.decodeUnknownSync(Schema.fromJsonString(SavedState))(yield* fs.readFileString(stateFile))
})

describe("the pool service", () => {
  const a = claude("a", 1)
  const b = claude("b", 2)

  it.effect("starts empty without state.json and takes its accounts from the store", () =>
    Effect.gen(function* () {
      const m = yield* (yield* pool).model
      expect(m.accounts.map((account) => account.id)).toEqual([a.id])
      expect(m.dirty).toBe(false)
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("restores state.json, and a malformed one stops the start", () =>
    Effect.gen(function* () {
      const saved = JSON.stringify({ agents: { claude: "claude-cli/2.1.0" } })
      const restored = yield* Effect.flatMap(Pool, (p) => p.model).pipe(Effect.provide(layerWith([a], saved)))
      expect(restored.agents.claude).toBe("claude-cli/2.1.0")
      const broken = yield* Effect.flip(Effect.flatMap(Pool, (p) => p.model).pipe(Effect.provide(layerWith([a], "{"))))
      expect(broken._tag).toBe("FileError")
    }),
  )

  it.effect("saves state.json only when something changed", () =>
    Effect.gen(function* () {
      const p = yield* pool
      const fs = yield* FileSystem.FileSystem
      yield* p.save
      expect(yield* fs.exists(stateFile)).toBe(false)
      yield* p.update((m) => sawAgent(m, "claude", "claude-cli/2.1.0"))
      yield* p.save
      expect((yield* readState).agents.claude).toBe("claude-cli/2.1.0")
      yield* fs.remove(stateFile)
      yield* p.save
      expect(yield* fs.exists(stateFile)).toBe(false)
      const mode = yield* p
        .update((m, now) => observe(m, a.id, limits([window("5h", 10)]), now))
        .pipe(Effect.andThen(p.save), Effect.andThen(fs.stat(stateFile)))
      expect(mode.mode & 0o777).toBe(0o600)
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("follows the account store as accounts come and go", () =>
    Effect.gen(function* () {
      const p = yield* pool
      const fs = yield* FileSystem.FileSystem
      const accounts = yield* Accounts
      yield* fs.writeFileString(accountFile(b), accountText(b))
      yield* accounts.rescan
      yield* until(Effect.map(p.model, (m) => m.accounts.length === 2))
      expect((yield* p.model).accounts.map((account) => account.id)).toEqual([a.id, b.id])
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("signals a change, and nothing for a change that changes nothing", () =>
    Effect.gen(function* () {
      const p = yield* pool
      const seen = yield* Effect.forkChild(Stream.runCollect(Stream.take(p.changes, 1)))
      yield* Effect.yieldNow
      yield* p.update((m) => m)
      yield* Effect.yieldNow
      expect(seen.pollUnsafe()).toBeUndefined()
      yield* p.update((m) => sawAgent(m, "claude", "x"))
      expect(yield* Fiber.join(seen)).toHaveLength(1)
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("pooled windows are reused until a reading changes or a window resets", () =>
    Effect.gen(function* () {
      const p = yield* pool
      yield* p.update((m, now) => observe(m, a.id, limits([window("5h", 40, 600)], 0), now))
      const first = yield* p.pooled("claude")
      expect(first.map((w) => w.used)).toEqual([40])
      expect(yield* p.pooled("claude")).toBe(first)
      yield* p.update((m, now) => observe(m, a.id, limits([window("5h", 50, 600)], 0), now))
      const second = yield* p.pooled("claude")
      expect(second.map((w) => w.used)).toEqual([50])
      expect(yield* p.pooled("claude")).toBe(second)
      // A served request or a throttling changes nothing the windows are read from.
      yield* p.update((m, now) =>
        throttle(succeeded(m, a.id, undefined, now), a.id, DateTime.addDuration(now, "1 minute")),
      )
      expect(yield* p.pooled("claude")).toBe(second)
      yield* TestClock.adjust("10 minutes")
      expect((yield* p.pooled("claude")).map((w) => w.used)).toEqual([0])
      expect(yield* p.pooled("codex")).toEqual([])
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("a change that dies leaves the pool as it was and usable", () =>
    Effect.gen(function* () {
      const p = yield* pool
      const before = yield* p.model
      const died = yield* Effect.exit(
        p.update(() => {
          throw new Error("boom")
        }),
      )
      expect(died._tag).toBe("Failure")
      expect(yield* p.model).toBe(before)
      yield* p.update((m) => sawAgent(m, "claude", "x"))
      expect((yield* p.model).agents.claude).toBe("x")
    }).pipe(Effect.provide(layerWith([a]))),
  )

  it.effect("the notices told are kept in the pool's state", () =>
    Effect.gen(function* () {
      const told = yield* Told
      yield* told.set({ "reset:x": ts(99) })
      expect(Object.keys(yield* told.get)).toEqual(["reset:x"])
      const p = yield* pool
      yield* p.save
      expect(Option.fromUndefinedOr((yield* readState).told["reset:x"])).toEqual(Option.some(ts(99)))
    }).pipe(Effect.provide(Pool.told.pipe(Layer.provideMerge(layerWith([a]))))),
  )
})
