// slopmax's own API under `/slopmax/`: status, usage, a live feed of
// answered requests, account actions, and the dashboard that uses them.
// Account actions call the same functions as the CLI, so both behave
// alike.
//
// Everything but the dashboard page itself needs the slopmax key. The page
// carries no data; it reads the key from its URL fragment (`#key=…`),
// which browsers never send to the server.
import { Cause, Deferred, Duration, Effect, Option, PubSub, Result, Schema, Stream } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"

import { log, text, Timestamp } from "@slopmax/common"
import { body as bodies, form as forms } from "@slopmax/net"

import { Account, type Endpoint, forget, pin, unpinAll, without } from "../account.ts"
import { connect } from "../auth/connect.ts"
import { LoginOptions, Prompt } from "../auth/mod.ts"
import { Config, liveValue, Strategy } from "../config.ts"
import * as doctor from "../doctor.ts"
import { chain, type Failure } from "../error.ts"
import * as history from "../history.ts"
import { listCredits, pollAll } from "../polls.ts"
import { ProviderId, Spec } from "../provider/mod.ts"
import { ReportSchema } from "../report.ts"
import * as summary from "../summary.ts"
import type * as toml from "../toml.ts"
import { type App, authorized, bodyOf, error, headersOf, splitUrl } from "./app.ts"
import DASHBOARD_PAGE from "./dashboard.html" with { type: "text" }

const utf8 = new TextEncoder()
/** `String::from_utf8_lossy`, which keeps a leading BOM. */
const fromUtf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })

/**
 * The page, as Rust's `include_str!` carries it in the binary, encoded
 * once rather than on every load. (A text import is a string; Bun's types
 * declare every `.html` import an `HTMLBundle`, hence `String`.)
 */
const DASHBOARD = utf8.encode(String(DASHBOARD_PAGE))
/** How often an idle feed says it is still there. */
const KEEPALIVE = Duration.seconds(15)
/** The most a form body may hold. */
const MAX_FORM = 64 * 1024

const encodeReport = Schema.encodeSync(ReportSchema)
const encodeHistory = Schema.encodeSync(history.HistorySchema)

type Response = HttpServerResponse.HttpServerResponse
type Request = HttpServerRequest.HttpServerRequest
type Form = ReadonlyArray<readonly [string, string]>

/** A JSON answer of an encoded value (Schema output, raw numbers and all). */
const reply = (status: number, value: unknown): Response =>
  HttpServerResponse.uint8Array(utf8.encode(JSON.stringify(value)), { status, contentType: "application/json" })

const fail = (status: number, message: string): Response => error(undefined, status, message)

/** Answers a request under `/slopmax/`. */
export const handle = Effect.fn("admin.handle")(function* (app: App, request: Request): Effect.fn.Return<Response> {
  const method = request.method
  const [path, query] = splitUrl(request.url)
  if (method === "GET" && path === "/slopmax/dashboard") return dashboard()
  if (!authorized(yield* app.config, headersOf(request))) {
    return fail(401, "missing or invalid slopmax key; see `slopmax env`")
  }
  let rest = path
  // `trim_start_matches`: the prefix, as often as it repeats.
  while (rest.startsWith("/slopmax/")) rest = rest.slice("/slopmax/".length)
  const segments = rest.split("/")
  const [first, second, third] = segments
  const route = `${method} ${segments.length === 1 ? first : segments.length === 2 ? `${first}/${second}` : ""}`
  switch (route) {
    case "GET status":
      return yield* report(app)
    // Polls every account's usage and lists its reset credits now, then
    // reports.
    case "POST refresh":
      yield* pollAll(app, true)
      yield* listCredits(app, true)
      return yield* report(app)
    // Picks up changes on disk now, config.toml's too, then reports.
    case "POST sync":
      yield* app.reloadConfig
      return yield* reload(app, Effect.void)
    case "POST shutdown":
      yield* Deferred.succeed(app.shutdown, undefined)
      return reply(200, { status: "stopping" })
    case "GET usage":
      return yield* usage(app, query)
    case "GET history":
      return yield* historyOf(app, query)
    case "GET settings":
      return reply(200, settings(yield* app.config))
    case "POST settings": {
      const read = yield* readBody(request)
      if (Result.isFailure(read)) return fail(400, read.failure)
      // The fields come in the query, the form body, or both.
      return yield* changeSettings(app, `${query}&${fromUtf8.decode(read.success)}`)
    }
    case "GET events":
      return events(app)
    case "POST use/auto":
      return yield* reload(app, unpinAll(app.home))
    // Adds an API key or a compatible endpoint; subscriptions sign in
    // with a browser, through the CLI or the app.
    case "POST accounts": {
      const read = yield* readForm(request, query)
      if (Result.isFailure(read)) return fail(400, read.failure)
      return yield* addAccount(app, read.success)
    }
    case "GET keys":
      return reply(200, keys(yield* app.config))
    case "POST keys": {
      const read = yield* readForm(request, query)
      if (Result.isFailure(read)) return fail(400, read.failure)
      return yield* addKey(app, read.success)
    }
    case "GET doctor": {
      const checked = yield* Effect.result(doctor.check(yield* app.config, app.store))
      if (Result.isFailure(checked)) return fail(500, chain(checked.failure))
      return reply(200, doctor.Section.json(checked.success))
    }
  }
  if (method === "POST" && segments.length === 3 && first === "accounts" && second !== undefined) {
    return yield* account(app, second, third ?? "", query)
  }
  if (method === "POST" && segments.length === 3 && first === "keys" && third === "remove" && second !== undefined) {
    return yield* removeKey(app, forms.percentDecode(second))
  }
  return fail(404, "no such slopmax endpoint")
})

