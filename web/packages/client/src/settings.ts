// Settings: `config.json` in slopmax's home.
//
// One Schema defines the file, its defaults, its validation and its JSON
// Schema (`config.schema.json`, for editor completion and hover text). Every
// key is optional, so a partial file loads; an unknown key is an error, so a
// typo is never silently ignored. Settings annotated `live` may change while
// slopmax runs (`slopmax config`, `PATCH /settings`, the app's switches); the
// rest need a restart.
//
// Descriptions and defaults sit on each field's plain JSON side (before any
// check or transformation), because that is the side the JSON Schema shows.
import { Effect, JsonSchema, Result, Schema, SchemaAST, SchemaTransformation, Struct } from "effect"
import { firstIssueText } from "./errors.ts"
import { KeyName, NonNegativeInt, PositiveInt, Secret, Strategy, withDefault } from "./ids.ts"
import { defaultNoticeKinds, NoticeKind } from "./notice.ts"
import { matchesAny } from "./providers.ts"

declare module "effect/Schema" {
  namespace Annotations {
    // This adds to Effect's own `Annotations` interface; it shadows nothing.
    // oxlint-disable-next-line no-shadow
    interface Annotations {
      /** May be changed by `slopmax config`, `PATCH /settings`, and the app while slopmax runs. */
      readonly live?: { readonly summary: string } | undefined
    }
  }
}

/** Decoding options for `config.json`: a key slopmax does not know is an error, at any depth. */
export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" }

/** The port slopmax listens on unless told otherwise: "slop" on a phone keypad. */
export const defaultPort = 7567

/** Where the proxy listens unless told otherwise: this machine only. */
export const defaultListen = `127.0.0.1:${defaultPort}`

const hostPort = /^(?:\[[0-9A-Fa-f:.]+\]|[^\s:[\]]+):(\d{1,5})$/

/** `host:port`, with an IPv6 host in brackets. */
export const isListen = Schema.makeFilter((text: string) => {
  const port = hostPort.exec(text)?.[1]
  return (
    (port !== undefined && Number(port) <= 65_535) || `${JSON.stringify(text)} is not an address, like ${defaultListen}`
  )
})

/**
 * Where the proxy listens: `host:port`, with an IPv6 host in brackets, for
 * checking an address on its own. `Settings` states the same check after its
 * description, since the JSON Schema shows only what sits before a check.
 */
export const Listen = Schema.String.check(isListen)

/** `http://`, `socks5://` (names resolved here) or `socks5h://` (names resolved by the proxy). */
export const isProxyUrl = Schema.makeFilter((text: string) => {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text)?.[1]?.toLowerCase()
  if (scheme === undefined) return `proxy ${JSON.stringify(text)} needs a scheme, like http:// or socks5://`
  return ["http", "socks5", "socks5h"].includes(scheme) || `unsupported proxy scheme ${JSON.stringify(scheme)}`
})

/** An outbound proxy for provider calls, for checking one on its own; `Settings` states it as `Listen` is. */
export const ProxyUrl = Schema.String.check(isProxyUrl)

/** A key other machines and tools present to the proxy, optionally limited to some models. */
export class ClientKey extends Schema.Class<ClientKey>("ClientKey")({
  name: KeyName,
  key: Secret,
  models: Schema.Array(Schema.String)
    .annotate({
      description: 'Model patterns this key may use, such as "gpt-*"; empty allows every model.',
      default: [],
    })
    .pipe(withDefault([])),
}) {
  /** Whether the key may use `model`: any model when it names none, else one matching a pattern. */
  allows(model: string): boolean {
    return this.models.length === 0 || matchesAny(this.models, model)
  }
}

/** API prices for a model, in dollars per million tokens. */
export class Price extends Schema.Class<Price>("Price")({
  input: Schema.Finite.annotate({ description: "Dollars per million input tokens." }),
  output: Schema.Finite.annotate({ description: "Dollars per million output tokens." }),
  cacheRead: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Dollars per million tokens read from cache; a tenth of input when absent.",
    }),
  ),
  cacheWrite: Schema.optionalKey(
    Schema.Finite.annotate({
      description: "Dollars per million tokens written to cache; 1.25 times input when absent.",
    }),
  ),
}) {}

