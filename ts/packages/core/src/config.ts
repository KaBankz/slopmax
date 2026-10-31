// User configuration, stored as TOML in `~/.slopmax/config.toml`.
import { dirname } from "node:path"

import { Config as EffectConfig, Effect, Option, Result, Schema, SchemaGetter, SchemaIssue } from "effect"

import { ids, text as texts } from "@slopmax/common"
import { client } from "@slopmax/net"

import { context, Failure } from "./error.ts"
import * as fsx from "./fsx.ts"
import * as paths from "./paths.ts"
import { join } from "./paths.ts"
import { CustomSchema } from "./pricing.ts"
import { matches } from "./provider/mod.ts"
import { list, omitWhen, opt, record, withDefault } from "./serde.ts"
import * as toml from "./toml.ts"

/** Default proxy port: "slop" on a phone keypad. */
export const DEFAULT_PORT = 7567

// ---- socket addresses ---------------------------------------------------------

/** `std::net::SocketAddr`: an IP (as Rust prints it, without brackets) and a port. */
export interface SocketAddr {
  readonly ip: string
  readonly port: number
  /** An IPv6 address's scope id (`%2`), when it has one other than 0. */
  readonly scope?: number
}

// Four decimal octets, none with a leading zero.
const V4 = /^(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})\.(?:0|[1-9][0-9]{0,2})$/

const parseV4 = (text: string): ReadonlyArray<number> | undefined => {
  if (!V4.test(text)) return undefined
  const octets = text.split(".").map(Number)
  return octets.every((o) => o <= 255) ? octets : undefined
}

// The 16-bit groups of one side of an IPv6 address's `::`, or undefined.
const v6Groups = (part: string): Array<number> | undefined => {
  if (part === "") return []
  const out: Array<number> = []
  const pieces = part.split(":")
  for (const [i, piece] of pieces.entries()) {
    if (i === pieces.length - 1 && piece.includes(".")) {
      const v4 = parseV4(piece)
      if (v4 === undefined) return undefined
      out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
    } else {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return undefined
      out.push(Number.parseInt(piece, 16))
    }
  }
  return out
}

// Eight 16-bit groups, or undefined.
const parseV6 = (text: string): ReadonlyArray<number> | undefined => {
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const head = v6Groups(halves[0] ?? "")
  if (head === undefined) return undefined
  if (halves.length === 1) return head.length === 8 ? head : undefined
  const tail = v6Groups(halves[1] ?? "")
  if (tail === undefined || head.length + tail.length > 7) return undefined
  return [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail]
}

// Rust's display of an `Ipv6Addr`: the longest run of zero groups as `::`.
const displayV6 = (g: ReadonlyArray<number>): string => {
  const at = (i: number): number => g[i] ?? 0
  if (g.every((x) => x === 0)) return "::"
  if (g.slice(0, 7).every((x) => x === 0) && at(7) === 1) return "::1"
  if (g.slice(0, 5).every((x) => x === 0) && at(5) === 0xffff) {
    return `::ffff:${at(6) >> 8}.${at(6) & 0xff}.${at(7) >> 8}.${at(7) & 0xff}`
  }
  let bestStart = -1
  let bestLength = 0
  for (let i = 0; i < 8;) {
    if (at(i) !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && at(j) === 0) j++
    if (j - i > bestLength) {
      bestStart = i
      bestLength = j - i
    }
    i = j
  }
  const hex = (from: number, to: number): string =>
    g
      .slice(from, to)
      .map((x) => x.toString(16))
      .join(":")
  if (bestLength < 2) return hex(0, 8)
  return `${hex(0, bestStart)}::${hex(bestStart + bestLength, 8)}`
}

const PORT = /^[0-9]+$/

