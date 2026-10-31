// `slopmax doctor`: prints the setup checks from the core's `doctor`.
import { Effect } from "effect"

import { type Config, doctor, type Failure, type Store } from "@slopmax/core"

import * as ui from "../ui.ts"

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

/** Prints every finding and returns the exit code: 1 if something is broken. */
export const run: (config: Config, store: Store) => Effect.Effect<number, Failure> = Effect.fn("doctor.run")(function* (
  config: Config,
  store: Store,
) {
  let worst: doctor.Level = "ok"
  let problems = 0
  let warnings = 0
  for (const section of yield* doctor.check(config, store)) {
    yield* ui.println(`\n${ui.bold(section.title)}`)
    for (const finding of section.findings) {
      const mark =
        finding.level === "ok"
          ? ui.green("✓")
          : finding.level === "note"
            ? ui.dim("·")
            : finding.level === "warn"
              ? ui.yellow("!")
              : ui.red("✗")
      yield* ui.println(`  ${mark} ${finding.text}`)
      if (finding.fix !== undefined) yield* ui.println(`      ${ui.dim("fix:")} ${finding.fix}`)
      if (doctor.Level.compare(finding.level, worst) > 0) worst = finding.level
      if (finding.level === "fail") problems += 1
      if (finding.level === "warn") warnings += 1
    }
  }
  yield* ui.println()
  if (problems === 0 && warnings === 0) yield* ui.println(ui.green("Everything looks good."))
  else yield* ui.println(`${plural(problems, "problem")}, ${plural(warnings, "warning")}.`)
  return worst === "fail" ? 1 : 0
})
