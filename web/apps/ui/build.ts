// Builds the web dashboard the daemon embeds and serves at /slopmax/:
// `dist/rust/`, with a gzip copy beside each file (every browser takes gzip;
// the daemon embeds whichever copy is smaller). Asset URLs are relative, so
// the page loads wherever it is served. `--rust`, which `mise run ui` and the
// Dockerfile pass, names this same build.
//
// Tailwind runs through the small plugin below rather than Tailwind's own
// Bun plugin, which bundles an older Tailwind than the one installed.
import { rm } from "node:fs/promises"
import { compile, optimize } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import type { BunPlugin } from "bun"
import path from "node:path"
import { outdir as defaultOutdir } from "./src/index.ts"

const root = import.meta.dir
const fontAssets = [
  ["bricolage-grotesque-latin.woff2", "bricolage-grotesque-latin.woff2"],
  ["OFL.txt", "bricolage-grotesque-OFL.txt"],
  ["geist-latin.woff2", "geist-latin.woff2"],
  ["geist-OFL.txt", "geist-OFL.txt"],
] as const

const tailwind = (minify: boolean): BunPlugin => ({
  name: "tailwind",
  setup(build) {
    build.onLoad({ filter: /\.css$/ }, async ({ path: file }) => {
      const source = await Bun.file(file).text()
      if (!source.includes('@import "tailwindcss"')) return { contents: source, loader: "css" }
      const base = path.dirname(file)
      const compiler = await compile(source, { base, from: file, shouldRewriteUrls: true, onDependency: () => {} })
      const sources = compiler.sources.map(({ base: from, pattern, negated }) => ({ base: from, pattern, negated }))
      if (compiler.root !== "none" && compiler.root !== null) sources.push({ ...compiler.root, negated: false })
      const candidates = new Scanner({ sources }).scan()
      const css = compiler.build(candidates)
      return { contents: minify ? optimize(css, { minify: true }).code : css, loader: "css" }
    })
  },
})

export interface BuildOptions {
  /** Where the files land; `dist/rust/` unless told otherwise. */
  readonly outdir?: string
  readonly minify?: boolean
  /** A gzip copy beside each file, for the daemon to embed. On unless told otherwise. */
  readonly compress?: boolean
}

/** Builds the UI and answers the files it wrote, with their sizes. */
export const build = async (options: BuildOptions = {}): Promise<ReadonlyArray<{ path: string; bytes: number }>> => {
  const outdir = options.outdir ?? path.join(root, defaultOutdir)
  const minify = options.minify ?? true
  await rm(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [path.join(root, "index.html")],
    outdir,
    minify,
    target: "browser",
    publicPath: "./",
    // The daemon permits font files from its own origin. Emit one instead of a CSS data URL.
    external: ["*.woff2"],
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development") },
    plugins: [tailwind(minify)],
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error("the UI did not build")
  }
  const fonts = await Promise.all(
    fontAssets.map(async ([source, name]) => {
      const destination = path.join(outdir, name)
      await Bun.write(destination, Bun.file(path.join(root, "src", "fonts", source)))
      return destination
    }),
  )
  const written = [...result.outputs.map((output) => output.path), ...fonts]
  if (options.compress ?? true) {
    for (const file of written) {
      await Bun.write(`${file}.gz`, Bun.gzipSync(await Bun.file(file).bytes(), { level: 9 }))
    }
  }
  return Promise.all(written.map(async (file) => ({ path: path.relative(outdir, file), bytes: Bun.file(file).size })))
}

if (import.meta.main) {
  const files = await build()
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`${defaultOutdir}: ${files.length} files, ${total} bytes`)
  for (const file of files) console.log(`  ${file.path} ${file.bytes}`)
}