export const SocketAddr = {
  /** `SocketAddr::from_str`: `1.2.3.4:5` or `[::1]:5`. */
  parse: (text: string): SocketAddr | undefined => {
    const colon = text.lastIndexOf(":")
    if (colon < 0) return undefined
    const host = text.slice(0, colon)
    const portText = text.slice(colon + 1)
    if (!PORT.test(portText)) return undefined
    const port = Number(portText)
    if (port > 65_535) return undefined
    if (host.startsWith("[") && host.endsWith("]")) {
      const inner = host.slice(1, -1)
      const percent = inner.indexOf("%")
      const groups = parseV6(percent >= 0 ? inner.slice(0, percent) : inner)
      if (groups === undefined) return undefined
      const ip = displayV6(groups)
      if (percent < 0) return { ip, port }
      // A `u32`.
      const scopeText = inner.slice(percent + 1)
      const scope = PORT.test(scopeText) ? Number(scopeText) : Number.NaN
      if (!(scope <= 0xffff_ffff)) return undefined
      return scope === 0 ? { ip, port } : { ip, port, scope }
    }
    const octets = parseV4(host)
    return octets === undefined ? undefined : { ip: octets.join("."), port }
  },

  isV6: (self: SocketAddr): boolean => self.ip.includes(":"),

  isUnspecified: (self: SocketAddr): boolean => self.ip === "0.0.0.0" || self.ip === "::",

  display: (self: SocketAddr): string => {
    if (!SocketAddr.isV6(self)) return `${self.ip}:${self.port}`
    return self.scope === undefined ? `[${self.ip}]:${self.port}` : `[${self.ip}%${self.scope}]:${self.port}`
  },
} as const

const SocketAddrSchema: Schema.Codec<SocketAddr, string> = Schema.String.pipe(
  Schema.decodeTo(Schema.Struct({ ip: Schema.String, port: Schema.Number, scope: Schema.optionalKey(Schema.Number) }), {
    decode: SchemaGetter.transformEffect((text: string, options) => {
      const addr = SocketAddr.parse(text)
      return addr === undefined
        ? Effect.fail(new SchemaIssue.InvalidValue({ message: "invalid socket address syntax" }, text, options))
        : Effect.succeed(addr)
    }),
    encode: SchemaGetter.transform((addr: SocketAddr) => SocketAddr.display(addr)),
  }),
)

// ---- strategy -----------------------------------------------------------------

/** Account selection strategy for sessions without an existing pin. */
export const StrategySchema = Schema.Literals([
  /**
   * Spend the quota that expires first: prefer the account whose usage
   * window resets soonest, so no capacity is lost to a reset.
   */
  "reset-first",
  /** Drain accounts in priority order, moving on only when one is limited. */
  "fill-first",
  /** Spread sessions across accounts, preferring the least used. */
  "least-used",
  /**
   * Hand each new session (each request, without affinity) to the next
   * account in turn.
   */
  "round-robin",
])

export type Strategy = typeof StrategySchema.Type

export const Strategy = {
  ALL: StrategySchema.literals,

  parse: (name: string): Strategy | undefined => Strategy.ALL.find((s) => s === name),

  /** What it does, in a phrase for people. */
  summary: (self: Strategy): string => {
    switch (self) {
      case "reset-first":
        return "Spend the quota that resets soonest, so none is lost"
      case "fill-first":
        return "Use accounts in priority order; fail over when one is limited"
      case "least-used":
        return "Balance load toward the least used account"
      case "round-robin":
        return "Take turns across accounts"
    }
  },
} as const

// ---- notifications --------------------------------------------------------------

/** What happened, for `[notify]` (the notifications themselves are in `notify.ts`). */
export const NotifyKindSchema = Schema.Literals([
  /** An account hit a usage limit. */
  "limited",
  /** A limited account can serve again. */
  "available",
  /** Every account of a provider is limited, so its requests fail. */
  "exhausted",
  /** A provider that was exhausted can serve again. */
  "recovered",
  /** An account's sign-in stopped working and needs `slopmax login`. */
  "signed-out",
  /**
   * A limit reset expires within the day, and slopmax won't redeem it by
   * itself (`redeem_expiring_credits` is off).
   */
  "reset-expiring",
  /**
   * A week (or month) resets within the day with much of its quota unused:
   * work put on the account now costs nothing extra.
   */
  "quota-unused",
  /** Sent by `slopmax notify` to check the setup. */
  "test",
])

export type NotifyKind = typeof NotifyKindSchema.Type

/** Settings under `[notify]` in config.toml. */
export const NotifySettingsSchema = Schema.Struct({
  /** Receives each event as a JSON POST. */
  webhook: opt(Schema.String),
  /** Run by the shell, with the event in `SLOPMAX_*` variables. */
  command: opt(Schema.String),
  /** The events to send; the default set when empty. */
  events: list(NotifyKindSchema),
})

