// slopmax's home: where its files live, and the one way they are read and
// written.
//
// Everything in the home holds secrets (tokens, keys) or state another
// process may read at any moment, so every write is private and atomic: a
// sibling temp file, opened 0600, synced, then renamed over the target, in a
// directory created 0700. A reader therefore sees the old file or the new
// one, never half of either. JSON files are pretty-printed with a trailing
// newline so people can read and edit them.
import { issueText } from "@slopmax/domain"
import {
  Config,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  type SchemaAST,
  Stream,
} from "effect"

/** What was being done to a file when it failed. */
export type FileAction = "read" | "write" | "remove" | "list" | "parse" | "watch"

const verbs: { readonly [K in FileAction]: string } = {
  read: "read",
  write: "write",
  remove: "remove",
  list: "list",
  parse: "make sense of",
  watch: "watch",
}

/** Why a cause failed, in one line. */
export const causeText = (cause: unknown): string => {
  if (Schema.isSchemaError(cause)) return issueText(cause.issue)
  if (PlatformError.isPlatformError(cause)) {
    return cause.reason._tag === "NotFound" ? "it does not exist" : (cause.reason.description ?? cause.reason.message)
  }
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** A file in the home could not be read, written, listed, removed or understood. */
export class FileError extends Data.TaggedError("FileError")<{
  readonly path: string
  readonly action: FileAction
  readonly cause: unknown
}> {
  override get message(): string {
    return `could not ${verbs[this.action]} ${this.path}: ${causeText(this.cause)}`
  }
}

/** Where slopmax's files, and the agents' files it reads and edits, are. */
export interface Paths {
  /** `$SLOPMAX_HOME` when set and not empty, else `~/.slopmax`. */
  readonly root: string
  /** The settings (`config.json`). */
  readonly config: string
  /** The settings' JSON Schema, for editors (`config.schema.json`). */
  readonly configSchema: string
  /** One file per account (`accounts/<id>.json`). */
  readonly accounts: string
  /** The daemon's state: health, sessions, pins, notices told. */
  readonly state: string
  /** What agent setup replaced, so it can be undone. */
  readonly backups: string
  /** The ledger, one NDJSON file per UTC month. */
  readonly usage: string
  /** The background daemon's log. */
  readonly log: string
  /** Lock files shared by every slopmax process on this home. */
  readonly locks: string
  /** The person's own home directory, else `.`. */
  readonly user: string
  /** Claude Code's settings: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly claudeDir: string
  /** Codex's home: `$CODEX_HOME`, else `~/.codex`. */
  readonly codexDir: string
  /** CLIProxyAPI's logins, whose tokens slopmax can follow: `~/.cli-proxy-api`. */
  readonly cliProxyApiDir: string
}

/** The directories everything else is found from. */
export interface Dirs {
  readonly root: string
  readonly user: string
  readonly claudeDir?: string | undefined
  readonly codexDir?: string | undefined
}

/** Every path, from the home and the person's own directory. */
export const pathsFor = (path: Path.Path, dirs: Dirs): Paths => {
  const at = (name: string) => path.join(dirs.root, name)
  return {
    root: dirs.root,
    config: at("config.json"),
    configSchema: at("config.schema.json"),
    accounts: at("accounts"),
    state: at("state.json"),
    backups: at("backups.json"),
    usage: at("usage"),
    log: at("slopmax.log"),
    locks: at("locks"),
    user: dirs.user,
    claudeDir: dirs.claudeDir ?? path.join(dirs.user, ".claude"),
    codexDir: dirs.codexDir ?? path.join(dirs.user, ".codex"),
    cliProxyApiDir: path.join(dirs.user, ".cli-proxy-api"),
  }
}

/** An environment variable, counted only when it is set and not empty. */
export const envDir = (name: string): Config.Config<Option.Option<string>> =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value.trim() !== "")))

/** The directories as the environment names them. */
export const dirsFromEnv: Config.Config<Dirs> = Config.all({
  slopmax: envDir("SLOPMAX_HOME"),
  home: envDir("HOME"),
  profile: envDir("USERPROFILE"),
  claude: envDir("CLAUDE_CONFIG_DIR"),
  codex: envDir("CODEX_HOME"),
}).pipe(
  Config.map(({ slopmax, home, profile, claude, codex }) => {
    const user = Option.getOrElse(
      Option.orElse(home, () => profile),
      () => ".",
    )
    return {
      root: Option.getOrElse(slopmax, () => `${user}/.slopmax`),
      user,
      claudeDir: Option.getOrUndefined(claude),
      codexDir: Option.getOrUndefined(codex),
    }
  }),
)

