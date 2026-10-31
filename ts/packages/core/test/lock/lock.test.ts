import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { it, MemoryFileSystem, TestHome } from "@slopmax/test"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Ref, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Home } from "../../src/home.ts"
import {
  AlreadyServing,
  Holder,
  linuxStartTime,
  type Liveness,
  Lock,
  LockTimeout,
  parseHolder,
  systemLiveness,
} from "../../src/lock.ts"

const root = "/home/me/.slopmax"
const lockFile = (name: string) => `${root}/locks/${name}.lock`

/** Another process, as the lock sees it: alive or not, and when it started. */
interface Other {
  readonly alive: boolean
  readonly startedAt?: string
}

const livenessOf = (others: Readonly<Record<number, Other>>): Liveness => ({
  alive: (pid) => Effect.succeed(pid === process.pid || (others[pid]?.alive ?? false)),
  startedAt: (pid) =>
    Effect.succeed(pid === process.pid ? Option.some("self") : Option.fromUndefinedOr(others[pid]?.startedAt)),
})

const holderText = (holder: { pid: number; startedAt: string; token: string }) =>
  JSON.stringify(Schema.encodeSync(Holder)(new Holder(holder)))

/** Locks over an in-memory home, where other processes are what `others` says. */
const onMemory = (others: Readonly<Record<number, Other>> = {}, files: Record<string, string> = {}) =>
  Lock.layerWith(livenessOf(others)).pipe(
    Layer.provideMerge(Home.layerAt(root)),
    Layer.provideMerge(MemoryFileSystem.layerWith({ files })),
  )