export type NotifySettings = typeof NotifySettingsSchema.Type

export const NotifySettings = {
  default: (): NotifySettings => ({ events: [] }),

  isEnabled: (self: NotifySettings): boolean => self.webhook !== undefined || self.command !== undefined,

  isEmpty: (self: NotifySettings): boolean =>
    self.webhook === undefined && self.command === undefined && self.events.length === 0,
} as const

// ---- client keys ----------------------------------------------------------------

/** A key a client presents instead of `api_key`. */
export const ClientKeySchema = Schema.Struct({
  name: Schema.String,
  key: Schema.String,
  /** The models it may use, as patterns where `*` matches anything; any model when empty. */
  models: list(Schema.String),
})

export type ClientKey = typeof ClientKeySchema.Type

export const ClientKey = {
  allows: (self: ClientKey, model: string): boolean =>
    self.models.length === 0 || self.models.some((p) => matches(p, model)),
} as const

// ---- the config -----------------------------------------------------------------

const DEFAULT_LISTEN = `127.0.0.1:${DEFAULT_PORT}`

export const ConfigSchema = Schema.Struct({
  /** Address the proxy listens on. */
  listen: withDefault(SocketAddrSchema, DEFAULT_LISTEN),
  /** Key agents must present (as a bearer token or `x-api-key`). */
  apiKey: withDefault(Schema.String, ""),
  /** How a new session picks its account. */
  strategy: withDefault(StrategySchema, "reset-first"),
  /** Minutes a session stays pinned to its account after its last request. */
  sessionTtlMins: withDefault(toml.U64, 60n),
  /**
   * Keep each session on the account it started on while that account can
   * serve, so its prompt cache stays warm. Off, every request is placed by
   * the strategy. A request can say otherwise with the
   * `x-slopmax-affinity: on|off` header.
   */
  sessionAffinity: withDefault(Schema.Boolean, true),
  /** Minutes between background usage polls per account (0 disables). */
  pollMins: withDefault(toml.U64, 5n),
  /**
   * Whether the proxy refreshes OAuth tokens. Disable only while another
   * tool owns the same refresh tokens.
   */
  refreshTokens: withDefault(Schema.Boolean, true),
  /**
   * Redeem a ChatGPT reset credit shortly before it expires, if the account
   * has usage to reset; otherwise the credit lapses unused.
   */
  redeemExpiringCredits: withDefault(Schema.Boolean, true),
  /** When every Codex account is spent, redeem a banked reset credit instead of failing the request. */
  redeemWhenExhausted: withDefault(Schema.Boolean, false),
  /**
   * Relay Codex's WebSockets to ChatGPT's, which starts answers sooner than
   * HTTP streaming. Off, Codex streams over HTTP.
   */
  websockets: withDefault(Schema.Boolean, true),
  /**
   * Start an idle ChatGPT account's 5-hour window with one tiny request
   * once the last one resets, so the next reset comes sooner.
   */
  warmWindows: withDefault(Schema.Boolean, false),
  /**
   * Let API keys serve a subscription's models once every subscription
   * account is limited. Off, they serve those models only when asked for by
   * name (`openai/gpt-6-sol`) or when no subscription exists.
   */
  paidOverflow: withDefault(Schema.Boolean, false),
  /** Proxy for requests to providers (`http://…`, `socks5://…`), in place of HTTPS_PROXY. */
  proxy: opt(Schema.String),
  /** Model names that stand for others: `fast = "gpt-6-sol-mini"`. */
  aliases: record(Schema.String),
  /** Models to try, in order, once a model is limited on every account. */
  fallbacks: record(Schema.Array(Schema.String)),
  /** Per-model API prices for `slopmax usage`, beyond the built-in ones. */
  prices: record(CustomSchema),
  /**
   * What each subscription plan costs a month, as `"claude/max 20x" = 200`,
   * for what unused quota is worth; list prices otherwise.
   */
  planPrices: record(toml.F64),
  /** Where to send notifications, and which. */
  notify: omitWhen(
    NotifySettingsSchema,
    { events: [] },
    (n) => n.webhook == null && n.command == null && (n.events ?? []).length === 0,
  ),
  /**
   * Keys for other machines and tools, each possibly limited to some
   * models. Only `api_key` reaches slopmax's own API.
   */
  keys: list(ClientKeySchema),
}).pipe(
  Schema.encodeKeys({
    apiKey: "api_key",
    sessionTtlMins: "session_ttl_mins",
    sessionAffinity: "session_affinity",
    pollMins: "poll_mins",
    refreshTokens: "refresh_tokens",
    redeemExpiringCredits: "redeem_expiring_credits",
    redeemWhenExhausted: "redeem_when_exhausted",
    warmWindows: "warm_windows",
    paidOverflow: "paid_overflow",
    planPrices: "plan_prices",
  }),
)

