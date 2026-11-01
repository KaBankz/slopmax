// `slopmax config [name] [value]`: the settings that change while the proxy
// runs, listed, shown one at a time, or set. Everything else lives in
// config.json, which the proxy reads again when it changes.
import { Home, SettingsService } from "@slopmax/core"
import { isLiveKey, liveKeys, liveOf, liveTable, liveText, parseLive } from "@slopmax/domain"
import { Effect, Option, Result } from "effect"
import { CliFailure } from "../failure.ts"
import { padEnd, Print } from "../print.ts"
import { syncRunning } from "../reach.ts"

export interface ConfigInput {
  readonly name: Option.Option<string>
  readonly value: Option.Option<string>
}

const notLive = (name: string) =>
  new CliFailure({
    message: `${name} is not a setting slopmax changes while it runs; those are ${liveKeys.join(", ")}`,
  })

export const config = Effect.fn("cli.config")(function* (input: ConfigInput) {
  const print = yield* Print
  const settings = yield* SettingsService
  const { bold, dim } = print.paint
  const current = liveOf(yield* settings.get)
  if (Option.isNone(input.name)) {
    const width = Math.max(...liveKeys.map((name) => name.length))
    for (const row of liveTable) {
      yield* print.out(
        `${padEnd(row.name, width)}  ${bold(padEnd(liveText(current, row.name), 11))}  ${dim(row.summary)}`,
      )
    }
    yield* print.out()
    yield* print.out(
      dim(`\`slopmax config <name> <value>\` changes one; the rest live in ${(yield* Home).paths.config}.`),
    )
    return
  }
  const name = input.name.value.trim()
  if (!isLiveKey(name)) return yield* notLive(name)
  if (Option.isNone(input.value)) {
    yield* print.out(liveText(current, name))
    return
  }
  const patch = parseLive(name, input.value.value)
  if (Result.isFailure(patch)) return yield* new CliFailure({ message: patch.failure })
  const after = liveOf(yield* settings.setLive(patch.success))
  const applied = yield* syncRunning
  yield* print.out(
    `${name} = ${bold(liveText(after, name))} ${dim(applied ? "(applied now)" : "(the proxy applies it when it starts)")}`,
  )
})
