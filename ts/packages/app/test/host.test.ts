// The host end to end, in-process: requests piped into its stdin, events
// read from its stdout, the app in a home of its own, and (for most tests)
// the real proxy running on a free local port.
import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { type Cause, Effect, Exit, Fiber, Queue, Sink, Stdio, Stream } from "effect"

import { Account, fsx, pool, Store, Tokens, VERSION } from "@slopmax/core"

import { runHost } from "../src/host.ts"
import * as protocol from "../src/protocol.ts"
import { KEY, sandbox, type Sandbox } from "./support/sandbox.ts"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface Shell {
  /** Writes a request line to the host's stdin. */
  readonly ask: (id: number, action: protocol.Action) => Effect.Effect<void>
  /** Writes any line. */
  readonly write: (line: string) => Effect.Effect<void>
  /** The next event that `wanted` accepts, skipping the rest; fails after 10 s. */
  readonly next: <E extends protocol.Event>(wanted: (e: protocol.Event) => e is E) => Effect.Effect<E>
  /** Every event read so far. */
  readonly seen: Array<protocol.Event>
  /** Closes the host's stdin. */
  readonly close: Effect.Effect<void>
  readonly host: Fiber.Fiber<void, unknown>
}

const is =
  <T extends protocol.Event["_tag"]>(tag: T) =>
  (e: protocol.Event): e is Extract<protocol.Event, { readonly _tag: T }> =>
    e._tag === tag

const viewWhere =
  (wanted: (v: protocol.View) => boolean) =>
  (e: protocol.Event): e is Extract<protocol.Event, { readonly _tag: "View" }> =>
    e._tag === "View" && wanted(e.view)

const shell = (box: Sandbox, stdin: "piped" | "never" = "piped") =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const events = yield* Queue.unbounded<protocol.Event>()
    const seen: Array<protocol.Event> = []
    let partial = ""
    const stdout = Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        partial += typeof chunk === "string" ? chunk : decoder.decode(chunk)
        const lines = partial.split("\n")
        partial = lines.pop() ?? ""
        for (const line of lines) {
          const event = protocol.decodeEvent(line)
          if (event._tag === "Failure") throw new Error(`not an event: ${line}: ${event.failure}`)
          seen.push(event.success)
          Queue.offerUnsafe(events, event.success)
        }
      }),
    )
    const stdio = Stdio.layerTest({
      stdin: stdin === "never" ? Stream.never : Stream.fromQueue(input),
      stdout: () => stdout,
    })
    const host = yield* runHost({ notify: true, cli: Effect.succeed(undefined) }).pipe(
      Effect.provide(stdio),
      Effect.provide(box.env),
      Effect.forkChild,
    )
    const write = (line: string) => Effect.asVoid(Queue.offer(input, encoder.encode(`${line}\n`)))
    const next = <E extends protocol.Event>(wanted: (e: protocol.Event) => e is E): Effect.Effect<E> =>
      Effect.gen(function* () {
        for (;;) {
          const event = yield* Queue.take(events)
          if (wanted(event)) return event
        }
      }).pipe(Effect.timeout("10 seconds"), Effect.orDie)
    const shellOf: Shell = {
      ask: (id, action) => write(protocol.encodeRequest({ id, action })),
      write,
      next,
      seen,
      close: Effect.asVoid(Queue.end(input)),
      host,
    }
    return shellOf
  })