export type Config = typeof ConfigSchema.Type

const decodeConfig = Schema.decodeUnknownResult(ConfigSchema, { onExcessProperty: "error" })

/** Reads config.toml's text as a config (unknown keys are refused), or says why not. */
export const parse = (text: string): Result.Result<Config, Failure> => {
  const doc = toml.Document.parse(text)
  if (Result.isFailure(doc)) return Result.fail(new Failure({ message: doc.failure.message }))
  const config = decodeConfig(doc.success.data)
  if (Result.isFailure(config)) return Result.fail(new Failure({ message: config.failure.message }))
  return Result.succeed(config.success)
}

/** The settings that hold when config.toml names none. */
const makeDefault = (): Config => ({
  listen: { ip: "127.0.0.1", port: DEFAULT_PORT },
  apiKey: "",
  strategy: "reset-first",
  sessionTtlMins: 60,
  sessionAffinity: true,
  pollMins: 5,
  refreshTokens: true,
  redeemExpiringCredits: true,
  redeemWhenExhausted: false,
  websockets: true,
  warmWindows: false,
  paidOverflow: false,
  aliases: {},
  fallbacks: {},
  prices: {},
  planPrices: {},
  notify: NotifySettings.default(),
  keys: [],
})

/**
 * The settings that apply while the proxy runs, which `slopmax config`, the
 * dashboard, and the app change: each name and what it does.
 */
export const LIVE: ReadonlyArray<readonly [name: string, what: string]> = [
  ["strategy", "reset-first, fill-first, least-used, or round-robin"],
  ["session_affinity", "keep a session on its account, for the prompt cache"],
  ["session_ttl_mins", "idle minutes before a session's account is forgotten"],
  ["redeem_expiring_credits", "redeem a limit reset before it expires unused"],
  ["redeem_when_exhausted", "redeem one when every account is spent"],
  ["warm_windows", "start idle ChatGPT accounts' windows as they reset"],
  ["paid_overflow", "let API keys take over once subscriptions are limited"],
  ["poll_mins", "minutes between usage polls (0 turns them off)"],
]

const I64 = /^[+-]?[0-9]+$/

/** `value` as the setting `name` takes it, or why not. */
export const liveValue = (name: string, value: string): Result.Result<readonly [string, toml.Value], string> => {
  const live = LIVE.find(([n]) => n === name)
  if (live === undefined) {
    const names = LIVE.map(([n]) => n)
    return Result.fail(`${name} is not a setting slopmax changes while it runs; those are ${names.join(", ")}`)
  }
  const trimmed = texts.trim(value)
  switch (name) {
    case "strategy": {
      const strategy = Strategy.parse(trimmed)
      if (strategy === undefined) return Result.fail(`strategy is one of ${Strategy.ALL.join(", ")}`)
      return Result.succeed([live[0], toml.Value.of(strategy)])
    }
    case "session_ttl_mins":
    case "poll_mins": {
      const mins = I64.test(trimmed) ? BigInt(trimmed) : undefined
      const fits = mins !== undefined && mins >= -(2n ** 63n) && mins < 2n ** 63n
      if (fits && (mins > 0n || (name === "poll_mins" && mins === 0n))) {
        return Result.succeed([live[0], toml.Value.of(mins)])
      }
      return Result.fail(`${name} is a number of minutes`)
    }
    default:
      switch (trimmed) {
        case "true":
        case "on":
        case "1":
        case "yes":
          return Result.succeed([live[0], toml.Value.of(true)])
        case "false":
        case "off":
        case "0":
        case "no":
          return Result.succeed([live[0], toml.Value.of(false)])
        default:
          return Result.fail(`${name} is on or off`)
      }
  }
}

