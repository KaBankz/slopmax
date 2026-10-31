// Bringing in logins people already have: Claude Code's, Codex's, and
// CLIProxyAPI's.
//
// A refresh token is single-use, so an imported login and its source share
// one chain of tokens: whichever refreshes first leaves the other's copy
// dead. Claude Code and Codex are pointed at slopmax afterwards, so slopmax
// owns their logins. CLIProxyAPI keeps refreshing its own, so slopmax
// follows its files instead until `slopmax own` hands a login over.
import type { ProviderId } from "@slopmax/domain"
import { Data, DateTime, Effect, Option, Path, Redacted, Result, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Account, Credential, Identity, Link, Tokens } from "./account.ts"
import { Accounts } from "./accounts.ts"
import { type FileError, Home } from "./home.ts"
import type { LockTimeout } from "./lock.ts"
import * as claude from "./providers/claude.ts"
import * as codex from "./providers/codex.ts"
import {
  newAccount,
  present,
  ProviderFailed,
  type RefreshRevoked,
  type RefreshTransient,
} from "./providers/provider.ts"
import { applyGrant, type CliProxyApiLogin, cliProxyApiTokens, parseCliProxyApiLogin, savedTokens } from "./refresh.ts"
import type { Upstream } from "./upstream.ts"

/** A login that was found but cannot be brought over as it is, or a source nobody knows. */
export class ImportFailed extends Data.TaggedError("ImportFailed")<{ readonly message: string }> {}

/** Why one found login could not be imported: its own problem, or renewing or identifying it failed. */
export type ImportError = ImportFailed | RefreshRevoked | RefreshTransient | ProviderFailed | FileError

/** Why one found login could not be saved. */
export type SaveError = ImportError | LockTimeout

/** Where logins can be imported from. */
export const Source = Schema.Literals(["all", "claude-code", "codex", "cliproxyapi"])
export type Source = typeof Source.Type

/** A source as people type it. */
export const parseSource = (text: string): Result.Result<Source, ImportFailed> =>
  Schema.is(Source)(text)
    ? Result.succeed(text)
    : Result.fail(new ImportFailed({ message: `unknown source ${JSON.stringify(text)}` }))

/** One login found, and where; a broken one says why instead of stopping the import. */
export interface Found {
  readonly origin: string
  readonly account: Result.Result<Account, ImportError>
}

/** What became of one found login: the account and whether it is new, or why it was skipped. */
export interface Saved {
  readonly origin: string
  readonly account: Result.Result<{ readonly account: Account; readonly isNew: boolean }, SaveError>
}

/** What the importers need: the files, the network for profiles, and `security` for the macOS keychain. */
export type ImportServices = Home | Path.Path | Upstream | ChildProcessSpawner.ChildProcessSpawner

// ---------------------------------------------------------------------------
// Claude Code

const ClaudeCodeLogin = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.NullOr(Schema.String)),
    /** Milliseconds since the epoch. */
    expiresAt: Schema.optional(Schema.NullOr(Schema.Finite)),
  }),
})
const parseClaudeCodeLogin = Schema.decodeUnknownOption(Schema.fromJsonString(ClaudeCodeLogin))

