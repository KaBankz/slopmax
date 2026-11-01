// The main window. It is made when opened and destroyed when closed (an open
// window's renderer costs about 100 MB; the tray keeps running without one),
// remembers its size and place, and stays on the app's own origin: links to
// anywhere else open in the system's browser.
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron"
import { Context, Effect, FiberSet, Layer, Option, Ref } from "effect"
import { Bounds, DesktopPrefs } from "@slopmax/domain/desktop"
import { AppPlaces, Electron, load, type Places, webPreferences } from "./electron.ts"
import { Panel } from "./panel.ts"
import { Prefs } from "./prefs.ts"
import { origin } from "./protocol.ts"

export const defaultSize = { width: 1160, height: 800 } as const
export const minimumSize = { width: 880, height: 560 } as const
/** At least this much of a remembered window must be on a display for it to open there again. */
const onScreen = 64

const overlap = (a: Rectangle, b: Rectangle): { readonly width: number; readonly height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
})

/**
 * Where the window opens: where it last was, if enough of that is still on a
 * display (a monitor may have been unplugged since); else centered, at the
 * remembered size, never below the minimum.
 */
export const openingBounds = (
  saved: Bounds | undefined,
  workAreas: ReadonlyArray<Rectangle>,
): { readonly width: number; readonly height: number; readonly x?: number; readonly y?: number } => {
  const width = Math.max(saved?.width ?? defaultSize.width, minimumSize.width)
  const height = Math.max(saved?.height ?? defaultSize.height, minimumSize.height)
  if (saved?.x === undefined || saved.y === undefined) return { width, height }
  const rect = { x: saved.x, y: saved.y, width, height }
  const visible = workAreas.some((area) => {
    const seen = overlap(rect, area)
    return seen.width >= onScreen && seen.height >= onScreen
  })
  return visible ? rect : { width, height }
}

/** The window's options on each platform: macOS keeps its traffic lights inset in the UI's title bar. */
export const windowOptions = (input: {
  readonly places: Places
  readonly bounds: ReturnType<typeof openingBounds>
  readonly dark: boolean
}): BrowserWindowConstructorOptions => ({
  ...input.bounds,
  minWidth: minimumSize.width,
  minHeight: minimumSize.height,
  title: "slopmax",
  show: false,
  // The UI's own background, so the window never flashes white before it draws.
  backgroundColor: input.dark ? "#1b1b1d" : "#ffffff",
  ...(input.places.platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 } }
    : { icon: `${input.places.here}/icons/icon.png`, autoHideMenuBar: true }),
  webPreferences: webPreferences(input.places),
})

/** A page's place in the window's address: `overview` → `app://slopmax/#/overview`. */
export const pageUrl = (page: string): string => `${origin}/#/${page}`

/** Whether a page name is one the UI could know: lowercase words, as its routes are. */
export const isPageName = (page: string): boolean => /^[a-z][a-z0-9-]{0,39}$/.test(page)

/** Addresses the system's browser may open: the web, and nothing that runs a program. */
export const isWebAddress = (url: string): boolean => {
  const parsed = URL.parse(url)
  return parsed?.protocol === "https:" || parsed?.protocol === "http:"
}

export interface Shape {
  /** Opens the window, or brings it forward, at `page` when given. */
  readonly show: (page?: string) => Effect.Effect<void>
  /** Tells the window something, when one is open. */
  readonly send: (channel: string, value: unknown) => Effect.Effect<void>
  /** Whether `id` is the main window's renderer. */
  readonly owns: (id: number) => Effect.Effect<boolean>
}

const make = Effect.gen(function* () {
  const electron = yield* Electron
  const places = yield* AppPlaces
  const prefs = yield* Prefs
  const panel = yield* Panel
  const window = yield* Ref.make(Option.none<BrowserWindow>())
  const run = yield* FiberSet.makeRuntime<never>()

  const open = (page: string) =>
    Effect.gen(function* () {
      const saved = (yield* prefs.get).bounds
      const areas = electron.screen.getAllDisplays().map((display) => display.workArea)
      const win = new electron.BrowserWindow(
        windowOptions({ places, bounds: openingBounds(saved, areas), dark: electron.nativeTheme.shouldUseDarkColors }),
      )
      const contents = win.webContents
      // The window stays on the app's origin; the web opens in the browser, anything else nowhere.
      contents.on("will-navigate", (event, url) => {
        if (url.startsWith(`${origin}/`)) return
        event.preventDefault()
        if (isWebAddress(url)) void electron.shell.openExternal(url)
      })
      contents.setWindowOpenHandler(({ url }) => {
        if (isWebAddress(url)) void electron.shell.openExternal(url)
        return { action: "deny" }
      })
      contents.on("will-attach-webview", (event) => event.preventDefault())
      win.once("ready-to-show", () => win.show())
      win.on("focus", () => run(panel.hide))
      win.on("close", () => {
        const normal = win.getNormalBounds()
        // Not cut short by quitting, which closes the window and then interrupts the app's fibers.
        run(
          Effect.uninterruptible(
            prefs.update(
              (now) =>
                new DesktopPrefs({
                  ...now,
                  bounds: new Bounds({
                    width: Math.round(normal.width),
                    height: Math.round(normal.height),
                    x: Math.round(normal.x),
                    y: Math.round(normal.y),
                  }),
                }),
            ),
          ),
        )
      })
      win.on("closed", () => run(Ref.set(window, Option.none())))
      yield* Ref.set(window, Option.some(win))
      load(win, pageUrl(page))
    })

  const show: Shape["show"] = (page) =>
    Effect.gen(function* () {
      // Opening the window dismisses the panel.
      yield* panel.hide
      const found = yield* Ref.get(window)
      if (Option.isNone(found) || found.value.isDestroyed()) return yield* open(page ?? "overview")
      const win = found.value
      // The same document at another fragment: the UI moves to the page without reloading.
      if (page !== undefined) load(win, pageUrl(page))
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })

  yield* Effect.addFinalizer(() =>
    Effect.map(Ref.get(window), (found) => {
      if (Option.isSome(found) && !found.value.isDestroyed()) found.value.destroy()
    }),
  )

  return {
    show,
    send: (channel, value) =>
      Effect.map(Ref.get(window), (found) => {
        if (Option.isSome(found) && !found.value.isDestroyed()) found.value.webContents.send(channel, value)
      }),
    owns: (id) =>
      Effect.map(Ref.get(window), (found) =>
        Option.exists(found, (win) => !win.isDestroyed() && win.webContents.id === id),
      ),
  } satisfies Shape
})

export class MainWindow extends Context.Service<MainWindow, Shape>()("slopmax-desktop/MainWindow") {
  static readonly layer: Layer.Layer<MainWindow, never, Electron | AppPlaces | Prefs | Panel> = Layer.effect(
    MainWindow,
    make,
  )
}
