import { describe, expect } from "bun:test"
import {
  type Account,
  Accounts,
  accountText,
  Background,
  Events,
  Home,
  Ledger,
  Lock,
  Pool,
  Quota,
  SettingsService,
  Upstream,
} from "@slopmax/core"
import type { RedeemOutcome } from "@slopmax/domain"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Effect, Layer, Option, References } from "effect"
import { FetchHttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { redeem } from "../src/commands/accounts.ts"
import { paint, Print } from "../src/print.ts"
import { make, Prompter } from "../src/terminal.ts"
import { subscription } from "./sandbox.ts"
import { pipedTerminal } from "./support.ts"

const home = "/home/me/.slopmax"

/** The sign-in is not refreshed here (nothing answers for that), which the engine warns about. */
const quiet = Layer.succeed(References.MinimumLogLevel)("Error")

const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

/** The ChatGPT backend's limit resets for one account: one expiring within the hour, one in two days. */
const chatgpt = (outcome: string) => {
  const redeemed: Array<unknown> = []
  const handle = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname === "/backend-api/wham/rate-limit-reset-credits") {
      return Response.json({
        credits: [
          { id: "credit-later", status: "available", reset_type: "codex_rate_limits", expires_at: inHours(48) },
          { id: "credit-soon", status: "available", reset_type: "codex_rate_limits", expires_at: inHours(1) },
          { id: "credit-spent", status: "redeemed", reset_type: "codex_rate_limits", expires_at: inHours(2) },
        ],
      })
    }
    if (request.method === "POST" && pathname === "/backend-api/wham/rate-limit-reset-credits/consume") {
      redeemed.push(await request.json())
      return Response.json({ code: outcome })
    }
    return Response.json({}, { status: 404 })
  }
  return { redeemed, layer: Upstream.layerHandler(handle) }
}

/**
 * `redeem` over the engine with no proxy running: an account store on an
 * in-memory disk, the ChatGPT backend answered in process, `answers` on
 * stdin, and what it prints kept in `out`.
 */
const redeemWith = (account: Account, upstream: Layer.Layer<Upstream>, answers: ReadonlyArray<string>) => {
  const out: Array<string> = []
  const print = Layer.succeed(Print)({
    paint: paint(false),
    out: (line = "") => Effect.sync(() => void out.push(line)),
    err: () => Effect.void,
  })
  const terminal = pipedTerminal(answers)
  const store = Accounts.layer.pipe(
    Layer.provideMerge(Lock.layerMemory),
    Layer.provideMerge(Home.layerAt(home)),
    Layer.provideMerge(
      MemoryFileSystem.layerWith({ files: { [`${home}/accounts/${account.id}.json`]: accountText(account) } }),
    ),
    Layer.provideMerge(upstream),
    Layer.provideMerge(SettingsService.layerValue({ listen: "127.0.0.1:9" })),
  )
  const engine = Layer.mergeAll(Quota.layer, Background.layer).pipe(
    Layer.provideMerge(Pool.layerMemory()),
    Layer.provideMerge(Ledger.layer),
    Layer.provideMerge(Events.layer),
    Layer.provideMerge(store),
    // No proxy answers and no program runs.
    Layer.provideMerge(
      Layer.succeed(FetchHttpClient.Fetch)(
        Object.assign(() => Promise.reject(new Error("no network in tests")), { preconnect: () => undefined }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
        ChildProcessSpawner.make(() => Effect.die("no programs run in tests")),
      ),
    ),
  )
  const prompter = Layer.effect(Prompter, make(false)).pipe(Layer.provide(terminal.layer))
  return {
    out,
    shown: terminal.shown,
    run: (input: { readonly reset?: string; readonly yes?: boolean } = {}) =>
      redeem({ account: "b@x.dev", reset: Option.fromUndefinedOr(input.reset), yes: input.yes ?? false }).pipe(
        Effect.provide(Layer.mergeAll(print, prompter, engine, quiet)),
      ),
  }
}

describe("redeem", () => {
  it.live("lists the resets, asks, and redeems the one expiring soonest", () =>
    Effect.gen(function* () {
      const backend = chatgpt("reset")
      const command = redeemWith(yield* subscription("codex", "b@x.dev", "pro"), backend.layer, ["y"])
      yield* command.run()
      expect(command.out[0]).toMatch(/^b@x\.dev has 2 limit resets; the next expires in (59m|1h)/)
      expect(command.shown[0]).toBe("Reset its usage windows now? [y/N] ")
      expect(backend.redeemed).toMatchObject([{ credit_id: "credit-soon" }])
      expect(command.out.at(-1)).toBe("Reset the usage windows on b@x.dev.")
    }),
  )

  it.live("redeems nothing when the question is answered no, or nobody answers", () =>
    Effect.gen(function* () {
      const account = yield* subscription("codex", "b@x.dev", "pro")
      for (const answers of [["n"], []]) {
        const backend = chatgpt("reset")
        const command = redeemWith(account, backend.layer, answers)
        yield* command.run()
        expect(backend.redeemed).toEqual([])
        expect(command.out.length).toBe(1)
      }
    }),
  )

  it.live("redeems the reset named, saying when that one expires", () =>
    Effect.gen(function* () {
      const backend = chatgpt("reset")
      const command = redeemWith(yield* subscription("codex", "b@x.dev", "pro"), backend.layer, [])
      yield* command.run({ reset: "credit-later", yes: true })
      expect(command.out[0]).toMatch(/"credit-later" expires in (1d23h|2d)/)
      expect(backend.redeemed).toMatchObject([{ credit_id: "credit-later" }])
      const unknown = yield* Effect.flip(command.run({ reset: "credit-gone", yes: true }))
      expect(unknown.message).toContain('holds no limit reset "credit-gone"')
    }),
  )

  it.live("says what each outcome came to", () =>
    Effect.gen(function* () {
      const said: Record<string, RedeemOutcome> = {
        "Nothing to reset yet; the limit reset was kept.": "nothing-to-reset",
        "No limit reset was available.": "no-credit",
        "That limit reset was already used.": "already-redeemed",
        "ChatGPT would not use one right now, so it was kept.": "declined",
      }
      const codes: Record<RedeemOutcome, string> = {
        reset: "reset",
        "nothing-to-reset": "nothing_to_reset",
        "no-credit": "no_credit",
        "already-redeemed": "already_redeemed",
        declined: "declined",
      }
      const account = yield* subscription("codex", "b@x.dev", "pro")
      for (const [line, outcome] of Object.entries(said)) {
        const command = redeemWith(account, chatgpt(codes[outcome]).layer, [])
        yield* command.run({ yes: true })
        expect(command.out.at(-1)).toBe(line)
      }
    }),
  )
})
