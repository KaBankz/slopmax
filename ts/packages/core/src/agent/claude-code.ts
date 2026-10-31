// Claude Code, and every app that runs it (the Agent SDK, IDE extensions,
// GUI wrappers): they all read `~/.claude/settings.json`.
import { join } from "node:path"
import process from "node:process"

import { Effect, Result, Schema } from "effect"

import { Timestamp } from "@slopmax/common"
import type { Client } from "@slopmax/net"
import { json } from "@slopmax/wire"

import { Account, Tokens } from "../account.ts"
import { Grant } from "../auth/mod.ts"
import { type Config, Config as Configs } from "../config.ts"
import { Failure, lift } from "../error.ts"
import * as fsx from "../fsx.ts"
import type { Found } from "../import.ts"
import { claudeDir } from "../paths.ts"
import { applyProfile, profile, refresh } from "../provider/claude/oauth.ts"
import { header, userAgent } from "../proxy/headers.ts"
import * as rawjson from "../proxy/rawjson.ts"
import * as proc from "../proc.ts"
import { i64, JsonValue, opt, pretty, swapRemove } from "../serde.ts"
import { type Agent, shellQuote } from "./mod.ts"

/** Settings keys `setup` manages in the `env` block. */
const MANAGED = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
  "ANTHROPIC_API_KEY",
] as const

/**
 * Environment that points Claude Code at the proxy.
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` makes it win over provider
 * variables in `~/.claude/settings.json`.
 */
const env = (config: Config): ReadonlyArray<readonly [string, string]> => [
  ["ANTHROPIC_BASE_URL", Configs.baseUrl(config)],
  ["ANTHROPIC_AUTH_TOKEN", config.apiKey],
  ["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1"],
  ["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1"],
]

const utf8 = new TextEncoder()

const readSettings = (path: string): Effect.Effect<json.JsonObject, Failure> =>
  Effect.gen(function* () {
    // `fsx::read_json`: serde reads the bytes, so it also says where they stop being UTF-8.
    const bytes = yield* fsx.readBytes(path).pipe(Effect.mapError(lift))
    if (bytes === undefined) return {}
    const read = json.read(bytes)
    if (read._tag === "Failure") return yield* Effect.fail(new Failure({ message: read.failure }))
    const value = read.success
    if (!json.isObject(value)) return yield* Effect.fail(new Failure({ message: `${path} is not a JSON object` }))
    return value
  })

const writeSettings = (path: string, settings: json.JsonObject): Effect.Effect<void, Failure> =>
  fsx.writePrivate(path, pretty(settings)).pipe(Effect.mapError(lift))

/** Claude Code's saved login, `claudeAiOauth` in its credentials. */
export interface SavedLogin {
  readonly accessToken: string
  readonly refreshToken?: string | undefined
  /** Milliseconds since the epoch. */
  readonly expiresAt?: number | undefined
}

const SavedLoginSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: opt(Schema.String),
  /** An `i64`, checked below: serde refuses `1.0` and text. */
  expiresAt: opt(JsonValue),
})

/** `serde_json::from_value::<SavedLogin>(…).ok()`. */
const savedLogin = (value: json.Json | undefined): SavedLogin | undefined => {
  if (value === undefined) return undefined
  const decoded = Schema.decodeUnknownResult(SavedLoginSchema)(value)
  if (Result.isFailure(decoded)) return undefined
  const { accessToken, refreshToken, expiresAt } = decoded.success
  if (expiresAt === undefined) return { accessToken, refreshToken }
  const millis = i64(expiresAt)
  return millis === undefined ? undefined : { accessToken, refreshToken, expiresAt: millis }
}