export interface Shape {
  readonly paths: Paths
  /** Reads a JSON file through `schema`; nothing when the file does not exist. */
  readonly read: <S extends Schema.Top>(
    path: string,
    schema: S,
    options?: SchemaAST.ParseOptions,
  ) => Effect.Effect<Option.Option<S["Type"]>, FileError, S["DecodingServices"]>
  /** A file's text; nothing when it does not exist. */
  readonly readText: (path: string) => Effect.Effect<Option.Option<string>, FileError>
  /** A file's bytes as they are read, for files too long to hold whole (the ledger); empty when it does not exist. */
  readonly stream: (path: string) => Stream.Stream<Uint8Array, FileError>
  /** Writes `value` as pretty JSON through `schema`, privately and atomically. */
  readonly write: <S extends Schema.Top>(
    path: string,
    schema: S,
    value: S["Type"],
  ) => Effect.Effect<void, FileError, S["EncodingServices"]>
  /** Writes text privately and atomically. */
  readonly writeText: (path: string, text: string) => Effect.Effect<void, FileError>
  /** Appends to a file opened `O_APPEND`, created 0600, so concurrent appends never interleave inside a line. */
  readonly append: (path: string, text: string) => Effect.Effect<void, FileError>
  /** Removes a file; false when it was not there. */
  readonly remove: (path: string) => Effect.Effect<boolean, FileError>
  /** The names in a directory; none when it does not exist. */
  readonly list: (dir: string) => Effect.Effect<ReadonlyArray<string>, FileError>
  /** Creates a directory and its parents, each new one 0700. */
  readonly privateDir: (dir: string) => Effect.Effect<void, FileError>
  /**
   * The files that changed, each at most once per 100 ms. A file is watched
   * through its directory, so atomic replaces and files that do not exist
   * yet are seen.
   */
  readonly watch: (files: ReadonlyArray<string>) => Stream.Stream<string, FileError>
  /**
   * The directory, at most once per 100 ms, whenever its entries change. It
   * is made (0700) first if missing, so files that appear in it later are
   * seen too.
   */
  readonly watchDir: (dir: string) => Stream.Stream<string, FileError>
}

const encoder = new TextEncoder()

/** A pretty-printed JSON document with a trailing newline. */
export const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// Temp files are named for this process and a counter, so two writes of the
// same file never share a temp file, in this process or another.
let sequence = 0

const isNotFound = (error: PlatformError.PlatformError) => error.reason._tag === "NotFound"

/** Changes reported as `target`, at most once per 100 ms. */
const settled = (
  events: Stream.Stream<FileSystem.WatchEvent, PlatformError.PlatformError>,
  target: string,
): Stream.Stream<string, FileError> =>
  events.pipe(
    Stream.as(target),
    Stream.debounce(Duration.millis(100)),
    Stream.mapError((cause) => new FileError({ path: target, action: "watch", cause })),
  )

