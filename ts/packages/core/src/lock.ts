// Locks shared by every slopmax process on one home.
//
// Inside a process a lock is a Semaphore per name. Across processes it is a
// file, `locks/<name>.lock`, that exists only while someone holds the lock.
// It names its holder: the pid, the process's start time, and a token for
// this one hold. A waiter that finds the file checks that the pid is alive
// and that its start time still matches; a dead holder, or a pid the system
// has since given to another program, makes the lock stale, and the waiter
// takes it over. There is no age limit on a live holder, so a long refresh is
// never stolen. Release runs in a finalizer, so an interrupted holder never
// leaves its lock behind.
//
// Names in use: `config` (every write of config.json, and the first-run
// key), `account-<id>` (account updates and token refresh), `backups`, and
// `serve` (held by the daemon for its whole life).
import {
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Ref,
  Result,
  Schedule,
  Schema,
  type Scope,
  Semaphore,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { FileError, Home, prettyJson } from "./home.ts"

/** The lock stayed taken for as long as the caller was willing to wait. */
export class LockTimeout extends Data.TaggedError("LockTimeout")<{
  readonly name: string
  /** The process holding it, when known. */
  readonly holder?: number | undefined
}> {
  override get message(): string {
    const by = this.holder === undefined ? "" : ` (held by process ${this.holder})`
    return `timed out waiting for the ${this.name} lock${by}`
  }
}

/** Another slopmax already serves this home: two daemons would both write its state. */
export class AlreadyServing extends Data.TaggedError("AlreadyServing")<{
  /** The serving process, when its lock file names it yet. */
  readonly pid?: number | undefined
}> {
  override get message(): string {
    const by = this.pid === undefined ? "" : ` (process ${this.pid})`
    return `slopmax is already running on this home${by}; stop it first with \`slopmax stop\``
  }
}

/** What a lock file holds. */
export class Holder extends Schema.Class<Holder>("LockHolder")({
  pid: Schema.Int,
  /** The holder's start time as the system reports it; empty when it cannot be read. */
  startedAt: Schema.String,
  /** This one hold, so a holder releases only its own file. */
  token: Schema.String,
}) {}

const decodeHolder = Schema.decodeUnknownOption(Schema.fromJsonString(Holder))

/** Reads a lock file's text; nothing when it is not a holder (empty, or still being written). */
export const parseHolder = (text: string): Option.Option<Holder> => decodeHolder(text)

/**
 * A process's start time from `/proc/<pid>/stat`: field 22, in clock ticks
 * since boot. The command name (field 2) is in parentheses and may hold
 * spaces or parentheses itself, so fields are counted from the last `)`.
 */
export const linuxStartTime = (stat: string): Option.Option<string> => {
  const end = stat.lastIndexOf(")")
  if (end < 0) return Option.none()
  // After the name come field 3 (state) onwards; field 22 is the 20th of them.
  const field = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/)[19]
  return field === undefined || !/^\d+$/.test(field) ? Option.none() : Option.some(field)
}

/** How the lock decides whether a holder is still the process that took the lock. */
export interface Liveness {
  /** Whether a process with this pid exists (one owned by another user counts). */
  readonly alive: (pid: number) => Effect.Effect<boolean>
  /** When the process with this pid started, if the system says. */
  readonly startedAt: (pid: number) => Effect.Effect<Option.Option<string>>
}

const errorCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined

const pidAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.try({
    // Signal 0 checks that the process exists without touching it.
    try: () => process.kill(pid, 0),
    catch: errorCode,
  }).pipe(
    Effect.as(true),
    Effect.catch((code) => Effect.succeed(code === "EPERM")),
  )

/** Liveness read from the system: `/proc` on Linux, `ps` on macOS, the pid alone elsewhere. */
export const systemLiveness: Effect.Effect<
  Liveness,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const startedAt = (pid: number): Effect.Effect<Option.Option<string>> => {
    if (process.platform === "linux") {
      return fs.readFileString(`/proc/${pid}/stat`).pipe(
        Effect.map(linuxStartTime),
        Effect.orElseSucceed(() => Option.none()),
      )
    }
    if (process.platform === "darwin") {
      return spawner.string(ChildProcess.make("ps", ["-o", "lstart=", "-p", String(pid)])).pipe(
        Effect.map((text) => Option.liftPredicate(text.trim(), (started) => started !== "")),
        Effect.orElseSucceed(() => Option.none()),
      )
    }
    return Effect.succeedNone
  }
  return { alive: pidAlive, startedAt }
})

