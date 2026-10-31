import { describe, expect } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect, Fiber, Schema } from "effect"

import * as fsx from "../src/fsx.ts"
import { tempDirs } from "./support/temp.ts"

const Secret = Schema.Struct({ token: Schema.String })

const temp = tempDirs()

describe("fsx", () => {
  it.live("new_directories_are_private", () =>
    Effect.gen(function* () {
      const root = join(temp("fsx"), "fsx")
      yield* fsx.writePrivate(join(root, "a/b/secret.json"), "{}")
      for (const dir of [join(root, "a"), join(root, "a/b")]) expect(statSync(dir).mode & 0o777).toBe(0o700)
    }),
  )

  it.live("write_private_round_trips_and_restricts_permissions", () =>
    Effect.gen(function* () {
      const dir = join(temp("fsx"), "fsx")
      const path = join(dir, "secret.json")
      yield* fsx.writeJson(path, Secret, { token: "abc" })
      const value = yield* fsx.readJson(path, Secret)
      expect(value?.token).toBe("abc")
      expect(statSync(path).mode & 0o777).toBe(0o600)
      // Pretty, as serde_json writes it, with a final newline; no temp file left.
      expect(readFileSync(path, "utf8")).toBe('{\n  "token": "abc"\n}\n')
      expect(readdirSync(dir)).toEqual(["secret.json"])
    }),
  )

  it.live("read_json_missing_file_is_none", () =>
    Effect.gen(function* () {
      const missing = join(tmpdir(), "slopmax-definitely-missing.json")
      expect(yield* fsx.readJson(missing, Schema.Unknown)).toBeUndefined()
    }),
  )
})

describe("fsx, beyond the Rust tests", () => {
  it.live("metadata follows symlinks and is undefined for nothing", () =>
    Effect.gen(function* () {
      const dir = join(temp("fsx"), "fsx")
      const path = join(dir, "file")
      yield* fsx.writePrivate(path, "x")
      const file = yield* fsx.metadata(path)
      expect(file?.isFile).toBe(true)
      expect((file?.mode ?? 0) & 0o777).toBe(0o600)
      expect((yield* fsx.metadata(dir))?.isFile).toBe(false)
      symlinkSync(path, join(dir, "link"))
      expect((yield* fsx.metadata(join(dir, "link")))?.isFile).toBe(true)
      expect(yield* fsx.metadata(join(dir, "missing"))).toBeUndefined()
    }),
  )

  it.live("unreadable JSON is invalid data, worded as serde_json words it", () =>
    Effect.gen(function* () {
      const dir = join(temp("fsx"), "fsx")
      const path = join(dir, "bad.json")
      yield* fsx.writePrivate(path, "{ nope")
      const error = yield* Effect.flip(fsx.readJson(path, Schema.Unknown))
      expect(error.kind).toBe("InvalidData")
      expect(error.message).toBe("key must be a string at line 1 column 3")
      // Valid JSON of the wrong shape is invalid data too.
      yield* fsx.writePrivate(path, '{"token": 1}')
      expect((yield* Effect.flip(fsx.readJson(path, Secret))).kind).toBe("InvalidData")
    }),
  )

  it.live("a failed write leaves the target and no temp file", () =>
    Effect.gen(function* () {
      const dir = join(temp("fsx"), "fsx")
      // A directory where the file should go: the rename fails.
      yield* fsx.privateDir(join(dir, "target"))
      yield* fsx.writePrivate(join(dir, "target", "inner"), "x")
      const error = yield* Effect.flip(fsx.writePrivate(join(dir, "target"), "data"))
      expect(error.message).toBe("Is a directory (os error 21)")
      expect(readdirSync(dir)).toEqual(["target"])
    }),
  )

  it.live("locks wait for the holder, across fibers and processes", () =>
    Effect.gen(function* () {
      const dir = join(temp("lock"), "lock")
      const path = join(dir, ".x.lock")
      const order: Array<string> = []
      const holder = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            yield* fsx.lock(path)
            order.push("first holds")
            yield* Effect.sleep("150 millis")
            order.push("first lets go")
          }),
        ),
      )
      yield* Effect.sleep("30 millis")
      yield* Effect.scoped(
        Effect.andThen(
          fsx.lock(path),
          Effect.sync(() => order.push("second holds")),
        ),
      )
      yield* Fiber.join(holder)
      expect(order).toEqual(["first holds", "first lets go", "second holds"])
      expect(statSync(path).mode & 0o777).toBe(0o600)

      // util-linux's flock (the call Rust's File::lock makes) sees the same lock.
      if (existsSync("/usr/bin/flock")) {
        const child = Bun.spawn(["/usr/bin/flock", path, "sleep", "0.3"], { stdout: "ignore", stderr: "ignore" })
        yield* Effect.sleep("100 millis")
        const start = Date.now()
        yield* Effect.scoped(fsx.lock(path))
        expect(Date.now() - start).toBeGreaterThan(100)
        yield* Effect.promise(() => child.exited)
      }
    }),
  )

  it.live("text that is not UTF-8 is invalid data; lines read as BufReader::lines does", () =>
    Effect.gen(function* () {
      const dir = join(temp("fsx"), "fsx")
      const path = join(dir, "bad.json")
      yield* fsx.writePrivate(path, new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))
      const text = yield* Effect.flip(fsx.readText(path))
      expect([text.kind, text.message]).toEqual(["InvalidData", "stream did not contain valid UTF-8"])
      const read = yield* Effect.flip(fsx.readJson(path, Schema.Unknown))
      expect([read.kind, read.message]).toEqual(["InvalidData", "invalid unicode code point at line 1 column 8"])

      const lines = join(dir, "lines.jsonl")
      yield* fsx.writePrivate(
        lines,
        new Uint8Array([...Buffer.from("a\r\n\nb\r\r\n"), 0xff, 0x0a, ...Buffer.from("c\n")]),
      )
      expect(yield* fsx.readLines(lines)).toEqual(["a", "", "b\r"])
      yield* fsx.writePrivate(lines, "x\ny")
      expect(yield* fsx.readLines(lines)).toEqual(["x", "y"])
      expect(yield* fsx.readLines(join(dir, "missing"))).toBeUndefined()
    }),
  )
})
