import { describe, expect } from "bun:test"
import { Assets, Platform } from "@slopmax/core"
import { it } from "@slopmax/test"
import { Effect, FileSystem, Layer, Path } from "effect"
import {
  aotArgs,
  allowedPackages,
  budgetProblems,
  embeddedSource,
  fallbackArgs,
  filesUnder,
  packagesOf,
  sizeBudget,
  xzBudget,
} from "../build.ts"

describe("the binary's build", () => {
  it("builds ahead of time with every unused API and locale trimmed, reading nothing beside the binary", () => {
    const args = aotArgs("/out/slopmax", false)
    expect(args[0]).toBe("compile")
    for (const flag of ["--trim", "--trim-locales=en", "--no-compile-function-source", "--outfile=/out/slopmax"]) {
      expect(args).toContain(flag)
    }
    expect(args.filter((arg) => arg.startsWith("--no-compile-autoload-")).length).toBe(4)
    expect(args).not.toContain("--explain=text")
    expect(aotArgs("/out/slopmax", true)).toContain("--explain=text")
    expect(args.at(-1)?.endsWith("src/main.ts")).toBe(true)
  })

  it("builds the fallback as bytecode, laid out by the profiles once there are some", () => {
    const first = fallbackArgs("/out/slopmax", [])
    expect(first).toContain("--no-aot")
    expect(first).toContain("--bytecode")
    expect(first.some((arg) => arg.startsWith("--bytecode-order"))).toBe(false)
    expect(fallbackArgs("/out/slopmax", ["/d/version.order", "/d/serve.order"])).toContain(
      "--bytecode-order=/d/version.order,/d/serve.order",
    )
  })

  it("names the third-party packages a bundle carries, leaving out slopmax's own", () => {
    const inputs = [
      "../../node_modules/.bun/effect@4.1.0/node_modules/effect/dist/Effect.js",
      "../../node_modules/.bun/effect@4.1.0/node_modules/effect/dist/Stream.js",
      "../../node_modules/.bun/@effect+platform-bun@4.1.0/node_modules/@effect/platform-bun/dist/BunServices.js",
      "../../node_modules/@slopmax/core/src/index.ts",
      "../../packages/domain/src/report.ts",
      "src/main.ts",
    ]
    expect(packagesOf(inputs)).toEqual(["@effect/platform-bun", "effect"])
  })

  it("passes a binary within its budgets and names each way one is broken", () => {
    expect(budgetProblems(sizeBudget, xzBudget, allowedPackages)).toEqual([])
    const problems = budgetProblems(sizeBudget + 1, xzBudget + 1, ["effect", "left-pad"])
    expect(problems.length).toBe(3)
    expect(problems[0]).toContain(`budget ${sizeBudget}`)
    expect(problems[1]).toContain("as xz")
    expect(problems[2]).toContain("left-pad")
  })

  it("lists each web file once, with its compressed copies, in an order that does not depend on the disk", () => {
    const source = embeddedSource(["index.html.gz", "app.js", "index.html", "font.woff2", "index.html.br"], "../web")
    expect(source).toContain('"app.js": { plain: Bun.file(')
    expect(source).toContain('"font.woff2": { plain: Bun.file(')
    expect(source).toMatch(/"index\.html": \{ br: Bun\.file\(file\d\), gzip: Bun\.file\(file\d\) \}/)
    expect(source).not.toContain('"index.html.br":')
    expect(source).toContain('import file0 from "../web/app.js" with { type: "file" }')
  })

  it.live("writes an embedded.ts that loads and carries each file's bytes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Beside the tests, so the generated module finds @slopmax/core; removed with the test.
      const dir = yield* fs.makeTempDirectoryScoped({ directory: import.meta.dir, prefix: ".embedded-" })
      const web = path.join(dir, "web")
      yield* fs.makeDirectory(path.join(web, "assets"), { recursive: true })
      const files: Record<string, string> = {
        "index.html": "<!doctype html>",
        "index.html.br": "brotli bytes",
        "index.html.gz": "gzip bytes",
        "assets/app-3f9a1c2b.js": "console.log(1)",
      }
      for (const [name, text] of Object.entries(files)) yield* fs.writeFileString(path.join(web, name), text)
      const names = yield* filesUnder(web)
      const module = path.join(dir, "embedded.ts")
      yield* fs.writeFileString(module, embeddedSource(names, "./web"))
      // The generated module's shape is what embeddedSource writes; loading it is the check.
      const loaded: { readonly embedded: Layer.Layer<Assets> } = yield* Effect.promise(
        // oxlint-disable-next-line import/no-dynamic-require -- the module is the one this test just generated
        () => import(module),
      )
      const assets = yield* Effect.provide(Effect.service(Assets), loaded.embedded)
      expect([...assets.files.keys()].toSorted()).toEqual(["assets/app-3f9a1c2b.js", "index.html"])
      const page = assets.files.get("index.html")
      expect(yield* Effect.promise(() => page?.br?.text() ?? Promise.resolve(""))).toBe("brotli bytes")
      expect(yield* Effect.promise(() => page?.gzip?.text() ?? Promise.resolve(""))).toBe("gzip bytes")
      expect(page?.plain).toBeUndefined()
      const script = assets.files.get("assets/app-3f9a1c2b.js")
      expect(yield* Effect.promise(() => script?.plain?.text() ?? Promise.resolve(""))).toBe("console.log(1)")
    }).pipe(Effect.provide(Platform.layer)),
  )
})
