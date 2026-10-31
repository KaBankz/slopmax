// The running settings: `config.json`, loaded once, kept in a
// SubscriptionRef that every reader asks at the moment it needs a value, and
// reloaded when the file changes.
//
// The first process to start on a new home makes the owner key, under the
// `config` lock, so processes started together all end up with the same one.
// Every write re-reads the file under that lock, changes only what it was
// asked to (the rest of the file stays as people wrote it), checks that the
// result loads, and replaces the file atomically; a file that does not load
// is never rewritten, so a person's broken edit is never lost.
// `listen` and `upstreamProxy` are read once at start (`running`); a changed
// value in the file waits for a restart, which `restartNeeded` reports.
import {
  ClientKey,
  decodeSettings,
  issueText,
  type KeyName,
  Listen,
  LivePatch,
  newKey,
  schemaFileName,
  SettingRejected,
  Settings,
  settingsFile,
  SettingsInvalid,
  settingsJsonSchema,
  slopmaxVersion,
  strict,
} from "@slopmax/domain"
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
  Ref,
  Schedule,
  Schema,
  SchemaIssue,
  type Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { SecureRandom } from "effect/crypto"
import { type FileError, Home, prettyJson } from "./home.ts"
import { Lock, type LockTimeout } from "./lock.ts"

/** What a reload did. */
export type Reloaded = "unchanged" | "applied" | "invalid"

/** The settings that take effect only at start, as this process started with them. */
export interface Running {
  /** Where the proxy listens: `SLOPMAX_LISTEN` when set, else the file's `listen`. */
  readonly listen: string
  /** The proxy for calls to providers, from the file. */
  readonly upstreamProxy: Option.Option<string>
}

export interface Shape {
  /** The settings now. No I/O. */
  readonly get: Effect.Effect<Settings>
  /** The settings now and after every change. */
  readonly changes: Stream.Stream<Settings>
  /** Reads the file again; an invalid file keeps the last good settings. */
  readonly reload: Effect.Effect<Reloaded>
  /** Changes the settings in the file and at once in this process. */
  readonly update: (
    f: (settings: Settings) => Settings,
  ) => Effect.Effect<Settings, SettingsInvalid | FileError | LockTimeout>
  /** Changes some live settings, checked before anything is written. */
  readonly setLive: (
    patch: LivePatch,
  ) => Effect.Effect<Settings, SettingRejected | SettingsInvalid | FileError | LockTimeout>
  /** Makes a client key, optionally limited to some models. */
  readonly addKey: (
    name: KeyName,
    models: ReadonlyArray<string>,
  ) => Effect.Effect<ClientKey, SettingRejected | SettingsInvalid | FileError | LockTimeout>
  /** Removes a client key; false when there was none by that name. */
  readonly removeKey: (name: KeyName) => Effect.Effect<boolean, SettingsInvalid | FileError | LockTimeout>
  /** The proxy's address for agents: `http://host:port`. */
  readonly baseUrl: Effect.Effect<string>
  readonly running: Running
  /**
   * Reloads whenever the file changes (within about 100 ms), and every 30
   * seconds in case a change was missed, until the scope closes.
   */
  readonly follow: Effect.Effect<void, never, Scope.Scope>
}

/**
 * The address agents reach the proxy at. A proxy listening on every
 * address (`0.0.0.0`, `::`) is reached on this machine's loopback, and an
 * IPv6 host is put in brackets.
 */
export const baseUrlOf = (listen: string): string => {
  const colon = listen.lastIndexOf(":")
  const rawHost = colon < 0 ? listen : listen.slice(0, colon)
  const port = colon < 0 ? "" : listen.slice(colon)
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost
  if (host === "0.0.0.0" || host === "::" || host === "") return `http://127.0.0.1${port}`
  return host.includes(":") ? `http://[${host}]${port}` : `http://${host}${port}`
}

/** The web dashboard, with the owner key in the fragment, which browsers never send to the server. */
export const dashboardUrl = (baseUrl: string, apiKey: string): string => `${baseUrl}/slopmax/#key=${apiKey}`

/** What `config.schema.json` is stamped with, so a new release rewrites it. */
export const schemaStamp = `slopmax ${slopmaxVersion}`

/** `config.schema.json`'s contents. */
export const schemaDocument = (): string => prettyJson({ $comment: schemaStamp, ...settingsJsonSchema() })

const SchemaStamp = Schema.Struct({ $comment: Schema.optionalKey(Schema.String) })

const hasKey = (settings: Settings) => Redacted.value(settings.apiKey) !== ""

/** `config.json`'s object, as people wrote it. */
export type Contents = Readonly<Record<string, unknown>>

