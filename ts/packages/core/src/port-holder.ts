// Who is listening on a port slopmax wants, so "the port is taken" can name
// the program to stop. Linux answers from /proc: the listening socket's
// inode in /proc/net/tcp{,6}, then the process with a descriptor for it.
// macOS answers through `lsof`. Elsewhere, or when nothing can be seen, the
// caller says "another program".
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import { Duration, Effect, FileSystem, Option } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { runProgram } from "./service.ts"

/** The TCP state /proc/net/tcp gives a listening socket. */
const listenState = "0A"

/** The inodes of sockets listening on `port`, from a /proc/net/tcp or tcp6 table. */
export const listeningInodes = (table: string, port: number): ReadonlyArray<string> =>
  table
    .split("\n")
    .slice(1)
    .flatMap((row) => {
      // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …
      const fields = row.trim().split(/\s+/)
      const local = fields[1]
      const inode = fields[9]
      if (local === undefined || inode === undefined || fields[3] !== listenState) return []
      const hexPort = local.split(":").at(-1) ?? ""
      return Number.parseInt(hexPort, 16) === port && inode !== "0" ? [inode] : []
    })

/** `lsof -Fpc`'s answer: the first process, as `{name} (pid N)`. */
export const lsofHolder = (output: string): Option.Option<string> => {
  let pid: string | undefined
  let name: string | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      if (pid !== undefined) break
      pid = line.slice(1)
    } else if (line.startsWith("c") && pid !== undefined) {
      name = line.slice(1)
    }
  }
  return pid === undefined
    ? Option.none()
    : Option.some(`${name === undefined || name === "" ? "a program" : name} (pid ${pid})`)
}

/** What a Linux holder is called when its process is another user's, whose descriptors cannot be read. */
export const unseenHolder = "another user's program"

const linuxHolder = (port: number): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tables = yield* Effect.forEach(["/proc/net/tcp", "/proc/net/tcp6"], (file) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed(() => "")),
    )
    const inodes = new Set(tables.flatMap((table) => listeningInodes(table, port)))
    if (inodes.size === 0) return Option.none()
    const links = new Set([...inodes].map((inode) => `socket:[${inode}]`))
    const pids = (yield* fs.readDirectory("/proc").pipe(Effect.orElseSucceed((): Array<string> => []))).filter((name) =>
      /^\d+$/.test(name),
    )
    // A busy machine has tens of thousands of descriptors, so processes are looked through many at a time.
    const holds = (pid: string) =>
      fs.readDirectory(`/proc/${pid}/fd`).pipe(
        Effect.flatMap((fds) =>
          Effect.forEach(fds, (fd) => fs.readLink(`/proc/${pid}/fd/${fd}`).pipe(Effect.orElseSucceed(() => ""))),
        ),
        Effect.map((targets) => targets.some((target) => links.has(target))),
        Effect.orElseSucceed(() => false),
      )
    const found = yield* Effect.filter(pids, holds, { concurrency: 32 })
    const pid = found[0]
    if (pid === undefined) return Option.some(unseenHolder)
    const comm = (yield* fs.readFileString(`/proc/${pid}/comm`).pipe(Effect.orElseSucceed(() => ""))).trim()
    return Option.some(`${comm === "" ? "a program" : comm} (pid ${pid})`)
  })

const macHolder = (port: number) =>
  runProgram("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]).pipe(
    Effect.map((ran) => lsofHolder(ran.stdout)),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** The program listening on `port`, when the system says. */
export const portHolder = (
  port: number,
  platform: NodeJS.Platform = process.platform,
): Effect.Effect<Option.Option<string>, never, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> => {
  if (platform === "linux") return linuxHolder(port)
  if (platform === "darwin") return macHolder(port)
  return Effect.succeedNone
}

const inUse = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE"

/**
 * Whether another program already listens on `host:port`: binding it here
 * fails as in use. The socket is closed at once, so the port is never held.
 */
export const portTaken = (host: string, port: number): Effect.Effect<boolean> =>
  Effect.scoped(BunSocketServer.make({ host, port, exclusive: true })).pipe(
    Effect.as(false),
    Effect.catchTag("SocketServerError", (error) => Effect.succeed(inUse(error.reason.cause))),
  )

/** Whether something accepts TCP connections on `host:port` within `wait`. It only connects, then hangs up. */
export const accepts = (host: string, port: number, wait: Duration.Input): Effect.Effect<boolean> =>
  Effect.scoped(Effect.flatMap(BunSocket.makeNet({ host, port, openTimeout: wait }), (socket) => socket.reader)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
