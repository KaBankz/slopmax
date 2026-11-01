// Starts the desktop app under playwright-core's `_electron`, for the smoke
// test and the screenshot script: the built app (`out/`, run by the Electron
// in node_modules) or a packaged one, with its own user data and the
// environment it is given, never the person's own.
import { _electron, type ElectronApplication, type Page } from "playwright-core"
import path from "node:path"

const root = import.meta.dir

/** The Electron binary `bun install` (and `node_modules/electron/install.js`) put in place. */
export const electronBinary = (): string =>
  path.join(
    root,
    "node_modules/electron/dist",
    process.platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron",
  )

export interface Launch {
  /** A packaged app's executable; the built `out/` when absent. */
  readonly app?: string | undefined
  readonly userData: string
  readonly env: Readonly<Record<string, string>>
  readonly args?: ReadonlyArray<string>
}

/** The command line that starts the app as `launch` does, for a second instance. */
export const command = (launch: Launch): { readonly program: string; readonly args: ReadonlyArray<string> } => {
  const shared = [`--user-data-dir=${launch.userData}`, ...(launch.args ?? [])]
  return launch.app === undefined
    ? { program: electronBinary(), args: [root, ...shared] }
    : { program: launch.app, args: shared }
}

export const launch = (options: Launch): Promise<ElectronApplication> => {
  const { program, args } = command(options)
  // No emulated color scheme: the app's own appearance setting and the system's decide, as for a person.
  return _electron.launch({
    executablePath: program,
    args: [...args],
    env: { ...options.env },
    timeout: 30_000,
    colorScheme: null,
  })
}

/** The window showing `#/name`, once the app has opened one. */
export const windowAt = async (app: ElectronApplication, hash: string, timeout = 20_000): Promise<Page> => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const page of app.windows()) if (page.url().includes(hash)) return page
    await Bun.sleep(100)
  }
  throw new Error(`no window at ${hash} within ${timeout} ms`)
}

/** Waits until the page's text satisfies `test`. */
export const textWhere = async (page: Page, test: (text: string) => boolean, timeout = 20_000): Promise<string> => {
  const deadline = Date.now() + timeout
  let text = ""
  while (Date.now() < deadline) {
    text = await page.evaluate(() => document.body.innerText).catch(() => "")
    if (test(text)) return text
    await Bun.sleep(150)
  }
  throw new Error(`the page never showed what was expected; it read:\n${text.slice(0, 2000)}`)
}