export class NotifySettings extends Schema.Class<NotifySettings>("NotifySettings")({
  webhook: Schema.optionalKey(
    Schema.String.annotate({
      description: 'Gets a JSON POST of each notice, with "text" and "content" for Slack and Discord.',
    }),
  ),
  command: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Runs in the shell with SLOPMAX_EVENT, SLOPMAX_PROVIDER, SLOPMAX_ACCOUNT, SLOPMAX_UNTIL and SLOPMAX_MESSAGE set.",
    }),
  ),
  events: Schema.Array(NoticeKind)
    .annotate({
      description: 'The kinds to send; add "limited" and "available" to hear about each account.',
      default: defaultNoticeKinds,
    })
    .pipe(withDefault(defaultNoticeKinds)),
}) {
  /** Nothing set up: notices go nowhere, and the default kinds would be sent. */
  static readonly empty: NotifySettings = Schema.decodeUnknownSync(NotifySettings)({})

  /** Whether anywhere is set up to receive notices. */
  get enabled(): boolean {
    return this.webhook !== undefined || this.command !== undefined
  }

  /** Whether notices of `kind` are sent: the test always is; an empty list means the default kinds. */
  wants(kind: NoticeKind): boolean {
    if (kind === "test") return true
    return (this.events.length === 0 ? defaultNoticeKinds : this.events).includes(kind)
  }
}

const strategyHelp = [
  "How a new session picks its account:",
  "reset-first spends the quota that resets soonest, so none is lost;",
  "fill-first drains accounts in priority order (plain failover);",
  "least-used spreads sessions over the least used accounts;",
  "round-robin hands sessions to each account in turn.",
].join(" ")

export class Settings extends Schema.Class<Settings>("Settings")({
  $schema: Schema.optionalKey(Schema.String.annotate({ description: "The JSON Schema editors check this file with." })),
  listen: Schema.String.annotate({
    description: "Address the proxy listens on, as host:port. Needs a restart.",
    default: defaultListen,
  })
    .check(isListen)
    .pipe(withDefault(defaultListen)),
  // The same as `Secret`, described on the text the file holds.
  apiKey: Schema.RedactedFromValue(
    Schema.String.annotate({
      description:
        "The owner key: agents present it to the proxy, and only it reaches slopmax's own API. Made on first run.",
    }),
  ).pipe(withDefault("")),
  strategy: Strategy.annotate({
    description: strategyHelp,
    default: "reset-first",
    live: { summary: "How a new session picks its account: reset-first, fill-first, least-used, or round-robin" },
  }).pipe(withDefault("reset-first")),
  sessionAffinity: Schema.Boolean.annotate({
    description:
      "Keep a session on the account it started on while that account can serve, so the provider's prompt cache stays warm. Off, every request is placed by the strategy. A client can decide per request with the header `x-slopmax-affinity: on` or `off`.",
    default: true,
    live: { summary: "Keep a session on its account, for the prompt cache" },
  }).pipe(withDefault(true)),
  sessionMinutes: PositiveInt.annotate({
    description: "Minutes a session stays on its account after its last request.",
    default: 60,
    live: { summary: "Idle minutes before a session's account is forgotten" },
  }).pipe(withDefault(60)),
  redeemExpiring: Schema.Boolean.annotate({
    description:
      "Redeem a ChatGPT limit reset in its last hours, if the account has usage to reset, rather than let it expire unused.",
    default: true,
    live: { summary: "Redeem a limit reset before it expires unused" },
  }).pipe(withDefault(true)),
  redeemWhenExhausted: Schema.Boolean.annotate({
    description: "When every Codex account is spent, redeem a limit reset instead of failing the request.",
    default: false,
    live: { summary: "Redeem one when every account is spent" },
  }).pipe(withDefault(false)),
  warmWindows: Schema.Boolean.annotate({
    description:
      "ChatGPT starts a 5-hour window at an account's first request. With this on, an idle account gets one tiny request as soon as its window resets, so its next reset comes sooner. Claude accounts are never warmed.",
    default: false,
    live: { summary: "Start idle ChatGPT accounts' windows as they reset" },
  }).pipe(withDefault(false)),
  paidOverflow: Schema.Boolean.annotate({
    description:
      "Let API keys serve a subscription's models once every subscription account is limited. Off, they serve those models only when asked for by name (`openai/gpt-6-sol`) or when there is no such subscription.",
    default: false,
    live: { summary: "Let API keys take over once subscriptions are limited" },
  }).pipe(withDefault(false)),
  pollMinutes: NonNegativeInt.annotate({
    description: "Minutes between usage polls per account (0 turns polling off).",
    default: 5,
    live: { summary: "Minutes between usage polls (0 turns them off)" },
  }).pipe(withDefault(5)),
  refreshTokens: Schema.Boolean.annotate({
    description:
      "Refresh sign-ins before they expire. Turn this off only while another tool uses the same accounts: every refresh rotates the refresh token.",
    default: true,
    live: { summary: "Refresh sign-ins before they expire" },
  }).pipe(withDefault(true)),
  websockets: Schema.Boolean.annotate({
    description:
      "Relay Codex's WebSocket connections to ChatGPT, which starts answers sooner than HTTP streaming. `slopmax setup codex` turns them on in Codex.",
    default: true,
    live: { summary: "Relay Codex's WebSocket connections" },
  }).pipe(withDefault(true)),
  upstreamProxy: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Proxy for requests to providers, instead of HTTPS_PROXY: http://, socks5:// or socks5h://, such as socks5h://127.0.0.1:1080. Needs a restart.",
    }).check(isProxyUrl),
  ),
  aliases: Schema.Record(Schema.String, Schema.String)
    .annotate({
      description:
        'Model names that stand for others. A name may pick a provider or account: { "fast": "openai/gpt-6-sol" }.',
      default: {},
    })
    .pipe(withDefault({})),
  fallbacks: Schema.Record(Schema.String, Schema.Array(Schema.String))
    .annotate({
      description:
        'Models to try, in order, once a model is limited on every account: { "gpt-6-sol": ["openai/gpt-6-sol"] }.',
      default: {},
    })
    .pipe(withDefault({})),
  prices: Schema.Record(Schema.String, Price)
    .annotate({
      description:
        "API prices for `slopmax usage`, in dollars per million tokens, for models slopmax cannot price. Anthropic's and OpenAI's list prices are built in.",
      default: {},
    })
    .pipe(withDefault({})),
  planPrices: Schema.Record(Schema.String, Schema.Finite)
    .annotate({
      description:
        'What each subscription really costs a month, for what unused quota is worth, such as { "claude/ultra": 200 }. List prices are built in.',
      default: {},
    })
    .pipe(withDefault({})),
  notify: NotifySettings.annotate({
    description:
      "Where notices go: when every account of a provider is limited, recovers, or needs signing in again, when a limit reset would expire unused, and when a week is about to reset with quota unused. Check it with `slopmax notify`.",
  }).pipe(withDefault({})),
  keys: Schema.Array(ClientKey)
    .annotate({
      description:
        "More keys, for other machines and tools, made with `slopmax key add`. Only apiKey reaches slopmax's own API.",
      default: [],
    })
    .pipe(withDefault([])),
}) {}

