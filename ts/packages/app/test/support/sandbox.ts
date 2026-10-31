// A home of its own for each test that starts the app: config.toml with a
// known key, every directory the app or the agents read inside it, the
// login service hidden, and, when asked, the real proxy running in-process
// on a free local port. Nothing reaches the machine's own slopmax.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ConfigProvider, Effect, Layer, Option, type Scope, Stream } from "effect"

import { Config, Home, ids, net, pool, proxy } from "@slopmax/core"

import type { AppShape, Snapshot } from "../../src/lib.ts"

export const KEY = "sm-test-key"

export interface Sandbox {
  /** The slopmax home. */
  readonly home: string
  /** The address the app expects the proxy at. */
  readonly listen: string
  /** The environment the app runs in. */
  readonly env: Layer.Layer<never>
}

/** A scratch directory, removed when the scope closes. */
export const scratch = (name: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = join(tmpdir(), `slopmax-app-${name}-${process.pid}-${ids.token()}`)
      mkdirSync(dir, { recursive: true })
      return dir
    }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const environment = (dir: string, home: string, listen: string): Layer.Layer<never> =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      HOME: dir,
      SLOPMAX_HOME: home,
      SLOPMAX_LISTEN: listen,
      SLOPMAX_NO_SERVICE: "1",
      CLAUDE_CONFIG_DIR: join(dir, "claude"),
      CODEX_HOME: join(dir, "codex"),
    }),
  )

/**
 * A home whose proxy would listen on `port`. With `serve`, the real proxy
 * runs there until the scope closes; else nothing answers.
 */
export const sandbox = (options: {
  readonly serve: boolean
  readonly config?: string
  /** Where the app expects the proxy, when something else answers there; else a free port. */
  readonly port?: number
}): Effect.Effect<Sandbox, never, Scope.Scope> =>
  Effect.gen(function* () {
    const dir = yield* scratch("home")
    const home = join(dir, "slopmax")
    mkdirSync(home, { recursive: true })
    if (options.port !== undefined) {
      const listen = `127.0.0.1:${options.port}`
      writeFileSync(join(home, "config.toml"), options.config ?? `api_key = "${KEY}"\n`)
      return { home, listen, env: environment(dir, home, listen) }
    }
    const listener = yield* net.server.bind({ hostname: "127.0.0.1", port: 0 }).pipe(Effect.orDie)
    const listen = `127.0.0.1:${listener.port}`
    writeFileSync(join(home, "config.toml"), options.config ?? `api_key = "${KEY}"\n`)
    if (options.serve) {
      const loaded = yield* Config.loadFrom(join(home, "config.toml")).pipe(Effect.orDie)
      const config = { ...loaded, listen: { ip: "127.0.0.1", port: listener.port } }
      const env = environment(dir, home, listen)
      const app = yield* proxy.App.make(config, Home.at(home), pool.State.empty(), new net.Origins()).pipe(
        Effect.provide(env),
      )
      yield* listener.serve(proxy.httpApp(app))
    } else {
      // Nothing answers there.
      yield* listener.shutdown
    }
    return { home, listen, env: environment(dir, home, listen) }
  })

/** The first snapshot, from now on, for which `wanted` holds; a test fails after 10 s without one. */
export const until = (app: AppShape, wanted: (s: Snapshot) => boolean): Effect.Effect<Snapshot> =>
  app.changes.pipe(
    Stream.filter(wanted),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout("10 seconds"),
    Effect.orDie,
  )
