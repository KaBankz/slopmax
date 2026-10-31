// Small filesystem helpers for files holding secrets.
//
// This is the one module that touches the disk through `node:fs`; the rest
// of the core reads and writes through it. Its I/O is asynchronous, so the
// disk never holds up the requests the event loop is serving (the Rust
// moves the same work off its runtime with `spawn_blocking`). Locks are
// `flock(2)` through `bun:ffi`: the lock Rust's `File::lock` takes, so a
// TypeScript and a Rust slopmax sharing a home take turns on the same lock
// files, and the kernel drops a lock when its holder dies.
import { dlopen, FFIType, type Pointer, read as ffiRead } from "bun:ffi"
import { constants } from "node:fs"
import { appendFile, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises"
import { constants as os } from "node:os"
import { basename, dirname } from "node:path"
import process from "node:process"

import { Data, Effect, Schedule, Schema, type Scope } from "effect"

import { json } from "@slopmax/wire"

import { join } from "./paths.ts"
import { compact, pretty } from "./serde.ts"

/** `io::ErrorKind`, as far as slopmax tells them apart. */
export type ErrorKind = "NotFound" | "InvalidData" | "Other"

/** An I/O error, worded as Rust's `io::Error` prints it. */
export class IoError extends Data.TaggedError("IoError")<{
  readonly kind: ErrorKind
  /** The system's code (`ENOENT`), when there is one. */
  readonly code: string | undefined
  readonly message: string
}> {}

const errno: Readonly<Record<string, number | undefined>> = os.errno

// glibc's strerror texts, which Rust's `io::Error` shows.
const STRERROR: Readonly<Record<string, string>> = {
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EIO: "Input/output error",
  EBADF: "Bad file descriptor",
  EAGAIN: "Resource temporarily unavailable",
  EWOULDBLOCK: "Resource temporarily unavailable",
  EACCES: "Permission denied",
  EBUSY: "Device or resource busy",
  EEXIST: "File exists",
  EXDEV: "Invalid cross-device link",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  EINVAL: "Invalid argument",
  EMFILE: "Too many open files",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  ENAMETOOLONG: "File name too long",
  ENOLCK: "No locks available",
  ENOTEMPTY: "Directory not empty",
  ELOOP: "Too many levels of symbolic links",
  EADDRINUSE: "Address already in use",
  EADDRNOTAVAIL: "Cannot assign requested address",
}

/** Rust's text for an OS error code: `No such file or directory (os error 2)`. */
export const osErrorText = (code: string, fallback: string): string => {
  const number = errno[code]
  const text = STRERROR[code]
  if (text === undefined || number === undefined) return fallback
  return `${text} (os error ${number})`
}

const signals: Readonly<Record<string, number | undefined>> = os.signals

/** A signal's number (`SIGINT` is 2). */
export const signalNumber = (name: string): number | undefined => signals[name]

const codeOf = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  return typeof cause.code === "string" ? cause.code : undefined
}

/** A thrown `node:fs` error as an {@link IoError}. */
export const ioError = (cause: unknown): IoError => {
  const code = codeOf(cause)
  const fallback = cause instanceof Error ? cause.message : String(cause)
  return new IoError({
    kind: code === "ENOENT" ? "NotFound" : "Other",
    code,
    message: code === undefined ? fallback : osErrorText(code, fallback),
  })
}

const io = <A>(f: () => Promise<A>): Effect.Effect<A, IoError> => Effect.tryPromise({ try: f, catch: ioError })

const invalidData = (message: string): IoError => new IoError({ kind: "InvalidData", code: undefined, message })

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

/**
 * Creates `dir` and any missing parents, readable only by the owner.
 * Directories that already exist keep their permissions.
 */
export const privateDir = (dir: string): Effect.Effect<void, IoError> =>
  io(() => mkdir(dir, { recursive: true, mode: 0o700 })).pipe(Effect.asVoid)

/**
 * Atomically replaces `path` with `data`, readable only by the owner.
 *
 * Writes to a sibling temp file, syncs it, then renames over the target so
 * readers never observe a partially written file.
 */
export const writePrivate = Effect.fn("fsx.writePrivate")(function* (path: string, data: Uint8Array | string) {
  const dir = dirname(path)
  yield* privateDir(dir)
  const name = basename(path) || "file"
  const tmp = join(dir, `.${name}.${process.pid}.tmp`)
  yield* io(async () => {
    const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tmp, path)
  }).pipe(Effect.tapError(() => Effect.promise(() => rm(tmp, { force: true }).catch(() => undefined))))
})

