// The same checks run against MemoryFileSystem and the real disk, so a store
// test that passes in memory means the same thing it would on a real home.
import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  type Layer,
  Option,
  Path,
  type PlatformError,
  type Scope,
  Stream,
} from "effect"
import { TestClock } from "effect/testing"
import { it, MemoryFileSystem } from "../src/index.ts"

type Disk = FileSystem.FileSystem | Path.Path

/** Runs `body` in a fresh temp directory of the file system under test. */
const inTemp = <A, E>(
  body: (root: string, fs: FileSystem.FileSystem, path: Path.Path) => Effect.Effect<A, E, Disk | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "slopmax-fs-contract-" }))
    return yield* body(root, fs, path)
  })

const reason = (error: PlatformError.PlatformError) => error.reason._tag

const contract = (name: string, disk: Layer.Layer<Disk>) => {
  const check = (title: string, body: Parameters<typeof inTemp>[0]) =>
    it.live(title, () => Effect.provide(inTemp(body), disk))
  describe(`${name} behaves like a POSIX file system`, () => {
    check("a written file reads back byte for byte", (root, fs, path) =>
      Effect.gen(function* () {
        const file = path.join(root, "accounts.json")
        yield* fs.writeFileString(file, '{"id":"acct-1"}\n')
        expect(yield* fs.readFileString(file)).toBe('{"id":"acct-1"}\n')
        const bytes = new Uint8Array([0, 255, 10, 13])
        yield* fs.writeFile(file, bytes)
        expect(yield* fs.readFile(file)).toEqual(bytes)
        const info = yield* fs.stat(file)
        expect(info.type).toBe("File")
        expect(Number(info.size)).toBe(4)
      }),
    )

    check("a new file or directory gets the mode asked for", (root, fs, path) =>
      Effect.gen(function* () {
        const dir = path.join(root, "home")
        yield* fs.makeDirectory(dir, { mode: 0o700 })
        const file = path.join(dir, "token.json")
        yield* fs.writeFileString(file, "secret", { mode: 0o600 })
        expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
        yield* fs.chmod(file, 0o640)
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o640)
      }),
    )

    check("exclusive create refuses a file that is already there", (root, fs, path) =>
      Effect.gen(function* () {
        const lock = path.join(root, "serve.lock")
        yield* Effect.scoped(fs.open(lock, { flag: "wx", mode: 0o600 }))
        const opened = yield* Effect.flip(Effect.scoped(fs.open(lock, { flag: "wx" })))
        expect(reason(opened)).toBe("AlreadyExists")
        const written = yield* Effect.flip(fs.writeFileString(lock, "again", { flag: "wx" }))
        expect(reason(written)).toBe("AlreadyExists")
      }),
    )

    check("exclusive create and noFollow never follow a link in the last name", (root, fs, path) =>
      Effect.gen(function* () {
        const lock = path.join(root, "serve.lock")
        yield* fs.symlink(path.join(root, "nowhere"), lock)
        const opened = yield* Effect.flip(Effect.scoped(fs.open(lock, { flag: "wx" })))
        expect(reason(opened)).toBe("AlreadyExists")
        expect(yield* fs.exists(path.join(root, "nowhere"))).toBe(false)
        yield* fs.writeFileString(path.join(root, "nowhere"), "x")
        expect(Exit.isFailure(yield* Effect.exit(Effect.scoped(fs.open(lock, { noFollow: true }))))).toBe(true)
      }),
    )

    check("a file handle stops working once its scope closes", (root, fs, path) =>
      Effect.gen(function* () {
        const at = path.join(root, "usage.ndjson")
        const file = yield* Effect.scoped(fs.open(at, { flag: "a" }))
        expect(Exit.isFailure(yield* Effect.exit(file.writeAll(new TextEncoder().encode("late\n"))))).toBe(true)
        expect(yield* fs.readFileString(at)).toBe("")
      }),
    )

    check("appending keeps every line, in order", (root, fs, path) =>
      Effect.gen(function* () {
        const at = path.join(root, "usage.ndjson")
        const lines = Array.from({ length: 2_000 }, (_, index) => `{"n":${index},"pad":"${"x".repeat(180)}"}\n`)
        for (const line of lines.slice(0, 1_000)) yield* fs.writeFileString(at, line, { flag: "a" })
        yield* Effect.scoped(
          Effect.flatMap(fs.open(at, { flag: "a" }), (file) =>
            Effect.forEach(lines.slice(1_000), (line) => file.writeAll(new TextEncoder().encode(line)), {
              discard: true,
            }),
          ),
        )
        expect(yield* fs.readFileString(at)).toBe(lines.join(""))
        expect(Number((yield* fs.stat(at)).size)).toBe(lines.join("").length)
      }),
    )

    check("rename replaces the target in one step", (root, fs, path) =>
      Effect.gen(function* () {
        const target = path.join(root, "config.json")
        const temp = path.join(root, ".config.json.123.tmp")
        yield* fs.writeFileString(target, "old")
        yield* fs.writeFileString(temp, "new")
        yield* fs.rename(temp, target)
        expect(yield* fs.readFileString(target)).toBe("new")
        expect(yield* fs.exists(temp)).toBe(false)
        expect(yield* fs.readDirectory(root)).toEqual(["config.json"])
      }),
    )

    check("rename moves a directory with everything in it", (root, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, "a", "b"), { recursive: true })
        yield* fs.writeFileString(path.join(root, "a", "b", "c.txt"), "c")
        yield* fs.rename(path.join(root, "a"), path.join(root, "z"))
        expect(yield* fs.readFileString(path.join(root, "z", "b", "c.txt"))).toBe("c")
        expect(yield* fs.exists(path.join(root, "a"))).toBe(false)
      }),
    )

    check("append mode adds to the end of the file", (root, fs, path) =>
      Effect.gen(function* () {
        const ledger = path.join(root, "2026-10.ndjson")
        yield* fs.writeFileString(ledger, "one\n", { flag: "a", mode: 0o600 })
        yield* fs.writeFileString(ledger, "two\n", { flag: "a" })
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(ledger, { flag: "a" })
            yield* file.writeAll(new TextEncoder().encode("three\n"))
          }),
        )
        expect(yield* fs.readFileString(ledger)).toBe("one\ntwo\nthree\n")
        expect((yield* fs.stat(ledger)).mode & 0o777).toBe(0o600)
      }),
    )

    check("a missing file is NotFound and does not exist", (root, fs, path) =>
      Effect.gen(function* () {
        const missing = path.join(root, "nope.json")
        expect(reason(yield* Effect.flip(fs.readFile(missing)))).toBe("NotFound")
        expect(reason(yield* Effect.flip(fs.stat(missing)))).toBe("NotFound")
        expect(yield* fs.exists(missing)).toBe(false)
        expect(reason(yield* Effect.flip(fs.writeFileString(path.join(root, "no", "dir.json"), "x")))).toBe("NotFound")
      }),
    )

    check("making directories needs a parent unless recursive, and refuses one that exists", (root, fs, path) =>
      Effect.gen(function* () {
        const deep = path.join(root, "a", "b", "c")
        expect(reason(yield* Effect.flip(fs.makeDirectory(deep)))).toBe("NotFound")
        yield* fs.makeDirectory(deep, { recursive: true })
        yield* fs.makeDirectory(deep, { recursive: true })
        expect(reason(yield* Effect.flip(fs.makeDirectory(deep)))).toBe("AlreadyExists")
        expect((yield* fs.stat(deep)).type).toBe("Directory")
      }),
    )

    check("listing a directory gives its names, or every path under it when recursive", (root, fs, path) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(root, "accounts", "claude"), { recursive: true })
        yield* fs.writeFileString(path.join(root, "accounts", "claude", "a.json"), "{}")
        yield* fs.writeFileString(path.join(root, "accounts", "index.json"), "{}")
        const accounts = path.join(root, "accounts")
        expect((yield* fs.readDirectory(accounts)).toSorted()).toEqual(["claude", "index.json"])
        expect((yield* fs.readDirectory(accounts, { recursive: true })).toSorted()).toEqual([
          "claude",
          "claude/a.json",
          "index.json",
        ])
        const entries = (yield* fs.readDirectoryEntries(accounts)).toSorted((a, b) => a.name.localeCompare(b.name))
        expect(entries).toEqual([
          { name: "claude", type: "Directory" },
          { name: "index.json", type: "File" },
        ])
      }),
    )

    check("removing a tree needs recursive, and force ignores a missing path", (root, fs, path) =>
      Effect.gen(function* () {
        const dir = path.join(root, "backups")
        yield* fs.makeDirectory(path.join(dir, "1"), { recursive: true })
        yield* fs.writeFileString(path.join(dir, "1", "settings.json"), "{}")
        expect(Exit.isFailure(yield* Effect.exit(fs.remove(dir)))).toBe(true)
        yield* fs.remove(dir, { recursive: true })
        expect(yield* fs.exists(dir)).toBe(false)
        expect(reason(yield* Effect.flip(fs.remove(dir)))).toBe("NotFound")
        yield* fs.remove(dir, { force: true })
      }),
    )

    check("an open file reads, writes and seeks from its own position", (root, fs, path) =>
      Effect.gen(function* () {
        const at = path.join(root, "handle.bin")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(at, { flag: "w+" })
            yield* file.writeAll(new TextEncoder().encode("hello world"))
            yield* file.seek(6n, "start")
            const read = yield* file.readAlloc(5)
            expect(Option.map(read, (bytes) => new TextDecoder().decode(bytes))).toEqual(Option.some("world"))
            expect(yield* file.readAlloc(5)).toEqual(Option.none())
            const buffer = new Uint8Array(5)
            expect(yield* file.read(buffer, { position: 0n })).toBe(5)
            expect(new TextDecoder().decode(buffer)).toBe("hello")
            yield* file.truncate(5)
            yield* file.sync
            expect(Number((yield* file.stat).size)).toBe(5)
          }),
        )
        expect(yield* fs.readFileString(at)).toBe("hello")
        yield* fs.truncate(at, 2)
        expect(yield* fs.readFileString(at)).toBe("he")
      }),
    )

    check("a file can be streamed in chunks and written through a sink", (root, fs, path) =>
      Effect.gen(function* () {
        const at = path.join(root, "stream.txt")
        yield* Stream.run(Stream.make(new TextEncoder().encode("ab"), new TextEncoder().encode("cd")), fs.sink(at))
        const chunks = yield* Stream.runCollect(fs.stream(at, { chunkSize: 3 }))
        expect(chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["abc", "d"])
      }),
    )

    check("links are followed by stat and realPath, and not by lstat", (root, fs, path) =>
      Effect.gen(function* () {
        const real = path.join(root, "real")
        yield* fs.makeDirectory(real)
        yield* fs.writeFileString(path.join(real, "settings.json"), "{}")
        const link = path.join(root, "link")
        yield* fs.symlink(real, link)
        expect((yield* fs.lstat(link)).type).toBe("SymbolicLink")
        expect((yield* fs.stat(link)).type).toBe("Directory")
        expect(yield* fs.readLink(link)).toBe(real)
        expect(yield* fs.realPath(path.join(link, "settings.json"))).toBe(path.join(real, "settings.json"))
        expect(yield* fs.readFileString(path.join(link, "settings.json"))).toBe("{}")
        yield* fs.remove(link)
        expect(yield* fs.exists(path.join(real, "settings.json"))).toBe(true)
      }),
    )

    check("copying a file or a tree copies the bytes", (root, fs, path) =>
      Effect.gen(function* () {
        const source = path.join(root, "source")
        yield* fs.makeDirectory(path.join(source, "inner"), { recursive: true })
        yield* fs.writeFileString(path.join(source, "inner", "a.txt"), "a")
        yield* fs.copyFile(path.join(source, "inner", "a.txt"), path.join(root, "a-copy.txt"))
        expect(yield* fs.readFileString(path.join(root, "a-copy.txt"))).toBe("a")
        yield* fs.copy(source, path.join(root, "copy"))
        expect(yield* fs.readFileString(path.join(root, "copy", "inner", "a.txt"))).toBe("a")
      }),
    )

    check("a hard link shares the contents of its file", (root, fs, path) =>
      Effect.gen(function* () {
        const first = path.join(root, "first")
        yield* fs.writeFileString(first, "one")
        yield* fs.link(first, path.join(root, "second"))
        yield* fs.writeFileString(first, "two")
        expect(yield* fs.readFileString(path.join(root, "second"))).toBe("two")
      }),
    )

    check("a temp directory made in a scope is removed when the scope closes", (root, fs, path) =>
      Effect.gen(function* () {
        const made = yield* Effect.scoped(
          Effect.gen(function* () {
            const dir = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: "slopmax-inner-" })
            yield* fs.writeFileString(path.join(dir, "file"), "x")
            expect(path.basename(dir).startsWith("slopmax-inner-")).toBe(true)
            return dir
          }),
        )
        expect(yield* fs.exists(made)).toBe(false)
        const file = yield* Effect.scoped(fs.makeTempFileScoped({ directory: root, suffix: ".json" }))
        expect(file.endsWith(".json")).toBe(true)
        expect(yield* fs.exists(file)).toBe(false)
      }),
    )

    check("watching a directory reports a new file, a change and its removal", (root, fs, path) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const watching = yield* fs.watch(root, { onReady: () => Deferred.doneUnsafe(ready, Exit.void) }).pipe(
          Stream.filter((event) => event.path === "settings.json"),
          Stream.takeUntil((event) => event._tag === "Remove"),
          Stream.runCollect,
          Effect.timeout("5 seconds"),
          Effect.forkChild,
        )
        yield* Deferred.await(ready)
        const file = path.join(root, "settings.json")
        yield* fs.writeFileString(file, "{}")
        yield* Effect.sleep("50 millis")
        yield* fs.writeFileString(file, '{"strategy":"fill-first"}')
        yield* Effect.sleep("50 millis")
        yield* fs.remove(file)
        const seen = new Set((yield* Fiber.join(watching)).map((event) => event._tag))
        expect(seen.has("Create")).toBe(true)
        expect(seen.has("Update")).toBe(true)
        expect(seen.has("Remove")).toBe(true)
      }),
    )
  })
}

