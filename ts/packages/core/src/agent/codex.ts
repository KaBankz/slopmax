// Codex, wired through a custom model provider in `~/.codex/config.toml`
// (or `-c` overrides for a single run).
import { dirname, join } from "node:path"

import { Effect, Result, Schema } from "effect"

import { Timestamp, TimestampFromString } from "@slopmax/common"
import { json } from "@slopmax/wire"

import { Account } from "../account.ts"
import { expiry } from "../auth/jwt.ts"
import { type Config, Config as Configs } from "../config.ts"
import { Failure, lift } from "../error.ts"
import * as fsx from "../fsx.ts"
import type { Found } from "../import.ts"
import { codexDir } from "../paths.ts"
import { applyClaims } from "../provider/codex/oauth.ts"
import { header, userAgent } from "../proxy/headers.ts"
import * as rawjson from "../proxy/rawjson.ts"
import { opt } from "../serde.ts"
import { Document, isTable, stringRepr, Table, Value } from "../toml.ts"
import { type Agent, shellQuote } from "./mod.ts"

/** Model provider id slopmax adds to Codex's config. */
const PROVIDER = "slopmax"
/** Env var Codex reads the slopmax key from in `run` mode. */
const KEY_ENV = "SLOPMAX_API_KEY"

/**
 * Codex subcommands that run a model session. Each parses its own `-c`
 * flags, and those replace (rather than merge with) root-level ones.
 */
const SESSION_COMMANDS: ReadonlyArray<string> = ["exec", "e", "review", "resume", "fork"]

const tomlString = (s: string): string => stringRepr(s).trim()

const set = (key: string, val: string): ReadonlyArray<string> => ["-c", `${key}=${tomlString(val)}`]

/**
 * `-c` overrides that point Codex at the proxy through a custom provider.
 * Named "OpenAI" so Codex keeps first-party behavior such as remote
 * compaction; `env_key` sends the slopmax key as a bearer token, and
 * `supports_websockets` lets Codex use the faster WebSocket transport.
 */
export const overrides = (config: Config): Array<string> => {
  const base = `${Configs.baseUrl(config)}/codex`
  const args: Array<string> = [...set("model_provider", PROVIDER)]
  for (const [key, val] of [
    ["name", "OpenAI"],
    ["base_url", base],
    ["wire_api", "responses"],
    ["env_key", KEY_ENV],
  ] as const) {
    args.push(...set(`model_providers.${PROVIDER}.${key}`, val))
  }
  if (config.websockets) args.push("-c", `model_providers.${PROVIDER}.supports_websockets=true`)
  return args
}

/**
 * The full Codex argument list: slopmax's overrides at the same level as
 * any the user passes, so neither set drops the other.
 */
export const argv = (config: Config, args: ReadonlyArray<string>): Array<string> => {
  const [command, ...rest] = args
  if (command !== undefined && SESSION_COMMANDS.includes(command)) return [command, ...overrides(config), ...rest]
  return [...overrides(config), ...args]
}

const readToml = (path: string): Effect.Effect<Document, Failure> =>
  Effect.gen(function* () {
    const text = yield* fsx
      .readText(path)
      .pipe(Effect.mapError((cause) => new Failure({ message: `reading ${path}`, cause: lift(cause) })))
    if (text === undefined) return Document.empty()
    const doc = Document.parse(text)
    if (Result.isFailure(doc)) {
      return yield* Effect.fail(new Failure({ message: `parsing ${path}`, cause: doc.failure }))
    }
    return doc.success
  })

const AuthFileSchema = Schema.Struct({
  tokens: opt(
    Schema.Struct({
      idToken: opt(Schema.String),
      accessToken: Schema.String,
      refreshToken: opt(Schema.String),
    }).pipe(Schema.encodeKeys({ idToken: "id_token", accessToken: "access_token", refreshToken: "refresh_token" })),
  ),
  lastRefresh: opt(TimestampFromString),
}).pipe(Schema.encodeKeys({ lastRefresh: "last_refresh" }))