const isContents = (value: unknown): value is Contents =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The file's text for these contents: the schema link first, then the settings as written. */
export const contentsText = (contents: Contents): string => {
  const { $schema: _link, ...rest } = contents
  return prettyJson({ $schema: `./${schemaFileName}`, ...rest })
}

/**
 * The file's contents after a change from `before` to `after`: each setting
 * that changed is written, each one `after` leaves out (an empty list, a
 * cleared proxy) is removed, and everything else stays as it was written.
 */
export const editContents = (contents: Contents, before: Settings, after: Settings): Contents => {
  const was = settingsFile(before)
  const now = settingsFile(after)
  const out: Record<string, unknown> = { ...contents }
  for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (key === "$schema") continue
    if (!(key in now)) delete out[key]
    else if (JSON.stringify(now[key]) !== JSON.stringify(was[key])) out[key] = now[key]
  }
  return out
}

/** Reads a file's text as contents and settings, explaining what is wrong when they do not load. */
export const parseSettings = (
  path: string,
  text: string,
): Effect.Effect<{ readonly contents: Contents; readonly settings: Settings }, SettingsInvalid> =>
  Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) =>
      new SettingsInvalid({ path, issue: `not JSON: ${cause instanceof Error ? cause.message : String(cause)}` }),
  }).pipe(
    Effect.flatMap((json) =>
      decodeSettings(json).pipe(
        Effect.mapError((error) => new SettingsInvalid({ path, issue: issueText(error.issue) })),
        Effect.map((settings) => ({ contents: isContents(json) ? json : {}, settings })),
      ),
    ),
  )

const checkListen = (value: string): Effect.Effect<string, SettingsInvalid> =>
  Schema.decodeUnknownEffect(Listen)(value).pipe(
    Effect.mapError(
      (error) =>
        new SettingsInvalid({
          path: "SLOPMAX_LISTEN",
          issue: issueText(error.issue),
          message: `SLOPMAX_LISTEN=${JSON.stringify(value)} is not an address`,
        }),
    ),
  )

const firstMessage = (issue: SchemaIssue.Issue): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(issue).issues[0]?.message ?? issueText(issue)

/** A change to the file: from what it says, and the settings it loads as, to what it should say. */
type Edit<E> = (contents: Contents, current: Settings) => Effect.Effect<Contents, E>

const encodeKeys = Schema.encodeSync(Schema.Array(ClientKey))

/** The edits behind each change, shared by the file and the in-memory settings. */
const edits = {
  update:
    (f: (settings: Settings) => Settings): Edit<never> =>
    (contents, current) =>
      Effect.succeed(editContents(contents, current, f(current))),
  setLive:
    (patch: LivePatch): Edit<SettingRejected> =>
    (contents) =>
      Schema.decodeUnknownEffect(LivePatch)(patch).pipe(
        Effect.mapError(
          (error) =>
            new SettingRejected({ name: Object.keys(patch)[0] ?? "settings", reason: firstMessage(error.issue) }),
        ),
        Effect.map((checked) => ({ ...contents, ...checked })),
      ),
  addKey:
    (name: KeyName, key: string, models: ReadonlyArray<string>): Edit<SettingRejected> =>
    (contents, current) =>
      current.keys.some((existing) => existing.name === name)
        ? Effect.fail(new SettingRejected({ name, reason: `a key named ${JSON.stringify(name)} already exists` }))
        : Effect.succeed({ ...contents, keys: [...encodeKeys(current.keys), { name, key, models }] }),
  removeKey:
    (name: KeyName): Edit<never> =>
    (contents, current) => {
      const kept = current.keys.filter((existing) => existing.name !== name)
      if (kept.length === current.keys.length) return Effect.succeed(contents)
      const { keys: _keys, ...rest } = contents
      return Effect.succeed(kept.length === 0 ? rest : { ...rest, keys: encodeKeys(kept) })
    },
}

/** Applies an edit and checks the result loads, without writing anything. */
const applyEdit = <E, R>(
  contents: Contents,
  current: Settings,
  edit: Edit<E>,
  rejected: (issue: string) => R,
): Effect.Effect<{ readonly contents: Contents; readonly settings: Settings }, E | R> =>
  Effect.gen(function* () {
    const next = yield* edit(contents, current)
    const settings = yield* decodeSettings(next).pipe(Effect.mapError((error) => rejected(issueText(error.issue))))
    return { contents: next, settings }
  })

/** The settings before and after a change. */
interface Committed {
  readonly before: Settings
  readonly after: Settings
}

/** Commits an edit: rejected ones fail with what `rejected` makes of the issue. */
type Commit = <E, R>(
  edit: Edit<E>,
  rejected: (issue: string) => R,
) => Effect.Effect<Committed, E | R | SettingsInvalid | FileError | LockTimeout>

