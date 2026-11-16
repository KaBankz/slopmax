/**
 * slopmax's app icon: a glass Option key (⌥) on a cobalt tile, ray-traced in
 * Blender Cycles from scene.py, then cut to the app-icon squircle.
 *
 *   bun assets/icon/build.ts draft    a quick 512 px look, written to the OS temp dir
 *   bun assets/icon/build.ts render   the 1024 px master, icon.png (about 20 min on 8 CPU cores)
 *   bun assets/icon/build.ts derive   the web UI's copies and slopmax.exe's icon.ico, from icon.png and mark.svg
 *
 * Run from the repository's root.
 *
 * Blender 5.2 and ImageMagick must be on PATH (or set BLENDER and MAGICK).
 * The master is committed, so `derive` needs only ImageMagick.
 */
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const here = import.meta.dir
const blender = process.env.BLENDER ?? "blender"
const magick = process.env.MAGICK ?? "convert"
const master = path.join(here, "icon.png")
const root = path.join(here, "../..")
const ui = path.join(root, "web/apps/ui/src")

/** The squircle's corner radius: 228 at 1024 px. */
const squircle = async (dir: string, size: number, radius: number): Promise<string> => {
  const mask = path.join(dir, `mask-${size}.png`)
  await $`${magick} -size ${size}x${size} xc:black -fill white -draw ${`roundrectangle 0,0,${size - 1},${size - 1},${radius},${radius}`} ${mask}`
  return mask
}

const render = async (draft: boolean): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slopmax-icon-"))
  const [size, samples] = draft ? [512, 48] : [1024, 256]
  const raw = path.join(dir, "raw.png")
  try {
    await $`${blender} -b -P ${path.join(here, "scene.py")} -- ${raw} ${size} ${samples}`.quiet()
    const mask = await squircle(dir, size, Math.round((228 * size) / 1024))
    const out = draft ? path.join(os.tmpdir(), "slopmax-icon-draft.png") : master
    await $`${magick} ${raw} -alpha off ${mask} -compose CopyOpacity -composite ${out}`
    console.log(`wrote ${out}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const resize = (size: number, out: string) =>
  $`${magick} ${master} -filter Lanczos -resize ${size}x${size} -depth 8 -strip ${out}`

const derive = async (): Promise<void> => {
  // The UI: the flat mark for the favicon and the small logo, the app icon for the large one.
  await Bun.write(path.join(ui, "logo.svg"), Bun.file(path.join(here, "mark.svg")))
  await resize(128, path.join(ui, "icon-128.png"))
  // Windows shows the tile as it is.
  await $`${magick} ${master} -filter Lanczos -define icon:auto-resize=256,128,64,48,32,24,16 ${path.join(here, "icon.ico")}`
  console.log("wrote icon.ico and the UI's logo.svg and icon-128.png")
}

const command = process.argv[2]
if (command === "draft") await render(true)
else if (command === "render") await render(false)
else if (command === "derive") await derive()
else {
  console.error("usage: bun assets/icon/build.ts draft | render | derive")
  process.exit(2)
}