describe("host", () => {
  it.live(
    "it says hello, draws the app, answers each request, and stops when stdin closes",
    () =>
      Effect.gen(function* () {
        const box = yield* sandbox({ serve: true })
        const sh = yield* shell(box)
        const hello = yield* sh.next(is("Hello"))
        expect(hello).toEqual({ _tag: "Hello", protocol: protocol.VERSION, version: VERSION })
        expect(sh.seen[0]?._tag).toBe("Hello")

        // The proxy answers, so the view says it runs, with nothing wrong.
        const running = yield* sh.next(viewWhere((v) => v.proxy.running && v.loaded && v.agents.length === 2))
        expect(running.view.proxy.foot).toEqual({ text: `Running ${running.view.proxy.version}`, tone: "good" })
        expect(running.view.proxy.toggle).toEqual({ label: "Stop", primary: false, action: { _tag: "StopProxy" } })
        expect(running.view.status?.headline).toBe("No accounts yet")
        expect(running.view.menuBar).toBe("slopmax")
        expect(running.view.canRefresh).toBe(true)
        expect(running.view.agents.map((a) => a.button.label)).toEqual(["Connect", "Connect"])
        expect(running.view.login).toEqual({
          on: false,
          available: false,
          detail: "This system has no login service slopmax can use, so the app starts the proxy while it runs.",
          action: { _tag: "InstallService" },
        })
        expect(running.view.settings.strategies.map((s) => [s.title, s.chosen])).toEqual([
          ["Reset first", true],
          ["Fill first", false],
          ["Least used", false],
          ["Round robin", false],
        ])
        expect(running.view.settings.sessionTtl).toMatchObject({ value: 60, text: "1 h", down: 30, up: 120 })
        expect(running.view.settings.poll).toMatchObject({ value: 5, text: "5 min", down: 2, up: 10 })

        // A setting: written, applied, worded, and done.
        const choose = running.view.settings.strategies[3]?.action
        if (choose === undefined) throw new Error("no strategy")
        yield* sh.ask(1, choose)
        const chosen = yield* sh.next(viewWhere((v) => v.notice !== undefined))
        expect(chosen.view.notice).toEqual({ text: "slopmax now routes round robin.", error: false })
        expect(chosen.view.routing).toBe("Round robin · sessions keep their account")
        // Done once the proxy has synced.
        yield* sh.next((e): e is Extract<protocol.Event, { _tag: "Done" }> => e._tag === "Done" && e.id === 1)
        expect(chosen.view.settings.strategies[3]?.chosen).toBe(true)
        expect(readFileSync(join(box.home, "config.toml"), "utf8")).toContain('strategy = "round-robin"')

        // A key made shows once, until dismissed.
        yield* sh.ask(2, { _tag: "AddClientKey", name: "laptop", models: [] })
        const made = yield* sh.next(viewWhere((v) => v.newKey !== undefined))
        expect(made.view.newKey?.name).toBe("laptop")
        expect(made.view.keys).toEqual([{ name: "laptop", models: "Any model" }])
        yield* sh.ask(3, { _tag: "DismissNewKey" })
        yield* sh.next(viewWhere((v) => v.newKey === undefined && v.keys.length === 1))

        // Today's ledger, read for the overview.
        yield* sh.ask(4, { _tag: "LoadToday" })
        const today = yield* sh.next(viewWhere((v) => v.today !== undefined))
        expect(today.view.today?.range).toBe("today")
        expect(today.view.today?.left).toBe("No weekly window reset in this range")

        // The setup checks.
        yield* sh.ask(5, { _tag: "CheckSetup" })
        const checked = yield* sh.next(viewWhere((v) => v.doctor.state === "done"))
        expect(checked.view.doctor.canCheck).toBe(true)
        expect(checked.view.doctor.findings.length).toBeGreaterThan(0)
        expect(checked.view.doctor.findings[0]?.section).toBeDefined()

        // A window shows: answered at once.
        yield* sh.ask(6, { _tag: "Window", shown: true })
        yield* sh.next((e): e is Extract<protocol.Event, { _tag: "Done" }> => e._tag === "Done" && e.id === 6)

        // What it cannot read, it says so, and goes on.
        yield* sh.write("not json")
        expect((yield* sh.next(is("Rejected"))).error.length).toBeGreaterThan(0)
        yield* sh.write(JSON.stringify({ id: 7, action: { _tag: "Explode" } }))
        yield* sh.next(is("Rejected"))
        yield* sh.ask(8, { _tag: "DismissNotice" })
        yield* sh.next((e): e is Extract<protocol.Event, { _tag: "Done" }> => e._tag === "Done" && e.id === 8)

        // Stdin closes: the host stops cleanly, and the proxy still answers.
        yield* sh.close
        const exit = yield* Fiber.await(sh.host).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        expect(Exit.isSuccess(exit)).toBe(true)
        expect(sh.seen.filter((e) => e._tag === "Hello").length).toBe(1)
        expect(sh.seen.some((e) => e._tag === "Fatal")).toBe(false)
      }),
    30_000,
  )

  it.live(
    "a config that does not load is fatal, after saying so",
    () =>
      Effect.gen(function* () {
        const box = yield* sandbox({ serve: false, config: `api_key = "${KEY}"\nstrategy = 3\n` })
        const sh = yield* shell(box)
        yield* sh.next(is("Hello"))
        const fatal = yield* sh.next(is("Fatal"))
        expect(fatal.message.startsWith("invalid config ")).toBe(true)
        const exit = yield* Fiber.await(sh.host).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    30_000,
  )

  it.live(
    "without a proxy, it says it could not start one, and a nudge becomes a notification once",
    () =>
      Effect.gen(function* () {
        const box = yield* sandbox({
          serve: false,
          config: `api_key = "${KEY}"\nredeem_expiring_credits = false\n`,
        })
        // A ChatGPT account whose limit reset lapses within the day.
        const now = Date.now()
        const store = Store.at(join(box.home, "accounts"))
        const [account] = yield* store
          .upsert(Account.assignId({ ...Account.make("codex", Tokens.empty(), now), email: "c@x.dev", accountId: "c" }))
          .pipe(Effect.orDie)
        const state: pool.AccountState = {
          ...pool.AccountState.empty(),
          credits: { credits: [{ id: "soon", expiresAt: now + 3_600_000 }], listedAt: now },
        }
        yield* fsx
          .writeJson(join(box.home, "state.json"), pool.StateSchema, {
            ...pool.State.empty(),
            accounts: { [account.id]: state },
          })
          .pipe(Effect.orDie)

        const sh = yield* shell(box)
        const stopped = yield* sh.next(viewWhere((v) => v.proxy.state === "stopped" && v.notice !== undefined))
        expect(stopped.view.notice).toEqual({
          text: "Could not start the proxy: cannot find the slopmax command line, which the app runs the proxy with; reinstall the app",
          error: true,
        })
        expect(stopped.view.proxy.toggle).toEqual({ label: "Start", primary: true, action: { _tag: "StartProxy" } })
        expect(stopped.view.proxy.panel).toEqual({ text: "The proxy is stopped", tone: "bad" })

        const told = yield* sh.next(is("Notify"))
        expect(told.key).toBe(`reset:${account.id}:soon`)
        expect(told.title).toBe("Limit reset expiring")
        expect(told.body.startsWith("A limit reset on c@x.dev expires in ")).toBe(true)
        expect(told.body.includes("`")).toBe(false)

        // Its account's row offers the reset, which needs the proxy.
        const drawn = yield* sh.next(viewWhere((v) => v.groups.length === 1))
        const row = drawn.view.groups[0]?.accounts[0]
        expect(row?.credits).toMatchObject({ title: "1 limit reset", canRedeem: false, reason: "Nothing to reset yet" })
        expect(row?.menu.map((m) => (m._tag === "Choice" ? m.key : m._tag))).toEqual([
          "pin",
          "toggle",
          "Separator",
          "Caption",
          "raise",
          "lower",
          "Separator",
          "redeem",
        ])
        expect(drawn.view.attention.map((a) => [a.remedy, a.button])).toEqual([["Redeem", "Redeem…"]])
        expect(drawn.view.providers).toEqual([{ provider: "codex", title: "ChatGPT", count: 1, dot: "warn" }])

        yield* sh.close
        yield* Fiber.await(sh.host).pipe(Effect.timeout("10 seconds"), Effect.orDie)
        // Told once: the next run keeps it as told.
        expect(sh.seen.filter((e) => e._tag === "Notify").length).toBe(1)
        expect(readFileSync(join(box.home, "desktop-notified"), "utf8")).toContain(`reset:${account.id}:soon\t`)
      }),
    30_000,
  )

  it.live(
    "an interrupted host stops the app's work",
    () =>
      Effect.gen(function* () {
        // Something on the proxy's address that counts the app's looks.
        let looks = 0
        const counter = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch: (request) => {
                // Only the app's: other programs on this machine may probe the port.
                const path = new URL(request.url).pathname
                if (path === "/healthz" || path.startsWith("/slopmax/")) looks++
                return new Response("not slopmax", { status: 503 })
              },
            }),
          ),
          (server) => Effect.promise(() => server.stop(true)),
        )
        const port = counter.port
        if (port === undefined) throw new Error("no port")
        const box = yield* sandbox({ serve: false, port })
        const sh = yield* shell(box, "never")
        yield* sh.next(viewWhere((v) => v.loaded))
        yield* Effect.repeat(Effect.sleep("50 millis"), { until: () => looks > 0 })
        yield* Fiber.interrupt(sh.host)
        // A look already sent may still land.
        yield* Effect.sleep("500 millis")
        const before = looks
        // Past two of the watcher's rounds.
        yield* Effect.sleep("4500 millis")
        expect(looks).toBe(before)
      }),
    30_000,
  )
})
