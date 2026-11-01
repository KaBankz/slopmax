// Builds the UI twice from one source: `dist/web/` (embedded in the CLI and
// served at /slopmax/, with brotli and gzip copies beside each file) and
// `dist/desktop/` (shipped in the desktop app and served from app://slopmax/).
// Asset URLs are relative, so both hosts load the same files.
//
// Tailwind runs through the small plugin below rather than Tailwind's own
// Bun plugin, which bundles an older Tailwind than the one installed.
//
// This script runs at build time under Bun and ships nothing, so it may use
// node:zlib: brotli has no Bun or web API (CompressionStream has no brotli).
// The app itself, under src/, uses no node:* module.
import { rm } from "node:fs/promises"
import { brotliCompressSync, constants, gzipSync } from "node:zlib"
import { compile, optimize } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import type { BunPlugin } from "bun"
import path from "node:path"
import { outputs } from "./src/index.ts"

const root = import.meta.dir

/**
 * The bundler would inline every font into the CSS as a data URL, which the
 * dashboard's CSP refuses (fonts come from its own origin) and which keeps
 * fonts out of the browser's cache. So the CSS names each font by a
 * placeholder address carrying its content hash, which the bundler leaves alone,
 * and the build copies the font beside the CSS and points the CSS at it.
 */
const fontScheme = "https://fonts.slopmax.invalid/"

const fonts = ["400", "500", "600"].map((weight) => ({
  source: path.join(root, `node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${weight}-normal.woff2`),
  weight,
}))

const fontName = async (font: (typeof fonts)[number]): Promise<string> =>
  `ibm-plex-sans-${font.weight}-${Bun.hash(await Bun.file(font.source).arrayBuffer()).toString(36)}.woff2`

const fontFaces = async (): Promise<string> =>
  (
    await Promise.all(
      fonts.map(
        async (font) =>
          `@font-face{font-family:"IBM Plex Sans";font-style:normal;font-display:swap;font-weight:${font.weight};src:url("${fontScheme}${await fontName(font)}") format("woff2")}`,
      ),
    )
  ).join("\n")

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
      const css = `${await fontFaces()}\n${compiler.build(candidates)}`
      return { contents: minify ? optimize(css, { minify: true }).code : css, loader: "css" }
    })
  },
})

export interface BuildOptions {
  readonly host: "web" | "desktop"
  readonly outdir?: string
  readonly minify?: boolean
  /** Brotli and gzip copies for the server to pick from; the web copy has them unless told otherwise. */
  readonly compress?: boolean
}

/** Builds one host's copy and answers the files it wrote, with their sizes. */
export const build = async (options: BuildOptions): Promise<ReadonlyArray<{ path: string; bytes: number }>> => {
  const outdir = options.outdir ?? path.join(root, outputs[options.host])
  const minify = options.minify ?? true
  await rm(outdir, { recursive: true, force: true })
  const result = await Bun.build({
    entrypoints: [path.join(root, "index.html")],
    outdir,
    minify,
    target: "browser",
    publicPath: "./",
    naming: { entry: "[name].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    define: { "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development") },
    plugins: [tailwind(minify)],
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error("the UI did not build")
  }
  // The fonts themselves, beside the CSS that now names them.
  const fontFiles = await Promise.all(
    fonts.map(async (font) => {
      const target = path.join(outdir, await fontName(font))
      await Bun.write(target, Bun.file(font.source))
      return target
    }),
  )
  for (const output of result.outputs) {
    if (!output.path.endsWith(".css")) continue
    const css = await Bun.file(output.path).text()
    await Bun.write(output.path, css.replaceAll(fontScheme, "./"))
  }
  // The fonts' license travels with them.
  await Bun.write(
    path.join(outdir, "OFL.txt"),
    Bun.file(path.join(root, "node_modules/@fontsource/ibm-plex-sans/LICENSE")),
  )
  const written = result.outputs.map((output) => output.path).concat(fontFiles, path.join(outdir, "OFL.txt"))
  if (options.compress ?? options.host === "web") {
    // Fonts are compressed already; the rest gets a brotli and a gzip copy for the server to pick from.
    for (const file of written.filter((name) => !name.endsWith(".woff2"))) {
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
      await Bun.write(
        `${file}.br`,
        brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }),
      )
      await Bun.write(`${file}.gz`, gzipSync(bytes, { level: 9 }))
    }
  }
  return Promise.all(written.map(async (file) => ({ path: path.relative(outdir, file), bytes: Bun.file(file).size })))
}

if (import.meta.main) {
  for (const host of ["web", "desktop"] as const) {
    const files = await build({ host })
    const total = files.reduce((sum, file) => sum + file.bytes, 0)
    console.log(`${host}: ${files.length} files, ${total} bytes`)
    for (const file of files) console.log(`  ${file.path} ${file.bytes}`)
  }
}