const readContext = (path: string) => (e: fsx.IoError) => new Failure({ message: `reading ${path}`, cause: e })

const writeText = (path: string, text: string): Effect.Effect<void, Failure> =>
  fsx.writePrivate(path, text).pipe(context(`writing ${path}`))

// The file's text (undefined when missing) and the config it makes.
const read = (path: string): Effect.Effect<readonly [string | undefined, Config], Failure> =>
  Effect.flatMap(fsx.readText(path).pipe(Effect.mapError(readContext(path))), (text) => {
    type Read = readonly [string | undefined, Config]
    if (text === undefined) return Effect.succeed<Read>([undefined, makeDefault()])
    const config = parse(text)
    if (Result.isFailure(config)) {
      return Effect.fail(new Failure({ message: `invalid config ${path}`, cause: config.failure }))
    }
    return Effect.succeed<Read>([text, config.success])
  })

// The file's text as a document.
const parseDocument = (path: string, text: string): Effect.Effect<toml.Document, Failure> => {
  const doc = toml.Document.parse(text)
  if (Result.isFailure(doc)) return Effect.fail(new Failure({ message: `invalid config ${path}`, cause: doc.failure }))
  return Effect.succeed(doc.success)
}

// The file as a document; a missing file is an error.
const document = (path: string): Effect.Effect<toml.Document, Failure> =>
  Effect.flatMap(fsx.readText(path).pipe(Effect.mapError(readContext(path))), (text) =>
    text === undefined
      ? Effect.fail(
          new Failure({ message: `reading ${path}`, cause: new Failure({ message: fsx.osErrorText("ENOENT", "") }) }),
        )
      : parseDocument(path, text),
  )

const loadFrom = Effect.fn("Config.loadFrom")(function* (path: string): Effect.fn.Return<Config, Failure> {
  const [text, config] = yield* read(path)
  if (config.apiKey !== "") return config
  // The first run makes the key. Processes started together take turns,
  // and each after the first finds the key already made, so all of them
  // agree on it.
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const lock = join(dirname(path), ".config.lock")
      yield* fsx.lock(lock).pipe(context(`locking ${lock}`))
      const [, made] = yield* read(path)
      if (made.apiKey !== "") return made
      const apiKey = `sm-${ids.token()}`
      let written: string
      if (text === undefined) written = template(apiKey)
      else {
        // Add the key without disturbing the user's comments.
        const doc = yield* parseDocument(path, text)
        doc.set("api_key", toml.Value.of(apiKey))
        written = doc.toString()
      }
      yield* writeText(path, written)
      return { ...config, apiKey }
    }),
  )
})

