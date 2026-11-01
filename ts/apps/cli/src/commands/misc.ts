// `slopmax notify` sends a test notification where notices go; `slopmax
// doctor` checks the setup and says how to fix what is wrong.
import { doctor as checkSetup, Home, Notifier, SettingsService } from "@slopmax/core"
import { type Level, Section } from "@slopmax/domain"
import { Config, Effect, Option, Schema } from "effect"
import { CliFailure, ExitWith } from "../failure.ts"
import { type Paint, plural, Print } from "../print.ts"

export const notify = Effect.fn("cli.notify")(function* () {
  const print = yield* Print
  const settings = yield* (yield* SettingsService).get
  if (!settings.notify.enabled) {
    const file = (yield* Home).paths.config
    return yield* new CliFailure({
      message: `notifications are off; set a webhook or command under notify in ${file}`,
    })
  }
  yield* (yield* Notifier).test
  yield* print.out("Sent a test notification.")
})

/**
 * Where the doctor looks for CLIProxyAPI, when it does not listen on its
 * usual port (and in tests, which must never touch that port).
 */
export const cliProxyApiPort = Config.option(Config.Int("SLOPMAX_CLIPROXYAPI_PORT")).pipe(
  Config.map(Option.getOrUndefined),
)

const marks = (paint: Paint): { readonly [K in Level]: string } => ({
  ok: paint.green("✓"),
  info: paint.dim("·"),
  warn: paint.yellow("!"),
  fail: paint.red("✗"),
})

/** What `slopmax doctor` prints for its sections, line by line. */
export const renderDoctor = (sections: ReadonlyArray<Section>, paint: Paint): ReadonlyArray<string> => {
  const mark = marks(paint)
  const lines: Array<string> = []
  let fails = 0
  let warnings = 0
  for (const section of sections) {
    lines.push("", paint.bold(section.title))
    for (const finding of section.findings) {
      if (finding.level === "fail") fails += 1
      if (finding.level === "warn") warnings += 1
      lines.push(`  ${mark[finding.level]} ${finding.text}`)
      if (finding.fix !== undefined) lines.push(`      ${paint.dim("fix:")} ${finding.fix}`)
    }
  }
  lines.push("")
  lines.push(
    fails === 0 && warnings === 0
      ? paint.green("Everything looks good.")
      : `${plural(fails, "problem")}, ${plural(warnings, "warning")}.`,
  )
  return lines
}

/** Whether any finding failed, which makes the doctor exit 1. */
export const anyFailed = (sections: ReadonlyArray<Section>): boolean =>
  sections.some((section) => section.findings.some((finding) => finding.level === "fail"))

export const doctor = Effect.fn("cli.doctor")(function* (json: boolean) {
  const print = yield* Print
  const sections = yield* checkSetup({ cliProxyApiPort: yield* cliProxyApiPort })
  if (json) {
    yield* print.out(JSON.stringify(yield* Schema.encodeEffect(Schema.Array(Section))(sections), null, 2))
  } else {
    for (const line of renderDoctor(sections, print.paint)) yield* print.out(line)
  }
  if (anyFailed(sections)) return yield* new ExitWith({ code: 1 })
})
