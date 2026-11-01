// What the bench reads off the processes it runs: memory from /proc (Linux
// only, as the gates run on Linux), how long a daemon takes to answer its
// health check, and plain statistics over repeated runs.
import { Clock, Data, Duration, Effect, FileSystem, Schedule } from "effect"
import { HttpClient } from "effect/http"
import { start } from "./programs.ts"

/** A process's memory, in bytes: resident now, and the most it has been resident. */
export interface Memory {
  readonly rss: number
  readonly peak: number
}

/** Reads `VmRSS` and `VmHWM` out of `/proc/<pid>/status`; a field it lacks reads 0. */
export const parseStatus = (text: string): Memory => {
  const kilobytes = (field: string) => {
    const line = text.split("\n").find((entry) => entry.startsWith(`${field}:`))
    const value = line === undefined ? 0 : Number.parseInt(line.slice(field.length + 1).trim(), 10)
    return Number.isFinite(value) ? value * 1024 : 0
  }
  return { rss: kilobytes("VmRSS"), peak: kilobytes("VmHWM") }
}

/** The memory of process `pid` now. */
export const memoryOf = Effect.fn("Bench.memoryOf")(function* (pid: number) {
  const fs = yield* FileSystem.FileSystem
  return parseStatus(yield* fs.readFileString(`/proc/${pid}/status`))
})

/** The middle value; the mean of the two middle ones for an even count; 0 for none. */
export const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((a, b) => a - b)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  const upper = sorted[middle] ?? 0
  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] ?? 0) + upper) / 2
}

/** A daemon never answered its health check. */
export class NeverHealthy extends Data.TaggedError("NeverHealthy")<{ readonly url: string; readonly after: string }> {
  override get message(): string {
    return `${this.url} did not answer within ${this.after}`
  }
}

/** A health check answered, but not with 200 (yet). */
export class NotHealthy extends Data.TaggedError("NotHealthy")<{ readonly url: string; readonly status: number }> {}

/** Waits until `url` answers 200, asking again at once after each refusal, for up to `within`. */
export const untilHealthy = Effect.fn("Bench.untilHealthy")(function* (
  url: string,
  within: Duration.Input = "20 seconds",
) {
  return yield* HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.void : Effect.fail(new NotHealthy({ url, status: response.status })),
    ),
    Effect.retry(Schedule.forever),
    Effect.timeoutOrElse({
      duration: within,
      orElse: () => Effect.fail(new NeverHealthy({ url, after: Duration.format(Duration.fromInputUnsafe(within)) })),
    }),
  )
})

/** Milliseconds since `since` (from `Clock.currentTimeNanos`). */
export const millisSince = (since: bigint) => Effect.map(Clock.currentTimeNanos, (now) => Number(now - since) / 1e6)

/**
 * How long `argv` takes from being started to answering `/healthz` at
 * `url`, once per run; each run's process is stopped before the next.
 */
export const startupTimes = Effect.fn("Bench.startupTimes")(function* (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  url: string,
  runs: number,
) {
  return yield* Effect.forEach(
    Array.from({ length: runs }, (_, i) => i),
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const began = yield* Clock.currentTimeNanos
          yield* start(argv, env)
          yield* untilHealthy(url)
          // Stopped with the scope, which waits for it to exit before the next run starts.
          return yield* millisSince(began)
        }),
      ),
  )
})
