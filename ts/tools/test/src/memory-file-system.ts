// An in-memory FileSystem for store tests. It keeps the POSIX behaviors the
// stores rely on, so a test that passes here passes on a real disk too:
// exclusive create (`wx`) for lock files, rename over an existing file for
// atomic writes, `O_APPEND` for the ledger, modes after the umask for private
// files, and watch events for reloading settings and accounts. The contract
// tests run the same checks against this and the real file system.
import { ByteSize, Effect, FileSystem, Layer, Option, Path, PlatformError, Queue, Result, Stream } from "effect"

type Kind = "File" | "Directory" | "SymbolicLink"

/** One file, directory or link. Hard links share the same node. */
interface Node {
  readonly type: Kind
  data: Uint8Array
  readonly target: string
  mode: number
  uid: number
  gid: number
  atime: number
  mtime: number
  readonly birthtime: number
  readonly ino: bigint
  links: number
}

/** A seeded file: its contents, or its contents and mode. */
export type Seed = string | Uint8Array | { readonly data: string | Uint8Array; readonly mode: number }

export interface Options {
  /** Files present from the start, by absolute path. Missing parents are created. */
  readonly files?: Readonly<Record<string, Seed>> | undefined
  /** Directories present from the start. */
  readonly directories?: ReadonlyArray<string> | undefined
  /** Where temp directories go when no directory is given. Default `/tmp`. */
  readonly tmp?: string | undefined
  /** The working directory relative paths resolve against. Default `/`. */
  readonly cwd?: string | undefined
  /** Applied to the mode of every new file and directory. Default `0o022`. */
  readonly umask?: number | undefined
  readonly uid?: number | undefined
  readonly gid?: number | undefined
  /** Makes a call fail with the returned reason, to test how callers handle a failing disk. */
  readonly fault?:
    ((call: { readonly method: string; readonly path: string }) => PlatformError.SystemErrorTag | undefined) | undefined
}

type Outcome<A> = Result.Result<A, PlatformError.PlatformError>

const typeBits: Record<Kind, number> = { File: 0o100000, Directory: 0o040000, SymbolicLink: 0o120000 }
const encoder = new TextEncoder()
const childPrefix = (dir: string) => (dir === "/" ? "/" : `${dir}/`)
const toBytes = (data: string | Uint8Array): Uint8Array =>
  typeof data === "string" ? encoder.encode(data) : data.slice()

const failure = (
  _tag: PlatformError.SystemErrorTag,
  method: string,
  path: string,
  description: string,
): Outcome<never> =>
  Result.fail(PlatformError.systemError({ _tag, module: "FileSystem", method, pathOrDescriptor: path, description }))

const badArgument = (method: string, description: string) =>
  PlatformError.badArgument({ module: "FileSystem", method, description })

const info = (node: Node): FileSystem.File.Info => {
  const size = node.type === "SymbolicLink" ? encoder.encode(node.target).length : node.data.length
  return {
    type: node.type,
    mtime: Option.some(new Date(node.mtime)),
    atime: Option.some(new Date(node.atime)),
    birthtime: Option.some(new Date(node.birthtime)),
    dev: 1n,
    ino: Option.some(node.ino),
    mode: typeBits[node.type] | node.mode,
    nlink: Option.some(BigInt(node.links)),
    uid: Option.some(node.uid),
    gid: Option.some(node.gid),
    rdev: Option.some(0n),
    size: ByteSize.bytes(size),
    blksize: Option.some(ByteSize.bytes(4096)),
    blocks: Option.some(BigInt(Math.ceil(size / 512))),
  }
}

/** Which reads and writes an open flag allows, and whether it creates, truncates, refuses an existing file, or appends. */
const flagMeaning = (flag: FileSystem.OpenFlag) => ({
  read: flag === "r" || flag.endsWith("+"),
  write: flag !== "r",
  create: flag !== "r" && flag !== "r+",
  exclusive: flag.includes("x"),
  truncate: flag.startsWith("w"),
  append: flag.startsWith("a"),
})

interface Watcher {
  readonly path: string
  readonly directory: boolean
  readonly recursive: boolean
  readonly emit: (event: FileSystem.WatchEvent) => void
}