contract("MemoryFileSystem", MemoryFileSystem.layer)
contract("the real disk", BunServices.layer)

describe("MemoryFileSystem", () => {
  it.effect("starts with the seeded files, their parents and /tmp", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString("/home/u/.claude/.credentials.json")).toBe('{"token":"t"}')
      expect((yield* fs.stat("/home/u/.claude")).type).toBe("Directory")
      expect((yield* fs.stat("/home/u/.codex/auth.json")).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat("/srv/empty")).type).toBe("Directory")
      expect((yield* fs.stat("/tmp")).type).toBe("Directory")
    }).pipe(
      Effect.provide(
        MemoryFileSystem.layerWith({
          files: {
            "/home/u/.claude/.credentials.json": '{"token":"t"}',
            "/home/u/.codex/auth.json": { data: "{}", mode: 0o600 },
          },
          directories: ["/srv/empty"],
        }),
      ),
    ),
  )

  it.effect("stamps changes with the test clock's time", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* TestClock.setTime(Date.UTC(2026, 9, 31, 12))
      yield* fs.writeFileString("/tmp/state.json", "{}")
      expect(Option.map((yield* fs.stat("/tmp/state.json")).mtime, (date) => date.toISOString())).toEqual(
        Option.some("2026-10-31T12:00:00.000Z"),
      )
    }).pipe(Effect.provide(MemoryFileSystem.layer)),
  )

  it.effect("fails the calls a test picks, with the reason it picks", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/fine.json", "{}")
      const error = yield* Effect.flip(fs.rename("/tmp/fine.json", "/tmp/config.json"))
      expect(error.reason._tag).toBe("PermissionDenied")
      expect(yield* fs.exists("/tmp/fine.json")).toBe(true)
    }).pipe(
      Effect.provide(
        MemoryFileSystem.layerWith({ fault: ({ method }) => (method === "rename" ? "PermissionDenied" : undefined) }),
      ),
    ),
  )

  it.effect("applies the umask to the modes of new files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString("/tmp/default", "x")
      yield* fs.makeDirectory("/tmp/dir")
      expect((yield* fs.stat("/tmp/default")).mode & 0o777).toBe(0o640)
      expect((yield* fs.stat("/tmp/dir")).mode & 0o777).toBe(0o750)
    }).pipe(Effect.provide(MemoryFileSystem.layerWith({ umask: 0o027 }))),
  )

  it.effect("gives every layer build its own empty tree", () =>
    Effect.gen(function* () {
      yield* Effect.provide(
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.writeFileString("/tmp/a", "a")),
        MemoryFileSystem.layer,
      )
      const exists = yield* Effect.provide(
        Effect.flatMap(Effect.service(FileSystem.FileSystem), (fs) => fs.exists("/tmp/a")),
        MemoryFileSystem.layer,
      )
      expect(exists).toBe(false)
    }),
  )

  it.effect("keeps an open file usable after it is renamed, as a real file system does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = yield* fs.open("/tmp/a.lock", { flag: "wx" })
      yield* fs.rename("/tmp/a.lock", "/tmp/b.lock")
      yield* file.writeAll(new TextEncoder().encode('{"pid":1}'))
      expect(yield* fs.readFileString("/tmp/b.lock")).toBe('{"pid":1}')
    }).pipe(Effect.provide(MemoryFileSystem.layer)),
  )
})
