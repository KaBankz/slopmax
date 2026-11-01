// Builds the desktop app into `out/`, ready for `electron .` or for package.ts:
//
//   out/main.js       main, one ESM file for Electron's Node (effect and the
//                     Node platform layer inlined; only `electron` stays outside)
//   out/preload.cjs   the preload, CommonJS, as a sandboxed preload must be
//   out/ui/           the UI's desktop build (apps/ui), served from app://slopmax/;
//                     `--ui <dir>` takes one built already instead
//   out/icons/        the tray and window icons, copied from slopmax's icon set
//                     (ts/assets/icon), so a new icon is made in one place
//
// This script runs at build time under Bun and ships nothing itself.
import { cp, rm } from "node:fs/promises"
import path from "node:path"
import { build as buildUi } from "../ui/build.ts"

const root = import.meta.dir
export const out = path.join(root, "out")
/** slopmax's icon set; package.ts takes the macOS and Windows app icons from here too. */
export const iconSet = path.join(root, "../../assets/icon")

/**
 * The icons main loads: the tray (a macOS menu bar template, a colored mark
 * elsewhere, each at 1x and 2x, which Electron picks by the display) and the
 * window's icon on Linux. macOS and Windows take the window's from the app.
 */
export const shippedIcons = ["tray.png", "tray@2x.png", "trayTemplate.png", "trayTemplate@2x.png", "icon.png"] as const

export interface Built {
  readonly path: string
  readonly bytes: number
}

const bundle = async (options: {
  readonly entry: string
  readonly name: string
  readonly format: "esm" | "cjs"
  readonly minify: boolean
}): Promise<void> => {
  const result = await Bun.build({
    entrypoints: [path.join(root, options.entry)],
    outdir: out,
    target: "node",
    format: options.format,
    minify: options.minify,
    // Electron gives main and the preload its module itself.
    external: ["electron"],
    naming: options.name,
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error(`${options.entry} did not build`)
  }
}

/** Builds everything into `out/` and answers the files written, with their sizes. */
export const buildApp = async (
  options: {
    readonly minify?: boolean
    /** A desktop build of the UI made already (apps/ui's dist/desktop), used instead of building one. */
    readonly ui?: string | undefined
  } = {},
): Promise<ReadonlyArray<Built>> => {
  const minify = options.minify ?? true
  const ui = path.join(out, "ui")
  await rm(out, { recursive: true, force: true })
  await Promise.all([
    bundle({ entry: "src/main/main.ts", name: "main.js", format: "esm", minify }),
    bundle({ entry: "src/preload.ts", name: "preload.cjs", format: "cjs", minify }),
    options.ui === undefined
      ? buildUi({ host: "desktop", outdir: ui, minify })
      : cp(path.resolve(options.ui), ui, { recursive: true }),
  ])
  for (const icon of shippedIcons) await cp(path.join(iconSet, icon), path.join(out, "icons", icon))
  const files: Array<Built> = []
  for await (const file of new Bun.Glob("**/*").scan({ cwd: out })) {
    files.push({ path: file, bytes: Bun.file(path.join(out, file)).size })
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path))
}

if (import.meta.main) {
  const at = process.argv.indexOf("--ui")
  const files = await buildApp({
    minify: !process.argv.includes("--no-minify"),
    ui: at < 0 ? undefined : process.argv[at + 1],
  })
  const total = files.reduce((sum, file) => sum + file.bytes, 0)
  console.log(`out/: ${files.length} files, ${total} bytes`)
  for (const file of files) console.log(`  ${file.path} ${file.bytes}`)
}
