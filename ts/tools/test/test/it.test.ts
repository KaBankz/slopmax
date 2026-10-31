import { describe, expect } from "bun:test"
import { Cause, Clock, Console, Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { it } from "../src/index.ts"
import { reportFailure, runTest } from "../src/it.ts"

describe("it.effect", () => {
  it.effect("runs on the test clock, so a sleep waits for TestClock.adjust", () =>
    Effect.gen(function* () {
      const woke = yield* Deferred.make<void>()
      yield* Effect.forkChild(Effect.andThen(Effect.sleep("1 hour"), Deferred.succeed(woke, undefined)))
      yield* TestClock.adjust("59 minutes")
      expect(yield* Deferred.isDone(woke)).toBe(false)
      yield* TestClock.adjust("1 minute")
      yield* Deferred.await(woke)
      expect(yield* Clock.currentTimeMillis).toBe(3_600_000)
    }),
  )

  it.effect("captures console output in the test console", () =>
    Effect.gen(function* () {
      yield* Console.log("hello from a test")
      expect(yield* TestConsole.logLines).toEqual(["hello from a test"])
    }),
  )

  const finalized: Array<string> = []
  it.effect("runs in a scope that closes when the test ends", () =>
    Effect.addFinalizer(() => Effect.sync(() => finalized.push("first test"))),
  )
  it("so the previous test's finalizer has already run", () => {
    expect(finalized).toEqual(["first test"])
  })

  it.effect.skipIf(true)("skips a test when asked, without running it", () => Effect.die("this test must not run"))
})

describe("it.live", () => {
  it.live("runs on the real clock", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      expect(Math.abs(now - Date.now())).toBeLessThan(5_000)
    }),
  )

  const stopped: Array<string> = []
  it.live("interrupts what a test forked into its scope once the test ends", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const work = Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
      yield* Effect.forkScoped(Effect.onInterrupt(work, () => Effect.sync(() => stopped.push("background work"))))
      yield* Deferred.await(started)
    }),
  )
  it("so the background work of the previous test has stopped", () => {
    expect(stopped).toEqual(["background work"])
  })
})

class Counter extends Context.Service<Counter, { readonly id: number; readonly builds: Ref.Ref<number> }>()(
  "@slopmax/test/test/Counter",
) {}

const builds = Ref.makeUnsafe(0)
const released: Array<number> = []
const counterLayer = Layer.effect(
  Counter,
  Effect.acquireRelease(
    Effect.map(
      Ref.updateAndGet(builds, (n) => n + 1),
      (id) => ({ id, builds }),
    ),
    ({ id }) => Effect.sync(() => released.push(id)),
  ),
)

describe("it.layer", () => {
  it.layer(counterLayer)("shares one build of the layer", (it) => {
    it.effect("for the first test", () =>
      Effect.gen(function* () {
        const counter = yield* Counter
        expect(counter.id).toBe(1)
        expect(yield* Ref.get(counter.builds)).toBe(1)
      }),
    )
    it.effect("and the second, with the test clock as well", () =>
      Effect.gen(function* () {
        const counter = yield* Counter
        expect(yield* Ref.get(counter.builds)).toBe(1)
        yield* TestClock.adjust("1 day")
        expect(yield* Clock.currentTimeMillis).toBe(86_400_000)
      }),
    )
  })

  it("releases the layer after the block's last test", () => {
    expect(released).toEqual([1])
  })

  it.layer(Layer.empty, { excludeTestServices: true })("can run on the real clock", (it) => {
    it.effect("when the test services are excluded", () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        expect(Math.abs(now - Date.now())).toBeLessThan(5_000)
      }),
    )
  })
})

describe("test failures", () => {
  it("are reported as the thrown error itself, so bun can show its diff", () => {
    const assertion = new Error("expected 1 to be 2")
    expect(reportFailure(Cause.die(assertion))).toBe(assertion)
  })

  it("carry the whole cause when the effect failed with a typed error", () => {
    const error = reportFailure(Cause.fail({ _tag: "AccountMissing", id: "acct-1" }))
    expect(error.message).toContain("AccountMissing")
    expect(error.message).toContain("acct-1")
  })

  it("reject the test's promise", async () => {
    await expect(runTest(Effect.fail("broken"))).rejects.toThrow("broken")
    await expect(runTest(Effect.void)).resolves.toBeUndefined()
  })

  it("time out on the real clock, closing the scope before the failure is reported", async () => {
    const closed: Array<string> = []
    const hung = Effect.scoped(
      Effect.andThen(
        Effect.addFinalizer(() => Effect.sync(() => closed.push("scope"))),
        Effect.onInterrupt(Effect.never, () => Effect.sync(() => closed.push("body"))),
      ),
    )
    await expect(runTest(hung, 50)).rejects.toThrow("timed out after 50ms")
    expect(closed).toEqual(["body", "scope"])
  })

  it("time out in real time even when the body waits on the test clock", async () => {
    const closed: Array<string> = []
    const onTestClock = Effect.provide(
      Effect.scoped(
        Effect.andThen(
          Effect.addFinalizer(() => Effect.sync(() => closed.push("scope"))),
          Effect.sleep("1 minute"),
        ),
      ),
      TestClock.layer(),
    )
    await expect(runTest(onTestClock, 50)).rejects.toThrow("timed out after 50ms")
    expect(closed).toEqual(["scope"])
  })

  it("include interruptions", async () => {
    const interrupted: Effect.Effect<void, never, never> = Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.never)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.join(fiber)
    })
    await expect(runTest(interrupted)).rejects.toThrow()
  })
})
