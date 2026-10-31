// Imports existing logins from Claude Code, Codex, and CLIProxyAPI.
//
// Refresh tokens are single-use, so an imported login and its source share
// one token chain: whichever refreshes first invalidates the other's copy.
// After importing, route the agent through slopmax rather than using the
// source login directly.
import { join } from "node:path"

import { Effect, Result, Schema } from "effect"

import { text as texts, Timestamp } from "@slopmax/common"
import type { Client } from "@slopmax/net"
import { json } from "@slopmax/wire"

import { Account, type Link, type Store, Tokens, without } from "./account.ts"
import { ClaudeCode } from "./agent/claude-code.ts"
import { Codex } from "./agent/codex.ts"
import { expiry } from "./auth/jwt.ts"
import { Failure, lift } from "./error.ts"
import * as fsx from "./fsx.ts"
import { parseTime } from "./limits.ts"
import { cliproxyapiDir } from "./paths.ts"
import { applyProfile, profile } from "./provider/claude/oauth.ts"
import { applyClaims } from "./provider/codex/oauth.ts"
import type { ProviderId } from "./provider/mod.ts"
import { byteOrder, i64, JsonValue, opt, withDefault } from "./serde.ts"

/** Where to import logins from, by its name on the command line. */
export type Source =
  /** Every source below. */
  | "all"
  /** Claude Code's login (~/.claude/.credentials.json or the macOS keychain). */
  | "claude-code"
  /** The Codex CLI login (~/.codex/auth.json). */
  | "codex"
  /** CLIProxyAPI credential files (~/.cli-proxy-api/*.json). */
  | "cliproxyapi"

const SOURCES: ReadonlyArray<Source> = ["all", "claude-code", "codex", "cliproxyapi"]

export const Source = {
  /** The source named `s`, or why not. */
  parse: (s: string): Result.Result<Source, string> => {
    const found = SOURCES.find((source) => source === s)
    return found === undefined ? Result.fail(`unknown source ${texts.debug(s)}`) : Result.succeed(found)
  },
} as const

/** One importable login and where it came from. */
export interface Found {
  readonly origin: string
  readonly account: Result.Result<Account, Failure>
}

/** What became of one found login once saved. */
export interface Saved {
  readonly origin: string
  /** The account and whether it is new, or why the login was skipped. */
  readonly account: Result.Result<readonly [Account, boolean], Failure>
}

/**
 * Saves found logins, merging each into an earlier record of the same
 * identity. With `own`, slopmax refreshes them itself instead of following
 * their source's files.
 */
export const save = (store: Store, found: ReadonlyArray<Found>, own: boolean): Effect.Effect<Array<Saved>> =>
  Effect.forEach(found, (item) =>
    Effect.gen(function* () {
      if (Result.isFailure(item.account)) {
        const saved: Saved = { origin: item.origin, account: Result.fail(item.account.failure) }
        return saved
      }
      const account = own ? without(item.account.success, "link") : item.account.success
      const saved: Saved = { origin: item.origin, account: yield* Effect.result(store.upsert(account)) }
      return saved
    }),
  )

/** Collects importable logins from `source`. Missing sources are skipped. */
export const discover = (http: Client, source: Source): Effect.Effect<Array<Found>> => {
  const wants = (s: Source): boolean => source === "all" || source === s
  return Effect.gen(function* () {
    const found: Array<Found> = []
    for (const [agent, wanted] of [
      [ClaudeCode, "claude-code"],
      [Codex, "codex"],
    ] as const) {
      if (!wants(wanted)) continue
      const login = yield* agent.import(http)
      if (login !== undefined) found.push(login)
    }
    if (wants("cliproxyapi")) found.push(...(yield* fromCliproxyapi(http, yield* cliproxyapiDir)))
    return found
  })
}

/** A CLIProxyAPI credential file. Only the fields slopmax uses are read. */
export const CliProxyFileSchema = Schema.Struct({
  kind: Schema.String,
  accessToken: opt(Schema.String),
  refreshToken: opt(Schema.String),
  idToken: opt(Schema.String),
  expired: opt(Schema.String),
  lastRefresh: opt(Schema.String),
  email: opt(Schema.String),
  accountUuid: opt(Schema.String),
  organizationUuid: opt(Schema.String),
  organizationName: opt(Schema.String),
  accountId: opt(Schema.String),
  planType: opt(Schema.String),
  label: opt(Schema.String),
  disabled: withDefault(Schema.Boolean, false),
  /** A number or numeric text. */
  priority: opt(JsonValue),
}).pipe(
  Schema.encodeKeys({
    kind: "type",
    accessToken: "access_token",
    refreshToken: "refresh_token",
    idToken: "id_token",
    lastRefresh: "last_refresh",
    accountUuid: "account_uuid",
    organizationUuid: "organization_uuid",
    organizationName: "organization_name",
    accountId: "account_id",
    planType: "plan_type",
  }),
)

export type CliProxyFile = typeof CliProxyFileSchema.Type

/**
 * `serde_json::from_str::<CliproxyFile>`: read as serde_json reads it, so a
 * `priority` of `3.0` stays a float.
 */