export const Config = {
  default: makeDefault,

  /** A live setting's value as config.toml writes it. */
  live: (self: Config, name: string): string | undefined => {
    switch (name) {
      case "strategy":
        return self.strategy
      case "session_affinity":
        return String(self.sessionAffinity)
      case "session_ttl_mins":
        return String(self.sessionTtlMins)
      case "redeem_expiring_credits":
        return String(self.redeemExpiringCredits)
      case "redeem_when_exhausted":
        return String(self.redeemWhenExhausted)
      case "warm_windows":
        return String(self.warmWindows)
      case "paid_overflow":
        return String(self.paidOverflow)
      case "poll_mins":
        return String(self.pollMins)
      default:
        return undefined
    }
  },

  /**
   * Loads the config, creating it (with a fresh API key) on first use.
   * `SLOPMAX_LISTEN` overrides `listen`, for containers.
   */
  load: Effect.fn("Config.load")(function* () {
    const config = yield* loadFrom(yield* paths.configFile)
    const listen = yield* EffectConfig.option(EffectConfig.String("SLOPMAX_LISTEN")).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    )
    if (listen === undefined || listen === "") return config
    const addr = SocketAddr.parse(listen)
    if (addr === undefined) {
      return yield* Effect.fail(
        new Failure({
          message: `SLOPMAX_LISTEN=${texts.debug(listen)} is not an address`,
          cause: new Failure({ message: "invalid socket address syntax" }),
        }),
      )
    }
    return { ...config, listen: addr }
  }),

  loadFrom,

  /**
   * Adds a client key named `name` to the config at `path`, keeping the
   * file's comments, and returns the new key.
   */
  addKey: Effect.fn("Config.addKey")(function* (path: string, name: string, models: ReadonlyArray<string>) {
    const config = yield* loadFrom(path)
    if (config.keys.some((k) => k.name === name)) {
      return yield* Effect.fail(new Failure({ message: `a key named ${texts.debug(name)} already exists` }))
    }
    const key = `sm-${ids.token()}`
    const doc = yield* document(path)
    const entry = toml.Table.make()
    entry.set("name", toml.Value.of(name))
    entry.set("key", toml.Value.of(key))
    if (models.length > 0) entry.set("models", toml.Value.of([...models]))
    let keys = doc.get("keys")
    if (keys === undefined) {
      keys = new toml.ArrayOfTables()
      doc.set("keys", keys)
    }
    if (!(keys instanceof toml.ArrayOfTables)) {
      return yield* Effect.fail(new Failure({ message: "`keys` in config.toml is not a list of [[keys]] tables" }))
    }
    keys.push(entry)
    yield* writeText(path, doc.toString())
    return key
  }),

  /** Removes the client key named `name`; returns whether there was one. */
  removeKey: Effect.fn("Config.removeKey")(function* (path: string, name: string) {
    const doc = yield* document(path)
    const keys = doc.get("keys")
    if (!(keys instanceof toml.ArrayOfTables)) return false
    const before = keys.length
    keys.retain((table) => {
      const n = table.get("name")
      return !(n instanceof toml.Value && n.asStr() === name)
    })
    if (keys.length === before) return false
    if (keys.length === 0) doc.remove("keys")
    yield* writeText(path, doc.toString())
    return true
  }),

  /**
   * Sets top-level settings in the config at `path`, keeping the file's
   * comments, and returns the config they make. Nothing is written if the
   * result is not a valid config.
   */
  set: Effect.fn("Config.set")(function* (path: string, values: ReadonlyArray<readonly [string, toml.Value]>) {
    const text = yield* fsx.readText(path).pipe(Effect.mapError(readContext(path)))
    const doc = text === undefined ? toml.Document.empty() : yield* parseDocument(path, text)
    for (const [key, value] of values) {
      // A comment beside the old value stays beside the new one.
      const old = doc.get(key)
      const decor = old instanceof toml.Value ? { ...old.decor } : { ...value.decor }
      doc.set(key, new toml.Value(value.data, value.repr, decor))
    }
    const written = doc.toString()
    const config = parse(written)
    if (Result.isFailure(config)) {
      return yield* Effect.fail(new Failure({ message: `invalid setting for ${path}`, cause: config.failure }))
    }
    yield* writeText(path, written)
    return config.success
  }),

  /** Base URL agents use to reach the proxy. */
  baseUrl: (self: Config): string => {
    const host = SocketAddr.isUnspecified(self.listen)
      ? "127.0.0.1"
      : SocketAddr.isV6(self.listen)
        ? `[${self.listen.ip}]`
        : self.listen.ip
    return `http://${host}:${self.listen.port}`
  },

  /** Applies the settings that hold for the whole process: the proxy for requests to providers. */
  apply: (self: Config): Effect.Effect<void, Failure> => {
    if (self.proxy === undefined) return Effect.void
    const proxy = client.Proxy.parse(self.proxy)
    if (Result.isFailure(proxy)) return Effect.fail(new Failure({ message: `config \`proxy\`: ${proxy.failure}` }))
    return Effect.sync(() => client.Proxy.setDefault(proxy.success))
  },

  /**
   * The dashboard's address. The key travels in the fragment, which
   * browsers never send to a server.
   */
  dashboardUrl: (self: Config): string => `${Config.baseUrl(self)}/slopmax/dashboard#key=${self.apiKey}`,
} as const

/**
 * The config written on first run: the generated key, then every other
 * setting commented out at its default. (Keys are base64url, so they need
 * no escaping.)
 */
