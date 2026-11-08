// it.effect / it.live / it.layer over bun:test.
//
// it.effect runs the test with TestClock and TestConsole, so token expiry,
// schedules and timeouts are driven by `TestClock.adjust` and never wait on
// the wall clock. it.live runs with the real clock and console, for tests that
// touch real processes or sockets. Both run in a scope that closes when the
// test ends, so temp homes, servers and fibers never outlive their test. That
// holds for a test that hangs too: at its timeout the test is interrupted and
// its scope closed before bun:test moves on.
import { afterAll, beforeAll, describe, test } from "bun:test"
import { Cause, type Context, Duration, Effect, Exit, Layer, Scope } from "effect"
import { TestClock, TestConsole } from "effect/testing"

export type TestServices = TestClock.TestClock | TestConsole.TestConsole

const testServices: Layer.Layer<TestServices> = Layer.mergeAll(TestConsole.layer, TestClock.layer())

/**
 * Turns a failed test's cause into what bun:test reports. A lone thrown error
 * (a failed `expect` inside the effect) is rethrown as it is, so bun shows its
 * diff; anything else becomes one error carrying the whole pretty-printed cause.
 */
export const reportFailure = (cause: Cause.Cause<unknown>): Error => {
  const [only, ...rest] = cause.reasons
  if (only?._tag === "Die" && rest.length === 0 && only.defect instanceof Error) return only.defect
  return new Error(Cause.pretty(cause))
}

/** bun:test's own default, used when a test names no timeout. */
export const defaultTimeout = 5_000

/**
 * How long past a test's timeout bun:test waits. slopmax's helpers interrupt
 * the test at its timeout; this leaves its finalizers time to stop servers and
 * remove temp homes before bun:test gives up on it.
 */
export const cleanupGrace = 1_000

/**
 * Runs `effect`, interrupting it once `timeout` milliseconds pass on the real
 * clock. Interrupting waits for the effect to stop, so its scope is closed by
 * the time the timeout is reported. The deadline sits outside the test's own
 * services, so a test on the test clock still times out in real time.
 */
const withDeadline = <A, E>(effect: Effect.Effect<A, E>, timeout: number): Effect.Effect<A, E> =>
  Effect.timeoutOrElse(effect, {
    duration: Duration.millis(timeout),
    orElse: () => Effect.die(new Error(`timed out after ${timeout}ms; the test was interrupted and its scope closed`)),
  })

/**
 * Runs a test body to completion, or until `timeout` milliseconds pass,
 * throwing what bun:test should report if it fails.
 */
export const runTest = (effect: Effect.Effect<unknown, unknown>, timeout: number = defaultTimeout): Promise<void> =>
  Effect.runPromiseExit(Number.isFinite(timeout) ? withDeadline(effect, timeout) : effect).then((exit) => {
    if (Exit.isFailure(exit)) throw reportFailure(exit.cause)
  })

export type Body<R> = () => Effect.Effect<unknown, unknown, R | Scope.Scope>

export interface Tester<R> {
  /**
   * Defines a test. After `timeout` milliseconds of real time (bun:test's 5 s
   * by default) the body is interrupted and its scope closed.
   */
  (name: string, body: Body<R>, timeout?: number): void
  /** Skips the test when `condition` holds, as for a platform it cannot run on. */
  readonly skipIf: (condition: boolean) => (name: string, body: Body<R>, timeout?: number) => void
}

type Provide<R> = (effect: Effect.Effect<unknown, unknown, R>) => Effect.Effect<unknown, unknown>

const tester = <R>(provide: Provide<R>): Tester<R> => {
  const define =
    (register: typeof test) =>
    (name: string, body: Body<R>, timeout: number = defaultTimeout): void => {
      register(name, () => runTest(provide(Effect.scoped(Effect.suspend(body))), timeout), timeout + cleanupGrace)
    }
  return Object.assign(define(test), {
    skipIf: (condition: boolean) => define(condition ? test.skip : test),
  })
}

const effect: Tester<TestServices> = tester((body) => Effect.provide(body, testServices))
const live: Tester<never> = tester((body) => body)

/** Defines tests that share a built layer. */
export type LayerSuite<R> = (name: string, body: (it: { readonly effect: Tester<R> }) => void) => void

const suite =
  <R, E>(services: Layer.Layer<R, E>): LayerSuite<R> =>
  (name, body) =>
    describe(name, () => {
      const scope = Scope.makeUnsafe()
      const built = Promise.withResolvers<Context.Context<R>>()
      // Tests that never run must not leave an unhandled rejection behind.
      built.promise.catch(() => undefined)
      beforeAll(() =>
        Effect.runPromise(Layer.buildWithScope(services, scope)).then(built.resolve, (error: unknown) => {
          built.reject(error)
          throw error
        }),
      )
      afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      // Each test waits for the build inside its own effect, so a failed build fails the test.
      const awaitBuilt = Effect.promise(() => built.promise)
      body({ effect: tester((run) => Effect.flatMap(awaitBuilt, (context) => Effect.provideContext(run, context))) })
    })

/**
 * A describe block whose tests share one build of `self`, released after the
 * last test. The layer is built with the test clock and console, so its
 * services and the tests see the same clock; `excludeTestServices` builds it
 * and runs its tests with the real ones instead.
 */
function layer<ROut, E>(self: Layer.Layer<ROut, E>, options: { readonly excludeTestServices: true }): LayerSuite<ROut>
function layer<ROut, E>(
  self: Layer.Layer<ROut, E>,
  options?: { readonly excludeTestServices?: false | undefined },
): LayerSuite<ROut | TestServices>
function layer<ROut, E>(
  self: Layer.Layer<ROut, E>,
  options?: { readonly excludeTestServices?: boolean | undefined },
): LayerSuite<ROut> | LayerSuite<ROut | TestServices> {
  return options?.excludeTestServices === true ? suite(self) : suite(Layer.provideMerge(self, testServices))
}

/** A plain bun:test test, plus `it.effect`, `it.live` and `it.layer`. */
export const it = Object.assign(
  (name: string, fn: () => void | Promise<unknown>, timeout?: number): void => {
    test(name, fn, timeout)
  },
  { effect, live, layer },
)
