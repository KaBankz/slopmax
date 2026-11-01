// Packages the desktop app for this platform into `pkg/`:
//
//   bun package.ts [--cli <slopmax binary>] [--ui <desktop UI build>] [--out <dir>] [--archive]
//
// It builds `out/` (build.ts), stages it with a minimal package.json (the
// bundle needs no node_modules), and runs @electron/packager with the app in
// an asar archive and the CLI in `resources/bin`, where the app looks for it
// first. Only the en-US locale is kept, and Chromium's Vulkan and SwiftShader
// files are dropped: the app runs without GPU acceleration and draws no 3D.
// The CLI is `--cli`, else apps/cli/dist/slopmax, else built here with
// `bun run --cwd ../cli compile` (ahead of time when this runs on Bun canary).
// On macOS the bundle is `slopmax.app` (bundle id dev.slopmax.desktop), with
// the CLI and then the app signed ad hoc. The app's icon is slopmax's own
// (ts/assets/icon: icon.icns, icon.ico). `--archive` adds a .tar.xz beside it
// (a .zip on Windows, whose tar writes no xz). The sizes are printed, and added
// to a GitHub job's summary.
//
// This script runs at build time under Bun and ships nothing itself.
import { packager } from "@electron/packager"
import { appendFile, chmod, cp, lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { slopmaxVersion } from "@slopmax/domain/version"
import { buildApp, iconSet, out } from "./build.ts"

const root = import.meta.dir

const option = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}

const run = (command: ReadonlyArray<string>, cwd = root): void => {
  const done = Bun.spawnSync([...command], { cwd, stdout: "inherit", stderr: "inherit" })
  if (done.exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${done.exitCode}`)
}

/** The CLI to ship: the one named, the one built already, or one built now. */
const cliBinary = async (): Promise<string> => {
  const named = option("--cli")
  if (named !== undefined) return path.resolve(named)
  const built = path.join(root, "../cli/dist", process.platform === "win32" ? "slopmax.exe" : "slopmax")
  if (!(await Bun.file(built).exists())) run([process.execPath, "run", "--cwd", path.join(root, "../cli"), "compile"])
  return built
}

/** Chromium's files the app never uses: every locale but en-US, and the Vulkan and SwiftShader GPU stand-ins. */
export const unused = (relative: string): boolean => {
  const name = path.basename(relative)
  const parent = path.basename(path.dirname(relative))
  if (parent === "locales" && name.endsWith(".pak")) return name !== "en-US.pak"
  if (name.endsWith(".lproj")) return name !== "en.lproj" && name !== "Base.lproj"
  return /^(lib)?vk_swiftshader|^libvulkan|^vulkan-1\.dll$|vk_swiftshader_icd\.json$/.test(name)
}

const prune = async (dir: string): Promise<void> => {
  for (const entry of await readdir(dir, { recursive: true })) {
    if (unused(entry)) await rm(path.join(dir, entry), { recursive: true, force: true })
  }
}

/** Bytes under `dir`, every file counted once. */
export const sizeOf = async (dir: string): Promise<number> => {
  let total = 0
  for (const entry of await readdir(dir, { recursive: true })) {
    const info = await lstat(path.join(dir, entry))
    if (info.isFile()) total += info.size
  }
  return total
}

const main = async (): Promise<void> => {
  const pkg = path.resolve(option("--out") ?? path.join(root, "pkg"))
  await buildApp({ ui: option("--ui") })
  const cli = await cliBinary()
  const stage = await mkdtemp(path.join(tmpdir(), "slopmax-desktop-stage-"))
  try {
    const app = path.join(stage, "app")
    await cp(out, app, { recursive: true })
    await Bun.write(
      path.join(app, "package.json"),
      JSON.stringify(
        {
          name: "slopmax-desktop",
          productName: "slopmax",
          version: slopmaxVersion,
          private: true,
          type: "module",
          main: "main.js",
        },
        null,
        2,
      ),
    )
    const bin = path.join(stage, "bin")
    // Shipped under the name the app looks for, whatever the given binary is called.
    const shipped = path.join(bin, process.platform === "win32" ? "slopmax.exe" : "slopmax")
    await cp(cli, shipped)
    await chmod(shipped, 0o755)
    const electron: { readonly version: string } = await Bun.file(
      path.join(root, "node_modules/electron/package.json"),
    ).json()
    const [made] = await packager({
      dir: app,
      out: pkg,
      name: "slopmax",
      executableName: "slopmax-desktop",
      appBundleId: "dev.slopmax.desktop",
      appVersion: slopmaxVersion,
      buildVersion: slopmaxVersion,
      electronVersion: electron.version,
      platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
      arch: process.arch === "arm64" ? "arm64" : "x64",
      asar: true,
      prune: false,
      overwrite: true,
      quiet: true,
      extraResource: [bin],
      // icon.icns on macOS and icon.ico on Windows; Linux takes the window's icon from out/icons.
      icon: path.join(iconSet, "icon"),
      extendInfo: { CFBundleDisplayName: "slopmax", LSMinimumSystemVersion: "12.0", NSHighResolutionCapable: true },
      afterExtract: [async ({ buildPath }) => prune(buildPath)],
    })
    if (made === undefined) throw new Error("the packager made nothing")
    if (process.platform === "darwin") {
      const bundle = path.join(made, "slopmax.app")
      run(["codesign", "--force", "--sign", "-", path.join(bundle, "Contents/Resources/bin/slopmax")])
      run(["codesign", "--force", "--deep", "--sign", "-", bundle])
    }
    const lines = [`- \`${path.basename(made)}\`: ${await sizeOf(made)} bytes unpacked`]
    if (process.argv.includes("--archive")) {
      const windows = process.platform === "win32"
      const archive = `${made}${windows ? ".zip" : ".tar.xz"}`
      // Windows' tar picks the zip format from the name (-a).
      const flags = windows ? ["-a", "-cf"] : ["-cJf"]
      run(["tar", ...flags, archive, "-C", path.dirname(made), path.basename(made)])
      lines.push(`- \`${path.basename(archive)}\`: ${Bun.file(archive).size} bytes`)
    }
    console.log(lines.join("\n"))
    // In CI, the sizes go to the job's summary too.
    const summary = process.env["GITHUB_STEP_SUMMARY"]
    if (summary !== undefined) await appendFile(summary, `${lines.join("\n")}\n`)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
