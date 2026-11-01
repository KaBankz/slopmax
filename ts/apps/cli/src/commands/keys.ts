// `slopmax key`: keys other machines and tools present to the proxy instead
// of the owner key, each optionally limited to some models. A key's secret
// is shown once, when it is made; lists show only names.
import { SettingsService } from "@slopmax/core"
import { KeyName } from "@slopmax/domain"
import { Effect, Redacted, Schema } from "effect"
import { CliFailure } from "../failure.ts"
import { Print } from "../print.ts"
import { syncRunning } from "../reach.ts"
import { splitList } from "./accounts.ts"

export const listKeys = Effect.fn("cli.key.list")(function* () {
  const print = yield* Print
  const { bold, dim } = print.paint
  const keys = (yield* (yield* SettingsService).get).keys
  if (keys.length === 0) {
    yield* print.out("No client keys. Make one with `slopmax key add <name>`.")
    return
  }
  for (const key of keys) {
    yield* print.out(`${bold(key.name)} ${dim(key.models.length === 0 ? "any model" : key.models.join(", "))}`)
  }
})

/** A key's name as typed, or why it cannot be one. */
const keyName = (text: string) =>
  Schema.decodeEffect(KeyName)(text.trim()).pipe(
    Effect.mapError(() => new CliFailure({ message: "a key needs a name" })),
  )

export const addKey = Effect.fn("cli.key.add")(function* (name: string, models: string) {
  const print = yield* Print
  const made = yield* (yield* SettingsService).addKey(yield* keyName(name), splitList(models))
  const proxy = (yield* syncRunning) ? "the running proxy takes it now" : "the proxy takes it when it starts"
  // Only the key goes to stdout, so `slopmax key add laptop > key.txt` keeps just the secret.
  yield* print.out(Redacted.value(made.key))
  yield* print.err(
    print.paint.dim(
      `Added the key ${JSON.stringify(made.name)}. Clients present it as a bearer token or x-api-key; ${proxy}.`,
    ),
  )
})

export const removeKey = Effect.fn("cli.key.remove")(function* (name: string) {
  const print = yield* Print
  const removed = yield* (yield* SettingsService).removeKey(yield* keyName(name))
  if (!removed) return yield* new CliFailure({ message: `no key named ${JSON.stringify(name.trim())}` })
  yield* syncRunning
  yield* print.out(`Revoked the key ${JSON.stringify(name.trim())}.`)
})
