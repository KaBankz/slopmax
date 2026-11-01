// Sign-ins started through the API, by the dashboard or the desktop window.
// Each runs in its own fiber, keyed by an id the caller gets at once; its
// progress (the address to open, a device code, notes, the outcome) goes out
// on the event feed as `Login` events. The caller opens the address itself,
// so a sign-in from another machine works too: the address the browser
// landed on is pasted back through the API. Cancelling interrupts the
// fiber, which closes the sign-in's callback server.
import { Event, LoginEvent, LoginId, NotFound, type SubscriptionId } from "@slopmax/domain"
import { Cause, Context, Effect, Exit, FiberMap, Layer, Option, Queue, Ref, Stream } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { Accounts } from "../accounts.ts"
import { Events } from "../events.ts"
import { Pool } from "../pool.ts"
import { LoginUi } from "../providers/oauth.ts"
import { signIn } from "../providers/index.ts"
import { SettingsService } from "../settings.ts"
import { Upstream } from "../upstream.ts"
import { freshReport, viewIn } from "./status.ts"

export interface Shape {
  /** Starts a sign-in, giving the id its events carry. */
  readonly start: (provider: SubscriptionId, options: { readonly device: boolean }) => Effect.Effect<LoginId>
  /** Hands a sign-in the address the browser landed on. */
  readonly paste: (id: LoginId, address: string) => Effect.Effect<void, NotFound>
  /** Stops a sign-in. */
  readonly cancel: (id: LoginId) => Effect.Effect<void, NotFound>
}

const missing = new NotFound({ what: "sign-in" })

const make = Effect.gen(function* () {
  const events = yield* Events
  // What each sign-in runs on: the same store, pool and network as the proxy.
  const services = yield* Effect.context<
    Accounts | Pool | SettingsService | Upstream | ChildProcessSpawner.ChildProcessSpawner
  >()
  const running = yield* FiberMap.make<LoginId>()
  const pastes = yield* Ref.make<ReadonlyMap<LoginId, Queue.Queue<string>>>(new Map())

  const forget = (id: LoginId) =>
    Ref.update(pastes, (now) => {
      const next = new Map(now)
      next.delete(id)
      return next
    })

  const tell = (id: LoginId, event: LoginEvent) => events.publish(Event.cases.Login.make({ id, event }))

  const session = (id: LoginId, provider: SubscriptionId, device: boolean, pasted: Queue.Queue<string>) =>
    Effect.gen(function* () {
      const ui = Layer.succeed(LoginUi)({
        tell: (event) => tell(id, event),
        pasted: Stream.fromQueue(pasted),
        openBrowser: false,
      })
      const exit = yield* signIn(provider, { device }).pipe(Effect.provide(ui), Effect.exit)
      if (Exit.isSuccess(exit)) {
        const { account, isNew } = exit.value
        const built = yield* freshReport
        const view = viewIn(built, account.id)
        // Every sign-in ends with an outcome, so nothing waits on one forever.
        yield* tell(
          id,
          view === undefined
            ? LoginEvent.cases.Failed.make({ message: `signed in as ${account.id}, but the pool does not list it` })
            : LoginEvent.cases.Done.make({ account: view, isNew }),
        )
        return
      }
      if (Exit.hasInterrupts(exit)) return
      const failure = Exit.findErrorOption(exit)
      // A defect has no words for the person signing in; its cause goes to the log.
      if (Option.isNone(failure)) yield* Effect.logError(`sign-in ${id}: ${Cause.pretty(exit.cause)}`)
      const message = Option.match(failure, { onNone: () => "the sign-in failed", onSome: (error) => error.message })
      yield* tell(id, LoginEvent.cases.Failed.make({ message }))
    }).pipe(Effect.ensuring(forget(id)), Effect.provideContext(services))

  const start = Effect.fn("Logins.start")(function* (provider: SubscriptionId, options: { readonly device: boolean }) {
    const id = LoginId.make(crypto.randomUUID())
    const pasted = yield* Queue.unbounded<string>()
    yield* Ref.update(pastes, (now) => new Map(now).set(id, pasted))
    yield* FiberMap.run(running, id, session(id, provider, options.device, pasted))
    return id
  })

  const paste = Effect.fn("Logins.paste")(function* (id: LoginId, address: string) {
    const queue = (yield* Ref.get(pastes)).get(id)
    if (queue === undefined) return yield* missing
    yield* Queue.offer(queue, address)
  })

  const cancel = Effect.fn("Logins.cancel")(function* (id: LoginId) {
    if (!(yield* FiberMap.has(running, id))) return yield* missing
    yield* FiberMap.remove(running, id)
  })

  return { start, paste, cancel } satisfies Shape
})

/** Sign-ins in progress through the API. They end with the daemon. */
export class Logins extends Context.Service<Logins, Shape>()("@slopmax/core/Logins", { make }) {
  static readonly layer: Layer.Layer<
    Logins,
    never,
    Events | Accounts | Pool | SettingsService | Upstream | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(Logins, Logins.make)
}