export interface Shape {
  /**
   * Runs `body` holding the lock: a Semaphore per name inside the process,
   * then `locks/<name>.lock` across processes. Waits up to `wait` (60 s).
   */
  readonly with: (
    name: string,
    options?: { readonly wait?: Duration.Input },
  ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E | LockTimeout | FileError, R>
  /** Runs `body` only if the lock is free now; nothing when another holder has it. */
  readonly tryWith: (
    name: string,
  ) => <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E | FileError, R>
  /** Holds the lock until the scope closes, failing at once when it is taken (the daemon's `serve` lock). */
  readonly hold: (name: string) => Effect.Effect<void, AlreadyServing | FileError, Scope.Scope>
}

/** The lock was taken; who holds it, when the file says. */
class Busy extends Data.TaggedError("Busy")<{ readonly holder: Option.Option<Holder> }> {}

const defaultWait = Duration.seconds(60)
const pollEvery = Duration.millis(25)

/** How long a lock file that names no holder may stay so before it counts as abandoned. */
const unnamedGrace = Duration.seconds(10)

const encoder = new TextEncoder()

const isReason = (tag: PlatformError.SystemErrorTag) => (error: PlatformError.PlatformError) =>
  error.reason._tag === tag

const fileError = (file: string, action: "read" | "write" | "remove") => (cause: unknown) =>
  new FileError({ path: file, action, cause })

/** A Semaphore per key, made on first use. */
const semaphores = () => {
  const byKey = new Map<string, Semaphore.Semaphore>()
  return (key: string): Semaphore.Semaphore => {
    const found = byKey.get(key)
    if (found !== undefined) return found
    const made = Semaphore.makeUnsafe(1)
    byKey.set(key, made)
    return made
  }
}

/**
 * What a process knows about its own holds: a Semaphore per lock file, and
 * the tokens of the holds it has now. It is shared by every Lock built in
 * the process (a CLI command beside an in-process daemon, two runtimes), so
 * they exclude each other as two processes do, and none of them takes
 * another's live hold for a stale one. Keyed by the pid holds are written
 * with, so tests that play several processes in one keep them apart.
 */
interface ProcessHolds {
  readonly semaphore: (file: string) => Semaphore.Semaphore
  readonly tokens: Set<string>
}

const holdsByPid = new Map<number, ProcessHolds>()

const holdsOf = (pid: number): ProcessHolds => {
  const found = holdsByPid.get(pid)
  if (found !== undefined) return found
  const made: ProcessHolds = { semaphore: semaphores(), tokens: new Set() }
  holdsByPid.set(pid, made)
  return made
}

/** Takes the name's Semaphore until the scope closes, if it is free now. */
const takeNow = (semaphore: Semaphore.Semaphore): Effect.Effect<boolean, never, Scope.Scope> =>
  Effect.uninterruptible(
    Effect.tap(Semaphore.takeIfAvailable(1)(semaphore), (taken) =>
      taken ? Effect.addFinalizer(() => Semaphore.release(1)(semaphore)) : Effect.void,
    ),
  )

/** Locks within this process only, for tests and for code that never shares a home. */
export const makeMemory: Effect.Effect<Shape> = Effect.sync(() => {
  const semaphore = semaphores()
  return {
    with: (name) => (body) => semaphore(name).withPermits(1)(body),
    tryWith: (name) => (body) => semaphore(name).withPermitsIfAvailable(1)(body),
    hold: (name) =>
      Effect.flatMap(takeNow(semaphore(name)), (taken) =>
        taken ? Effect.void : Effect.fail(new AlreadyServing({ pid: process.pid })),
      ),
  }
})

/** Locks shared with every process on the home, judged live by `liveness`. */
export const makeWith = (
  liveness: Liveness,
  self: number = process.pid,
): Effect.Effect<Shape, never, Home | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const home = yield* Home
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const holds = holdsOf(self)
    const ownStart = Option.getOrElse(yield* liveness.startedAt(self), () => "")
    // The holds this process has now, so a file left with this process's
    // name but none of its tokens is known to be stale.
    const ours = holds.tokens
    let sequence = 0

    const fileOf = (name: string) => path.join(home.paths.locks, `${name}.lock`)
    const semaphore = (name: string) => holds.semaphore(fileOf(name))