/** The four changes, built over one way of committing an edit. */
const changesOver = (
  commit: Commit,
  makeKey: Effect.Effect<string>,
): Pick<Shape, "update" | "setLive" | "addKey" | "removeKey"> => ({
  update: Effect.fn("Settings.update")(function* (f: (settings: Settings) => Settings) {
    const { after } = yield* commit(edits.update(f), (issue) => new SettingsInvalid({ path: "config.json", issue }))
    return after
  }),
  setLive: Effect.fn("Settings.setLive")(function* (patch: LivePatch) {
    const name = Object.keys(patch)[0] ?? "settings"
    const { after } = yield* commit(edits.setLive(patch), (reason) => new SettingRejected({ name, reason }))
    return after
  }),
  addKey: Effect.fn("Settings.addKey")(function* (name: KeyName, models: ReadonlyArray<string>) {
    const key = yield* makeKey
    const { after } = yield* commit(edits.addKey(name, key, models), (reason) => new SettingRejected({ name, reason }))
    return (
      after.keys.find((existing) => existing.name === name) ?? new ClientKey({ name, key: Redacted.make(key), models })
    )
  }),
  removeKey: Effect.fn("Settings.removeKey")(function* (name: KeyName) {
    const { before, after } = yield* commit(
      edits.removeKey(name),
      (issue) => new SettingsInvalid({ path: "config.json", issue }),
    )
    return after.keys.length < before.keys.length
  }),
})

const followEvery = "30 seconds"

const make = Effect.gen(function* () {
  const home = yield* Home
  const lock = yield* Lock
  const random = yield* SecureRandom.SecureRandom
  const file = home.paths.config
  const makeKey = Effect.provideService(newKey, SecureRandom.SecureRandom, random)

  /** The file's text, contents and settings; nothing when there is no file. */
  const readFile = home.readText(file).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed(
            Option.none<{ readonly text: string; readonly contents: Contents; readonly settings: Settings }>(),
          ),
        onSome: (text: string) => Effect.map(parseSettings(file, text), (parsed) => Option.some({ text, ...parsed })),
      }),
    ),
  )

  /** Writes the schema beside the file when it is missing or from another release. */
  const ensureSchema = Effect.gen(function* () {
    const stamp = yield* home.read(home.paths.configSchema, SchemaStamp).pipe(Effect.orElseSucceed(() => Option.none()))
    if (Option.isSome(stamp) && stamp.value.$comment === schemaStamp) return
    yield* home.writeText(home.paths.configSchema, schemaDocument())
  })

  // First run: the key is made under the lock, after reading the file again,
  // so a key another process made meanwhile is the one kept.
  const first = yield* readFile
  const loaded =
    Option.isSome(first) && hasKey(first.value.settings)
      ? first.value
      : yield* lock.with("config")(
          Effect.gen(function* () {
            const again = yield* readFile
            if (Option.isSome(again) && hasKey(again.value.settings)) return again.value
            const base = Option.match(again, { onNone: (): Contents => ({}), onSome: ({ contents }) => contents })
            const text = contentsText({ ...base, apiKey: yield* makeKey })
            const parsed = yield* parseSettings(file, text)
            yield* home.writeText(file, text)
            return { text, ...parsed }
          }),
        )
  yield* ensureSchema.pipe(
    Effect.catch((error) => Effect.logWarning(`could not write ${schemaFileName}: ${error.message}`)),
  )

  const fromEnv = yield* Config.option(Config.String("SLOPMAX_LISTEN")).pipe(
    Effect.map(Option.filter((value) => value.trim() !== "")),
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  const running: Running = {
    listen: Option.isSome(fromEnv) ? yield* checkListen(fromEnv.value.trim()) : loaded.settings.listen,
    upstreamProxy: Option.fromUndefinedOr(loaded.settings.upstreamProxy),
  }

  const ref = yield* SubscriptionRef.make(loaded.settings)
  const lastText = yield* Ref.make(loaded.text)
  const lastInvalid = yield* Ref.make(Option.none<string>())

  /** A good file's settings, keeping the running key when the file's is blank. */
  const keepKey = (next: Settings, current: Settings): Settings =>
    hasKey(next) ? next : new Settings({ ...next, apiKey: current.apiKey })

  const reload = Effect.gen(function* () {
    const text = yield* home.readText(file).pipe(Effect.orElseSucceed(() => Option.none<string>()))
    if (Option.isNone(text) || text.value === (yield* Ref.get(lastText))) return "unchanged" as const
    const parsed = yield* Effect.result(parseSettings(file, text.value))
    if (parsed._tag === "Failure") {
      const seen = yield* Ref.get(lastInvalid)
      if (Option.isNone(seen) || seen.value !== text.value) {
        yield* Ref.set(lastInvalid, Option.some(text.value))
        yield* Effect.logWarning(`config.json is invalid, keeping the last good one: ${parsed.failure.issue}`)
      }
      return "invalid" as const
    }
    yield* Ref.set(lastText, text.value)
    yield* Ref.set(lastInvalid, Option.none())
    const current = yield* SubscriptionRef.get(ref)
    const next = keepKey(parsed.success.settings, current)
    if (prettyJson(settingsFile(next)) === prettyJson(settingsFile(current))) return "unchanged" as const
    yield* SubscriptionRef.set(ref, next)
    yield* Effect.logInfo("config.json changed; applying it")
    return "applied" as const
  }).pipe(Effect.withSpan("Settings.reload"))

  // Under the lock: read the file, edit what it says, check the result loads,
  // write it, and set the running settings.
  const commit: Commit = (edit, rejected) =>
    lock.with("config")(
      Effect.gen(function* () {
        const inMemory = yield* SubscriptionRef.get(ref)
        const found = yield* readFile
        const contents = Option.match(found, {
          // A file removed meanwhile is written again with the running key, so the key survives.
          onNone: (): Contents => ({ apiKey: Redacted.value(inMemory.apiKey) }),
          onSome: (read) => read.contents,
        })
        const current = Option.match(found, {
          onNone: () => inMemory,
          onSome: (read) => keepKey(read.settings, inMemory),
        })
        const next = yield* applyEdit(contents, current, edit, rejected)
        const settings = keepKey(next.settings, inMemory)
        // Nothing to change: the file stays exactly as people wrote it, and
        // is taken as read, in case it changed since the last reload.
        if (Option.isSome(found) && JSON.stringify(next.contents) === JSON.stringify(contents)) {
          yield* Ref.set(lastText, found.value.text)
          yield* SubscriptionRef.set(ref, settings)
          return { before: current, after: settings }
        }
        const text = contentsText(next.contents)
        yield* home.writeText(file, text)
        yield* Ref.set(lastText, text)
        yield* SubscriptionRef.set(ref, settings)
        return { before: current, after: settings }
      }),
    )

  const follow: Effect.Effect<void, never, Scope.Scope> = Effect.gen(function* () {
    yield* home.watch([file]).pipe(
      Stream.runForEach(() => reload),
      Effect.catch((error) => Effect.logWarning(`stopped watching config.json: ${error.message}`)),
      Effect.forkScoped,
    )
    yield* reload.pipe(Effect.repeat(Schedule.spaced(followEvery)), Effect.forkScoped)
  })

  const shape: Shape = {
    get: SubscriptionRef.get(ref),
    changes: SubscriptionRef.changes(ref),
    reload,
    ...changesOver(commit, makeKey),
    baseUrl: Effect.succeed(baseUrlOf(running.listen)),
    running,
    follow,
  }
  return shape
})

