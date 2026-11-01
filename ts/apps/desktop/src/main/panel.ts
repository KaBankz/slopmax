// The menu bar's panel: a small frameless window under the tray icon with how
// things stand, each pool, today, and the app's commands (the UI's
// `#/panel` page). It is made when first opened, fits its content's height,
// and goes away on Escape, when it loses focus, and when the main window
// comes forward. Hidden for a while, it is destroyed, so an idle app keeps
// only the tray.
import type { BrowserWindow, Rectangle } from "electron"
import { Clock, Context, Duration, Effect, FiberHandle, FiberSet, Layer, Option, Ref } from "effect"
import { AppPlaces, Electron, load, webPreferences } from "./electron.ts"
import { origin } from "./protocol.ts"

export const panelWidth = 340
/** Kept this far inside the display's edges. */
export const edgeGap = 8
/** Hung this far below the menu bar (or above a taskbar at the bottom). */
export const barGap = 6
/** The height it opens at, until its content says how tall it is. */
export const initialHeight = 420
/** Losing focus this soon after opening does not close it: a tray click moves focus on its way in. */
export const blurGuard = Duration.millis(150)
/** A tray click this soon after the panel hid on losing focus was the click that took the focus: it stays hidden. */
export const reclickGuard = Duration.millis(300)
/** How long a hidden panel is kept for a quick reopen before it is destroyed. */
export const keepHidden = Duration.minutes(1)

export interface Display {
  readonly bounds: Rectangle
  readonly workArea: Rectangle
}

/** An anchor that says nothing: Linux trays report no position. */
const empty = (anchor: Rectangle | undefined): boolean =>
  anchor === undefined || (anchor.width === 0 && anchor.height === 0)

const clamp = (value: number, least: number, most: number) => Math.min(Math.max(value, least), Math.max(least, most))

/**
 * Where the panel goes: centered under the tray icon and kept inside the
 * display's edges; below a menu bar at the top, above a taskbar at the
 * bottom. With no icon position it sits at the work area's top right.
 */
export const placePanel = (anchor: Rectangle | undefined, display: Display, height: number): Rectangle => {
  const work = display.workArea
  const fitted = Math.round(clamp(height, 120, work.height - 2 * barGap))
  const least = work.x + edgeGap
  const most = work.x + work.width - panelWidth - edgeGap
  if (anchor === undefined || empty(anchor)) {
    return { x: most, y: work.y + barGap, width: panelWidth, height: fitted }
  }
  const x = Math.round(clamp(anchor.x + anchor.width / 2 - panelWidth / 2, least, most))
  const middle = display.bounds.y + display.bounds.height / 2
  const y = anchor.y < middle ? work.y + barGap : work.y + work.height - fitted - barGap
  return { x, y, width: panelWidth, height: fitted }
}

/**
 * Whether the panel is moved for a new content height: always when the
 * content grew (a clipped point would show a scroll bar), and when it shrank
 * only past a point, so rounding never makes it jitter.
 */
export const needsRefit = (current: number, next: number): boolean => next > current || current - next > 1

/** What a tray click does to the panel. */
export const toggleVerdict = (input: {
  readonly visible: boolean
  readonly hiddenOnBlurAt: Option.Option<number>
  readonly now: number
}): "show" | "hide" | "stay" => {
  if (input.visible) return "hide"
  const justHid = Option.exists(input.hiddenOnBlurAt, (at) => input.now - at < Duration.toMillis(reclickGuard))
  return justHid ? "stay" : "show"
}

/** Whether losing focus closes it: not in the moment right after it opened. */
export const blurCloses = (shownAt: number, now: number): boolean => now - shownAt >= Duration.toMillis(blurGuard)

export interface Shape {
  /** Opens or closes it under `anchor` (the tray icon's bounds). */
  readonly toggle: (anchor: Option.Option<Rectangle>) => Effect.Effect<void>
  readonly show: (anchor: Option.Option<Rectangle>) => Effect.Effect<void>
  readonly hide: Effect.Effect<void>
  /** The content is this tall. */
  readonly fit: (height: number) => Effect.Effect<void>
  /** Whether `contents` is the panel's window. */
  readonly owns: (id: number) => Effect.Effect<boolean>
}

