// `slopmax logs`: the end of the background proxy's log, and with
// `--follow` what it writes from then on. The log can be long, so only its
// last mebibyte is read; following checks its size twice a second, and a
// log that shrank (rotated or truncated) is read again from its start.
import { Home } from "@slopmax/core"
import { Effect, FileSystem, Option, Schedule, Stdio, Stream } from "effect"
import { Print } from "../print.ts"

export interface LogsInput {
  readonly follow: boolean
  readonly lines: number
}

/** How much of the log's end is read for its last lines. */
export const tailBytes = 1024 * 1024

/** How often a followed log is checked for more. */
const followEvery = "500 millis"

/** The last `count` lines of `text`, each ending in a newline. */
export const lastLines = (text: string, count: number): string => {
  if (count <= 0 || text === "") return ""
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
    .slice(-count)
    .map((line) => `${line}\n`)
    .join("")
}

export const logs = Effect.fn("cli.logs")(function* (input: LogsInput) {
  const print = yield* Print
  const fs = yield* FileSystem.FileSystem
  const stdio = yield* Stdio.Stdio
  const path = (yield* Home).paths.log
  const size = fs.stat(path).pipe(
    Effect.map((info) => Option.some(Number(info.size))),
    Effect.orElseSucceed(() => Option.none<number>()),
  )
  const write = (bytes: Stream.Stream<Uint8Array, unknown>) =>
    Stream.run(bytes, stdio.stdout({ endOnDone: false })).pipe(Effect.ignore)

  let found = yield* size
  if (Option.isNone(found)) {
    yield* print.out(`No log yet: ${path} is written once the proxy runs in the background.`)
    if (!input.follow) return
    found = yield* size.pipe(
      Effect.filterOrFail(Option.isSome, () => "missing" as const),
      Effect.retry(Schedule.spaced(followEvery)),
    )
  }
  const length = Option.getOrElse(found, () => 0)
  const start = Math.max(0, length - tailBytes)
  const tail = yield* fs.stream(path, { offset: start, bytesToRead: length - start }).pipe(
    // Bytes that are not UTF-8 read as U+FFFD rather than failing.
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  )
  // A tail cut mid-line starts at the next whole line.
  const whole = start > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail
  const shown = lastLines(whole, input.lines)
  if (shown !== "") yield* write(Stream.make(new TextEncoder().encode(shown)))
  if (!input.follow) return
  let offset = length
  yield* Effect.gen(function* () {
    const now = Option.getOrElse(yield* size, () => 0)
    if (now < offset) offset = 0
    if (now > offset) {
      yield* write(fs.stream(path, { offset, bytesToRead: now - offset }))
      offset = now
    }
  }).pipe(Effect.repeat(Schedule.spaced(followEvery)))
})