export const template = (
  apiKey: string,
): string => `# slopmax settings. Everything but api_key is optional; the commented
# values are the defaults.

# Key agents present to the proxy, as a bearer token or x-api-key.
api_key = "${apiKey}"

# Address the proxy listens on.
# listen = "127.0.0.1:${DEFAULT_PORT}"

# How a new session picks its account:
#   reset-first  spend the quota that resets soonest, so none is lost
#   fill-first   drain accounts in priority order (plain failover)
#   least-used   spread sessions over the least used accounts
#   round-robin  hand sessions to each account in turn
# strategy = "reset-first"

# Keep a session on the account it started on while that account can serve,
# so the provider's prompt cache stays warm. Off, every request is placed by
# the strategy (load balancing, at the cost of the cache). A client can
# decide per request with the header \`x-slopmax-affinity: on\` or \`off\`.
# session_affinity = true

# Minutes a session stays on its account after its last request.
# session_ttl_mins = 60

# Minutes between usage polls per account (0 turns polling off).
# poll_mins = 5

# Refresh OAuth tokens before they expire. Turn this off only while another
# tool uses the same accounts: every refresh rotates the refresh token.
# refresh_tokens = true

# Redeem a ChatGPT reset credit in its last hours, if the account has usage
# to reset, rather than let it expire unused.
# redeem_expiring_credits = true

# When every Codex account is spent, redeem a reset credit instead of
# failing the request.
# redeem_when_exhausted = false

# Relay Codex's WebSocket connections to ChatGPT, which starts answers
# sooner than HTTP streaming. \`slopmax setup codex\` turns them on in Codex.
# websockets = true

# ChatGPT starts a 5-hour window at an account's first request. With this
# on, an idle account gets one tiny request as soon as its window resets,
# so its next reset comes sooner when you need it. Claude accounts are
# never warmed.
# warm_windows = false

# Let API keys (\`slopmax login openai\`, \`slopmax login anthropic\`) serve a
# subscription's models once every subscription account is limited. Off,
# they serve those models only when asked for by name (\`openai/gpt-6-sol\`)
# or when you have no such subscription.
# paid_overflow = false

# Proxy for requests to providers, instead of HTTPS_PROXY:
#   proxy = "socks5h://127.0.0.1:1080"

# Model names that stand for others, and models to try once one is limited
# on every account. A name may pick a provider or account: "openai/gpt-6-sol".
#   [aliases]
#   fast = "gpt-6-sol-mini"
#   [fallbacks]
#   "gpt-6-sol" = ["openai/gpt-6-sol"]

# Notifications, sent when every account of a kind is limited (so requests
# fail), when it recovers, when an account needs \`slopmax login\` again, when
# a limit reset would expire unused (with redeem_expiring_credits off), and
# when a week is about to reset with much of its quota unused.
# A webhook gets a JSON POST (with "text" and "content", so Slack and
# Discord show it); a command runs in the shell with SLOPMAX_EVENT,
# SLOPMAX_PROVIDER, SLOPMAX_ACCOUNT, SLOPMAX_UNTIL, and SLOPMAX_MESSAGE set.
# Add "limited" and "available" to events to hear about each account too.
# Check the setup with \`slopmax notify\`.
#   [notify]
#   webhook = "https://hooks.slack.com/services/..."
#   command = 'notify-send slopmax "$SLOPMAX_MESSAGE"'
#   events = ["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"]

# More keys, for other machines and tools, made with \`slopmax key add\`. A
# key may be limited to some models; only api_key reaches slopmax's own API.
#   [[keys]]
#   name = "laptop"
#   key = "sm-..."
#   models = ["gpt-*"]

# What each subscription costs a month, for what unused quota is worth.
# List prices are built in (Claude Pro $20, Max 5x $100, Max 20x $200;
# ChatGPT Plus $20, Pro $200); set what you really pay:
#   [plan_prices]
#   "claude/max 20x" = 200
#   "codex/pro" = 200

# API prices for \`slopmax usage\`, in dollars per million tokens. Anthropic's
# and OpenAI's list prices are built in; add models it can't price. Cache reads default
# to a tenth of input, cache writes to 1.25x input. For example:
#   [prices."my-model"]
#   input = 2.0
#   output = 8.0
#   cache_read = 0.5
`