export type SettingsKey = keyof typeof Settings.fields

/** Reads `config.json`'s contents. Missing keys take their defaults; unknown ones are errors. */
export const decodeSettings = (input: unknown): Effect.Effect<Settings, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Settings)(input, strict)

/** Every setting at its default, with this owner key. */
export const defaultSettings = (apiKey: string): Settings => Schema.decodeUnknownSync(Settings)({ apiKey }, strict)

const encodeSettings = Schema.encodeSync(Settings)

/** The file names the schema beside it, so editors find it. */
export const schemaFileName = "config.schema.json"

const isEmptyCollection = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.length === 0
    : typeof value === "object" && value !== null && Object.keys(value).length === 0

/**
 * The settings as `config.json` holds them: the `$schema` link first, and
 * the lists and tables that are empty left out, so the file shows only what
 * someone set. Notices at their defaults are left out too.
 */
export const settingsFile = (settings: Settings): Record<string, unknown> => {
  const encoded: Record<string, unknown> = { $schema: `./${schemaFileName}`, ...encodeSettings(settings) }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(encoded)) {
    if (key !== "notify" && isEmptyCollection(value)) continue
    if (key === "notify" && !settings.notify.enabled && sameKinds(settings.notify.events, defaultNoticeKinds)) continue
    out[key] = value
  }
  return out
}

const sameKinds = (a: ReadonlyArray<NoticeKind>, b: ReadonlyArray<NoticeKind>) =>
  a.length === b.length && a.every((kind, index) => kind === b[index])

/**
 * `config.schema.json`: the JSON Schema of `config.json`, with every
 * setting's description and default, for editor completion and hover text.
 */
export const settingsJsonSchema = (): JsonSchema.JsonSchema => {
  const { schema, definitions } = Schema.toJsonSchemaDocument(Settings, strict)
  // The settings object itself sits at the root rather than behind a reference.
  const name = typeof schema["$ref"] === "string" ? schema["$ref"].replace("#/$defs/", "") : ""
  const { [name]: root = schema, ...defs } = definitions
  const properties: Record<string, unknown> = isObject(root["properties"]) ? root["properties"] : {}
  return {
    $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12,
    title: "slopmax settings",
    description: "slopmax's config.json. Every setting is optional and takes its default when left out.",
    ...root,
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, described(key, value)])),
    $defs: defs,
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSettingsKey = (key: string): key is SettingsKey => Object.hasOwn(Settings.fields, key)

