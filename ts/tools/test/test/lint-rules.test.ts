// The import boundaries and hot-path bans of ARCHITECTURE.md §1.3 and §2 are
// enforced by .oxlintrc.json. These tests lint small files laid out like the
// workspace with the real config, so a rule that stops firing (an override in
// the wrong order, a glob that misses) fails here, not in review.
import { describe, expect } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect, FileSystem, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { it, TestHome } from "../src/index.ts"

const workspace = `${import.meta.dir}/../../..`

/** Rules that carry the boundaries; other findings (unused names and such) are ignored. */
const boundaryRules = new Set([
  "eslint(no-restricted-imports)",
  "eslint(no-restricted-globals)",
  "eslint(no-restricted-properties)",
  "import(no-nodejs-modules)",
  "typescript(consistent-type-assertions)",
  "typescript(no-explicit-any)",
  "typescript(no-non-null-assertion)",
  "typescript(ban-ts-comment)",
  "import(no-dynamic-require)",
])

type Verdict = "rejected" | "allowed"

const cases: ReadonlyArray<readonly [what: string, file: string, source: string, verdict: Verdict]> = [
  ["the domain importing Node", "packages/domain/src/node.ts", `import { readFileSync } from "node:fs"`, "rejected"],
  ["the domain importing the wire", "packages/domain/src/up.ts", `import { scan } from "@slopmax/wire"`, "rejected"],
  [
    "the domain importing the engine",
    "packages/domain/src/core.ts",
    `import { Pool } from "@slopmax/core"`,
    "rejected",
  ],
  [
    "the domain importing a platform layer",
    "packages/domain/src/bun.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "rejected",
  ],
  [
    "the domain importing FileSystem",
    "packages/domain/src/files.ts",
    `import { FileSystem } from "effect"`,
    "rejected",
  ],
  [
    "the domain importing HttpClient",
    "packages/domain/src/client.ts",
    `import { HttpClient } from "effect/http"`,
    "rejected",
  ],
  ["the domain importing Schema", "packages/domain/src/ok.ts", `import { Schema } from "effect"`, "allowed"],
  [
    "the domain importing a third-party package",
    "packages/domain/src/react.ts",
    `import { useState } from "react"`,
    "rejected",
  ],
  [
    "the domain importing its own files",
    "packages/domain/src/sibling.ts",
    `import { ProviderId } from "./ids.ts"`,
    "allowed",
  ],
  [
    "a domain test importing test support",
    "packages/domain/test/support.test.ts",
    `import { it } from "@slopmax/test"`,
    "allowed",
  ],
  ["the wire importing a third-party package", "packages/wire/src/zod.ts", `import { z } from "zod"`, "rejected"],
  [
    "engine code importing a computed module",
    "packages/core/src/plugin.ts",
    `export const load = (name: string) => import(name)`,
    "rejected",
  ],
  [
    "engine code importing a fixed module lazily",
    "packages/core/src/lazy.ts",
    `export const load = () => import("./lock.ts")`,
    "allowed",
  ],
  [
    "engine code asserting a value is present",
    "packages/core/src/bang.ts",
    `export const n = new Map<string, number>().get("x")!`,
    "rejected",
  ],
  [
    "engine code silencing the type checker",
    "packages/core/src/ignore.ts",
    `// @ts-ignore\nexport const n: number = "1"`,
    "rejected",
  ],
  [
    "the domain defining its HttpApi",
    "packages/domain/src/api.ts",
    `import { HttpApi } from "effect/http-api"`,
    "allowed",
  ],
  [
    "a domain test importing bun:test",
    "packages/domain/test/ok.test.ts",
    `import { expect } from "bun:test"`,
    "allowed",
  ],
  [
    "domain code reading the environment",
    "packages/domain/src/env.ts",
    `export const home = process.env.HOME`,
    "rejected",
  ],
  ["domain code calling Bun", "packages/domain/src/global.ts", `export const v = Bun.version`, "rejected"],
  [
    "the wire importing the domain",
    "packages/wire/src/ok.ts",
    `import { ProviderId } from "@slopmax/domain"`,
    "allowed",
  ],
  ["the wire importing the engine", "packages/wire/src/core.ts", `import { Pool } from "@slopmax/core"`, "rejected"],
  ["the wire importing ws", "packages/wire/src/ws.ts", `import WebSocket from "ws"`, "rejected"],
  [
    "the engine importing Bun's platform layer",
    "packages/core/src/ok.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "allowed",
  ],
  [
    "the engine importing node:fs",
    "packages/core/src/fs.ts",
    `import { readFile } from "node:fs/promises"`,
    "rejected",
  ],
  [
    "the engine importing node:child_process",
    "packages/core/src/spawn.ts",
    `import { spawn } from "node:child_process"`,
    "rejected",
  ],
  [
    "the engine importing node:net for SOCKS",
    "packages/core/src/socks.ts",
    `import { createServer } from "node:net"`,
    "allowed",
  ],
  ["the engine importing the CLI", "packages/core/src/app.ts", `import { main } from "slopmax"`, "rejected"],
  [
    "the engine reaching into an app by path",
    "packages/core/src/rel.ts",
    `import { x } from "../../../apps/cli/src/x.ts"`,
    "rejected",
  ],
  ["the engine importing bun:ffi", "packages/core/src/ffi.ts", `import { dlopen } from "bun:ffi"`, "rejected"],
  [
    "the engine using Stream outside the proxy",
    "packages/core/src/events.ts",
    `import { Stream } from "effect"`,
    "allowed",
  ],
  ["a cold call using HttpClient", "packages/core/src/quota.ts", `import { HttpClient } from "effect/http"`, "allowed"],
  [
    "the proxy importing Stream",
    "packages/core/src/proxy/relay.ts",
    `import { Effect, Stream } from "effect"`,
    "rejected",
  ],
  [
    "the proxy importing effect/Stream",
    "packages/core/src/proxy/tap.ts",
    `import * as Stream from "effect/Stream"`,
    "rejected",
  ],
  [
    "the proxy importing HttpClient",
    "packages/core/src/proxy/forward.ts",
    `import { HttpClient } from "effect/http"`,
    "rejected",
  ],
  [
    "the proxy importing HttpClient directly",
    "packages/core/src/proxy/attempt.ts",
    `import * as H from "effect/http/HttpClient"`,
    "rejected",
  ],
  ["the proxy importing Effect", "packages/core/src/proxy/ok.ts", `import { Effect } from "effect"`, "allowed"],
  ["the proxy importing node:fs", "packages/core/src/proxy/fs.ts", `import { readFile } from "node:fs"`, "rejected"],
  ["engine code calling setTimeout", "packages/core/src/timer.ts", `setTimeout(() => {}, 1)`, "rejected"],
  [
    "engine code calling globalThis.setInterval",
    "packages/core/src/interval.ts",
    `globalThis.setInterval(() => {}, 1)`,
    "rejected",
  ],
  ["an engine test calling setTimeout", "packages/core/test/timer.test.ts", `setTimeout(() => {}, 1)`, "rejected"],
  ["engine code spawning with Bun", "packages/core/src/run.ts", `Bun.spawn(["claude"])`, "rejected"],
  ["engine code reading with Bun.file", "packages/core/src/read.ts", `export const f = Bun.file("x")`, "rejected"],
  ["engine code casting", "packages/core/src/cast.ts", `export const n = JSON.parse("1") as number`, "rejected"],
  ["engine code with as const", "packages/core/src/const.ts", `export const xs = ["a"] as const`, "allowed"],
  ["code typed any", "packages/core/src/any.ts", `export const f = (x: any) => x`, "rejected"],
  [
    "engine code serving with Bun",
    "packages/core/src/pool.ts",
    `export const s = Bun.serve({ fetch: () => new Response() })`,
    "rejected",
  ],
  [
    "the front door serving with Bun",
    "packages/core/src/server.ts",
    `export const s = Bun.serve({ fetch: () => new Response() })`,
    "allowed",
  ],
  [
    "a cold call using bare fetch",
    "packages/core/src/usage.ts",
    `export const r = fetch("https://example.com")`,
    "rejected",
  ],
  [
    "Upstream.send using fetch",
    "packages/core/src/upstream.ts",
    `import { getCACertificates } from "node:tls"\nexport const r = [fetch, getCACertificates]`,
    "allowed",
  ],
  [
    "engine code opening a Bun WebSocket",
    "packages/core/src/hub.ts",
    `export const w = new WebSocket("ws://x")`,
    "rejected",
  ],
  ["engine code importing node:os", "packages/core/src/home.ts", `import { homedir } from "node:os"`, "rejected"],
  [
    "engine code importing node:http",
    "packages/core/src/admin.ts",
    `import { createServer } from "node:http"`,
    "rejected",
  ],
  [
    "engine code importing node:tls outside Upstream",
    "packages/core/src/certs.ts",
    `import { connect } from "node:tls"`,
    "rejected",
  ],
  ["engine code importing ws", "packages/core/src/ledger.ts", `import WebSocket from "ws"`, "rejected"],
  ["the proxy importing ws", "packages/core/src/proxy/socket.ts", `import WebSocket from "ws"`, "rejected"],
  ["Upstream.dial importing ws", "packages/core/src/dial.ts", `import WebSocket from "ws"`, "allowed"],
  [
    "engine code importing ws's types",
    "packages/core/src/sockets.ts",
    `import type WebSocket from "ws"\nexport type S = WebSocket`,
    "allowed",
  ],
  [
    "engine code reading the environment",
    "packages/core/src/env.ts",
    `export const home = process.env.HOME`,
    "rejected",
  ],
  ["engine code checking a pid", "packages/core/src/lock.ts", `export const alive = process.kill(1, 0)`, "allowed"],
  [
    "the proxy importing effect/index's Stream",
    "packages/core/src/proxy/index-alias.ts",
    `import { Stream } from "effect/index"`,
    "rejected",
  ],
  [
    "the domain importing effect/http/index's HttpClient",
    "packages/domain/src/http-alias.ts",
    `import { HttpClient } from "effect/http/index"`,
    "rejected",
  ],
  ["test support casting", "tools/test/src/cast.ts", `export const n = JSON.parse("1") as number`, "rejected"],
  ["a UI component casting", "apps/ui/src/cast.ts", `export const n = JSON.parse("1") as number`, "rejected"],
  ["the UI importing bun", "apps/ui/src/bun.ts", `import { serve } from "bun"`, "rejected"],
  ["the UI calling Bun", "apps/ui/src/global.ts", `export const v = Bun.version`, "rejected"],
  ["a UI test importing bun:test", "apps/ui/test/ok.test.ts", `import { expect } from "bun:test"`, "allowed"],
  ["the UI importing the engine", "apps/ui/src/core.ts", `import { Pool } from "@slopmax/core"`, "rejected"],
  ["the UI importing the wire", "apps/ui/src/wire.ts", `import { scan } from "@slopmax/wire"`, "rejected"],
  ["the UI importing Node", "apps/ui/src/node.ts", `import { join } from "node:path"`, "rejected"],
  ["the UI importing the domain", "apps/ui/src/ok.ts", `import { SlopmaxApi } from "@slopmax/domain/api"`, "allowed"],
  ["the UI's build script importing Node", "apps/ui/build.ts", `import { join } from "node:path"`, "allowed"],
  [
    "the desktop's main process importing the wire",
    "apps/desktop/src/main/wire.ts",
    `import { scan } from "@slopmax/wire"`,
    "rejected",
  ],
  [
    "the desktop's preload importing the engine",
    "apps/desktop/src/preload/core.ts",
    `import { Pool } from "@slopmax/core"`,
    "rejected",
  ],
  [
    "the desktop's preload importing Node's platform",
    "apps/desktop/src/preload/platform.ts",
    `import { NodeServices } from "@effect/platform-node"`,
    "rejected",
  ],
  [
    "the desktop's preload importing the domain",
    "apps/desktop/src/preload/ok.ts",
    `import { DesktopBridge } from "@slopmax/domain/desktop"`,
    "allowed",
  ],
  [
    "the desktop's main process importing Node's platform",
    "apps/desktop/src/main/ok.ts",
    `import { NodeServices } from "@effect/platform-node"`,
    "allowed",
  ],
  [
    "the UI importing Node's platform",
    "apps/ui/src/platform.ts",
    `import { NodeServices } from "@effect/platform-node"`,
    "rejected",
  ],
  [
    "a CLI command importing Bun's platform layer",
    "apps/cli/src/commands.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "rejected",
  ],
  [
    "the CLI's main importing Bun's platform layer",
    "apps/cli/src/main.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "allowed",
  ],
  ["the CLI importing the wire", "apps/cli/src/wire.ts", `import { scan } from "@slopmax/wire"`, "rejected"],
  [
    "the bench importing Bun's platform layer",
    "tools/bench/src/ok.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "allowed",
  ],
  [
    "test support importing Bun's platform layer",
    "tools/test/src/bun.ts",
    `import { BunServices } from "@effect/platform-bun"`,
    "rejected",
  ],
  ["test support importing Node", "tools/test/src/node.ts", `import { tmpdir } from "node:os"`, "rejected"],
  [
    "test support importing a workspace package",
    "tools/test/src/domain.ts",
    `import { ProviderId } from "@slopmax/domain"`,
    "rejected",
  ],
]