    /**
     * Creates the lock file with its holder already written, failing with
     * `AlreadyExists` when it exists. The holder is written to a temp file
     * that is then hard-linked to the lock's name, so the lock file never
     * exists half-written. Where hard links are not supported, the file is
     * created exclusively (`wx`) and written after.
     */
    const create = (file: string, holder: Holder) =>
      Effect.gen(function* () {
        const bytes = encoder.encode(prettyJson(Schema.encodeSync(Holder)(holder)))
        sequence += 1
        const temp = `${file}.${self}.${sequence}.tmp`
        yield* fs.writeFile(temp, bytes, { flag: "w", mode: 0o600 })
        const linked = yield* fs.link(temp, file).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => !isReason("AlreadyExists")(error),
            () => Effect.succeed(false),
          ),
          Effect.ensuring(Effect.ignore(fs.remove(temp, { force: true }))),
        )
        if (!linked) {
          yield* Effect.scoped(
            Effect.flatMap(fs.open(file, { flag: "wx", mode: 0o600 }), (handle) => handle.writeAll(bytes)),
          )
        }
      })

    /** The holder named in the file; none when the file is gone. Unnamed holders are `Some(None)`. */
    const readHolder = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.map((text) => Option.some(parseHolder(text))),
        Effect.catchIf(isReason("NotFound"), () => Effect.succeed(Option.none<Option.Option<Holder>>())),
      )

    const isStale = (file: string, holder: Option.Option<Holder>) =>
      Effect.gen(function* () {
        if (Option.isNone(holder)) {
          // A file being written names no one for a moment; one that stays so
          // was left by a holder that died between creating and writing it.
          const info = yield* fs.stat(file)
          const now = yield* Clock.currentTimeMillis
          const written = Option.getOrElse(
            Option.map(info.mtime, (at) => at.getTime()),
            () => now,
          )
          return now - written > Duration.toMillis(unnamedGrace)
        }
        const { pid, startedAt, token } = holder.value
        if (pid === self && startedAt === ownStart) return !ours.has(token)
        if (!(yield* liveness.alive(pid))) return true
        if (startedAt === "") return false
        const now = yield* liveness.startedAt(pid)
        // A different start time means the pid now belongs to another program.
        return Option.isSome(now) && now.value !== startedAt
      })

    /**
     * Takes over a stale lock by removing its file, so the next try creates
     * it. Takeovers are one at a time, under a guard file made exclusively:
     * the taker reads the lock again under the guard and removes it only if
     * it still names the holder judged stale. Nobody else removes another's
     * lock file, so it cannot change between that read and the removal, and
     * a live hold is never removed or brought back. A guard left by a taker
     * that died mid-takeover is cleared once it is old.
     */
    const steal = (file: string, stale: Option.Option<Holder>) => {
      const guard = `${file}.steal`
      const takeover = Effect.gen(function* () {
        const now = yield* readHolder(file)
        if (Option.isNone(now)) return
        const same = Option.match(stale, {
          onNone: () => Option.isNone(now.value),
          onSome: (judged) => Option.exists(now.value, (holder) => holder.token === judged.token),
        })
        if (same) yield* fs.remove(file, { force: true })
      })
      return fs.writeFile(guard, new Uint8Array(0), { flag: "wx", mode: 0o600 }).pipe(
        Effect.matchEffect({
          onSuccess: () => takeover.pipe(Effect.ensuring(Effect.ignore(fs.remove(guard, { force: true })))),
          onFailure: (error) => (isReason("AlreadyExists")(error) ? clearAbandonedGuard(guard) : Effect.fail(error)),
        }),
      )
    }

    /** Removes a takeover guard that has stood far longer than any takeover takes. */
    const clearAbandonedGuard = (guard: string) =>
      Effect.gen(function* () {
        const info = yield* fs.stat(guard)
        const now = yield* Clock.currentTimeMillis
        const written = Option.getOrElse(
          Option.map(info.mtime, (at) => at.getTime()),
          () => now,
        )
        if (now - written > Duration.toMillis(unnamedGrace)) yield* fs.remove(guard, { force: true })
      }).pipe(Effect.catchIf(isReason("NotFound"), () => Effect.void))

    /** One try at the file: the token held, or `Busy` with whoever holds it. */
    const attempt = (name: string): Effect.Effect<string, Busy | FileError> => {
      const file = fileOf(name)
      return Effect.gen(function* () {
        yield* home.privateDir(home.paths.locks)
        const holder = new Holder({ pid: self, startedAt: ownStart, token: crypto.randomUUID() })
        // Two passes: a stale lock taken over on the first is created on the second.
        for (let pass = 0; pass < 2; pass++) {
          const created = yield* create(file, holder).pipe(
            Effect.as(true),
            Effect.catchIf(isReason("AlreadyExists"), () => Effect.succeed(false)),
          )
          if (created) {
            ours.add(holder.token)
            return holder.token
          }
          const found = yield* readHolder(file)
          if (Option.isNone(found)) continue
          if (!(yield* isStale(file, found.value))) return yield* new Busy({ holder: found.value })
          yield* steal(file, found.value)
        }
        return yield* new Busy({ holder: Option.none() })
      }).pipe(Effect.mapError((error) => (error instanceof Busy ? error : fileError(file, "write")(error))))
    }

    /** Removes the lock file if it is still this hold's. */
    const release = (name: string, token: string) => {
      const file = fileOf(name)
      return Effect.gen(function* () {
        ours.delete(token)
        const found = Option.flatten(yield* readHolder(file))
        if (Option.isSome(found) && found.value.token === token) yield* fs.remove(file, { force: true })
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`could not release the ${name} lock: ${fileError(file, "remove")(cause).message}`),
        ),
      )
    }

    /** Holds the file until the scope closes, waiting up to `wait` for it. */
    const acquireFile = (name: string, wait: Duration.Duration) =>
      Effect.gen(function* () {
        const last = yield* Ref.make(Option.none<Holder>())
        // Each try is short and uninterruptible; the waits between are not, so the timeout ends them.
        return yield* Effect.acquireRelease(attempt(name), (token) => release(name, token)).pipe(
          Effect.tapError((error) => (error instanceof Busy ? Ref.set(last, error.holder) : Effect.void)),
          Effect.retry({ schedule: Schedule.spaced(pollEvery), while: (error) => error instanceof Busy }),
          Effect.catchTag("Busy", () => Effect.never),
          Effect.timeoutOrElse({
            duration: wait,
            orElse: () =>
              Effect.flatMap(Ref.get(last), (holder) =>
                Effect.fail(new LockTimeout({ name, holder: Option.getOrUndefined(Option.map(holder, (h) => h.pid)) })),
              ),
          }),
        )
      })

    const withLock: Shape["with"] = (name, options) => (body) => {
      const wait = Duration.fromInputUnsafe(options?.wait ?? defaultWait)
      return Effect.scoped(
        Effect.gen(function* () {
          const start = yield* Clock.currentTimeMillis
          yield* Semaphore.takeScoped(semaphore(name), 1).pipe(
            Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(new LockTimeout({ name })) }),
          )
          const spent = Duration.millis((yield* Clock.currentTimeMillis) - start)
          yield* acquireFile(name, Duration.max(Duration.zero, Duration.subtract(wait, spent)))
          return yield* body
        }),
      )
    }

    /**
     * Takes the lock if it is free now, holding it until the scope closes;
     * otherwise reports that it is taken, and by which process when known
     * (this one, when its own Semaphore is taken), and holds nothing.
     */
    const takeOrHolder = (
      name: string,
    ): Effect.Effect<Option.Option<{ readonly pid: number | undefined }>, FileError, Scope.Scope> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const local = semaphore(name)
          if (!(yield* Semaphore.takeIfAvailable(1)(local))) return Option.some({ pid: self })
          const outcome = yield* Effect.result(attempt(name))
          if (Result.isSuccess(outcome)) {
            const token = outcome.success
            yield* Effect.addFinalizer(() => Effect.andThen(release(name, token), Semaphore.release(1)(local)))
            return Option.none()
          }
          yield* Semaphore.release(1)(local)
          const error = outcome.failure
          if (error instanceof Busy) return Option.some({ pid: Option.getOrUndefined(error.holder)?.pid })
          return yield* Effect.fail(error)
        }),
      )

    const tryWith: Shape["tryWith"] = (name) => (body) =>
      Effect.scoped(
        Effect.flatMap(takeOrHolder(name), (holder) =>
          Option.isSome(holder) ? Effect.succeedNone : Effect.asSome(body),
        ),
      )

    const hold: Shape["hold"] = (name) =>
      Effect.flatMap(takeOrHolder(name), (holder) =>
        Option.isSome(holder) ? Effect.fail(new AlreadyServing({ pid: holder.value.pid })) : Effect.void,
      )

    return { with: withLock, tryWith, hold }
  })

/** Locks on slopmax's home. */
export class Lock extends Context.Service<Lock, Shape>()("@slopmax/core/Lock", {
  make: Effect.flatMap(systemLiveness, makeWith),
}) {
  static readonly layer: Layer.Layer<
    Lock,
    never,
    Home | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(Lock, Lock.make)

  /** Locks with the given liveness, for tests of stale and reused holders. */
  static readonly layerWith = (
    liveness: Liveness,
    /** The pid this process's holds are written with; tests give each simulated process its own. */
    self?: number,
  ): Layer.Layer<Lock, never, Home | FileSystem.FileSystem | Path.Path> => Layer.effect(Lock, makeWith(liveness, self))

  /** Semaphores only: locks within this process, for tests. */
  static readonly layerMemory: Layer.Layer<Lock> = Layer.effect(Lock, makeMemory)
}
