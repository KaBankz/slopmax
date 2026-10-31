import { describe, expect } from "bun:test"
import * as BunServices from "@effect/platform-bun/BunServices"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Effect, FileSystem, Layer, Option } from "effect"
import { accepts, listeningInodes, lsofHolder, portHolder, portTaken, unseenHolder } from "../../src/port-holder.ts"
import { recordingSpawner } from "../service/recording-spawner.ts"

// Port 7567 (0x1D8F) listening on 127.0.0.1 with inode 4242; one connected socket on the same port that is not listening.
const tcp = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:1D8F 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4242 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:1D8F 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 5151 1 0000000000000000 20 4 30 10 -1",
  "   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 999 1 0000000000000000 100 0 0 10 0",
].join("\n")

/** A /proc with processes 77 (`slopmaxd`) and 88; each test links their descriptors. */
const proc = () =>
  MemoryFileSystem.layerWith({
    files: {
      "/proc/net/tcp": tcp,
      "/proc/net/tcp6": "  sl  local_address remote_address st\n",
      "/proc/77/comm": "slopmaxd\n",
      "/proc/88/comm": "other\n",
      "/proc/self/comm": "self\n",
    },
    directories: ["/proc/77/fd", "/proc/88/fd"],
  })

const withLinks = (links: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    for (const [path, target] of Object.entries(links)) yield* fs.symlink(target, path)
  })

describe("reading /proc and lsof", () => {
  it("finds the inodes of sockets listening on a port", () => {
    expect(listeningInodes(tcp, 7567)).toEqual(["4242"])
    expect(listeningInodes(tcp, 22)).toEqual(["999"])
    expect(listeningInodes(tcp, 8080)).toEqual([])
    expect(listeningInodes("", 7567)).toEqual([])
  })

  it("names the first process lsof reports, or says a program when it has no name", () => {
    expect(lsofHolder("p812\ncnode\nf23\n")).toEqual(Option.some("node (pid 812)"))
    expect(lsofHolder("p812\nf23\n")).toEqual(Option.some("a program (pid 812)"))
    expect(lsofHolder("p1\ncfirst\np2\ncsecond\n")).toEqual(Option.some("first (pid 1)"))
    expect(lsofHolder("")).toEqual(Option.none())
  })
})

describe("the program holding a port", () => {
  it.effect("on Linux it is the process with a descriptor for the listening socket", () =>
    Effect.gen(function* () {
      yield* withLinks({
        "/proc/88/fd/3": "socket:[5151]",
        "/proc/77/fd/0": "/dev/null",
        "/proc/77/fd/9": "socket:[4242]",
      })
      expect(yield* portHolder(7567, "linux")).toEqual(Option.some("slopmaxd (pid 77)"))
    }).pipe(Effect.provide(Layer.merge(proc(), recordingSpawner().layer))),
  )

  it.effect("on Linux a listening socket no visible process owns is another user's program", () =>
    Effect.gen(function* () {
      yield* withLinks({ "/proc/88/fd/3": "socket:[5151]" })
      expect(yield* portHolder(7567, "linux")).toEqual(Option.some(unseenHolder))
      expect(yield* portHolder(8080, "linux")).toEqual(Option.none())
    }).pipe(Effect.provide(Layer.merge(proc(), recordingSpawner().layer))),
  )

  it.effect("on macOS lsof is asked, and elsewhere nothing is", () => {
    const spawner = recordingSpawner((program) => (program === "lsof" ? { stdout: "p501\ncpython3\n" } : {}))
    return Effect.gen(function* () {
      expect(yield* portHolder(7567, "darwin")).toEqual(Option.some("python3 (pid 501)"))
      expect(spawner.calls.map((call) => call.line)).toEqual(["lsof -nP -iTCP:7567 -sTCP:LISTEN -Fpc"])
      expect(yield* portHolder(7567, "win32")).toEqual(Option.none())
      expect(spawner.calls).toHaveLength(1)
    }).pipe(Effect.provide(Layer.merge(MemoryFileSystem.layer, spawner.layer)))
  })
})

/** A throwaway port on loopback with a listener on it until the scope closes. */
const listening = Effect.acquireRelease(
  Effect.sync(() => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data: () => undefined } })),
  (server) => Effect.sync(() => server.stop(true)),
)

describe("ports on this machine", () => {
  it.live("a port another program listens on is taken, and free again once it stops", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* listening
          expect(yield* portTaken("127.0.0.1", server.port)).toBe(true)
          return server.port
        }),
      )
      expect(yield* portTaken("127.0.0.1", port)).toBe(false)
      // Checking never keeps the port: a second check finds it free as well.
      expect(yield* portTaken("127.0.0.1", port)).toBe(false)
    }),
  )

  it.live.skipIf(process.platform !== "linux")("names this very process when it holds the port", () =>
    Effect.gen(function* () {
      const server = yield* listening
      const holder = yield* portHolder(server.port)
      expect(holder).toEqual(Option.some(expect.stringContaining(`(pid ${process.pid})`)))
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.live("a connection probe sees a listener, and nothing on a closed port", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* listening
          expect(yield* accepts("127.0.0.1", server.port, "300 millis")).toBe(true)
          return server.port
        }),
      )
      expect(yield* accepts("127.0.0.1", port, "300 millis")).toBe(false)
    }),
  )
})
