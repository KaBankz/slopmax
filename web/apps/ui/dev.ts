// `bun dev.ts`: the web dashboard over the stub API, for working on the UI
// without a daemon or accounts. It builds the web copy, serves it at
// /slopmax/ and answers /slopmax/api/* from fixtures (changes stick until
// it stops, and each one is pushed on the event stream as the daemon would).
// Run it with `bun --watch dev.ts` to rebuild on every change.
//
//   PORT       where to listen (default 7590; never slopmax's own ports)
//   SCENARIO   `full` (default) or `empty`, a slopmax before any account
//   LATENCY    milliseconds each API answer waits, to see loading states
//   KEY        the owner key the API asks for (default: any key works)
import { Event, LedgerRecord, Usage } from "@slopmax/client"
import { DateTime, Effect, Fiber, Random, Schedule } from "effect"
import { build } from "./build.ts"
import { ownerKey } from "./test/support/fixtures.ts"
import { makeStub } from "./test/support/stub-api.ts"

const port = Number(process.env["PORT"] ?? 7590)
const scenario = process.env["SCENARIO"] === "empty" ? "empty" : "full"
const latency = Number(process.env["LATENCY"] ?? 0)
const outdir = `${import.meta.dir}/dist/dev`

await build({ host: "web", outdir, minify: false, compress: false })
const stub = makeStub({ scenario, latency: `${latency} millis`, key: process.env["KEY"] })

/** A request answered every couple of seconds, so the live feed and the history move. */
const traffic = Effect.gen(function* () {
  if (scenario === "empty") return
  const accounts = stub.report().accounts.filter((account) => account.condition._tag !== "SignInNeeded")
  const account = accounts[yield* Random.nextIntBetween(0, Math.max(0, accounts.length - 1))]
  if (account === undefined) return
  const failed = (yield* Random.next) < 0.08
  const tokens = yield* Random.nextIntBetween(2_000, 90_000)
  const ms = yield* Random.nextIntBetween(900, 24_000)
  stub.publish(
    Event.cases.Request.make({
      record: LedgerRecord.cases.Request.make({
        at: yield* DateTime.now,
        account: account.id,
        provider: account.provider,
        model: account.provider === "codex" ? "gpt-6-codex" : "claude-sonnet-5",
        status: failed ? 529 : 200,
        usage: failed
          ? Usage.zero
          : new Usage({
              requests: 1,
              input: Math.round(tokens * 0.1),
              output: Math.round(tokens * 0.05),
              cacheRead: Math.round(tokens * 0.8),
              cacheWrite: Math.round(tokens * 0.05),
            }),
        ms,
        firstByteMs: Math.min(ms, yield* Random.nextIntBetween(300, 2_400)),
        attempts: (yield* Random.next) < 0.1 ? 2 : 1,
        agent: account.provider === "codex" ? "codex" : "claude-code",
        via: account.provider === "codex" ? "socket" : "http",
      }),
    }),
  )
})
const fiber = Effect.runFork(
  Effect.repeat(
    traffic.pipe(Effect.tapCause((cause) => Effect.logWarning("dev traffic failed", cause))),
    Schedule.spaced("2 seconds"),
  ),
)

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path.startsWith("/slopmax/api/")) return stub.fetch(request)
    if (path === "/" || path === "/slopmax") return Response.redirect("/slopmax/", 302)
    const name = path === "/slopmax/" ? "index.html" : path.replace(/^\/slopmax\//, "")
    const file = Bun.file(`${outdir}/${name}`)
    return file.exists().then((found) => (found ? new Response(file) : new Response("not found", { status: 404 })))
  },
})

console.log(`slopmax UI on http://127.0.0.1:${server.port}/slopmax/#key=${process.env["KEY"] ?? ownerKey}`)

const stop = async () => {
  await Effect.runPromise(Fiber.interrupt(fiber))
  await server.stop(true)
  await stub.dispose()
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