describe("Lock", () => {
  it.effect("lets one holder in at a time within a process", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const inside = yield* Ref.make(0)
      const most = yield* Ref.make(0)
      const body = Effect.gen(function* () {
        const now = yield* Ref.updateAndGet(inside, (n) => n + 1)
        yield* Ref.update(most, (m) => Math.max(m, now))
        yield* Effect.sleep("10 millis")
        yield* Ref.update(inside, (n) => n - 1)
      })
      const all = yield* Effect.forkScoped(
        Effect.all(
          [1, 2, 3].map(() => lock.with("config")(body)),
          { concurrency: 3 },
        ),
      )
      for (let turn = 0; turn < 10; turn++) yield* TestClock.adjust("10 millis")
      yield* Fiber.join(all)
      expect(yield* Ref.get(most)).toBe(1)
    }).pipe(Effect.provide(onMemory())),
  )

  it.effect("keeps a lock file naming its holder while held, and removes it after", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const fs = yield* FileSystem.FileSystem
      const during = yield* lock.with("account-claude-1")(fs.readFileString(lockFile("account-claude-1")))
      const holder = parseHolder(during)
      expect(Option.map(holder, (h) => [h.pid, h.startedAt])).toEqual(Option.some([process.pid, "self"]))
      expect(yield* fs.exists(lockFile("account-claude-1"))).toBe(false)
      expect((yield* fs.stat(`${root}/locks`)).mode & 0o777).toBe(0o700)
      // Nothing is left beside it either.
      expect(yield* fs.readDirectory(`${root}/locks`)).toEqual([])
    }).pipe(Effect.provide(onMemory())),
  )

  it.effect("waits for a live holder in another process, then times out naming it", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const waiting = yield* Effect.forkScoped(Effect.flip(lock.with("config", { wait: "2 seconds" })(Effect.void)))
      for (let turn = 0; turn < 30; turn++) yield* TestClock.adjust("100 millis")
      const error = yield* Fiber.join(waiting)
      expect(error).toBeInstanceOf(LockTimeout)
      expect(error).toMatchObject({ name: "config", holder: 4242 })
      expect(error.message).toBe("timed out waiting for the config lock (held by process 4242)")
    }).pipe(
      Effect.provide(
        onMemory(
          { 4242: { alive: true, startedAt: "100" } },
          { [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) },
        ),
      ),
    ),
  )

  it.effect("gets a lock as soon as its holder lets go", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const fs = yield* FileSystem.FileSystem
      const ran = yield* Deferred.make<void>()
      const waiting = yield* Effect.forkScoped(lock.with("config")(Deferred.succeed(ran, undefined)))
      yield* TestClock.adjust("100 millis")
      expect(yield* Deferred.isDone(ran)).toBe(false)
      yield* fs.remove(lockFile("config"))
      yield* TestClock.adjust("100 millis")
      yield* Fiber.join(waiting)
      expect(yield* Deferred.isDone(ran)).toBe(true)
    }).pipe(
      Effect.provide(
        onMemory(
          { 4242: { alive: true, startedAt: "100" } },
          { [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) },
        ),
      ),
    ),
  )

  it.effect("takes over a lock whose holder has died", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      expect(yield* lock.with("config", { wait: "1 second" })(Effect.succeed("got it"))).toBe("got it")
    }).pipe(
      Effect.provide(onMemory({}, { [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) })),
    ),
  )

  it.effect("takes over a lock whose pid now belongs to another program", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      expect(yield* lock.tryWith("config")(Effect.succeed("got it"))).toEqual(Option.some("got it"))
    }).pipe(
      Effect.provide(
        onMemory(
          { 4242: { alive: true, startedAt: "999" } },
          { [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) },
        ),
      ),
    ),
  )

  it.effect("never takes a lock from a live holder, however long it has held it", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      yield* TestClock.adjust("365 days")
      expect(yield* lock.tryWith("config")(Effect.succeed("got it"))).toEqual(Option.none())
    }).pipe(
      Effect.provide(
        onMemory(
          { 4242: { alive: true, startedAt: "100" } },
          { [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) },
        ),
      ),
    ),
  )

  it.effect("takes over a lock file that names no holder only once it has stayed so a while", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      expect(yield* lock.tryWith("config")(Effect.succeed(1))).toEqual(Option.none())
      yield* TestClock.adjust("11 seconds")
      expect(yield* lock.tryWith("config")(Effect.succeed(2))).toEqual(Option.some(2))
    }).pipe(Effect.provide(onMemory({}, { [lockFile("config")]: "" }))),
  )

  it.effect("takes over a stale lock one taker at a time, clearing a takeover abandoned long ago", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const fs = yield* FileSystem.FileSystem
      // Another taker is in the middle of taking it over: this one leaves it alone.
      expect(yield* lock.tryWith("config")(Effect.succeed(1))).toEqual(Option.none())
      expect(yield* fs.exists(lockFile("config"))).toBe(true)
      // A takeover that has stood for seconds was abandoned by a taker that died.
      yield* TestClock.adjust("11 seconds")
      expect(yield* lock.tryWith("config")(Effect.succeed(2))).toEqual(Option.none())
      expect(yield* lock.tryWith("config")(Effect.succeed(3))).toEqual(Option.some(3))
      expect(yield* fs.readDirectory(`${root}/locks`)).toEqual([])
    }).pipe(
      Effect.provide(
        onMemory(
          {},
          {
            [lockFile("config")]: holderText({ pid: 4242, startedAt: "100", token: "t" }),
            [`${lockFile("config")}.steal`]: "",
          },
        ),
      ),
    ),
  )

  it.effect("keeps two Locks built in one process from holding the same lock at once", () =>
    Effect.gen(function* () {
      const layer = Lock.layerWith(livenessOf({}))
      const first = yield* Effect.provide(Lock, layer)
      const second = yield* Effect.provide(Lock, layer)
      const inside = yield* Ref.make(0)
      const most = yield* Ref.make(0)
      const body = Effect.gen(function* () {
        const now = yield* Ref.updateAndGet(inside, (n) => n + 1)
        yield* Ref.update(most, (m) => Math.max(m, now))
        yield* Effect.sleep("50 millis")
        yield* Ref.update(inside, (n) => n - 1)
      })
      const both = yield* Effect.forkScoped(
        Effect.all([first.with("config")(body), Effect.delay(second.with("config")(body), "10 millis")], {
          concurrency: 2,
        }),
      )
      for (let turn = 0; turn < 20; turn++) yield* TestClock.adjust("10 millis")
      yield* Fiber.join(both)
      expect(yield* Ref.get(most)).toBe(1)
      // Neither takes the other's live hold for one left behind.
      const scope = yield* Effect.scope
      yield* first.hold("serve").pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* second.tryWith("serve")(Effect.succeed("stolen"))).toEqual(Option.none())
    }).pipe(Effect.provide(Home.layerAt(root).pipe(Layer.provideMerge(MemoryFileSystem.layer)))),
  )

  it.effect("says a home is served without naming a process when the lock file names none yet", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const error = yield* Effect.flip(Effect.scoped(lock.hold("serve")))
      expect(error).toEqual(new AlreadyServing({}))
      expect(error.message).not.toContain("process")
    }).pipe(Effect.provide(onMemory({}, { [lockFile("serve")]: "" }))),
  )

  it.effect("holds the serve lock for a scope, and a second holder is told who serves", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Effect.scope
      const first = yield* Effect.exit(Effect.scoped(Effect.andThen(lock.hold("serve"), lock.hold("serve"))))
      expect(Exit.isFailure(first)).toBe(true)
      if (Exit.isFailure(first)) {
        const reason = first.cause.reasons[0]
        expect(reason?._tag === "Fail" ? reason.error : undefined).toEqual(new AlreadyServing({ pid: process.pid }))
      }
      // Released with its scope: it can be held again, and nothing is left on disk.
      expect(yield* fs.exists(lockFile("serve"))).toBe(false)
      yield* lock.hold("serve").pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* fs.exists(lockFile("serve"))).toBe(true)
      expect(yield* lock.tryWith("serve")(Effect.succeed("offline write"))).toEqual(Option.none())
    }).pipe(Effect.provide(onMemory())),
  )

  it.effect("tells a daemon starting beside another process which process serves", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const error = yield* Effect.flip(Effect.scoped(lock.hold("serve")))
      expect(error).toEqual(new AlreadyServing({ pid: 4242 }))
      expect(error.message).toContain("process 4242")
    }).pipe(
      Effect.provide(
        onMemory(
          { 4242: { alive: true, startedAt: "100" } },
          { [lockFile("serve")]: holderText({ pid: 4242, startedAt: "100", token: "t" }) },
        ),
      ),
    ),
  )

  it.effect("releases a lock when its holder is interrupted", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const fs = yield* FileSystem.FileSystem
      const inside = yield* Deferred.make<void>()
      const holder = yield* Effect.forkScoped(
        lock.with("config")(Effect.andThen(Deferred.succeed(inside, undefined), Effect.never)),
      )
      yield* Deferred.await(inside)
      expect(yield* fs.exists(lockFile("config"))).toBe(true)
      yield* Fiber.interrupt(holder)
      expect(yield* fs.exists(lockFile("config"))).toBe(false)
      expect(yield* lock.tryWith("config")(Effect.succeed("free"))).toEqual(Option.some("free"))
    }).pipe(Effect.provide(onMemory())),
  )

  it.effect("keeps locks within the process alone when told to", () =>
    Effect.gen(function* () {
      const lock = yield* Lock
      const scope = yield* Effect.scope
      yield* lock.hold("serve").pipe(Effect.provideService(Scope.Scope, scope))
      expect(yield* lock.tryWith("serve")(Effect.succeed(1))).toEqual(Option.none())
      expect(yield* lock.with("config")(Effect.succeed(2))).toBe(2)
      expect(yield* Effect.flip(Effect.scoped(lock.hold("serve")))).toEqual(new AlreadyServing({ pid: process.pid }))
    }).pipe(Effect.provide(Lock.layerMemory)),
  )

  it("reads a process's start time from /proc, even when its name has spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index + 3))
    expect(linuxStartTime(`1234 (bun) ${fields.join(" ")}`)).toEqual(Option.some("22"))
    expect(linuxStartTime(`1234 (a (weird) name) ${fields.join(" ")}`)).toEqual(Option.some("22"))
    expect(linuxStartTime("1234 (short) S 1")).toEqual(Option.none())
    expect(linuxStartTime("garbage")).toEqual(Option.none())
  })

  it("reads only lock files that name a holder", () => {
    expect(parseHolder(holderText({ pid: 7, startedAt: "1", token: "x" }))).toEqual(
      Option.some(new Holder({ pid: 7, startedAt: "1", token: "x" })),
    )
    expect(parseHolder("")).toEqual(Option.none())
    expect(parseHolder('{ "pid": 7 }')).toEqual(Option.none())
  })

  it.live.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "sees this process alive with a start time, and a pid nobody has as gone",
    () =>
      Effect.gen(function* () {
        const liveness = yield* systemLiveness
        expect(yield* liveness.alive(process.pid)).toBe(true)
        expect(Option.isSome(yield* liveness.startedAt(process.pid))).toBe(true)
        // Above the kernel's largest pid, so no process has it.
        expect(yield* liveness.alive(4_194_400)).toBe(false)
      }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live.skipIf(process.platform === "win32")(
    "takes a lock from another process the moment that process is killed",
    () =>
      Effect.gen(function* () {
        const test = yield* TestHome.make("lock-kill")
        const fs = yield* FileSystem.FileSystem
        const holder = Bun.spawn(["bun", `${import.meta.dir}/holder.ts`, test.slopmax, "config"], {
          stdout: "pipe",
          stderr: "inherit",
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill("SIGKILL")))
        const reader = holder.stdout.getReader()
        const first = yield* Effect.promise(() => reader.read())
        expect(new TextDecoder().decode(first.value)).toContain("held")
        const lock = yield* Effect.provide(Lock, Lock.layer.pipe(Layer.provideMerge(Home.layerAt(test.slopmax))))
        expect(yield* lock.tryWith("config")(Effect.succeed("mine"))).toEqual(Option.none())
        const text = yield* fs.readFileString(`${test.slopmax}/locks/config.lock`)
        expect(Option.map(parseHolder(text), (h) => h.pid)).toEqual(Option.some(holder.pid))
        holder.kill("SIGKILL")
        yield* Effect.promise(() => holder.exited)
        expect(yield* lock.with("config", { wait: "5 seconds" })(Effect.succeed("mine"))).toBe("mine")
      }).pipe(Effect.provide(BunServices.layer)),
    15_000,
  )
})
