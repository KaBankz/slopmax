// How a command reaches what it changes. Changes to files (accounts, keys,
// settings, agent setups) are made here in this process, then a running
// proxy is told to read them again at once. The proxy's own state (pins,
// limit resets, fresh usage) belongs to the proxy while one runs, so those
// go through its API; with none running they are made here, holding the
// home's `serve` lock so no proxy can start meanwhile and overwrite them.
import { Background, Lock, type SlopmaxClient } from "@slopmax/core"
import { Effect, Option } from "effect"
import { CliFailure, failureText } from "./failure.ts"

/** The running proxy's API, or nothing when none runs. */
export const runningClient: Effect.Effect<Option.Option<SlopmaxClient>, never, Background> = Effect.gen(function* () {
  const background = yield* Background
  return yield* background.client.pipe(Effect.option)
})

/**
 * Tells a running proxy to read its files again now, after this process
 * changed them; true when one did.
 */
export const syncRunning: Effect.Effect<boolean, never, Background> = Effect.gen(function* () {
  const client = yield* runningClient
  if (Option.isNone(client)) return false
  return yield* client.value.system.sync().pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
})

/** A failed call to the proxy, in the CLI's words. */
export const apiFailure = (error: unknown): CliFailure => new CliFailure({ message: failureText(error) })

/**
 * Changes the proxy's own state: through `api` while a proxy runs, else
 * `local` in this process, under the `serve` lock.
 */
export const onProxyState = <A, E1, R1, E2, R2>(
  api: (client: SlopmaxClient) => Effect.Effect<A, E1, R1>,
  local: Effect.Effect<A, E2, R2>,
) =>
  Effect.gen(function* () {
    const client = yield* runningClient
    if (Option.isSome(client)) return yield* api(client.value).pipe(Effect.mapError(apiFailure))
    const done = yield* (yield* Lock).tryWith("serve")(local)
    if (Option.isNone(done)) {
      return yield* new CliFailure({
        message: "a slopmax proxy is starting or stopping on this home; try again in a moment",
      })
    }
    return done.value
  })
