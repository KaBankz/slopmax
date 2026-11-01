// Draws every page of the desktop app, and the menu bar's panel, in light and
// dark, to `<dir>/{light,dark}-<page>.png`: for the README, for reviewing a
// change to the UI, and for checking a packaged app at a glance.
//
//   bun shots.ts <dir> [--app <packaged executable>] [--height <px>]
//
// The app runs against the proxy its environment names (SLOPMAX_HOME,
// SLOPMAX_LISTEN, SLOPMAX_CLI…; `mise run demo` prints one with fake
// accounts), with throwaway user data and reduced motion. It waits up to 20 s
// for the proxy's report, then for each page's data, and quits when done.
// Light and dark are switched for the run only; no preference is saved, and
// notifications are off, so nothing the daemon says reaches the desktop.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { command, launch, textWhere, windowAt } from "./drive.ts"

/** Pages in sidebar order; each account's provider page goes after the overview. */
const pagesAfterProviders = ["usage", "performance", "requests", "agents", "access", "diagnostics", "settings"]

/** How long a page is given to draw its data (history, the doctor's checks) before it is drawn. */
const settle = (page: string): number =>
  page === "diagnostics" ? 4_000 : page === "usage" || page === "performance" ? 2_500 : 1_200

const option = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}

const main = async (): Promise<void> => {
  const dir = process.argv[2]
  if (dir === undefined || dir.startsWith("--"))
    throw new Error("usage: bun shots.ts <dir> [--app <executable>] [--height <px>]")
  const asked = Number(option("--height") ?? "1400")
  const height = asked >= 400 ? asked : 1400
  const app = option("--app")
  const userData = await mkdtemp(path.join(tmpdir(), "slopmax-shots-"))
  await Bun.write(path.join(userData, "prefs.json"), JSON.stringify({ notifications: false }))
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const setup = { app, userData, env, args: ["--force-prefers-reduced-motion"] }
  const running = await launch(setup)
  try {
    const window = await windowAt(running, "#/")
    await running.evaluate(
      ({ BrowserWindow }, size) => {
        for (const win of BrowserWindow.getAllWindows()) win.setContentSize(size.width, size.height)
      },
      { width: 1160, height },
    )
    await textWhere(window, (text) => text.includes("Overview") && !text.includes("Starting the proxy"))
    const providers = await window.evaluate(async () => {
      const answer = await fetch("/slopmax/api/status")
      if (!answer.ok) return []
      const report: { readonly accounts: ReadonlyArray<{ readonly provider: string }> } = await answer.json()
      return [...new Set(report.accounts.map((account) => account.provider))]
    })
    const pages = ["overview", ...providers, ...pagesAfterProviders]
    for (const mode of ["light", "dark"] as const) {
      await running.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme
      }, mode)
      for (const page of pages) {
        await window.evaluate((hash) => {
          location.hash = hash
        }, `#/${page}`)
        await Bun.sleep(settle(page))
        const file = path.join(dir, `${mode}-${page}.png`)
        await window.screenshot({ path: file })
        console.log(file)
      }
      // The panel opens from a second launch with --panel, as a desktop shortcut opens it, and closes the same way.
      const second = command({ ...setup, args: ["--panel"] })
      const togglePanel = () => Bun.spawnSync([second.program, ...second.args], { env })
      togglePanel()
      const panel = await windowAt(running, "#/panel")
      await Bun.sleep(1_500)
      const file = path.join(dir, `${mode}-panel.png`)
      await panel.screenshot({ path: file })
      console.log(file)
      togglePanel()
    }
  } finally {
    await running.close().catch(() => undefined)
    await rm(userData, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(`slopmax: could not draw the pages: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