const make = Effect.gen(function* () {
  const electron = yield* Electron
  const places = yield* AppPlaces
  const window = yield* Ref.make(Option.none<BrowserWindow>())
  const anchor = yield* Ref.make(Option.none<Rectangle>())
  const shownAt = yield* Ref.make(0)
  const hiddenOnBlurAt = yield* Ref.make(Option.none<number>())
  const reaper = yield* FiberHandle.make()
  // Electron's callbacks run their effects here, in the panel's scope.
  const run = yield* FiberSet.makeRuntime<never>()

  const display = (at: Option.Option<Rectangle>): Display => {
    const screen = electron.screen
    const found = Option.match(at, {
      onNone: () => screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
      onSome: (rect) => (empty(rect) ? screen.getPrimaryDisplay() : screen.getDisplayMatching(rect)),
    })
    return { bounds: found.bounds, workArea: found.workArea }
  }

  const place = (win: BrowserWindow, height: number) =>
    Effect.gen(function* () {
      const at = yield* Ref.get(anchor)
      win.setBounds(placePanel(Option.getOrUndefined(at), display(at), height))
    })

  const destroy = Effect.gen(function* () {
    const found = yield* Ref.getAndSet(window, Option.none())
    if (Option.isSome(found) && !found.value.isDestroyed()) found.value.destroy()
  })

  const hideNow = (onBlur: boolean) =>
    Effect.gen(function* () {
      const found = yield* Ref.get(window)
      if (Option.isNone(found) || found.value.isDestroyed() || !found.value.isVisible()) return
      found.value.hide()
      if (onBlur) yield* Ref.set(hiddenOnBlurAt, Option.some(yield* Clock.currentTimeMillis))
      yield* FiberHandle.run(reaper, Effect.andThen(Effect.sleep(keepHidden), destroy))
    })

  const create = Effect.sync(() => {
    const isMac = places.platform === "darwin"
    const win = new electron.BrowserWindow({
      width: panelWidth,
      height: initialHeight,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: "slopmax",
      // The card's rounded corners show the desktop through on macOS; elsewhere a
      // transparent window needs a compositor many Linux desktops lack.
      transparent: isMac,
      ...(isMac ? { type: "panel", backgroundColor: "#00000000" } : {}),
      webPreferences: webPreferences(places),
    })
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault()
        run(hideNow(false))
      }
    })
    win.on("blur", () =>
      run(
        Effect.gen(function* () {
          if (blurCloses(yield* Ref.get(shownAt), yield* Clock.currentTimeMillis)) yield* hideNow(true)
        }),
      ),
    )
    win.on("closed", () => run(Ref.set(window, Option.none())))
    load(win, `${origin}/#/panel`)
    return win
  })

  const show: Shape["show"] = (at) =>
    Effect.gen(function* () {
      yield* FiberHandle.clear(reaper)
      yield* Ref.set(anchor, at)
      const existing = yield* Ref.get(window)
      const win =
        Option.isSome(existing) && !existing.value.isDestroyed()
          ? existing.value
          : yield* Effect.tap(create, (made) => Ref.set(window, Option.some(made)))
      yield* place(win, win.getBounds().height)
      const reveal = () => {
        win.show()
        win.focus()
        run(Effect.flatMap(Clock.currentTimeMillis, (now) => Ref.set(shownAt, now)))
      }
      if (win.webContents.isLoading()) win.once("ready-to-show", reveal)
      else reveal()
    })

  const toggle: Shape["toggle"] = (at) =>
    Effect.gen(function* () {
      const found = yield* Ref.get(window)
      const visible = Option.exists(found, (win) => !win.isDestroyed() && win.isVisible())
      const verdict = toggleVerdict({
        visible,
        hiddenOnBlurAt: yield* Ref.get(hiddenOnBlurAt),
        now: yield* Clock.currentTimeMillis,
      })
      yield* Ref.set(hiddenOnBlurAt, Option.none())
      if (verdict === "show") yield* show(at)
      else if (verdict === "hide") yield* hideNow(false)
    })

  const fit: Shape["fit"] = (height) =>
    Effect.gen(function* () {
      const found = yield* Ref.get(window)
      if (Option.isNone(found) || found.value.isDestroyed()) return
      if (needsRefit(found.value.getBounds().height, height)) yield* place(found.value, height)
    })

  yield* Effect.addFinalizer(() => destroy)

  return {
    toggle,
    show,
    hide: hideNow(false),
    fit,
    owns: (id) =>
      Effect.map(Ref.get(window), (found) =>
        Option.exists(found, (win) => !win.isDestroyed() && win.webContents.id === id),
      ),
  } satisfies Shape
})

export class Panel extends Context.Service<Panel, Shape>()("slopmax-desktop/Panel") {
  static readonly layer: Layer.Layer<Panel, never, Electron | AppPlaces> = Layer.effect(Panel, make)
}