/** The Codex CLI's login in `~/.codex/auth.json`. */
export const accountFrom = Effect.fn("codex.accountFrom")(function* (path: string) {
  const text = yield* fsx.readToString(path).pipe(Effect.mapError(lift))
  const file = yield* fsx
    .parseJson(text, AuthFileSchema)
    .pipe(Effect.mapError((cause) => new Failure({ message: `reading ${path}`, cause: lift(cause) })))
  const tokens = file.tokens
  if (tokens === undefined) {
    return yield* Effect.fail(new Failure({ message: "not a ChatGPT login (API key or proxy auth)" }))
  }
  const expiresAt = expiry(tokens.accessToken)
  const account = Account.make(
    "codex",
    {
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
      ...(tokens.idToken === undefined ? {} : { idToken: tokens.idToken }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(file.lastRefresh === undefined ? {} : { refreshedAt: file.lastRefresh }),
    },
    yield* Timestamp.now,
  )
  return applyClaims(account)
})

/**
 * toml_edit holds dotted keys (`model_providers.slopmax.name = …`) as
 * tables, so replacing or removing the slopmax table drops them as well.
 */
const dropDotted = (doc: Document, providers: Table): void => {
  for (const [name, entry] of doc.root.entries) {
    if (entry.path.length > 2 && entry.path[0] === "model_providers" && entry.path[1] === PROVIDER) {
      doc.root.entries.delete(name)
    }
  }
  for (const [name, entry] of providers.entries) {
    if (entry.path.length > 1 && entry.path[0] === PROVIDER) providers.entries.delete(name)
  }
}

const utf8 = new TextEncoder()

const authFile: Effect.Effect<string> = Effect.map(codexDir, (dir) => join(dir, "auth.json"))

export const Codex: Agent = {
  id: "codex",
  title: "Codex",
  provider: "codex",

  /** Codex's clients name themselves `codex_exec/…`, `codex_cli_rs/…`, and so on. */
  detect: (headers) => userAgent(headers)?.startsWith("codex") ?? false,

  /**
   * Codex sends the same `session-id` for a whole tree of subagents,
   * matching its `prompt_cache_key`, so the tree stays on one account.
   */
  session: (headers, body) => {
    const direct = header(headers, "session-id") ?? header(headers, "session_id")
    if (direct !== undefined) return direct
    const metadata = header(headers, "x-codex-turn-metadata")
    const fromMetadata = metadata === undefined ? undefined : rawjson.findStr(utf8.encode(metadata), ["session_id"])
    return fromMetadata ?? rawjson.findStr(body, ["prompt_cache_key"])
  },

  command: (config, args) => ({
    program: "codex",
    args: argv(config, args),
    env: { [KEY_ENV]: config.apiKey },
    envRemove: [],
  }),

  /**
   * A shell function that goes through `slopmax run`, which places the
   * overrides after any session subcommand (see `argv`).
   */
  env: (_config, exe) => `codex() { ${shellQuote(exe)} run codex "$@"; }\n`,

  configFile: Effect.map(codexDir, (dir) => join(dir, "config.toml")),

  setup: Effect.fn("Codex.setup")(function* (config: Config, file: string, saved: json.Json | undefined) {
    const doc = yield* readToml(file)
    let kept = saved
    if (kept === undefined) {
      const current = doc.get("model_provider")
      const previous = current instanceof Value ? current.asStr() : undefined
      kept = { model_provider: previous === undefined || previous === PROVIDER ? null : previous }
    }
    doc.set("model_provider", Value.of(PROVIDER))

    let providers = doc.get("model_providers")
    if (providers === undefined) {
      const table = Table.make()
      table.implicit = true
      doc.set("model_providers", table)
      providers = table
    }
    if (!(providers instanceof Table)) {
      return yield* Effect.fail(new Failure({ message: "`model_providers` in config.toml is not a table" }))
    }
    dropDotted(doc, providers)
    const table = Table.make()
    table.set("name", Value.of("OpenAI"))
    table.set("base_url", Value.of(`${Configs.baseUrl(config)}/codex`))
    table.set("wire_api", Value.of("responses"))
    table.set("experimental_bearer_token", Value.of(config.apiKey))
    if (config.websockets) table.set("supports_websockets", Value.of(true))
    // Keeps the desktop app's account screens when signed in to Codex;
    // requests still carry the slopmax key, which takes precedence.
    if (yield* fsx.exists(join(dirname(file), "auth.json"))) table.set("requires_openai_auth", Value.of(true))
    providers.set(PROVIDER, table)

    // The file now holds the slopmax key, so it stays private.
    yield* fsx.writePrivate(file, doc.toString()).pipe(Effect.mapError(lift))
    return kept
  }),

  undo: Effect.fn("Codex.undo")(function* (file: string, saved: json.Json) {
    const doc = yield* readToml(file)
    const provider = json.str(json.get(saved, "model_provider"))
    if (provider !== undefined) doc.set("model_provider", Value.of(provider))
    else doc.remove("model_provider")
    const providers = doc.get("model_providers")
    if (providers instanceof Table) {
      providers.remove(PROVIDER)
      dropDotted(doc, providers)
    }
    yield* fsx.writePrivate(file, doc.toString()).pipe(Effect.mapError(lift))
  }),

  setupNote: "Restart Codex. Quit and reopen the Codex (ChatGPT) desktop app, which reads the same config.",

  hasLogin: Effect.gen(function* () {
    const text = yield* fsx.readText(yield* authFile).pipe(Effect.orElseSucceed(() => undefined))
    if (text === undefined) return false
    const file = yield* Effect.option(fsx.parseJson(text, AuthFileSchema))
    return file._tag === "Some" && file.value.tokens !== undefined
  }).pipe(Effect.withSpan("Codex.hasLogin")),

  wiredTo: Effect.gen(function* () {
    const file = join(yield* codexDir, "config.toml")
    const doc = yield* Effect.option(readToml(file))
    if (doc._tag === "None") return undefined
    const data = doc.value.data
    const provider = data.model_provider
    if (typeof provider !== "string") return undefined
    const providers = data.model_providers
    const entry = isTable(providers) ? providers[provider] : undefined
    const base = isTable(entry) ? entry.base_url : undefined
    return typeof base === "string" ? `${provider} (${base})` : provider
  }).pipe(Effect.withSpan("Codex.wiredTo")),

  import: Effect.fn("Codex.import")(function* () {
    const file = yield* authFile
    if (!(yield* fsx.exists(file))) return undefined
    const found: Found = { origin: file, account: yield* Effect.result(accountFrom(file)) }
    return found
  }),
}