const Diagnostics = Schema.Struct({
  diagnostics: Schema.Array(Schema.Struct({ code: Schema.String, filename: Schema.String, message: Schema.String })),
})

/** Lints every case in a throwaway copy of the workspace layout; returns the boundary findings per file. */
const lintCases = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* TestHome.make("lint")
  yield* fs.copyFile(path.join(workspace, ".oxlintrc.json"), home.path(".oxlintrc.json"))
  // The config loads JS plugins (the UI's lint rules), resolved next to it.
  yield* fs.symlink(path.join(workspace, "node_modules"), home.path("node_modules"))
  for (const [, file, source] of cases) {
    yield* fs.makeDirectory(path.dirname(home.path(file)), { recursive: true })
    yield* fs.writeFileString(home.path(file), `${source}\n`)
  }
  const output = yield* spawner.string(
    ChildProcess.make(
      path.join(workspace, "node_modules/.bin/oxlint"),
      ["-c", ".oxlintrc.json", "--format", "json", "."],
      {
        cwd: home.root,
      },
    ),
  )
  const { diagnostics } = yield* Schema.decodeEffect(Schema.fromJsonString(Diagnostics))(output)
  const findings = new Map<string, Array<string>>()
  for (const diagnostic of diagnostics) {
    if (!boundaryRules.has(diagnostic.code)) continue
    findings.set(diagnostic.filename, [...(findings.get(diagnostic.filename) ?? []), diagnostic.message])
  }
  return findings
})

describe("the lint config", () => {
  it.live(
    "enforces every package boundary and hot-path ban",
    () =>
      Effect.gen(function* () {
        const findings = yield* lintCases
        const wrong = cases
          .filter(([, file, , verdict]) => (findings.has(file) ? "rejected" : "allowed") !== verdict)
          .map(
            ([what, file, , verdict]) =>
              `${what} (${file}) should be ${verdict}: ${findings.get(file)?.join("; ") ?? "no finding"}`,
          )
        expect(wrong).toEqual([])
      }).pipe(Effect.provide(BunServices.layer)),
    30_000,
  )
})