const parseFile = (text: string): Effect.Effect<CliProxyFile, fsx.IoError> => {
  const read = json.read(text)
  if (Result.isFailure(read)) {
    return Effect.fail(new fsx.IoError({ kind: "InvalidData", code: undefined, message: read.failure }))
  }
  return Schema.decodeUnknownEffect(CliProxyFileSchema)(read.success).pipe(
    Effect.mapError((e) => new fsx.IoError({ kind: "InvalidData", code: undefined, message: e.message })),
  )
}

/** The logins in CLIProxyAPI's credential directory `dir`. */
export const fromCliproxyapi = (http: Client, dir: string): Effect.Effect<Array<Found>> =>
  Effect.gen(function* () {
    const listed = yield* Effect.option(fsx.readDir(dir))
    if (listed._tag === "None") return []
    // `Path::extension`: a name such as `.json` alone has none.
    const paths = listed.value
      .filter((name) => name.endsWith(".json") && name !== ".json")
      // A path as Rust orders `PathBuf`s in one directory: by the bytes of the name.
      .toSorted(byteOrder)
      .map((name) => join(dir, name))

    const found: Array<Found> = []
    for (const path of paths) {
      const text = yield* fsx.readText(path).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) continue
      const file = yield* Effect.option(parseFile(text))
      if (file._tag === "None") continue
      let provider: ProviderId
      if (file.value.kind === "claude") provider = "claude"
      else if (file.value.kind === "codex") provider = "codex"
      else continue
      found.push({ origin: path, account: yield* Effect.result(fromCliproxyFile(http, provider, file.value, path)) })
    }
    return found
  })

/** The tokens a CLIProxyAPI file holds. */
export const cliproxyTokens = (file: CliProxyFile): Result.Result<Tokens, Failure> => {
  const accessToken = file.accessToken
  if (accessToken === undefined) return Result.fail(new Failure({ message: "no access token" }))
  const expiresAt = expiry(accessToken) ?? parseTime(file.expired)
  const refreshedAt = parseTime(file.lastRefresh)
  const refreshToken = file.refreshToken === "" ? undefined : file.refreshToken
  const idToken = file.idToken === "" ? undefined : file.idToken
  return Result.succeed({
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    ...(idToken === undefined ? {} : { idToken }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
  })
}

/** The tokens a linked account's source holds right now. */
export const linkedTokens = (link: Link): Effect.Effect<Tokens, Failure> =>
  Effect.gen(function* () {
    if (link.tool !== "cliproxyapi") {
      return yield* Effect.fail(new Failure({ message: `cannot follow logins from ${link.tool}` }))
    }
    const text = yield* fsx
      .readToString(link.path)
      .pipe(Effect.mapError((e) => new Failure({ message: `reading ${link.path}`, cause: lift(e) })))
    const file = yield* parseFile(text).pipe(
      Effect.mapError((e) => new Failure({ message: `parsing ${link.path}`, cause: lift(e) })),
    )
    return yield* Effect.fromResult(cliproxyTokens(file))
  })

const I64 = /^[+-]?[0-9]+$/

/**
 * `p.as_i64().or_else(|| p.as_str()?.parse().ok()).unwrap_or(0) as i32`:
 * an integer, or integer text, wrapped to 32 bits as Rust's `as` does.
 */
const priorityOf = (value: json.Json | undefined): number => {
  let n: bigint | undefined
  if (i64(value) !== undefined) n = BigInt(typeof value === "number" ? value : (value as json.RawJson).rawJSON)
  else if (typeof value === "string" && I64.test(value)) n = BigInt(value)
  if (n === undefined || n < -(2n ** 63n) || n >= 2n ** 63n) return 0
  return Number(BigInt.asIntN(32, n))
}

const fromCliproxyFile = (
  http: Client,
  provider: ProviderId,
  file: CliProxyFile,
  path: string,
): Effect.Effect<Account, Failure> =>
  Effect.gen(function* () {
    const tokens = yield* Effect.fromResult(cliproxyTokens(file))
    const now = yield* Timestamp.now
    let account: Account = {
      ...Account.make(provider, tokens, now),
      // CLIProxyAPI keeps refreshing its copy; follow it until `slopmax own`.
      link: { tool: "cliproxyapi", path },
      ...(file.email === undefined ? {} : { email: file.email }),
      ...(file.label === undefined ? {} : { label: file.label }),
      disabled: file.disabled,
      priority: priorityOf(file.priority),
    }
    if (provider === "claude") {
      account = {
        ...account,
        ...(file.accountUuid === undefined ? {} : { accountId: file.accountUuid }),
        ...(file.organizationUuid === undefined ? {} : { orgId: file.organizationUuid }),
        ...(file.organizationName === undefined ? {} : { orgName: file.organizationName }),
      }
      if (!Tokens.isExpired(account.tokens, now)) {
        const looked = yield* Effect.result(profile(http, account.tokens.accessToken))
        if (Result.isSuccess(looked)) account = applyProfile(account, looked.success)
      }
    } else if (provider === "codex") {
      account = applyClaims({
        ...account,
        ...(file.accountId === undefined ? {} : { accountId: file.accountId }),
        ...(file.planType === undefined ? {} : { plan: file.planType }),
      })
    }
    // Only subscription logins are imported.
    return Account.assignId(account)
  })
