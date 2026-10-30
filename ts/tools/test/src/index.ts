// it.effect / it.live / it.layer over bun:test, in the shape of @effect/vitest.
// it.effect runs with TestClock and TestConsole; it.live with the real ones; both are scoped.
import { afterAll, beforeAll, describe, test } from "bun:test"
import { Cause, type Context, Effect, Exit, Layer, Scope } from "effect"
import { TestClock, TestConsole } from "effect/testing"

type TestServices = TestClock.TestClock | TestConsole.TestConsole
const TestEnv: Layer.Layer<TestServices> = Layer.mergeAll(TestConsole.layer, TestClock.layer())

const run = <E>(effect: Effect.Effect<unknown, E>) =>
  Effect.runPromise(Effect.exit(effect)).then((exit) => {
    if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause))
  })

type Body<R> = () => Effect.Effect<unknown, unknown, R>
type Tester<R> = (name: string, body: Body<R | Scope.Scope>, timeout?: number) => void

const tester =
  <R>(provide: (e: Effect.Effect<unknown, unknown, R>) => Promise<Effect.Effect<unknown, unknown>>): Tester<R> =>
  (name, body, timeout) =>
    test(name, async () => run(await provide(Effect.scoped(Effect.suspend(body)))), timeout)

const effect: Tester<TestServices> = tester(async (e) => Effect.provide(e, TestEnv))
const live: Tester<never> = tester(async (e) => e)

/** A describe block whose tests share one build of `layer` (plus the test services). */
const layer =
  <ROut, E>(self: Layer.Layer<ROut, E>) =>
  (name: string, body: (it: { effect: Tester<ROut | TestServices> }) => void) =>
    describe(name, () => {
      const scope = Scope.makeUnsafe()
      const built = Promise.withResolvers<Context.Context<ROut | TestServices>>()
      beforeAll(() =>
        Effect.runPromise(Layer.buildWithScope(Layer.provideMerge(self, TestEnv), scope)).then(built.resolve, (e) => {
          built.reject(e)
          throw e
        }),
      )
      afterAll(() => Effect.runPromise(Scope.close(scope, Exit.void)))
      body({ effect: tester(async (e) => Effect.provide(e, await built.promise)) })
    })

export const it = Object.assign(
  (name: string, fn: () => unknown, timeout?: number) => test(name, fn as () => void, timeout),
  { effect, live, layer },
)
