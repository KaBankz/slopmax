import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer, Option, Path, Schema } from "effect"
import { StartedProxy } from "@slopmax/domain/desktop"
import { it, MemoryFileSystem } from "@slopmax/test"
import { Cli, cliCandidates, failureText, findCli, missingMessage, parseVersion, type Where } from "../src/main/cli.ts"
import { scriptedSpawner, started } from "./support.ts"

const linux: Where = {
  resources: "/opt/slopmax/resources",
  executable: "/opt/slopmax/slopmax-desktop",
  platform: "linux",
}
const program = { data: "#!/bin/sh\n", mode: 0o755 }
const posix = Effect.runSync(
  Effect.gen(function* () {
    return yield* Path.Path
  }).pipe(Effect.provide(Path.layer)),
)

const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars))

const files = (seed: Record<string, string | { readonly data: string; readonly mode: number }>) =>
  MemoryFileSystem.layerWith({ files: seed })

const find = (where: Where, vars: Record<string, string>, seed: Parameters<typeof files>[0]) =>
  findCli(where).pipe(Effect.provide(Layer.mergeAll(files(seed), env(vars))))

describe("finding the CLI", () => {
  test("looks inside the app first, then beside its executable, then each directory on PATH in order", () => {
    expect(cliCandidates(linux, "/usr/local/bin::/usr/bin", posix)).toEqual([
      "/opt/slopmax/resources/bin/slopmax",
      "/opt/slopmax/slopmax",
      "/usr/local/bin/slopmax",
      "/usr/bin/slopmax",
    ])
  })

  test("on Windows, looks for slopmax.exe and splits PATH at semicolons", () => {
    const windows: Where = { resources: "/app/resources", executable: "/app/slopmax-desktop.exe", platform: "win32" }
    expect(cliCandidates(windows, "/a;/b", posix)).toEqual([
      "/app/resources/bin/slopmax.exe",
      "/app/slopmax.exe",
      "/a/slopmax.exe",
      "/b/slopmax.exe",
    ])
  })

  it.effect("commands are looked up on PATH: the first directory holding the CLI wins", () =>
    Effect.gen(function* () {
      const found = yield* find(
        linux,
        { PATH: "/home/someone/bin:/usr/local/bin:/usr/bin" },
        {
          "/usr/local/bin/slopmax": program,
          "/usr/bin/slopmax": program,
        },
      )
      expect(found).toBe("/usr/local/bin/slopmax")
    }),
  )

  it.effect("prefers the CLI the app carries over one on PATH", () =>
    Effect.gen(function* () {
      const found = yield* find(
        linux,
        { PATH: "/usr/bin" },
        {
          "/opt/slopmax/resources/bin/slopmax": program,
          "/usr/bin/slopmax": program,
        },
      )
      expect(found).toBe("/opt/slopmax/resources/bin/slopmax")
    }),
  )

  it.effect("passes over a file it cannot run and a directory of the same name", () =>
    Effect.gen(function* () {
      const found = yield* find(
        linux,
        { PATH: "/first:/second:/third" },
        {
          "/first/slopmax": { data: "not a program", mode: 0o644 },
          "/second/slopmax/readme": "a directory named slopmax",
          "/third/slopmax": program,
        },
      )
      expect(found).toBe("/third/slopmax")
    }),
  )

  it.effect("SLOPMAX_CLI names the CLI directly", () =>
    Effect.gen(function* () {
      const found = yield* find(
        linux,
        { SLOPMAX_CLI: "/work/slopmax", PATH: "/usr/bin" },
        {
          "/work/slopmax": program,
          "/usr/bin/slopmax": program,
        },
      )
      expect(found).toBe("/work/slopmax")
    }),
  )

  it.effect("says to reinstall the app when the CLI is nowhere", () =>
    Effect.gen(function* () {
      const error = yield* find(linux, { PATH: "/usr/bin" }, {}).pipe(Effect.flip)
      expect(error.message).toBe(missingMessage)
    }),
  )
})