const dashboard = (): Response =>
  HttpServerResponse.uint8Array(DASHBOARD, {
    contentType: "text/html; charset=utf-8",
    headers: {
      // The page loads nothing from elsewhere, and nothing may frame it.
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src data:; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    },
  })

const report = (app: App): Effect.Effect<Response> => Effect.map(app.report, (r) => reply(200, encodeReport(r)))

/** Accounts by id, with the names people know them by. */
const names = (app: App): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.map(app.pool.accounts, (accounts) => new Map(accounts.map((a) => [a.id, Account.name(a)] as const)))

/** The first value of `name` in a query, if any. */
const param = (query: string, name: string): string | undefined => forms.decode(query).find(([k]) => k === name)?.[1]

/** `?range=7d&by=day` → a usage summary. */
const usage = Effect.fn("admin.usage")(function* (app: App, query: string) {
  const range = param(query, "range") ?? "7d"
  const by = param(query, "by") ?? "day"
  const since = summary.since(range, yield* Timestamp.now)
  if (since === undefined) return fail(400, "range is today, 7d, 30d, or all")
  if (!summary.GROUPS.includes(by)) return fail(400, "by is day, model, or account")
  const config = yield* app.config
  const built = yield* summary.build(app.home.usage(), since, by, config.prices, yield* names(app))
  return HttpServerResponse.text(summary.Summary.json(built), { status: 200, contentType: "application/json" })
})

/**
 * `?range=today|7d|30d` → what went through slopmax over the range, as
 * the desktop app charts it.
 */
const historyOf = Effect.fn("admin.history")(function* (app: App, query: string) {
  const range = history.Range.parse(param(query, "range") ?? "7d")
  if (range === undefined) return fail(400, "range is today, 7d, or 30d")
  const config = yield* app.config
  // Reading a month of the ledger takes a moment. Rust reads it on a
  // blocking thread; here only the file reads yield to other requests, and
  // parsing and bucketing run on the one event loop (see PORT.md).
  const loaded = yield* Effect.exit(
    history.load(app.home, range, yield* Timestamp.now, history.Prices.of(config), yield* names(app)),
  )
  if (loaded._tag === "Failure") return fail(500, chain(Cause.squash(loaded.cause)))
  return reply(200, encodeHistory(loaded.value))
})

/** A request's body, up to 64 KiB, or why it could not be read. */
const readBody = (request: Request): Effect.Effect<Result.Result<Uint8Array, string>> =>
  Effect.result(Effect.mapError(bodies.read(bodyOf(request), MAX_FORM), (e) => e.message))

/** The form fields of a POST, from its query and its body. */
const readForm = (request: Request, query: string): Effect.Effect<Result.Result<Form, string>> =>
  Effect.map(
    readBody(request),
    Result.map((bytes) => forms.decode(`${query}&${fromUtf8.decode(bytes)}`)),
  )

/** The first field named `name`, trimmed; empty means absent. */
const field = (form: Form, name: string): string | undefined => {
  const value = form.find(([k]) => k === name)?.[1]
  if (value === undefined) return undefined
  const trimmed = text.trim(value)
  return trimmed === "" ? undefined : trimmed
}

/** A comma-separated list, each trimmed, empties dropped. */
const list = (value: string | undefined): Array<string> =>
  (value ?? "")
    .split(",")
    .map(text.trim)
    .filter((m) => m !== "")

/**
 * `POST /slopmax/accounts` with `provider` (`anthropic`, `openai`, `xai`,
 * or `compat`), `key`, and for `compat` its `url`, `dialect`, and
 * `models`; `label` names it. The key is checked before it is saved.
 */