/** Claude Code keeps its login in the macOS keychain when there is no credentials file. */
const fromKeychain = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* spawner
    .string(ChildProcess.make("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]))
    .pipe(
      Effect.map((text) => Option.liftPredicate(text.trim(), (found) => found !== "")),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
})

/** Claude Code's login as an account: refreshed first when expired, since reading the profile needs a live token. */
const claudeCodeAccount = (saved: typeof ClaudeCodeLogin.Type) =>
  Effect.gen(function* () {
    const oauth = saved.claudeAiOauth
    const now = yield* DateTime.now
    const stored = new Tokens({
      access: Redacted.make(oauth.accessToken),
      ...(present(oauth.refreshToken) ? { refresh: Redacted.make(oauth.refreshToken) } : {}),
      ...(oauth.expiresAt == null ? {} : { expiresAt: DateTime.makeUnsafe(oauth.expiresAt) }),
    })
    const draft = yield* newAccount({
      provider: "claude",
      credential: Credential.cases.OAuth.make({ tokens: stored }),
      now,
    })
    let tokens = stored
    if (stored.isExpired(now)) {
      // Refreshing rotates Claude Code's own copy, which is fine once Claude Code goes through slopmax.
      if (stored.refresh === undefined) return yield* new ImportFailed({ message: "login expired; log in again" })
      const grant = yield* claude.claude.refresh(draft)
      tokens = Option.getOrElse(applyGrant(draft, grant, now).tokens, () => stored)
    }
    const profile = yield* claude.profile(Redacted.value(tokens.access)).pipe(
      Effect.mapError(
        (error) =>
          new ProviderFailed({
            message: `could not read the Claude profile: ${error.message}`,
            ...(error.status === undefined ? {} : { status: error.status }),
          }),
      ),
    )
    return yield* newAccount({
      provider: "claude",
      credential: Credential.cases.OAuth.make({ tokens }),
      identity: claude.withProfile(new Identity({}), profile),
      now,
    })
  })

/**
 * Claude Code's login: `.credentials.json` in its config directory, else on
 * macOS the keychain. A file that is there, even expired, is used as it is.
 */
export const claudeCodeLogin = (
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<Option.Option<Found>, never, ImportServices> =>
  Effect.gen(function* () {
    const home = yield* Home
    const path = yield* Path.Path
    const file = path.join(home.paths.claudeDir, ".credentials.json")
    const text = yield* home.readText(file).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    const fromFile = Option.isSome(text)
    const found = fromFile ? text : platform === "darwin" ? yield* fromKeychain : Option.none<string>()
    const saved = Option.flatMap(found, parseClaudeCodeLogin)
    if (Option.isNone(saved)) return Option.none()
    const account = yield* Effect.result(claudeCodeAccount(saved.value))
    return Option.some({ origin: fromFile ? file : "the macOS keychain", account })
  }).pipe(Effect.withSpan("importers.claudeCode"))

// ---------------------------------------------------------------------------
// Codex

const CodexLogin = Schema.Struct({
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id_token: Schema.optional(Schema.NullOr(Schema.String)),
        access_token: Schema.String,
        refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  last_refresh: Schema.optional(Schema.NullOr(Schema.String)),
})
const parseCodexLogin = Schema.decodeUnknownOption(Schema.fromJsonString(CodexLogin))

const codexAccount = (path: string, text: string) =>
  Effect.gen(function* () {
    const login = parseCodexLogin(text)
    if (Option.isNone(login)) return yield* new ImportFailed({ message: `${path} is not a Codex login` })
    const saved = login.value.tokens
    if (saved == null) {
      return yield* new ImportFailed({ message: "not a ChatGPT login (an API key or proxy auth)" })
    }
    const tokens = savedTokens({
      access: saved.access_token,
      refresh: saved.refresh_token,
      idToken: saved.id_token,
      lastRefresh: login.value.last_refresh,
    })
    const identity = codex.withClaims(new Identity({}), {
      access: saved.access_token,
      idToken: present(saved.id_token) ? saved.id_token : undefined,
    })
    return yield* newAccount({
      provider: "codex",
      credential: Credential.cases.OAuth.make({ tokens }),
      identity,
      now: yield* DateTime.now,
    })
  })

/** The Codex CLI's login, `auth.json` in its home. */
export const codexLogin: Effect.Effect<Option.Option<Found>, never, Home | Path.Path> = Effect.gen(function* () {
  const home = yield* Home
  const path = yield* Path.Path
  const file = path.join(home.paths.codexDir, "auth.json")
  const text = yield* Effect.result(home.readText(file))
  if (text._tag === "Failure") return Option.some({ origin: file, account: Result.fail(text.failure) })
  if (Option.isNone(text.success)) return Option.none()
  return Option.some({ origin: file, account: yield* Effect.result(codexAccount(file, text.success.value)) })
}).pipe(Effect.withSpan("importers.codex"))

// ---------------------------------------------------------------------------
// CLIProxyAPI

/** A priority as CLIProxyAPI writes it: a number or a number as text; 0 otherwise. */
export const priorityOf = (value: unknown): number => {
  const number =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

const providerOfType = (type: string): Option.Option<Extract<ProviderId, "claude" | "codex">> =>
  type === "claude" ? Option.some("claude") : type === "codex" ? Option.some("codex") : Option.none()

const cliProxyApiAccount = (path: string, provider: "claude" | "codex", login: CliProxyApiLogin) =>
  Effect.gen(function* () {
    const tokens = cliProxyApiTokens(login)
    if (Option.isNone(tokens)) return yield* new ImportFailed({ message: "no access token" })
    const now = yield* DateTime.now
    const base = new Identity(present(login.email) ? { email: login.email } : {})
    const identity =
      provider === "claude"
        ? yield* Effect.gen(function* () {
            const fromFile = new Identity({
              ...base,
              ...(present(login.account_uuid) ? { accountId: login.account_uuid } : {}),
              ...(present(login.organization_uuid) ? { orgId: login.organization_uuid } : {}),
              ...(present(login.organization_name) ? { orgName: login.organization_name } : {}),
            })
            if (tokens.value.isExpired(now)) return fromFile
            return yield* claude.profile(Redacted.value(tokens.value.access)).pipe(
              Effect.map((profile) => claude.withProfile(fromFile, profile)),
              Effect.orElseSucceed(() => fromFile),
            )
          })
        : codex.withClaims(
            new Identity({
              ...base,
              ...(present(login.account_id) ? { accountId: login.account_id } : {}),
              ...(present(login.plan_type) ? { plan: login.plan_type } : {}),
            }),
            {
              access: Redacted.value(tokens.value.access),
              idToken: tokens.value.idToken === undefined ? undefined : Redacted.value(tokens.value.idToken),
            },
          )
    const account = yield* newAccount({
      provider,
      // CLIProxyAPI keeps refreshing its copy; slopmax follows it until `slopmax own`.
      credential: Credential.cases.OAuth.make({
        tokens: tokens.value,
        follows: new Link({ tool: "cliproxyapi", path }),
      }),
      identity,
      now,
    })
    return new Account({
      ...account,
      ...(present(login.label) ? { label: login.label } : {}),
      disabled: login.disabled === true,
      priority: priorityOf(login.priority),
    })
  })

/**
 * CLIProxyAPI's logins: its `*.json` files, in path order. Files that cannot
 * be read or are not logins are skipped, and so are logins of kinds slopmax
 * does not import (only Claude and ChatGPT subscriptions are).
 */
export const cliProxyApiLogins: Effect.Effect<ReadonlyArray<Found>, never, Home | Path.Path | Upstream> = Effect.gen(
  function* () {
    const home = yield* Home
    const path = yield* Path.Path
    const dir = home.paths.cliProxyApiDir
    const names = yield* home.list(dir).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
    const found: Array<Found> = []
    for (const file of names
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(dir, name))
      .toSorted()) {
      const text = yield* home.readText(file).pipe(Effect.orElseSucceed(() => Option.none<string>()))
      const login = Option.flatMap(text, parseCliProxyApiLogin)
      if (Option.isNone(login)) continue
      const provider = providerOfType(login.value.type)
      if (Option.isNone(provider)) continue
      found.push({ origin: file, account: yield* Effect.result(cliProxyApiAccount(file, provider.value, login.value)) })
    }
    return found
  },
).pipe(Effect.withSpan("importers.cliProxyApi"))

// ---------------------------------------------------------------------------
// Importing

const wanted = (source: Source, from: Source) => source === "all" || source === from

/** Every login `source` has: Claude Code's, then Codex's, then CLIProxyAPI's. Missing sources are skipped. */
export const discover = (
  source: Source,
  options?: { readonly platform?: NodeJS.Platform },
): Effect.Effect<ReadonlyArray<Found>, never, ImportServices> =>
  Effect.gen(function* () {
    const found: Array<Found> = []
    if (wanted(source, "claude-code")) found.push(...Option.toArray(yield* claudeCodeLogin(options?.platform)))
    if (wanted(source, "codex")) found.push(...Option.toArray(yield* codexLogin))
    if (wanted(source, "cliproxyapi")) found.push(...(yield* cliProxyApiLogins))
    return found
  })

/** The account without the link to its source: slopmax refreshes it itself from now on. */
export const owned = (account: Account): Account =>
  account.credential._tag === "OAuth" && account.credential.follows !== undefined
    ? new Account({ ...account, credential: Credential.cases.OAuth.make({ tokens: account.credential.tokens }) })
    : account

/** Saves what was found, each merged into an earlier sign-in of the same account. With `own`, links are dropped. */
export const save = (found: ReadonlyArray<Found>, own: boolean): Effect.Effect<ReadonlyArray<Saved>, never, Accounts> =>
  Effect.gen(function* () {
    const accounts = yield* Accounts
    const saved: Array<Saved> = []
    for (const item of found) {
      if (Result.isFailure(item.account)) {
        saved.push({ origin: item.origin, account: Result.fail(item.account.failure) })
        continue
      }
      const account = own ? owned(item.account.success) : item.account.success
      const result = yield* Effect.result(accounts.upsert(account))
      saved.push({ origin: item.origin, account: result })
    }
    return saved
  })