/**
 * A setting whose JSON Schema is a reference (a nested object) gets its
 * description and default beside the reference. The owner key's default is
 * left out: an empty key only means one is made on first run.
 */
const described = (key: string, property: unknown): unknown => {
  if (!isObject(property) || !isSettingsKey(key)) return property
  const description =
    property["description"] === undefined ? Schema.resolveAnnotations(Settings.fields[key])?.description : undefined
  const fallback = property["default"] === undefined && key !== "apiKey" ? encodedDefaults()[key] : undefined
  return {
    ...property,
    ...(description === undefined ? {} : { description }),
    ...(fallback === undefined ? {} : { default: fallback }),
  }
}

const encodedDefaults = (): Record<string, unknown> => encodeSettings(defaultSettings(""))

const notLive = (name: string) =>
  `${name} is not a setting slopmax changes while it runs; those are ${liveKeys.join(", ")}`

const onOff = (name: string) => Schema.Boolean.annotate({ message: `${name} is on or off` })

const minutes = (name: string, least: 0 | 1) => {
  const message = `${name} is a number of minutes`
  return Schema.Number.annotate({ message }).check(
    Schema.isInt({ message }),
    Schema.isGreaterThanOrEqualTo(least, { message }),
  )
}

/**
 * The settings that may change while slopmax runs, as their own class, each
 * refusing a wrong value in words people read. A test checks they are exactly
 * the fields of `Settings` annotated `live`.
 */
export class LiveSettings extends Schema.Class<LiveSettings>("LiveSettings")({
  strategy: Strategy,
  sessionAffinity: onOff("sessionAffinity"),
  sessionMinutes: minutes("sessionMinutes", 1),
  redeemExpiring: onOff("redeemExpiring"),
  redeemWhenExhausted: onOff("redeemWhenExhausted"),
  warmWindows: onOff("warmWindows"),
  paidOverflow: onOff("paidOverflow"),
  pollMinutes: minutes("pollMinutes", 0),
  refreshTokens: onOff("refreshTokens"),
  websockets: onOff("websockets"),
}) {}

export type LiveKey = keyof typeof LiveSettings.fields

/** The live settings in the order people see them. */
export const liveKeys: ReadonlyArray<LiveKey> = Struct.keys(LiveSettings.fields)

export const isLiveKey = (name: string): name is LiveKey => liveKeys.some((key) => key === name)

/** A change to some live settings. */
export const LivePatch = Schema.Struct(LiveSettings.fields).mapFields(Struct.map(Schema.optionalKey))
export type LivePatch = typeof LivePatch.Type

/**
 * `PATCH /settings`'s body: some live settings and their new values. The
 * whole body is checked before anything is written; a name that is not a
 * live setting, or no setting at all, is refused in words people read.
 */
export const SettingsPatch = Schema.Record(Schema.String, Schema.Unknown)
  .check(
    Schema.makeFilter((body: { readonly [name: string]: unknown }) => {
      const names = Object.keys(body)
      if (names.length === 0) return "no settings to change"
      const other = names.find((name) => !isLiveKey(name))
      return other === undefined || notLive(other)
    }),
  )
  .pipe(Schema.decodeTo(LivePatch, SchemaTransformation.passthroughSupertype()))

/** How a live setting is changed: a switch, a number of minutes, or a choice among names. */
export const LiveKind = Schema.Literals(["switch", "minutes", "choice"])
export type LiveKind = typeof LiveKind.Type

const kindOf = (name: LiveKey): LiveKind => {
  const ast = SchemaAST.toType(LiveSettings.fields[name].ast)
  return SchemaAST.isBoolean(ast) ? "switch" : SchemaAST.isNumber(ast) ? "minutes" : "choice"
}

const yes = ["true", "on", "1", "yes"]
const no = ["false", "off", "0", "no"]

const parseAs = (name: LiveKey, kind: LiveKind, text: string): Result.Result<LivePatch, string> => {
  const value = text.trim()
  const input =
    kind === "switch"
      ? yes.includes(value)
        ? true
        : no.includes(value)
          ? false
          : value
      : kind === "minutes" && /^\d+$/.test(value)
        ? Number(value)
        : value
  return Result.mapError(Schema.decodeUnknownResult(LivePatch)({ [name]: input }), (error) =>
    firstIssueText(error.issue),
  )
}

