// The menu bar item (the tray elsewhere): the app's presence while no window
// is open. On macOS its title reads each pool's 5-hour use and a click opens
// the panel; on Windows a click opens the panel. Linux trays (AppIndicator)
// send no clicks, so there the item carries a menu with the pools, Open,
// Settings, the proxy's Start or Stop, and Quit. A system with no tray to put
// it in leaves the app running without one.
import type { MenuItemConstructorOptions, Rectangle, Tray } from "electron"
import { Context, Data, DateTime, Effect, FiberSet, Layer, Option, Schedule, Stream } from "effect"
import { type Report, providerFacts, type Span } from "@slopmax/domain"
import type { ProxyState } from "@slopmax/domain/desktop"
import { menuBar, percent } from "@slopmax/domain/format"
import { AppPlaces, Electron } from "./electron.ts"
import { Engine } from "./engine.ts"
import { Follower } from "./events.ts"
import { Panel } from "./panel.ts"
import { MainWindow } from "./window.ts"

/** The proxy's state, as the tray's tooltip says it. */
export const stateLine = (state: ProxyState): string => {
  switch (state._tag) {
    case "Running":
      return "The proxy is running"
    case "Checking":
    case "Starting":
      return "Starting the proxy…"
    case "Stopped":
      return "The proxy is stopped"
    case "OtherVersion":
      return `The proxy runs slopmax ${state.running}; this app is ${state.bundled}`
  }
}

/**
 * The item's title (macOS shows it beside the icon) and tooltip. The usage
 * shows only while the proxy runs on this release: a stopped proxy's last
 * numbers would read healthy while agents cannot reach it, so the title says
 * how it stands instead. `slopmax` means the icon alone.
 */
export const trayText = (
  report: Option.Option<Report>,
  state: ProxyState,
  now: DateTime.DateTime,
): { readonly title: string; readonly tooltip: string } => {
  switch (state._tag) {
    case "Running": {
      const title = Option.match(report, { onNone: () => "slopmax", onSome: (found) => menuBar(found, now) })
      return { title, tooltip: title }
    }
    case "Checking":
    case "Starting":
      return { title: "slopmax", tooltip: stateLine(state) }
    case "Stopped":
      return { title: "Stopped", tooltip: stateLine(state) }
    case "OtherVersion":
      return { title: "Restart needed", tooltip: stateLine(state) }
  }
}

const spanWords: { readonly [K in Span]: string } = { "5h": "5-hour", "7d": "weekly", "30d": "monthly" }

/** A pool as one line of the Linux menu: `Claude: 5-hour 42% · weekly 18%`. */
export const poolLine = (pool: Report["pools"][number], now: DateTime.DateTime): string => {
  const title = providerFacts[pool.provider].title
  if (pool.windows.length === 0) return `${title}: no usage read yet`
  const windows = pool.windows.map((window) => {
    const passed = window.resetsAt !== undefined && DateTime.isLessThanOrEqualTo(window.resetsAt, now)
    return `${spanWords[window.span]} ${percent(passed ? 0 : window.used)}`
  })
  return `${title}: ${windows.join(" · ")}`
}

/** What a tray menu item does. */
export type TrayAction = "open" | "settings" | "start" | "stop" | "quit"

export type TrayItem = Data.TaggedEnum<{
  Line: { readonly label: string }
  Command: { readonly label: string; readonly action: TrayAction; readonly enabled: boolean }
  Separator: {}
}>
export const TrayItem = Data.taggedEnum<TrayItem>()

/** The Linux tray's menu; the pools only while the proxy runs, as their numbers are live only then. */
export const trayMenu = (
  report: Option.Option<Report>,
  state: ProxyState,
  now: DateTime.DateTime,
): ReadonlyArray<TrayItem> => {
  const pools =
    state._tag === "Running"
      ? Option.match(report, {
          onNone: () => [],
          onSome: (found) => found.pools.map((pool) => TrayItem.Line({ label: poolLine(pool, now) })),
        })
      : []
  const running = state._tag === "Running" || state._tag === "OtherVersion"
  const busy = state._tag === "Checking" || state._tag === "Starting"
  return [
    TrayItem.Line({ label: stateLine(state) }),
    ...pools,
    TrayItem.Separator(),
    TrayItem.Command({ label: "Open slopmax", action: "open", enabled: true }),
    TrayItem.Command({ label: "Settings…", action: "settings", enabled: true }),
    running
      ? TrayItem.Command({ label: "Stop the proxy", action: "stop", enabled: true })
      : TrayItem.Command({ label: "Start the proxy", action: "start", enabled: !busy }),
    TrayItem.Separator(),
    TrayItem.Command({ label: "Quit slopmax", action: "quit", enabled: true }),
  ]
}