/** Encodes `value` with `schema` and writes it as pretty JSON with {@link writePrivate}. */
export const writeJson = Effect.fn("fsx.writeJson")(function* <
  S extends Schema.Top & { readonly EncodingServices: never },
>(path: string, schema: S, value: S["Type"]) {
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(Effect.mapError((e) => invalidData(e.message)))
  yield* writePrivate(path, pretty(encoded))
})

/** The file's bytes, or undefined if it does not exist. */
export const readBytes = (path: string): Effect.Effect<Uint8Array | undefined, IoError> =>
  io(() => readFile(path)).pipe(
    Effect.catchIf(
      (e) => e.kind === "NotFound",
      () => Effect.succeed(undefined),
    ),
  )

/**
 * The file's text, or undefined if it does not exist; text that is not
 * UTF-8 is invalid data, as `fs::read_to_string` says.
 */
export const readText = (path: string): Effect.Effect<string | undefined, IoError> =>
  Effect.flatMap(readBytes(path), (bytes) => {
    if (bytes === undefined) return Effect.succeed(undefined)
    try {
      return Effect.succeed(utf8.decode(bytes))
    } catch {
      return Effect.fail(invalidData("stream did not contain valid UTF-8"))
    }
  })

/** `fs::read_to_string`: the file's text; a missing file is a NotFound error. */
export const readToString = (path: string): Effect.Effect<string, IoError> =>
  Effect.flatMap(readText(path), (text) =>
    text === undefined
      ? Effect.fail(new IoError({ kind: "NotFound", code: "ENOENT", message: osErrorText("ENOENT", "not found") }))
      : Effect.succeed(text),
  )

/**
 * The file's lines as `BufReader::lines().map_while(Result::ok)` reads
 * them: split at `\n` (a `\r` before it dropped), ending at the first line
 * that is not UTF-8. Undefined if the file cannot be read.
 */
export const readLines = (path: string): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.map(
    Effect.orElseSucceed(readBytes(path), () => undefined),
    (bytes) => {
      if (bytes === undefined) return undefined
      const lines: Array<string> = []
      let start = 0
      while (start < bytes.length) {
        const newline = bytes.indexOf(0x0a, start)
        let end = newline < 0 ? bytes.length : newline
        if (newline >= 0 && end > start && bytes[end - 1] === 0x0d) end--
        try {
          lines.push(utf8.decode(bytes.subarray(start, end)))
        } catch {
          break
        }
        start = newline < 0 ? bytes.length : newline + 1
      }
      return lines
    },
  )

/** Parses JSON text as serde_json would read it into `schema`, or says why not (InvalidData). */
export const parseJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
): Effect.Effect<S["Type"], IoError> => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    const read = json.read(text)
    return Effect.fail(invalidData(read._tag === "Failure" ? read.failure : "invalid JSON"))
  }
  return Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError((e) => invalidData(e.message)))
}

/** Reads and parses a JSON file, or undefined if it does not exist. */
export const readJson = Effect.fn("fsx.readJson")(function* <
  S extends Schema.Top & { readonly DecodingServices: never },
>(path: string, schema: S) {
  const bytes = yield* readBytes(path)
  if (bytes === undefined) return undefined
  let text: string
  try {
    text = utf8.decode(bytes)
  } catch {
    // serde_json reads bytes and says where they stop being UTF-8.
    return yield* Effect.fail(invalidData(json.scan(bytes) ?? "invalid unicode code point"))
  }
  const value: S["Type"] = yield* parseJson(text, schema)
  return value
})

/**
 * Appends `lines` (each encoded with `schema`, one compact JSON line apiece)
 * to `path`, creating it readable only by the owner.
 */
export const appendLines = Effect.fn("fsx.appendLines")(function* <
  S extends Schema.Top & { readonly EncodingServices: never },
>(path: string, schema: S, lines: ReadonlyArray<S["Type"]>) {
  let text = ""
  for (const line of lines) {
    const encoded = yield* Schema.encodeEffect(schema)(line).pipe(Effect.mapError((e) => invalidData(e.message)))
    text += `${compact(encoded)}\n`
  }
  yield* io(() => appendFile(path, text, { mode: 0o600 }))
})