/** One live setting, as `slopmax config`, the dashboard and the app list it. */
export interface LiveRow {
  readonly name: LiveKey
  readonly summary: string
  readonly kind: LiveKind
  /** Reads a value as people type it, into a patch holding just this setting. */
  readonly parse: (text: string) => Result.Result<LivePatch, string>
}

/** One row per live setting, read from the `live` annotations on `Settings`. */
export const liveTable: ReadonlyArray<LiveRow> = liveKeys.map((name) => {
  const kind = kindOf(name)
  return {
    name,
    summary: Schema.resolveAnnotations(Settings.fields[name])?.live?.summary ?? name,
    kind,
    parse: (text: string) => parseAs(name, kind, text),
  }
})

/**
 * Reads a value for a live setting as people type it: `on`/`off` (or
 * true/false, yes/no, 1/0) for switches, a whole number of minutes, or a
 * strategy's name. The answer is a patch holding just that setting.
 */
export const parseLive = (name: string, text: string): Result.Result<LivePatch, string> =>
  isLiveKey(name) ? parseAs(name, kindOf(name), text) : Result.fail(notLive(name))

/** A live setting's value as `parseLive` reads it back: `on`, `60`, `reset-first`. */
export const liveText = (settings: LiveSettings | Settings, name: LiveKey): string => {
  const value = settings[name]
  return typeof value === "boolean" ? (value ? "on" : "off") : String(value)
}

/** The live settings of a whole settings file. */
export const liveOf = (settings: Settings): LiveSettings => new LiveSettings(Struct.pick(settings, liveKeys))

/** The summaries the strategy choices are offered with. */
export const strategySummaries: { readonly [K in Strategy]: string } = {
  "reset-first": "Spend the quota that resets soonest, so none is lost",
  "fill-first": "Use accounts in priority order; fail over when one is limited",
  "least-used": "Balance load toward the least used account",
  "round-robin": "Take turns across accounts",
}

/** A client key without the key itself, as lists show it. */
export class KeyInfo extends Schema.Class<KeyInfo>("KeyInfo")({
  name: KeyName,
  models: Schema.Array(Schema.String),
}) {}

/** A key just made: the only time its secret is shown. */
export class NewKey extends Schema.Class<NewKey>("NewKey")({
  name: KeyName,
  key: Schema.String,
  models: Schema.Array(Schema.String),
}) {}

const { apiKey: _apiKey, keys: _keys, $schema: _schema, ...publicFields } = Settings.fields

/** The settings without any secret, as the API serves them. */
export class PublicSettings extends Schema.Class<PublicSettings>("PublicSettings")({
  ...publicFields,
  keys: Schema.Array(KeyInfo),
}) {}

export const keyInfo = (key: ClientKey): KeyInfo => new KeyInfo({ name: key.name, models: key.models })

export const toPublic = (settings: Settings): PublicSettings => {
  const { apiKey: _key, keys, $schema: _s, ...rest } = settings
  return new PublicSettings({ ...rest, keys: keys.map(keyInfo) })
}

export class LiveInfo extends Schema.Class<LiveInfo>("LiveInfo")({
  name: Schema.String,
  summary: Schema.String,
  /** Whether a front end shows a switch, a stepper of minutes, or a choice. */
  kind: LiveKind,
}) {}

export class StrategyInfo extends Schema.Class<StrategyInfo>("StrategyInfo")({
  id: Strategy,
  summary: Schema.String,
}) {}

/** `GET /settings`: the settings, what may change live, and what waits for a restart. */
export class SettingsView extends Schema.Class<SettingsView>("SettingsView")({
  settings: PublicSettings,
  live: Schema.Array(LiveInfo),
  strategies: Schema.Array(StrategyInfo),
  /** Settings whose value in the file differs from the one the running proxy uses. */
  restartNeeded: Schema.Array(Schema.String),
}) {}

/** The settings that need a restart to take effect. */
export const restartKeys = ["listen", "upstreamProxy"] as const

/** Which restart-only settings differ between what runs and what the file says now. */
export const restartNeeded = (running: Settings, file: Settings): ReadonlyArray<string> =>
  restartKeys.filter((key) => running[key] !== file[key])

/** `GET /settings`'s answer for the running settings, given what the file says now. */
export const settingsView = (settings: Settings, file: Settings = settings): SettingsView =>
  new SettingsView({
    settings: toPublic(settings),
    live: liveTable.map(({ name, summary, kind }) => new LiveInfo({ name, summary, kind })),
    strategies: Strategy.literals.map((id) => new StrategyInfo({ id, summary: strategySummaries[id] })),
    restartNeeded: restartNeeded(settings, file),
  })