describe("reading what the CLI says", () => {
  test("a version line gives the version", () => {
    expect(parseVersion("slopmax 0.4.0\n")).toEqual(Option.some("0.4.0"))
    expect(parseVersion("something else")).toEqual(Option.none())
  })

  test("a failure says the CLI's own last complaint, without its error prefix", () => {
    expect(failureText(["start"], { code: 1, stdout: "", stderr: "starting…\nerror: port 7567 is taken\n" })).toBe(
      "port 7567 is taken",
    )
    expect(failureText(["stop"], { code: 3, stdout: "", stderr: "" })).toBe("slopmax stop exited with 3")
  })
})

const cliLayer = (answer: Parameters<typeof scriptedSpawner>[0]) => {
  const spawner = scriptedSpawner(answer)
  const layer = Cli.layer(linux).pipe(
    Layer.provide(
      Layer.mergeAll(spawner.layer, files({ "/opt/slopmax/resources/bin/slopmax": program }), env({ PATH: "" })),
    ),
  )
  return { layer, calls: spawner.calls }
}

const startJson = JSON.stringify(Schema.encodeSync(StartedProxy)(started("0.4.0")), null, 2)

describe("running the CLI", () => {
  it.effect("start reads where the proxy runs from start --json", () => {
    const { layer, calls } = cliLayer((args) => (args[0] === "start" ? { stdout: startJson } : {}))
    return Effect.gen(function* () {
      const cli = yield* Cli
      const proxy = yield* cli.start
      expect(proxy.url).toBe("http://127.0.0.1:7567")
      expect(calls).toEqual([["/opt/slopmax/resources/bin/slopmax", "start", "--json"]])
    }).pipe(Effect.provide(layer))
  })

  it.effect("a run that fails says why in the CLI's words", () => {
    const { layer } = cliLayer(() => ({ code: 1, stderr: "error: no supported service manager here\n" }))
    return Effect.gen(function* () {
      const cli = yield* Cli
      const error = yield* Effect.flip(cli.serviceInstall)
      expect(error.message).toBe("no supported service manager here")
    }).pipe(Effect.provide(layer))
  })

  it.effect("the doctor's findings are its answer even when it found a failure", () => {
    const sections = JSON.stringify([{ title: "Proxy", findings: [{ level: "fail", text: "not running" }] }])
    const { layer } = cliLayer(() => ({ code: 1, stdout: sections }))
    return Effect.gen(function* () {
      const cli = yield* Cli
      const found = yield* cli.doctor
      expect(found.map((section) => section.title)).toEqual(["Proxy"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("output it cannot read says the CLI may be from another release", () => {
    const { layer } = cliLayer(() => ({ stdout: "{ not json" }))
    return Effect.gen(function* () {
      const cli = yield* Cli
      const error = yield* Effect.flip(cli.status)
      expect(error.message).toContain("does not understand")
    }).pipe(Effect.provide(layer))
  })

  it.effect("asks the bundled CLI its version once", () => {
    const { layer, calls } = cliLayer(() => ({ stdout: "slopmax 0.4.0\n" }))
    return Effect.gen(function* () {
      const cli = yield* Cli
      expect(yield* cli.version).toBe("0.4.0")
      expect(yield* cli.version).toBe("0.4.0")
      expect(calls).toHaveLength(1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a version it could not read is asked again next time", () => {
    let answers = 0
    const { layer, calls } = cliLayer(() =>
      ++answers === 1 ? { code: 1, stderr: "error: busy" } : { stdout: "slopmax 0.4.0\n" },
    )
    return Effect.gen(function* () {
      const cli = yield* Cli
      expect((yield* Effect.flip(cli.version)).message).toBe("busy")
      expect(yield* cli.version).toBe("0.4.0")
      expect(yield* cli.version).toBe("0.4.0")
      expect(calls).toHaveLength(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("a CLI that will not start says it could not be run", () => {
    const { layer } = cliLayer(() => "missing")
    return Effect.gen(function* () {
      const cli = yield* Cli
      const error = yield* Effect.flip(cli.stop)
      expect(error.message).toBe("could not run /opt/slopmax/resources/bin/slopmax")
    }).pipe(Effect.provide(layer))
  })
})