/** Builds an in-memory FileSystem. Each call starts from its own empty tree. */
export const make = (options: Options = {}): Effect.Effect<FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const path = yield* Effect.provide(Effect.service(Path.Path), Path.layer)
    const umask = options.umask ?? 0o022
    const uid = options.uid ?? 1000
    const gid = options.gid ?? 1000
    const tmp = options.tmp ?? "/tmp"
    const cwd = options.cwd ?? "/"
    const nodes = new Map<string, Node>()
    const watchers = new Set<Watcher>()
    let inodes = 0n
    let temps = 0

    const absolute = (input: string) => path.resolve(cwd, input)
    const parentOf = (input: string) => path.dirname(input)
    const nameOf = (input: string) => path.basename(input)

    const newNode = (type: Kind, mode: number, now: number, target = ""): Node => {
      inodes += 1n
      return {
        type,
        data: new Uint8Array(0),
        target,
        mode: mode & 0o7777,
        uid,
        gid,
        atime: now,
        mtime: now,
        birthtime: now,
        ino: inodes,
        links: 1,
      }
    }

    const notify = (changed: string, _tag: FileSystem.WatchEvent["_tag"]) => {
      for (const watcher of watchers) {
        if (changed === watcher.path) {
          watcher.emit({ _tag, path: nameOf(changed) })
          continue
        }
        if (!watcher.directory || !changed.startsWith(childPrefix(watcher.path))) continue
        const relative = changed.slice(childPrefix(watcher.path).length)
        if (watcher.recursive || !relative.includes("/")) watcher.emit({ _tag, path: relative })
      }
    }

    // Walks `input` one name at a time, following links in the middle of the
    // path (and at the end when `followLast`), and returns the real path. The
    // last name need not exist; every name before it must be a directory.
    const locate = (method: string, input: string, followLast: boolean): Outcome<string> => {
      let parts = absolute(input)
        .split("/")
        .filter((part) => part !== "")
      let current = "/"
      let hops = 0
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index] ?? ""
        const candidate = `${childPrefix(current)}${part}`
        const node = nodes.get(candidate)
        const last = index === parts.length - 1
        if (node?.type === "SymbolicLink" && (!last || followLast)) {
          hops += 1
          if (hops > 40) return failure("BadResource", method, input, "Too many levels of symbolic links")
          const target = path.resolve(current, node.target)
          parts = [...target.split("/").filter((p) => p !== ""), ...parts.slice(index + 1)]
          current = "/"
          index = -1
          continue
        }
        if (!last) {
          if (node === undefined) return failure("NotFound", method, input, "No such file or directory")
          if (node.type !== "Directory") return failure("BadResource", method, input, "Not a directory")
        }
        current = candidate
      }
      return Result.succeed(current)
    }

    const existing = (method: string, input: string, followLast = true): Outcome<readonly [string, Node]> =>
      Result.flatMap(locate(method, input, followLast), (real) => {
        const node = nodes.get(real)
        return node === undefined
          ? failure("NotFound", method, input, "No such file or directory")
          : Result.succeed([real, node] as const)
      })

    const directoryAt = (method: string, input: string): Outcome<string> =>
      Result.flatMap(existing(method, input), ([real, node]) =>
        node.type === "Directory" ? Result.succeed(real) : failure("BadResource", method, input, "Not a directory"),
      )

    /** The real path for something about to be made: its parent must already be a directory. */
    const vacancy = (method: string, input: string): Outcome<string> =>
      Result.gen(function* () {
        const real = yield* locate(method, input, false)
        yield* directoryAt(method, parentOf(real))
        return real
      })

    const children = (dir: string, recursive: boolean): Array<string> => {
      const prefix = childPrefix(dir)
      const found: Array<string> = []
      for (const key of nodes.keys()) {
        if (key === dir || !key.startsWith(prefix)) continue
        const relative = key.slice(prefix.length)
        if (recursive || !relative.includes("/")) found.push(relative)
      }
      return found.toSorted()
    }

    const removeTree = (real: string) => {
      const doomed = [real, ...children(real, true).map((relative) => `${childPrefix(real)}${relative}`)]
      for (const key of doomed.toReversed()) {
        const node = nodes.get(key)
        if (node !== undefined) node.links -= 1
        nodes.delete(key)
        notify(key, "Remove")
      }
    }

    // A file's bytes are a view over a larger buffer that doubles when it
    // fills, so appending a line to the ledger costs the line, not the file.
    // Bytes past the view were never written (shrinking reallocates), so a
    // write past the end reads back zeros in the gap, as on a real disk.
    const writeInto = (node: Node, bytes: Uint8Array, at: number, now: number) => {
      const end = at + bytes.length
      if (end > node.data.length) {
        const capacity = node.data.buffer.byteLength - node.data.byteOffset
        if (end <= capacity) {
          node.data = new Uint8Array(node.data.buffer, node.data.byteOffset, end)
        } else {
          const grown = new Uint8Array(Math.max(end, capacity * 2, 64))
          grown.set(node.data)
          node.data = grown.subarray(0, end)
        }
      }
      node.data.set(bytes, at)
      node.mtime = now
    }

    const resize = (node: Node, length: number, now: number) => {
      const next = new Uint8Array(length)
      next.set(node.data.subarray(0, length))
      node.data = next
      node.mtime = now
    }

    // Opens (and maybe creates) a file the way open(2) does for `flag`.
    const openNode = (
      method: string,
      input: string,
      flag: FileSystem.OpenFlag,
      mode: number | undefined,
      now: number,
      noFollow = false,
    ) =>
      Result.gen(function* () {
        const meaning = flagMeaning(flag)
        // O_EXCL and O_NOFOLLOW look at the last name itself: a link there,
        // even a dangling one, is never followed.
        const named = nodes.get(yield* locate(method, input, false))
        if (named?.type === "SymbolicLink" && noFollow)
          return yield* failure("BadResource", method, input, "Too many levels of symbolic links")
        if (named?.type === "SymbolicLink" && meaning.exclusive)
          return yield* failure("AlreadyExists", method, input, "File exists")
        const real = yield* locate(method, input, true)
        const found = nodes.get(real)
        if (found !== undefined && meaning.exclusive)
          return yield* failure("AlreadyExists", method, input, "File exists")
        if (found?.type === "Directory") return yield* failure("BadResource", method, input, "Is a directory")
        if (found !== undefined) {
          if (meaning.truncate && found.data.length > 0) {
            resize(found, 0, now)
            notify(real, "Update")
          }
          return [real, found] as const
        }
        if (!meaning.create) return yield* failure("NotFound", method, input, "No such file or directory")
        yield* directoryAt(method, parentOf(real))
        const created = newNode("File", (mode ?? 0o666) & ~umask, now)
        nodes.set(real, created)
        notify(real, "Create")
        return [real, created] as const
      })

    const op = <A>(method: string, input: string, body: (now: number) => Outcome<A>) =>
      Effect.clockWith((clock) =>
        Effect.suspend(() => {
          const reason = options.fault?.({ method, path: input })
          if (reason !== undefined) return Effect.fromResult(failure(reason, method, input, "Injected fault"))
          return Effect.fromResult(body(clock.currentTimeMillisUnsafe()))
        }),
      )

    // A handle stops working once the scope it was opened in closes, like a
    // closed descriptor, so a test cannot lean on a file it no longer holds.
    const makeFile = (real: string, node: Node, flag: FileSystem.OpenFlag, isOpen: () => boolean): FileSystem.File => {
      const meaning = flagMeaning(flag)
      let position = 0n
      const handleOp = <A>(method: string, body: (now: number) => Outcome<A>) =>
        op(method, real, (now) => (isOpen() ? body(now) : failure("BadResource", method, real, "Bad file descriptor")))
      const readAt = (method: string, size: number, explicit: bigint | undefined) =>
        handleOp(method, (now) => {
          if (!meaning.read) return failure("BadResource", method, real, "File not open for reading")
          const at = explicit ?? position
          if (at < 0n) return Result.fail(badArgument(method, "Cannot read before the start of the file"))
          const start = Math.min(Number(at), node.data.length)
          const bytes = node.data.slice(start, Math.min(start + size, node.data.length))
          if (explicit === undefined) position = at + BigInt(bytes.length)
          node.atime = now
          return Result.succeed(bytes)
        })
      const write = (method: string, buffer: Uint8Array) =>
        handleOp(method, (now) => {
          if (!meaning.write) return failure("BadResource", method, real, "File not open for writing")
          const at = meaning.append ? node.data.length : Number(position)
          writeInto(node, buffer, at, now)
          if (!meaning.append) position += BigInt(buffer.length)
          notify(real, "Update")
          return Result.succeed(buffer.length)
        })
      return {
        [FileSystem.FileTypeId]: FileSystem.FileTypeId,
        stat: handleOp("stat", () => Result.succeed(info(node))),
        sync: handleOp("sync", () => Result.succeed(undefined)),
        seek: (offset, from) =>
          handleOp("seek", () => {
            const next = from === "start" ? offset : position + offset
            if (next < 0n) return Result.fail(badArgument("seek", "Cannot seek before the start of the file"))
            position = next
            return Result.succeed(next)
          }),
        read: (buffer, readOptions) =>
          Effect.map(readAt("read", buffer.length, readOptions?.position), (bytes) => {
            buffer.set(bytes)
            return bytes.length
          }),
        readAlloc: (size, readOptions) =>
          Effect.map(readAt("readAlloc", size, readOptions?.position), (bytes) =>
            bytes.length === 0 ? Option.none() : Option.some(bytes),
          ),
        truncate: (length) =>
          handleOp("truncate", (now) => {
            if (!meaning.write) return failure("BadResource", "truncate", real, "File not open for writing")
            const size = length ?? 0
            resize(node, size, now)
            if (!meaning.append && position > BigInt(size)) position = BigInt(size)
            notify(real, "Update")
            return Result.succeed(undefined)
          }),
        write: (buffer) => write("write", buffer),
        writeAll: (buffer) => Effect.asVoid(write("writeAll", buffer)),
      }
    }

    const makeDirectory = (input: string, mode: number | undefined, recursive: boolean, now: number) =>
      Result.gen(function* () {
        const dirMode = (mode ?? 0o777) & ~umask
        const create = (at: string) => {
          nodes.set(at, newNode("Directory", dirMode, now))
          notify(at, "Create")
        }
        if (!recursive) {
          const real = yield* locate("makeDirectory", input, false)
          if (nodes.has(real)) return yield* failure("AlreadyExists", "makeDirectory", input, "File exists")
          yield* directoryAt("makeDirectory", parentOf(real))
          create(real)
          return
        }
        // Walk down from the root, following links, creating each missing directory.
        const names = absolute(input)
          .split("/")
          .filter((name) => name !== "")
        let at = "/"
        for (const [index, name] of names.entries()) {
          const next = yield* locate("makeDirectory", `${childPrefix(at)}${name}`, true)
          const found = nodes.get(next)
          if (found === undefined) create(next)
          else if (found.type !== "Directory") {
            return yield* index === names.length - 1
              ? failure("AlreadyExists", "makeDirectory", input, "File exists")
              : failure("BadResource", "makeDirectory", input, "Not a directory")
          }
          at = next
        }
      })

    const makeTempDirectory = (
      fileOptions: { readonly directory?: string | undefined; readonly prefix?: string | undefined } | undefined,
    ) =>
      op("makeTempDirectory", fileOptions?.directory ?? tmp, (now) =>
        Result.gen(function* () {
          const base = yield* directoryAt("makeTempDirectory", fileOptions?.directory ?? tmp)
          let candidate: string
          do {
            temps += 1
            candidate = path.join(base, `${fileOptions?.prefix ?? ""}${temps.toString(36).padStart(6, "0")}`)
          } while (nodes.has(candidate))
          nodes.set(candidate, newNode("Directory", 0o700, now))
          notify(candidate, "Create")
          return candidate
        }),
      )

    const remove = (
      input: string,
      removeOptions?: { readonly recursive?: boolean | undefined; readonly force?: boolean | undefined },
    ) =>
      op("remove", input, () =>
        Result.gen(function* () {
          const real = yield* locate("remove", input, false)
          const node = nodes.get(real)
          if (node === undefined) {
            return removeOptions?.force === true
              ? undefined
              : yield* failure("NotFound", "remove", input, "No such file or directory")
          }
          if (node.type === "Directory" && removeOptions?.recursive !== true) {
            return yield* failure("BadResource", "remove", input, "Is a directory")
          }
          removeTree(real)
          return undefined
        }),
      )

    const makeTempFile = (fileOptions?: {
      readonly directory?: string | undefined
      readonly prefix?: string | undefined
      readonly suffix?: string | undefined
    }) =>
      Effect.flatMap(makeTempDirectory(fileOptions), (dir) =>
        op("makeTempFile", dir, (now) => {
          temps += 1
          const file = path.join(dir, `${temps.toString(16).padStart(12, "0")}${fileOptions?.suffix ?? ""}`)
          nodes.set(file, newNode("File", 0o666 & ~umask, now))
          notify(file, "Create")
          return Result.succeed(file)
        }),
      )

    const copyNode = (from: Node, to: string, now: number) => {
      const copy = newNode(from.type, from.mode, now, from.target)
      copy.data = from.data.slice()
      nodes.set(to, copy)
      notify(to, "Create")
    }

    const watch = (input: string, watchOptions?: FileSystem.WatchOptions) =>
      Stream.callback<FileSystem.WatchEvent, PlatformError.PlatformError>((queue) =>
        Effect.flatMap(
          op("watch", input, () => existing("watch", input)),
          ([real, node]) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                const watcher: Watcher = {
                  path: real,
                  directory: node.type === "Directory",
                  recursive: watchOptions?.recursive ?? false,
                  emit: (event) => {
                    Queue.offerUnsafe(queue, event)
                  },
                }
                watchers.add(watcher)
                watchOptions?.onReady?.()
                return watcher
              }),
              (watcher) => Effect.sync(() => watchers.delete(watcher)),
            ),
        ),
      )

    nodes.set("/", newNode("Directory", 0o755, 0))
    const seed = (at: string, kind: "File" | "Directory", data: Uint8Array, mode: number) => {
      const real = absolute(at)
      for (let dir = parentOf(real); dir !== "/" && !nodes.has(dir); dir = parentOf(dir)) {
        nodes.set(dir, newNode("Directory", 0o755, 0))
      }
      const node = newNode(kind, mode, 0)
      node.data = data
      nodes.set(real, node)
    }
    seed(tmp, "Directory", new Uint8Array(0), 0o1777)
    for (const dir of options.directories ?? []) seed(dir, "Directory", new Uint8Array(0), 0o755)
    for (const [at, contents] of Object.entries(options.files ?? {})) {
      if (typeof contents === "string" || contents instanceof Uint8Array) seed(at, "File", toBytes(contents), 0o644)
      else seed(at, "File", toBytes(contents.data), contents.mode)
    }

    return FileSystem.make({
      access: (input, accessOptions) =>
        op("access", input, () =>
          Result.flatMap(existing("access", input), ([, node]) => {
            const denied =
              (accessOptions?.readable === true && (node.mode & 0o400) === 0) ||
              (accessOptions?.writable === true && (node.mode & 0o200) === 0)
            return denied
              ? failure("PermissionDenied", "access", input, "Permission denied")
              : Result.succeed(undefined)
          }),
        ),
      chmod: (input, mode) =>
        op("chmod", input, () =>
          Result.map(existing("chmod", input), ([real, node]) => {
            node.mode = mode & 0o7777
            notify(real, "Update")
          }),
        ),
      chown: (input, owner, group) =>
        op("chown", input, () =>
          Result.map(existing("chown", input), ([real, node]) => {
            node.uid = owner
            node.gid = group
            notify(real, "Update")
          }),
        ),
      copy: (fromPath, toPath, copyOptions) =>
        op("copy", fromPath, (now) =>
          Result.gen(function* () {
            const [source, node] = yield* existing("copy", fromPath)
            const destination = yield* locate("copy", toPath, true)
            const pairs: Array<readonly [string, string]> = [[source, destination]]
            if (node.type === "Directory") {
              for (const relative of children(source, true)) {
                pairs.push([`${childPrefix(source)}${relative}`, `${childPrefix(destination)}${relative}`])
              }
            }
            if (!nodes.has(parentOf(destination))) yield* makeDirectory(parentOf(destination), undefined, true, now)
            for (const [from, to] of pairs) {
              const original = nodes.get(from)
              if (original === undefined) continue
              const present = nodes.get(to)
              if (original.type === "Directory") {
                if (present === undefined) copyNode(original, to, now)
                continue
              }
              if (present !== undefined && copyOptions?.overwrite !== true) continue
              copyNode(original, to, now)
            }
          }),
        ),
      copyFile: (fromPath, toPath) =>
        op("copyFile", fromPath, (now) =>
          Result.gen(function* () {
            const [, node] = yield* existing("copyFile", fromPath)
            if (node.type !== "File") return yield* failure("BadResource", "copyFile", fromPath, "Is a directory")
            const destination = yield* vacancy("copyFile", toPath)
            const present = nodes.get(destination)
            if (present?.type === "Directory")
              return yield* failure("BadResource", "copyFile", toPath, "Is a directory")
            if (present !== undefined) {
              present.data = node.data.slice()
              present.mtime = now
              notify(destination, "Update")
              return
            }
            copyNode(node, destination, now)
            const copied = nodes.get(destination)
            if (copied !== undefined) copied.mode = node.mode & ~umask
          }),
        ),
      link: (fromPath, toPath) =>
        op("link", fromPath, () =>
          Result.gen(function* () {
            const [, node] = yield* existing("link", fromPath)
            if (node.type === "Directory")
              return yield* failure("PermissionDenied", "link", fromPath, "Operation not permitted")
            const destination = yield* vacancy("link", toPath)
            if (nodes.has(destination)) return yield* failure("AlreadyExists", "link", toPath, "File exists")
            node.links += 1
            nodes.set(destination, node)
            notify(destination, "Create")
          }),
        ),
      lstat: (input) => op("lstat", input, () => Result.map(existing("lstat", input, false), ([, node]) => info(node))),
      makeDirectory: (input, dirOptions) =>
        op("makeDirectory", input, (now) =>
          makeDirectory(input, dirOptions?.mode, dirOptions?.recursive ?? false, now),
        ),
      makeTempDirectory,
      makeTempDirectoryScoped: (dirOptions) =>
        Effect.acquireRelease(makeTempDirectory(dirOptions), (dir) =>
          Effect.orDie(remove(dir, { recursive: true, force: true })),
        ),
      makeTempFile,
      makeTempFileScoped: (fileOptions) =>
        Effect.acquireRelease(makeTempFile(fileOptions), (file) =>
          Effect.orDie(remove(parentOf(file), { recursive: true, force: true })),
        ),
      open: (input, openOptions) => {
        const flag = openOptions?.flag ?? "r"
        return Effect.flatMap(
          op("open", input, (now) => openNode("open", input, flag, openOptions?.mode, now, openOptions?.noFollow)),
          ([real, node]) => {
            let open = true
            return Effect.as(
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  open = false
                }),
              ),
              makeFile(real, node, flag, () => open),
            )
          },
        )
      },
      readDirectory: (input, dirOptions) =>
        op("readDirectory", input, () =>
          Result.map(directoryAt("readDirectory", input), (real) => children(real, dirOptions?.recursive ?? false)),
        ),
      readDirectoryEntries: (input) =>
        op("readDirectoryEntries", input, () =>
          Result.map(directoryAt("readDirectoryEntries", input), (real) =>
            children(real, false).map((name) => ({
              name,
              type: nodes.get(`${childPrefix(real)}${name}`)?.type ?? "Unknown",
            })),
          ),
        ),
      readFile: (input) =>
        op("readFile", input, (now) =>
          Result.flatMap(existing("readFile", input), ([, node]) => {
            if (node.type !== "File") return failure("BadResource", "readFile", input, "Is a directory")
            node.atime = now
            return Result.succeed(node.data.slice())
          }),
        ),
      readLink: (input) =>
        op("readLink", input, () =>
          Result.flatMap(existing("readLink", input, false), ([, node]) =>
            node.type === "SymbolicLink"
              ? Result.succeed(node.target)
              : failure("BadResource", "readLink", input, "Not a symbolic link"),
          ),
        ),
      realPath: (input) => op("realPath", input, () => Result.map(existing("realPath", input), ([real]) => real)),
      remove,
      rename: (oldPath, newPath) =>
        op("rename", oldPath, () =>
          Result.gen(function* () {
            const [source, node] = yield* existing("rename", oldPath, false)
            const destination = yield* vacancy("rename", newPath)
            if (source === destination) return
            if (destination.startsWith(childPrefix(source))) {
              return yield* Result.fail(badArgument("rename", "Cannot move a directory into itself"))
            }
            const present = nodes.get(destination)
            if (present !== undefined) {
              if (node.type === "Directory" && present.type !== "Directory") {
                return yield* failure("BadResource", "rename", newPath, "Not a directory")
              }
              if (node.type !== "Directory" && present.type === "Directory") {
                return yield* failure("BadResource", "rename", newPath, "Is a directory")
              }
              if (present.type === "Directory" && children(destination, false).length > 0) {
                return yield* failure("Unknown", "rename", newPath, "Directory not empty")
              }
              present.links -= 1
              nodes.delete(destination)
            }
            const moved = [source, ...children(source, true).map((relative) => `${childPrefix(source)}${relative}`)]
            for (const from of moved) {
              const moving = nodes.get(from)
              if (moving === undefined) continue
              nodes.delete(from)
              nodes.set(`${destination}${from.slice(source.length)}`, moving)
            }
            notify(source, "Remove")
            notify(destination, "Create")
          }),
        ),
      stat: (input) => op("stat", input, () => Result.map(existing("stat", input), ([, node]) => info(node))),
      symlink: (target, linkPath) =>
        op("symlink", linkPath, (now) =>
          Result.gen(function* () {
            const at = yield* vacancy("symlink", linkPath)
            if (nodes.has(at)) return yield* failure("AlreadyExists", "symlink", linkPath, "File exists")
            nodes.set(at, newNode("SymbolicLink", 0o777, now, target))
            notify(at, "Create")
          }),
        ),
      truncate: (input, length) =>
        op("truncate", input, (now) =>
          Result.flatMap(existing("truncate", input), ([real, node]) => {
            if (node.type !== "File") return failure("BadResource", "truncate", input, "Is a directory")
            resize(node, length ?? 0, now)
            notify(real, "Update")
            return Result.succeed(undefined)
          }),
        ),
      // Numbers are seconds since the epoch, as utimes(2) takes them.
      utimes: (input, atime, mtime) =>
        op("utimes", input, () =>
          Result.map(existing("utimes", input), ([real, node]) => {
            node.atime = typeof atime === "number" ? atime * 1000 : atime.getTime()
            node.mtime = typeof mtime === "number" ? mtime * 1000 : mtime.getTime()
            notify(real, "Update")
          }),
        ),
      watch,
      writeFile: (input, data, writeOptions) =>
        op("writeFile", input, (now) =>
          Result.map(
            openNode("writeFile", input, writeOptions?.flag ?? "w", writeOptions?.mode, now),
            ([real, node]) => {
              const append = flagMeaning(writeOptions?.flag ?? "w").append
              if (data.length > 0) {
                writeInto(node, data, append ? node.data.length : 0, now)
                notify(real, "Update")
              }
            },
          ),
        ),
    })
  })

/** An empty in-memory FileSystem (with `/tmp`), plus the POSIX `Path` service. */
export const layer: Layer.Layer<FileSystem.FileSystem | Path.Path> = Layer.merge(
  Layer.effect(FileSystem.FileSystem, make()),
  Path.layer,
)

/** An in-memory FileSystem seeded with files and directories, plus `Path`. */
export const layerWith = (options: Options): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
  Layer.merge(Layer.effect(FileSystem.FileSystem, make(options)), Path.layer)