/** The tray's menu as Electron builds it. */
export const menuTemplate = (
  items: ReadonlyArray<TrayItem>,
  act: (action: TrayAction) => void,
): Array<MenuItemConstructorOptions> =>
  items.map(
    TrayItem.$match({
      Line: (line): MenuItemConstructorOptions => ({ label: line.label, enabled: false }),
      Separator: (): MenuItemConstructorOptions => ({ type: "separator" }),
      Command: (command): MenuItemConstructorOptions => ({
        label: command.label,
        enabled: command.enabled,
        click: () => act(command.action),
      }),
    }),
  )

const nothing = () => undefined

/** Where an item with no place on screen is: the panel then opens at the screen's corner. */
const noBounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }

/** How often the title is read again with no new report, so a window that reset reads 0%. */
const retitle = Schedule.spaced("1 minute")

const make = Effect.gen(function* () {
  const electron = yield* Electron
  const places = yield* AppPlaces
  const engine = yield* Engine
  const follower = yield* Follower
  const panel = yield* Panel
  const window = yield* MainWindow
  const run = yield* FiberSet.makeRuntime<never>()
  const mac = places.platform === "darwin"
  const linux = places.platform === "linux"

  const icon = Effect.sync(() => {
    const image = electron.nativeImage.createFromPath(`${places.here}/icons/${mac ? "trayTemplate" : "tray"}.png`)
    if (mac) image.setTemplateImage(true)
    return image
  })

  const made = yield* Effect.acquireRelease(
    Effect.flatMap(icon, (image) => Effect.try(() => new electron.Tray(image))).pipe(
      Effect.map(Option.some<Tray>),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning("could not put slopmax in the tray; it runs without one", error),
          Option.none<Tray>(),
        ),
      ),
    ),
    (found) => Effect.sync(() => Option.map(found, (tray) => tray.destroy())),
  )
  if (Option.isNone(made)) return { bounds: Effect.succeed(noBounds) } satisfies Shape
  const tray = made.value

  const act = (action: TrayAction): Effect.Effect<void> => {
    switch (action) {
      case "open":
        return window.show()
      case "settings":
        return window.show("settings")
      case "start":
        return Effect.asVoid(engine.act("start"))
      case "stop":
        return Effect.asVoid(engine.act("stop"))
      case "quit":
        return Effect.sync(() => electron.app.quit())
    }
  }

  const draw = Effect.gen(function* () {
    const report = yield* follower.report
    const state = yield* engine.state
    const now = yield* DateTime.now
    const text = trayText(report, state, now)
    if (mac) tray.setTitle(text.title === "slopmax" ? "" : ` ${text.title}`)
    tray.setToolTip(text.tooltip)
    if (linux) {
      tray.setContextMenu(
        electron.Menu.buildFromTemplate(menuTemplate(trayMenu(report, state, now), (a) => run(act(a)))),
      )
    }
  })

  tray.setToolTip("slopmax")
  // AppIndicator trays send no clicks; where they do arrive (other Linux trays, Windows, macOS) one toggles the panel.
  tray.on("click", () => run(panel.toggle(Option.some(tray.getBounds()))))

  yield* draw
  yield* Stream.merge(Stream.map(follower.reports, nothing), Stream.map(engine.changes, nothing)).pipe(
    Stream.runForEach(() => draw),
    Effect.forkScoped,
  )
  yield* draw.pipe(Effect.repeat(retitle), Effect.forkScoped)

  return { bounds: Effect.sync(() => tray.getBounds()) } satisfies Shape
})

export interface Shape {
  /** Where the item is on screen, for the panel to hang under; empty where the system does not say. */
  readonly bounds: Effect.Effect<Rectangle>
}

/** The tray item, for as long as the app runs. */
export class AppTray extends Context.Service<AppTray, Shape>()("slopmax-desktop/AppTray") {
  static readonly layer: Layer.Layer<AppTray, never, Electron | AppPlaces | Engine | Follower | Panel | MainWindow> =
    Layer.effect(AppTray, make)
}