/** Settings fixed in memory, with no file: what tests and the harness run on. */
export const makeValue = (
  given: Partial<typeof Settings.Encoded>,
): Effect.Effect<Shape, never, SecureRandom.SecureRandom> =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom
    const makeKey = Effect.provideService(newKey, SecureRandom.SecureRandom, random)
    const initial = Schema.decodeUnknownSync(Settings)({ apiKey: "sm-test-key", ...given }, strict)
    const ref = yield* SubscriptionRef.make(initial)
    const commit: Commit = (edit, rejected) =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(ref)
        const next = yield* applyEdit(settingsFile(current), current, edit, rejected)
        yield* SubscriptionRef.set(ref, next.settings)
        return { before: current, after: next.settings }
      })
    const running: Running = {
      listen: initial.listen,
      upstreamProxy: Option.fromUndefinedOr(initial.upstreamProxy),
    }
    const shape: Shape = {
      get: SubscriptionRef.get(ref),
      changes: SubscriptionRef.changes(ref),
      reload: Effect.succeed("unchanged"),
      ...changesOver(commit, makeKey),
      baseUrl: Effect.succeed(baseUrlOf(running.listen)),
      running,
      follow: Effect.void,
    }
    return shape
  })

/** The running settings. */
export class SettingsService extends Context.Service<SettingsService, Shape>()("@slopmax/core/Settings", { make }) {
  /** Settings from `config.json` in the home, made on first run. `SLOPMAX_LISTEN` overrides `listen`. */
  static readonly layer: Layer.Layer<SettingsService, SettingsInvalid | FileError | LockTimeout, Home | Lock> =
    Layer.effect(SettingsService, SettingsService.make).pipe(Layer.provide(SecureRandom.layerWebCrypto))

  /** Settings held in memory, from defaults plus `given` (as `config.json` would write them). No file is read or written. */
  static readonly layerValue = (given: Partial<typeof Settings.Encoded> = {}): Layer.Layer<SettingsService> =>
    Layer.effect(SettingsService, makeValue(given)).pipe(Layer.provide(SecureRandom.layerWebCrypto))
}
