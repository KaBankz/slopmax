// Window warmup (opt-in, `warm_windows`): ChatGPT starts an account's
// 5-hour window at its first request, so an account left idle after a
// reset gets its next reset late. One tiny request on an idle account
// starts the window early, and its reset comes sooner when the account is
// needed. Only ChatGPT accounts are warmed; slopmax never sends traffic of
// its own to Claude subscriptions.
import { Clock, Effect } from "effect"

import { log, Timestamp } from "@slopmax/common"
import { client as net } from "@slopmax/net"
import { ir, translate } from "@slopmax/wire"

import type { Account } from "../account.ts"
import { Window } from "../limits.ts"
import { AccountState } from "../pool.ts"
import { ProviderId } from "../provider/mod.ts"
import { USER_AGENT } from "../version.ts"
import { insert } from "./headers.ts"
import { type App, entry } from "./app.ts"
import { events } from "./transcode.ts"

/** At most one warmup per account per window, in milliseconds. */
const COOLDOWN = 5 * 3600 * 1000

/** Warms every idle ChatGPT account, using the model Codex last used. */
export const idleAccounts = Effect.fn("warm.idleAccounts")(function* (app: App) {
  const model = app.lastCodexModel()
  if (model === undefined) return
  const now = yield* Timestamp.now
  const idle: Array<Account> = []
  for (const a of yield* app.pool.accounts) {
    if (a.provider !== "codex" || a.disabled || a.authError !== undefined) continue
    const state = yield* app.pool.state(a.id)
    const fiveHours = state.limits.windows.find((w) => w.span === "5h" && w.model === undefined)
    if (!AccountState.isBlocked(state, now) && fiveHours !== undefined && Window.usedAt(fiveHours, now) === 0) {
      idle.push(a)
    }
  }
  for (const account of idle) {
    const at = yield* Clock.currentTimeMillis
    const warmed = app.warmed.get(account.id)
    if (warmed !== undefined && at - warmed < COOLDOWN) continue
    app.warmed.set(account.id, at)
    const result = yield* Effect.result(warm(app, account, model))
    if (result._tag === "Success") log.info(`${account.id}: started its 5-hour window early`)
    else log.warn(`${account.id}: warmup failed: ${result.failure}`)
  }
})

/** One tiny request on `account`. */
const warm = Effect.fn("warm.warm")(function* (
  app: App,
  picked: Account,
  model: string,
): Effect.fn.Return<void, string> {
  const account = yield* app.ready(picked)
  if (account === undefined) return yield* Effect.fail("its sign-in could not be refreshed")
  const provider = ProviderId.get(account.provider)
  const own = new Headers()
  insert(own, "content-type", "application/json")
  insert(own, "accept", "text/event-stream")
  insert(own, "user-agent", USER_AGENT)
  const body = {
    model,
    instructions: "Reply with OK.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    store: false,
    stream: true,
  }
  const started = yield* Clock.currentTimeMillis
  const response = yield* app.http
    .post(`${provider.api(account)}/responses`)
    .headers(provider.headers(own, account, false))
    .json(body)
    .send()
    .pipe(Effect.mapError((e) => e.message))
  const now = yield* Timestamp.now
  const limits = provider.limits(response.headers, now)
  if (limits !== undefined) yield* app.pool.observe(account.id, limits, now)
  const status = response.status
  const bytes = yield* response.bytes().pipe(Effect.mapError((e) => e.message))
  if (status < 200 || status >= 300) return yield* Effect.fail(`answered ${net.statusText(status)}`)
  const decoder = translate.Decoder.make("responses", ir.Request.make())
  const usage = ir.Answer.collect(events(decoder, false, bytes, () => {})).usage
  yield* app.pool.addUsage(account.id, usage)
  app.record(
    entry({
      at: now,
      account: account.id,
      provider: "codex",
      model,
      status,
      usage: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
      },
      ms: (yield* Clock.currentTimeMillis) - started,
      firstByteMs: undefined,
      attempts: 1,
      agent: "slopmax",
      session: undefined,
    }),
  )
})
