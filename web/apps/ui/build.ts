// Builds the web dashboard: `dist/web/`, with Geist and brotli and gzip
// copies beside each file, or with `--rust`, `dist/rust/`, the copy the CLI
// embeds and serves at /slopmax/. Asset URLs are relative, so the page loads
// wherever it is served.
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

/** Geist, shadcn/ui's font: one variable file covers every weight. */
const fonts = [
  {
    source: path.join(root, "node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"),
    weight: "100 900",
  },
]

const fontName = async (font: (typeof fonts)[number]): Promise<string> =>
  `geist-${Bun.hash(await Bun.file(font.source).arrayBuffer()).toString(36)}.woff2`

const fontFaces = async (): Promise<string> =>
  (
    await Promise.all(
      fonts.map(
        async (font) =>
          `@font-face{font-family:"Geist Variable";font-style:normal;font-display:swap;font-weight:${font.weight};src:url("${fontScheme}${await fontName(font)}") format("woff2-variations")}`,
      ),
    )
  ).join("\n")

const tailwind = (minify: boolean, withFonts: boolean): BunPlugin => ({
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
      const css = `${withFonts ? await fontFaces() : ""}\n${compiler.build(candidates)}`
      return { contents: minify ? optimize(css, { minify: true }).code : css, loader: "css" }
    })
  },
})

export interface BuildOptions {
  /** Where the files land; `dist/web/` unless told otherwise. */
  readonly outdir?: string
  readonly minify?: boolean
  /** Brotli and gzip copies for the server to pick from. On unless told otherwise. */
  readonly compress?: boolean
  /** Geist shipped as a file; without them, the page uses the system's font. On unless told otherwise. */
  readonly fonts?: boolean
  /** A brotli copy beside the gzip one, when compressing. On unless told otherwise. */
  readonly brotli?: boolean
}

/** Builds the UI and answers the files it wrote, with their sizes. */
export const build = async (options: BuildOptions = {}): Promise<ReadonlyArray<{ path: string; bytes: number }>> => {
  const outdir = options.outdir ?? path.join(root, outputs.web)
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
    plugins: [tailwind(minify, options.fonts ?? true)],
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error("the UI did not build")
  }
  // The fonts themselves, beside the CSS that now names them.
  const fontFiles = await Promise.all(
    ((options.fonts ?? true) ? fonts : []).map(async (font) => {
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
  const license = path.join(outdir, "OFL.txt")
  if (fontFiles.length > 0) {
    await Bun.write(license, Bun.file(path.join(root, "node_modules/@fontsource-variable/geist/LICENSE")))
  }
  const written = result.outputs.map((output) => output.path).concat(fontFiles, fontFiles.length > 0 ? [license] : [])
  if (options.compress ?? true) {
    // Fonts are compressed already; the rest gets a brotli and a gzip copy for the server to pick from.
    for (const file of written.filter((name) => !name.endsWith(".woff2"))) {
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
      if (options.brotli ?? true) {
        await Bun.write(
          `${file}.br`,
          brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }),
        )
      }
      await Bun.write(`${file}.gz`, gzipSync(bytes, { level: 9 }))
    }
  }
  return Promise.all(written.map(async (file) => ({ path: path.relative(outdir, file), bytes: Bun.file(file).size })))
}

if (import.meta.main && Bun.argv.includes("--rust")) {
  // The copy the Rust daemon embeds and serves at /slopmax/: the system's
  // font, and one gzip copy of each file (every browser takes gzip).
  const files = await build({
    outdir: path.join(root, outputs.rust),
    fonts: false,
    brotli: false,
    compress: true,
  })
  console.log(`rust: ${files.length} files, ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes`)
} else if (import.meta.main) {
  const files = await build()
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`web: ${files.length} files, ${total} bytes`)
  for (const file of files) console.log(`  ${file.path} ${file.bytes}`)
}