const keychainCredentials: Effect.Effect<string | undefined> =
  process.platform === "darwin"
    ? proc.output("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]).pipe(
        Effect.map((out) => (proc.ExitStatus.success(out.status) ? proc.text(out.stdout) : undefined)),
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.succeed(undefined)

/**
 * Claude Code's login: `~/.claude/.credentials.json`, or the keychain on
 * macOS.
 */
const credentials: Effect.Effect<SavedLogin | undefined> = Effect.gen(function* () {
  const file = join(yield* claudeDir, ".credentials.json")
  const text = (yield* fsx.readText(file).pipe(Effect.orElseSucceed(() => undefined))) ?? (yield* keychainCredentials)
  if (text === undefined) return undefined
  return savedLogin(json.get(json.parse(text), "claudeAiOauth"))
}).pipe(Effect.withSpan("claudeCode.credentials"))

/** The account a saved Claude Code login stands for, with its profile. */
export const accountFrom = Effect.fn("claudeCode.accountFrom")(function* (http: Client, login: SavedLogin) {
  const expiresAt = login.expiresAt === undefined ? undefined : Timestamp.fromMillisecond(login.expiresAt)
  let tokens: Tokens = {
    accessToken: login.accessToken,
    ...(login.refreshToken === undefined ? {} : { refreshToken: login.refreshToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
  const now = yield* Timestamp.now
  if (Tokens.isExpired(tokens, now)) {
    // The profile lookup needs a live token. Refreshing rotates Claude
    // Code's own copy, which is fine once Claude Code uses slopmax.
    const old = tokens.refreshToken
    if (old === undefined) return yield* Effect.fail(new Failure({ message: "login expired; log in again" }))
    const grant = yield* refresh(http, old).pipe(Effect.mapError(lift))
    const fresh = Grant.intoTokens(grant, now)
    tokens = { ...fresh, refreshToken: fresh.refreshToken ?? old }
  }
  const account = Account.make("claude", tokens, now)
  const found = yield* profile(http, account.tokens.accessToken).pipe(
    Effect.mapError((cause) => new Failure({ message: "could not read the Claude profile", cause })),
  )
  return Account.assignId(applyProfile(account, found))
})

export const ClaudeCode: Agent = {
  id: "claude",
  title: "Claude Code",
  provider: "claude",

  /**
   * Every Claude Code entrypoint (CLI, Agent SDK, IDE, desktop) sends
   * `claude-cli/<version> (external, <entrypoint>)` on API calls and
   * `claude-code/<version>` on its others.
   */
  detect: (headers) => {
    const ua = userAgent(headers)
    return ua !== undefined && (ua.startsWith("claude-cli/") || ua.startsWith("claude-code/"))
  },

  session: (headers, body) => {
    const id = header(headers, "x-claude-code-session-id")
    if (id !== undefined) return id
    const userId = rawjson.findStr(body, ["metadata", "user_id"])
    if (userId === undefined) return undefined
    const inner = rawjson.findStr(utf8.encode(userId), ["session_id"])
    if (inner !== undefined) return inner
    // Legacy form: user_<hash>_account_<uuid>_session_<uuid>.
    const at = userId.lastIndexOf("_session_")
    return at < 0 ? undefined : userId.slice(at + "_session_".length)
  },

  command: (config, args) => ({
    program: "claude",
    args: [...args],
    env: Object.fromEntries(env(config)),
    envRemove: ["ANTHROPIC_API_KEY"],
  }),

  env: (config) => {
    let out = ""
    for (const [k, v] of env(config)) out += `export ${k}=${shellQuote(v)}\n`
    return `${out}unset ANTHROPIC_API_KEY\n`
  },

  configFile: Effect.map(claudeDir, (dir) => join(dir, "settings.json")),

  setup: Effect.fn("ClaudeCode.setup")(function* (config: Config, file: string, saved: json.Json | undefined) {
    const settings = yield* readSettings(file)
    if (!Object.hasOwn(settings, "env")) settings.env = {}
    const block = settings.env
    if (!json.isObject(block)) {
      return yield* Effect.fail(new Failure({ message: "settings.json `env` is not an object" }))
    }
    let kept = saved
    if (kept === undefined) {
      const previous: json.JsonObject = {}
      for (const key of MANAGED) previous[key] = Object.hasOwn(block, key) ? (block[key] ?? null) : null
      kept = previous
    }
    block.ANTHROPIC_BASE_URL = Configs.baseUrl(config)
    block.ANTHROPIC_AUTH_TOKEN = config.apiKey
    block.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
    // An API key alongside the token makes Claude Code warn about conflicts.
    swapRemove(block, "ANTHROPIC_API_KEY")
    // The file now holds the slopmax key, so it stays private.
    yield* writeSettings(file, settings)
    return kept
  }),

  undo: Effect.fn("ClaudeCode.undo")(function* (file: string, saved: json.Json) {
    if (!json.isObject(saved)) {
      return yield* Effect.fail(new Failure({ message: "the saved Claude Code settings are unreadable" }))
    }
    const settings = yield* readSettings(file)
    const block = json.get(settings, "env")
    if (json.isObject(block)) {
      for (const [key, value] of Object.entries(saved)) {
        if (value === null) swapRemove(block, key)
        else block[key] = value
      }
    }
    yield* writeSettings(file, settings)
  }),

  setupNote:
    "Restart Claude Code and the apps that run it. The Claude desktop app's Code " +
    "tab and Cowork keep using the app's own login.",

  hasLogin: Effect.map(credentials, (login) => login !== undefined).pipe(Effect.withSpan("ClaudeCode.hasLogin")),

  wiredTo: Effect.gen(function* () {
    const file = join(yield* claudeDir, "settings.json")
    const settings = yield* Effect.option(readSettings(file))
    if (settings._tag === "None") return undefined
    return json.str(json.get(json.get(settings.value, "env"), "ANTHROPIC_BASE_URL"))
  }).pipe(Effect.withSpan("ClaudeCode.wiredTo")),

  import: Effect.fn("ClaudeCode.import")(function* (http: Client) {
    const login = yield* credentials
    if (login === undefined) return undefined
    const found: Found = { origin: "claude code", account: yield* Effect.result(accountFrom(http, login)) }
    return found
  }),
}