const addAccount = Effect.fn("admin.addAccount")(function* (app: App, form: Form) {
  const named = field(form, "provider")
  const parsed = named === undefined ? undefined : ProviderId.parse(named)
  if (parsed === undefined || Result.isFailure(parsed)) {
    return fail(400, "provider is anthropic, openai, xai, or compat")
  }
  const provider = parsed.success
  const spec = ProviderId.spec(provider)
  if (Spec.isSubscription(spec)) {
    return fail(400, `${spec.title} accounts sign in with a browser: \`slopmax login ${provider}\`, or the app`)
  }
  let endpoint: Endpoint | undefined
  if (provider === "compat") {
    const url = field(form, "url")
    if (url === undefined) return fail(400, "a compatible endpoint needs its url")
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return fail(400, "url is an http:// or https:// base URL")
    }
    const dialect = field(form, "dialect") ?? "chat"
    if (dialect !== "chat" && dialect !== "responses" && dialect !== "messages") {
      return fail(400, "dialect is chat, responses, or messages")
    }
    endpoint = { baseUrl: url.replace(/\/+$/, ""), dialect, models: list(field(form, "models")) }
  }
  const options: LoginOptions = {
    ...LoginOptions.default(),
    ...(endpoint === undefined ? {} : { endpoint }),
    key: field(form, "key") ?? "",
  }
  // A key needs no one to answer anything.
  const prompt = Prompt.make(() => {})
  const connected = yield* Effect.result(connect(app.store, provider, field(form, "label"), options, prompt))
  if (Result.isFailure(connected)) return fail(400, chain(connected.failure))
  return yield* reload(app, Effect.void)
})

/**
 * The client keys, by name and the models each may use; the keys
 * themselves are shown once, when made.
 */
const keys = (config: Config) => ({ keys: config.keys.map((k) => ({ name: k.name, models: k.models })) })

/**
 * `POST /slopmax/keys` with `name` and, to hold it to some, `models`
 * (patterns, comma-separated): makes a key and answers it once.
 */
const addKey = Effect.fn("admin.addKey")(function* (app: App, form: Form) {
  const name = field(form, "name")
  if (name === undefined) return fail(400, "a key needs a name")
  const models = list(field(form, "models"))
  const made = yield* Effect.result(Config.addKey(app.home.config(), name, models))
  if (Result.isFailure(made)) return fail(400, chain(made.failure))
  yield* app.reloadConfig
  return reply(200, { name, key: made.success, models })
})

const removeKey = Effect.fn("admin.removeKey")(function* (app: App, name: string) {
  const removed = yield* Effect.result(Config.removeKey(app.home.config(), name))
  if (Result.isFailure(removed)) return fail(500, chain(removed.failure))
  if (!removed.success) return fail(404, "no such key")
  yield* app.reloadConfig
  return reply(200, keys(yield* app.config))
})

/** The settings a front end may change while the proxy runs. */
const settings = (config: Config) => ({
  strategy: config.strategy,
  strategies: Strategy.ALL.map((s) => ({ id: s, summary: Strategy.summary(s) })),
  session_affinity: config.sessionAffinity,
  session_ttl_mins: config.sessionTtlMins,
  redeem_expiring_credits: config.redeemExpiringCredits,
  redeem_when_exhausted: config.redeemWhenExhausted,
  warm_windows: config.warmWindows,
  paid_overflow: config.paidOverflow,
  poll_mins: config.pollMins,
})

/**
 * `POST /slopmax/settings` with any of `settings`' fields as form
 * values: writes them to config.toml, keeping its comments, and applies
 * them at once.
 */
const changeSettings = Effect.fn("admin.changeSettings")(function* (app: App, form: string) {
  const values: Array<readonly [string, toml.Value]> = []
  for (const [key, value] of forms.decode(form)) {
    if (key === "") continue
    const setting = liveValue(key, value)
    if (Result.isFailure(setting)) return fail(400, setting.failure)
    values.push(setting.success)
  }
  if (values.length === 0) return fail(400, "no settings to change")
  const set = yield* Effect.result(Config.set(app.home.config(), values))
  if (Result.isFailure(set)) return fail(400, chain(set.failure))
  const current = yield* app.config
  const config: Config = { ...set.success, listen: current.listen, apiKey: current.apiKey }
  log.info("settings changed from the API")
  const answer = settings(config)
  yield* app.setConfig(config)
  return reply(200, answer)
})

const CONNECTED = utf8.encode(": connected\n\n")
const KEEPALIVE_LINE = utf8.encode(": keepalive\n\n")
const DATA = utf8.encode("data: ")
const END = utf8.encode("\n\n")

const event = (line: Uint8Array): Uint8Array => {
  const chunk = new Uint8Array(DATA.length + line.length + END.length)
  chunk.set(DATA)
  chunk.set(line, DATA.length)
  chunk.set(END, DATA.length + line.length)
  return chunk
}

