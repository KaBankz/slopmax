import { describe, expect } from "bun:test"
import { createServer, type Socket } from "node:net"
import { it } from "@slopmax/test"
import { Effect } from "effect"

import { Conn, openTcp } from "../src/conn.ts"

// A loopback server that hands each connection to `serve`.
const server = (serve: (socket: Socket) => void) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly port: number; readonly close: () => void }>((resolve) => {
          const sockets = new Set<Socket>()
          const listener = createServer((socket) => {
            sockets.add(socket)
            socket.on("error", () => undefined)
            serve(socket)
          })
          listener.listen(0, "127.0.0.1", () => {
            const address = listener.address()
            resolve({
              port: typeof address === "object" && address !== null ? address.port : 0,
              close: () => {
                for (const socket of sockets) socket.destroy()
                listener.close()
              },
            })
          })
        }),
    ),
    ({ close }) => Effect.sync(close),
  )

const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes)

describe("conn", () => {
  it.live("an interrupted read takes nothing", () =>
    Effect.gen(function* () {
      const { port } = yield* server((socket) => {
        setTimeout(() => socket.write("first"), 100)
        setTimeout(() => socket.end("second"), 300)
      })
      const conn = new Conn(yield* openTcp("127.0.0.1", port))
      expect(yield* Effect.timeoutOption(conn.read, "20 millis")).toMatchObject({ _tag: "None" })
      expect(decode(yield* conn.read)).toBe("first")
      expect(decode(yield* conn.read)).toBe("second")
      expect(yield* conn.read).toBeUndefined()
      conn.destroy()
    }),
  )

  it.live("a head arriving a byte at a time is read whole, the rest put back", () =>
    Effect.gen(function* () {
      const text = `HTTP/1.1 200 OK\r\nx-long: ${"y".repeat(20_000)}\r\n\r\nbody`
      const { port } = yield* server((socket) => {
        void (async () => {
          for (let i = 0; i < text.length; i += 1) {
            socket.write(text[i] ?? "")
            if (i % 2048 === 0) await Bun.sleep(1)
          }
          socket.end()
        })()
      })
      const conn = new Conn(yield* openTcp("127.0.0.1", port))
      const head = yield* conn.readHead(1024 * 1024, "eof", "too long")
      expect(decode(head)).toBe(text.slice(0, -4))
      expect(decode(yield* conn.readExact(4))).toBe("body")
      const short = yield* Effect.flip(conn.readExact(1))
      expect(short.message).toBe("failed to fill whole buffer")
      conn.destroy()
    }),
  )
})