/** A home at the given directories, with nothing read from the environment. */
export const makeAt = (dirs: Dirs): Effect.Effect<Shape, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const paths = pathsFor(path, dirs)

    const privateDir = (dir: string) =>
      fs
        .makeDirectory(dir, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => new FileError({ path: dir, action: "write", cause })))

    const readText = Effect.fn("Home.readText")(function* (file: string) {
      return yield* fs.readFileString(file).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<string>())),
        Effect.mapError((cause) => new FileError({ path: file, action: "read", cause })),
      )
    })

    const read = <S extends Schema.Top>(
      file: string,
      schema: S,
      options?: SchemaAST.ParseOptions,
    ): Effect.Effect<Option.Option<S["Type"]>, FileError, S["DecodingServices"]> =>
      readText(file).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none<S["Type"]>()),
            onSome: (text: string) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text, options).pipe(
                Effect.mapError((cause) => new FileError({ path: file, action: "parse", cause })),
                Effect.map(Option.some),
              ),
          }),
        ),
        Effect.withSpan("Home.read"),
      )

    const writeText = Effect.fn("Home.writeText")(function* (file: string, text: string) {
      const dir = path.dirname(file)
      yield* privateDir(dir)
      sequence += 1
      const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${sequence}.tmp`)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(temp, { flag: "w", mode: 0o600 })
          yield* handle.writeAll(encoder.encode(text))
          yield* handle.sync
        }),
      ).pipe(
        Effect.andThen(fs.rename(temp, file)),
        Effect.onError(() => Effect.ignore(fs.remove(temp, { force: true }))),
        Effect.mapError((cause) => new FileError({ path: file, action: "write", cause })),
      )
    })

    const write = <S extends Schema.Top>(
      file: string,
      schema: S,
      value: S["Type"],
    ): Effect.Effect<void, FileError, S["EncodingServices"]> =>
      Schema.encodeEffect(schema)(value).pipe(
        Effect.mapError((cause) => new FileError({ path: file, action: "write", cause })),
        Effect.flatMap((encoded) => writeText(file, prettyJson(encoded))),
        Effect.withSpan("Home.write"),
      )

    const append = Effect.fn("Home.append")(function* (file: string, text: string) {
      yield* privateDir(path.dirname(file))
      yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* fs.open(file, { flag: "a", mode: 0o600 })
          yield* handle.writeAll(encoder.encode(text))
        }),
      ).pipe(Effect.mapError((cause) => new FileError({ path: file, action: "write", cause })))
    })

    const stream = (file: string): Stream.Stream<Uint8Array, FileError> =>
      fs.stream(file).pipe(
        Stream.catchIf(isNotFound, () => Stream.empty),
        Stream.mapError((cause) => new FileError({ path: file, action: "read", cause })),
      )

    const remove = Effect.fn("Home.remove")(function* (file: string) {
      return yield* fs.remove(file).pipe(
        Effect.as(true),
        Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        Effect.mapError((cause) => new FileError({ path: file, action: "remove", cause })),
      )
    })

    const list = Effect.fn("Home.list")(function* (dir: string) {
      return yield* fs.readDirectory(dir).pipe(
        Effect.map((names): ReadonlyArray<string> => names.toSorted()),
        Effect.catchIf(isNotFound, () => Effect.succeed([])),
        Effect.mapError((cause) => new FileError({ path: dir, action: "list", cause })),
      )
    })

    // A file is watched through its directory, keeping the events that name it.
    const watchFile = (file: string): Stream.Stream<string, FileError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const dir = path.dirname(file)
          yield* privateDir(dir)
          const name = path.basename(file)
          return settled(
            Stream.filter(fs.watch(dir), (event) => path.basename(event.path) === name),
            file,
          )
        }),
      )

    const watch = (files: ReadonlyArray<string>): Stream.Stream<string, FileError> =>
      Stream.mergeAll(files.map(watchFile), { concurrency: "unbounded" })

    const watchDir = (dir: string): Stream.Stream<string, FileError> =>
      Stream.unwrap(Effect.as(privateDir(dir), settled(fs.watch(dir), dir)))

    return { paths, read, readText, stream, write, writeText, append, remove, list, privateDir, watch, watchDir }
  })

/** slopmax's home and its files. */
export class Home extends Context.Service<Home, Shape>()("@slopmax/core/Home", {
  make: Effect.flatMap(dirsFromEnv, makeAt),
}) {
  /** The home the environment names (`$SLOPMAX_HOME`, else `~/.slopmax`). */
  static readonly layer: Layer.Layer<Home, Config.ConfigError, FileSystem.FileSystem | Path.Path> = Layer.effect(
    Home,
    Home.make,
  )

  /**
   * A home at `root`, reading nothing from the environment. The person's own
   * directory defaults to the home's parent, so `TestHome`'s `.slopmax`,
   * `.claude` and `.codex` line up.
   */
  static readonly layerAt = (
    root: string,
    others: Partial<Omit<Dirs, "root">> = {},
  ): Layer.Layer<Home, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Home,
      Effect.flatMap(Path.Path, (path) =>
        makeAt({
          root,
          user: others.user ?? path.dirname(root),
          claudeDir: others.claudeDir,
          codexDir: others.codexDir,
        }),
      ),
    )
}
