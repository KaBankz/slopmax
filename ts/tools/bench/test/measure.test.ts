import { describe, expect, test } from "bun:test"
import { Platform } from "@slopmax/core"
import { it } from "@slopmax/test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { median, memoryOf, NeverHealthy, parseStatus, startupTimes, untilHealthy } from "../src/measure.ts"
import { canaryCommand, isCanary, ProgramFailed, run } from "../src/programs.ts"
import { ensureAnswered, NotAnswering, nowhere, probeEnv, sandboxEnv, usablePort } from "../src/workbench.ts"

const services = Layer.merge(Platform.layer, FetchHttpClient.layer)

describe("measuring", () => {
  test("reads resident and peak memory from /proc's status, in bytes", () => {
    const status = "Name:\tslopmax\nVmHWM:\t  153600 kB\nVmRSS:\t   59392 kB\nThreads:\t7\n"
    expect(parseStatus(status)).toEqual({ rss: 59392 * 1024, peak: 153600 * 1024 })
    expect(parseStatus("Name:\tx\n")).toEqual({ rss: 0, peak: 0 })
  })

  test("takes the middle of the runs", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBe(0)
  })

  it.live.skipIf(process.platform !== "linux")("reads a running process's memory", () =>
    Effect.gen(function* () {
      const memory = yield* memoryOf(process.pid)
      expect(memory.rss).toBeGreaterThan(1_000_000)
      expect(memory.peak).toBeGreaterThanOrEqual(memory.rss)
    }).pipe(Effect.provide(services)),
  )

  it.live("waits for a health check to answer 200, asking again after each refusal", () =>
    Effect.gen(function* () {
      let asked = 0
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          asked += 1
          return new Response(null, { status: asked < 3 ? 503 : 200 })
        },
      })
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop(true)))
      yield* untilHealthy(`http://127.0.0.1:${server.port}/healthz`)
      expect(asked).toBe(3)
    }).pipe(Effect.provide(services)),
  )

  it.live("gives up on a health check that never answers", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(untilHealthy("http://127.0.0.1:9/healthz", "200 millis"))
      expect(error).toBeInstanceOf(NeverHealthy)
    }).pipe(Effect.provide(services)),
  )

  it.live(
    "times a program from its start to its first healthy answer, once per run",
    () =>
      Effect.gen(function* () {
        const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
        const port = listener.port
        listener.stop(true)
        const script = `Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ok") })`
        const times = yield* startupTimes(
          [process.execPath, "-e", script],
          { PATH: "/usr/bin:/bin" },
          `http://127.0.0.1:${port}/healthz`,
          2,
        )
        expect(times).toHaveLength(2)
        for (const time of times) expect(time).toBeGreaterThan(0)
      }).pipe(Effect.provide(services)),
    20_000,
  )
})

describe("running programs", () => {
  test("compile with this Bun when it is canary, else with canary through mise", () => {
    expect(isCanary("v1.4.4-canary.1 (da867c60b)")).toBe(true)
    expect(canaryCommand("v1.4.4-canary.1 (da867c60b)", "/bun")).toEqual(["/bun"])
    expect(canaryCommand("v1.4.4 (38afee6c)", "/bun")).toEqual([
      "mise",
      "exec",
      "github:oven-sh/bun@canary",
      "--",
      "bun",
    ])
  })

  it.live("gives what a program printed, and fails with its code and last words when it fails", () =>
    Effect.gen(function* () {
      expect(yield* run(["sh", "-c", "echo hello"])).toBe("hello\n")
      expect(yield* run(["sh", "-c", 'printf "%s" "$ONLY"'], { env: { ONLY: "this" } })).toBe("this")
      const error = yield* Effect.flip(run(["sh", "-c", "echo broke >&2; exit 3"]))
      expect(error).toBeInstanceOf(ProgramFailed)
      expect(error.message).toBe("sh -c echo broke >&2; exit 3 failed (exit 3): broke")
    }).pipe(Effect.provide(services)),
  )
})

describe("the processes under test", () => {
  test("see their home and address, and every way out to the internet sent to a dead proxy", () => {
    const env = sandboxEnv({ HOME: "/h", SLOPMAX_HOME: "/h/.slopmax" }, "127.0.0.1:9101")
    expect(env).toMatchObject({ HOME: "/h", SLOPMAX_LISTEN: "127.0.0.1:9101", SLOPMAX_NO_SERVICE: "1" })
    expect([env["HTTPS_PROXY"], env["HTTP_PROXY"], env["ALL_PROXY"]]).toEqual([nowhere, nowhere, nowhere])
  })

  test("leave the raw probe with no proxy, which Bun's fetch would use even for the mock on loopback", () => {
    expect(Object.keys(probeEnv({ HOME: "/h" })).filter((name) => name.toUpperCase().includes("PROXY"))).toEqual([])
  })

  it.live("count a load's figures only when nearly every request was answered 200", () =>
    Effect.gen(function* () {
      yield* ensureAnswered("raw probe", 1)
      const error = yield* Effect.flip(ensureAnswered("raw probe", 0))
      expect(error).toBeInstanceOf(NotAnswering)
      expect(error.message).toBe(
        "the raw probe answered only 0.0% of requests with 200, so its figures would measure failures",
      )
    }),
  )

  test("never use CLIProxyAPI's port", () => {
    expect(usablePort(8317)).toBe(false)
    expect(usablePort(9201)).toBe(true)
  })
})