/** The names in `dir`. */
export const readDir = (dir: string): Effect.Effect<ReadonlyArray<string>, IoError> => io(() => readdir(dir))

/** Removes a file. */
export const removeFile = (path: string): Effect.Effect<void, IoError> => io(() => unlink(path))

/** Whether anything exists at `path` (following symlinks). */
export const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    stat(path).then(
      () => true,
      () => false,
    ),
  )

/** What `fs::metadata` tells (following symlinks), as far as slopmax asks. */
export interface Metadata {
  /** The permission bits and file type, as `PermissionsExt::mode`. */
  readonly mode: number
  readonly isFile: boolean
}

/** `fs::metadata(path).ok()`: undefined when there is nothing to read (or it cannot be). */
export const metadata = (path: string): Effect.Effect<Metadata | undefined> =>
  Effect.promise(() =>
    stat(path).then(
      (s): Metadata | undefined => ({ mode: s.mode, isFile: s.isFile() }),
      () => undefined,
    ),
  )

/** `fs::canonicalize`: the real path, with every symlink followed. */
export const canonicalize = (path: string): Effect.Effect<string, IoError> => io(() => realpath(path))

// ---- locks ------------------------------------------------------------------

const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

interface Libc {
  readonly flock: (fd: number, operation: number) => number
  readonly errno: () => number
}

let libc: Libc | undefined

const loadLibc = (): Libc => {
  if (libc !== undefined) return libc
  const darwin = process.platform === "darwin"
  const errnoSymbol = darwin ? "__error" : "__errno_location"
  const names = darwin
    ? ["libSystem.B.dylib"]
    : ["libc.so.6", "libc.so", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]
  let lastError: unknown
  for (const name of names) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        [errnoSymbol]: { args: [], returns: FFIType.ptr },
      })
      const location = lib.symbols[errnoSymbol]
      const flock = lib.symbols.flock
      if (location === undefined || flock === undefined) continue
      libc = {
        flock: (fd, operation) => flock(fd, operation),
        errno: () => {
          const at = location()
          return at === null ? 0 : ffiRead.i32(at as Pointer, 0)
        },
      }
      return libc
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("libc not found")
}

class Busy extends Data.TaggedError("Busy")<{}> {}

const retryable = new Set([errno.EWOULDBLOCK, errno.EAGAIN, errno.EINTR].filter((n) => n !== undefined))

const loaded = (): Effect.Effect<Libc, IoError> =>
  Effect.try({
    try: loadLibc,
    catch: (error) => new IoError({ kind: "Other", code: undefined, message: String(error) }),
  })

// One try at the lock on `fd`: Busy while another holds it.
const tryLock = (c: Libc, fd: number): Effect.Effect<void, IoError | Busy> =>
  Effect.suspend((): Effect.Effect<void, IoError | Busy> => {
    if (c.flock(fd, LOCK_EX | LOCK_NB) === 0) return Effect.void
    const code = c.errno()
    if (retryable.has(code)) return Effect.fail(new Busy())
    const name = Object.keys(errno).find((key) => errno[key] === code)
    return Effect.fail(
      new IoError({
        kind: "Other",
        code: name,
        message: name === undefined ? `os error ${code}` : osErrorText(name, `os error ${code}`),
      }),
    )
  })

/**
 * Opens (creating if needed) a lock file and takes an exclusive lock on it,
 * waiting while another holds it.
 *
 * The lock is released when the scope closes. Used to keep separate
 * slopmax processes from refreshing the same token concurrently. Waiting
 * polls without blocking the event loop.
 */
export const lock = Effect.fn("fsx.lock")(function* (path: string): Effect.fn.Return<void, IoError, Scope.Scope> {
  yield* privateDir(dirname(path))
  const c = yield* loaded()
  const handle = yield* Effect.acquireRelease(
    io(() => open(path, constants.O_WRONLY | constants.O_CREAT, 0o600)),
    (opened) => Effect.promise(() => opened.close().catch(() => undefined)),
  )
  yield* Effect.acquireRelease(
    tryLock(c, handle.fd).pipe(
      Effect.retry({ schedule: Schedule.spaced("10 millis"), while: (e) => e._tag === "Busy" }),
      Effect.catchTag("Busy", () => Effect.die("lock retries ended")),
    ),
    () => Effect.sync(() => void c.flock(handle.fd, LOCK_UN)),
  )
})