/**
 * A server-sent event for each request answered from now on. A subscriber
 * that lags loses the oldest (the feed is a sliding buffer); the feed ends
 * when the client goes, which interrupts the stream.
 */
const events = (app: App): Response => {
  const feed = Stream.unwrap(
    Effect.map(app.feed, (subscription) =>
      Stream.concat(
        Stream.succeed(CONNECTED),
        Stream.fromEffectRepeat(
          Effect.map(
            Effect.timeoutOption(PubSub.take(subscription), KEEPALIVE),
            Option.match({ onNone: () => KEEPALIVE_LINE, onSome: event }),
          ),
        ),
      ),
    ),
  )
  return HttpServerResponse.stream(feed, { contentType: "text/event-stream", headers: { "cache-control": "no-cache" } })
}

/** Rust's `str::parse::<i32>`: an optional sign, then digits, in range. */
const parseI32 = (value: string): number | undefined => {
  if (!/^[+-]?[0-9]+$/.test(value)) return undefined
  const n = Number(value)
  return n >= -(2 ** 31) && n <= 2 ** 31 - 1 ? n : undefined
}

/**
 * `POST /slopmax/accounts/<id>/<action>`: enable, disable, use, redeem (a
 * reset credit: `?value=<credit id>`, else the soonest to expire), remove,
 * priority (`?value=N`), or label (`?value=name`, empty to clear).
 */
const account = Effect.fn("admin.account")(function* (app: App, id: string, action: string, query: string) {
  const found = (yield* app.pool.accounts).find((a) => a.id === id)
  if (found === undefined) return fail(404, "no such account")
  const value = param(query, "value")
  const update = (change: (a: Account) => Account): Effect.Effect<void, Failure> =>
    Effect.asVoid(app.store.update(found.id, change))
  let changed: Effect.Effect<void, Failure>
  switch (action) {
    case "enable":
    case "disable": {
      const disabled = action === "disable"
      changed = update((a) => ({ ...a, disabled }))
      break
    }
    case "priority": {
      const priority = value === undefined ? undefined : parseI32(value)
      if (priority === undefined) return fail(400, "priority needs ?value=<number>")
      changed = update((a) => ({ ...a, priority }))
      break
    }
    case "label": {
      const label = value !== undefined && text.trim(value) !== "" ? value : undefined
      changed = update((a) => (label === undefined ? without(a, "label") : { ...a, label }))
      break
    }
    case "use":
      changed = pin(app.home, found)
      break
    // Refresh here, rather than follow the tool it was imported from.
    case "own":
      changed = update((a) => without(a, "link"))
      break
    case "remove":
      changed = forget(app.store, app.home, found)
      break
    case "redeem":
      return yield* redeem(app, found, value)
    default:
      return fail(404, "no such account action")
  }
  return yield* reload(app, changed)
})

/** Picks up a change on disk right away, then reports. */
const reload = Effect.fn("admin.reload")(function* (
  app: App,
  changed: Effect.Effect<void, Failure>,
): Effect.fn.Return<Response> {
  const done = yield* Effect.result(Effect.andThen(changed, app.sync))
  if (Result.isFailure(done)) return fail(500, chain(done.failure))
  return yield* report(app)
})

/**
 * Redeems `credit`, or the account's soonest to expire as listed now, and
 * answers how it went with the report.
 */
const redeem = Effect.fn("admin.redeem")(function* (
  app: App,
  picked: Account,
  credit: string | undefined,
): Effect.fn.Return<Response> {
  const credits = ProviderId.get(picked.provider).credits()
  if (credits === undefined) return fail(400, "this account has no limit resets")
  return yield* app.redeeming.withPermit(
    Effect.gen(function* () {
      const ready = yield* app.ready(picked)
      if (ready === undefined) return fail(409, "the account needs signing in again")
      const agent = yield* app.pool.agent(ready.provider)
      let chosen = credit
      if (chosen === undefined) {
        const listed = yield* Effect.result(credits.list(app.authHttp, ready, agent))
        if (Result.isFailure(listed)) return fail(502, chain(listed.failure))
        const soonest = listed.success[0]?.id
        yield* app.pool.recordCredits(ready.id, listed.success, yield* Timestamp.now)
        if (soonest === undefined) return reply(200, { outcome: "no_credit", report: encodeReport(yield* app.report) })
        chosen = soonest
      }
      const redeemed = yield* Effect.result(credits.redeem(app.authHttp, ready, agent, chosen))
      if (Result.isFailure(redeemed)) return fail(502, chain(redeemed.failure))
      const outcome = redeemed.success
      if (outcome === "reset") {
        log.info(`${ready.id}: redeemed a limit reset on request`)
        yield* app.pool.recordReset(ready.id, yield* Timestamp.now, chosen)
      }
      return reply(200, { outcome, report: encodeReport(yield* app.report) })
    }),
  )
})
