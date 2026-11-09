/**
 * slopmax's app icon: a glass Option key (⌥) on a cobalt tile, ray-traced in
 * Blender Cycles from scene.py, then cut to the app-icon squircle.
 *
 *   bun assets/icon/build.ts draft    a quick 512 px look, written to the OS temp dir
 *   bun assets/icon/build.ts render   the 1024 px master, icon.png (about 20 min on 8 CPU cores)
 *   bun assets/icon/build.ts derive   every size the apps use, from icon.png, mark.svg and tray-template.svg
 *
 * Run from the repository's root. `derive` writes the files here, the web UI's copies,
 * and the macOS app's asset catalog (its icon, menu bar glyph and accent color).
 *
 * Blender 5.2 and ImageMagick must be on PATH (or set BLENDER and MAGICK).
 * The master is committed, so `derive` needs only ImageMagick.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const here = import.meta.dir
const blender = process.env.BLENDER ?? "blender"
const magick = process.env.MAGICK ?? "convert"
const master = path.join(here, "icon.png")
const root = path.join(here, "../..")
const ui = path.join(root, "web/apps/ui/src")
const catalog = path.join(root, "apple/Slopmax/Assets.xcassets")

/** Big Sur's icon grid: the tile is 824 of the 1024 canvas, its corner radius 228 at full size. */
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

const svg = (source: string, size: number, out: string) =>
  $`${magick} -background none -density 1200 ${source} -filter Lanczos -resize ${size}x${size} -depth 8 -strip ${out}`

/** An .icns is a list of PNGs, each tagged with its slot; macOS reads PNG in every one used here. */
const icns = async (dir: string, macos: string): Promise<Uint8Array> => {
  const slots: ReadonlyArray<readonly [string, number]> = [
    ["icp4", 16],
    ["icp5", 32],
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024],
  ]
  const entries = await Promise.all(
    slots.map(async ([tag, size]) => {
      const file = path.join(dir, `mac-${size}.png`)
      await $`${magick} ${macos} -filter Lanczos -resize ${size}x${size} -depth 8 -strip ${file}`
      return [tag, new Uint8Array(await Bun.file(file).arrayBuffer())] as const
    }),
  )
  const length = 8 + entries.reduce((sum, [, png]) => sum + 8 + png.byteLength, 0)
  const out = new Uint8Array(length)
  const view = new DataView(out.buffer)
  const tag = (at: number, name: string) => out.set(new TextEncoder().encode(name), at)
  tag(0, "icns")
  view.setUint32(4, length)
  let at = 8
  for (const [name, png] of entries) {
    tag(at, name)
    view.setUint32(at + 4, 8 + png.byteLength)
    out.set(png, at + 8)
    at += 8 + png.byteLength
  }
  return out
}

const json = (file: string, value: unknown) => Bun.write(file, `${JSON.stringify(value, null, 2)}\n`)
const info = { author: "xcode", version: 1 }

/** The macOS app's asset catalog: the app icon at every size macOS asks for, the menu bar glyph, the accent. */
const apple = async (macos: string): Promise<void> => {
  await json(path.join(catalog, "Contents.json"), { info })
  const icon = path.join(catalog, "AppIcon.appiconset")
  await mkdir(icon, { recursive: true })
  const images = []
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon-${points}@${scale}x.png`
      await $`${magick} ${macos} -filter Lanczos -resize ${points * scale}x${points * scale} -depth 8 -strip ${path.join(icon, filename)}`
      images.push({ filename, idiom: "mac", scale: `${scale}x`, size: `${points}x${points}` })
    }
  }
  await json(path.join(icon, "Contents.json"), { images, info })
  // The menu bar tints a template image to suit itself; the vector scales to any display.
  const glyph = path.join(catalog, "MenuBarIcon.imageset")
  await Bun.write(path.join(glyph, "menubar.svg"), Bun.file(path.join(here, "tray-template.svg")))
  await json(path.join(glyph, "Contents.json"), {
    images: [{ filename: "menubar.svg", idiom: "universal" }],
    info,
    properties: { "preserves-vector-representation": true, "template-rendering-intent": "template" },
  })
  // The cobalt of the tile, as the web UI's --brand has it in light and dark.
  const color = (hex: string) => ({
    "color-space": "srgb",
    components: {
      alpha: "1.000",
      red: `0x${hex.slice(0, 2)}`,
      green: `0x${hex.slice(2, 4)}`,
      blue: `0x${hex.slice(4, 6)}`,
    },
  })
  await json(path.join(catalog, "AccentColor.colorset", "Contents.json"), {
    colors: [
      { color: color("2470EE"), idiom: "universal" },
      {
        appearances: [{ appearance: "luminosity", value: "dark" }],
        color: color("6AA0FF"),
        idiom: "universal",
      },
    ],
    info,
  })
}

const derive = async (): Promise<void> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slopmax-icon-"))
  try {
    // The UI: the flat mark for the favicon and the small logo, the app icon for the large one.
    await Bun.write(path.join(ui, "logo.svg"), Bun.file(path.join(here, "mark.svg")))
    await resize(128, path.join(ui, "icon-128.png"))
    // The menu bar (a macOS template: black, its alpha is all that counts) and the Windows and Linux tray.
    await svg(path.join(here, "tray-template.svg"), 16, path.join(here, "trayTemplate.png"))
    await svg(path.join(here, "tray-template.svg"), 32, path.join(here, "trayTemplate@2x.png"))
    await svg(path.join(here, "mark.svg"), 16, path.join(here, "tray.png"))
    await svg(path.join(here, "mark.svg"), 32, path.join(here, "tray@2x.png"))
    // macOS draws no shape of its own, so the tile sits on Apple's grid with its soft shadow.
    const macos = path.join(here, "icon-macos.png")
    // prettier-ignore
    const shadowed = [
      "-size", "1024x1024", "xc:none",
      "(", master, "-filter", "Lanczos", "-resize", "824x824", "-repage", "+100+100", ")",
      "(", "+clone", "-background", "black", "-shadow", "35x14+0+12", ")",
      "-swap", "1,2", "-layers", "flatten", "-depth", "8", "-strip", macos,
    ]
    await $`${magick} ${shadowed}`
    await Bun.write(path.join(here, "icon.icns"), await icns(dir, macos))
    // Windows and Linux show the tile as it is.
    await $`${magick} ${master} -filter Lanczos -define icon:auto-resize=256,128,64,48,32,24,16 ${path.join(here, "icon.ico")}`
    await apple(macos)
    console.log(
      "wrote icon-macos.png, icon.icns, icon.ico, the tray images, the UI's logo.svg and icon-128.png, and apple/Slopmax/Assets.xcassets",
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const command = process.argv[2]
if (command === "draft") await render(true)
else if (command === "render") await render(false)
else if (command === "derive") await derive()
else {
  console.error("usage: bun assets/icon/build.ts draft | render | derive")
  process.exit(2)
}
