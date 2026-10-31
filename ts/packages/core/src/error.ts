// What anyhow gives the Rust: an error that says what failed, in words for
// people, with the error that caused it underneath. `message` is what
// `{e}` shows (the outermost context alone); `chain` is `{e:#}`, every
// message from the outside in, joined by ": ".
import { Data, Effect } from "effect"

/** A failure with a message for people and, perhaps, its cause. */
export class Failure extends Data.TaggedError("Failure")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** `?` on another error: its message, now a `Failure`. */
export const lift = (error: { readonly message: string }): Failure => new Failure({ message: error.message })

/** An error's own message, as `{e}` shows it. */
export const text = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `{e:#}`: the message, then each cause's, joined by ": ". */
export const chain = (error: unknown): string => {
  const parts: Array<string> = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && depth < 32; depth++) {
    parts.push(text(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return parts.join(": ")
}

/** `bail!(message)`. */
export const fail = (message: string): Effect.Effect<never, Failure> => Effect.fail(new Failure({ message }))

/** `.context(message)`: wraps any error in a `Failure` that says what was being done. */
export const context =
  (message: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, Failure, R> =>
    Effect.mapError(self, (cause) => new Failure({ message, cause }))
