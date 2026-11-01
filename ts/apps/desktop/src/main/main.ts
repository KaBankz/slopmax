// The desktop app's main process. One instance runs at a time (a second
// launch brings the window forward, or with `--panel` opens the panel, which
// a desktop shortcut can bind where trays take no clicks). Closing the window
// leaves the tray running; only Quit ends the app, and the proxy outlives it.
// Electron starts lean: no GPU process (a status window needs no GPU
// compositing) and the network service inside the browser process.
//
// This is the only module that loads `electron`; everything else asks for it
// as a service, and the whole app is one Effect program built from layers.
import * as electron from "electron"
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Effect, Exit, Fiber, FiberSet, type FileSystem, Layer, Option, Path, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { channels } from "../channels.ts"
import { bridgeLayer } from "./bridge.ts"
import { Cli } from "./cli.ts"
import { AppPlaces, Electron } from "./electron.ts"
import { Engine } from "./engine.ts"
import { Follower } from "./events.ts"
import { appMenu, commandPage, type MenuCommand, menuTemplate } from "./menus.ts"
import { Notifications } from "./notifications.ts"
import { Panel } from "./panel.ts"
import { Prefs } from "./prefs.ts"
import { ApiFetch, handle, scheme } from "./protocol.ts"
import { AppTray } from "./tray.ts"
import { MainWindow } from "./window.ts"

const { app, protocol } = electron
const here = dirname(fileURLToPath(import.meta.url))

/** The whole app, for as long as it runs. */
const program = Effect.gen(function* () {
  const engine = yield* Engine
  const prefs = yield* Prefs
  const window = yield* MainWindow
  const panel = yield* Panel
  const notifications = yield* Notifications
  const follower = yield* Follower
  const tray = yield* AppTray
  const run = yield* FiberSet.makeRuntime<never>()
  // Requests run in the program's own fibers, so quitting interrupts any still under way.
  const answer = yield* FiberSet.makeRuntimePromise<Engine | ApiFetch | FileSystem.FileSystem | Path.Path>()
  const places = yield* AppPlaces
  const path = yield* Path.Path

  // The window's origin: the UI's files, and the API passed to the proxy.
  const respond = handle(path.join(places.here, "ui"))
  yield* Effect.acquireRelease(
    Effect.sync(() => protocol.handle(scheme, (request) => answer(respond(request)))),
    () => Effect.sync(() => protocol.unhandle(scheme)),
  )

  const onCommand = (command: MenuCommand): Effect.Effect<void> => {
    const page = commandPage(command)
    if (page !== undefined) return window.show(page)
    return window.send(channels.menu, command === "toggle-sidebar" ? "toggle-sidebar" : "refresh")
  }

  // The menus say Hide or Show Sidebar as it stands; the appearance follows the preference.
  yield* prefs.changes.pipe(
    Stream.map((now) => now.sidebarHidden),
    Stream.changes,
    Stream.runForEach((sidebarHidden) =>
      Effect.sync(() => {
        const entries = appMenu({ platform: process.platform, sidebarHidden })
        electron.Menu.setApplicationMenu(
          electron.Menu.buildFromTemplate(menuTemplate(entries, (command) => run(onCommand(command)))),
        )
      }),
    ),
    Effect.forkScoped,
  )
  yield* prefs.changes.pipe(
    Stream.map((now) => now.appearance),
    Stream.changes,
    Stream.runForEach((appearance) =>
      Effect.sync(() => {
        electron.nativeTheme.themeSource = appearance
      }),
    ),
    Effect.forkScoped,
  )

  const togglePanel = Effect.flatMap(tray.bounds, (bounds) => panel.toggle(Option.some(bounds)))
  const onSecond = (_event: unknown, argv: ReadonlyArray<string>) =>
    run(argv.includes("--panel") ? togglePanel : window.show())
  const onActivate = () => run(window.show())
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      app.on("second-instance", onSecond)
      app.on("activate", onActivate)
    }),
    () =>
      Effect.sync(() => {
        app.removeListener("second-instance", onSecond)
        app.removeListener("activate", onActivate)
      }),
  )

  yield* process.argv.includes("--panel") ? togglePanel : window.show()
  // The proxy starts behind the window, which shows Starting until it answers.
  yield* engine.launch.pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.void
        : notifications.say({ title: "Could not start the proxy", body: result.message, key: "proxy-start" }),
    ),
    Effect.forkScoped,
  )
  yield* Effect.forkScoped(follower.follow)
  return yield* Effect.never
})

const files = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Calls to the proxy carry no trace headers; the daemon is local and needs none. */
const http = Layer.mergeAll(FetchHttpClient.layer, Layer.succeed(HttpClient.TracerPropagationEnabled, false))

const layers = (userData: string) => {
  const base = Layer.mergeAll(
    Layer.succeed(Electron, electron),
    Layer.succeed(AppPlaces, { here, platform: process.platform }),
    Layer.succeed(ApiFetch, (request: Request) => electron.net.fetch(request)),
    files,
    http,
  )
  const cli = Cli.layer({ resources: process.resourcesPath, executable: process.execPath, platform: process.platform })
  return Layer.mergeAll(bridgeLayer, AppTray.layer).pipe(
    Layer.provideMerge(Follower.layer),
    Layer.provideMerge(Notifications.layer),
    Layer.provideMerge(MainWindow.layer),
    Layer.provideMerge(Panel.layer),
    Layer.provideMerge(Prefs.layer(join(userData, "prefs.json"))),
    Layer.provideMerge(Engine.layer),
    Layer.provideMerge(cli),
    Layer.provideMerge(NodeChildProcessSpawner.layer),
    Layer.provideMerge(base),
  )
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.disableHardwareAcceleration()
  // Windows shows a notification only for an app it can name: the bundle's id, as on macOS.
  if (process.platform === "win32") app.setAppUserModelId("dev.slopmax.desktop")
  app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2")
  // The app's preferences live apart from the CLI's own files, unless a run names its own place.
  if (!app.commandLine.hasSwitch("user-data-dir"))
    app.setPath("userData", join(app.getPath("appData"), "slopmax-desktop"))
  protocol.registerSchemesAsPrivileged([
    { scheme, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])
  // Closing the last window leaves the tray running.
  app.on("window-all-closed", () => {})

  void app.whenReady().then(() => {
    const fiber = Effect.runFork(
      Effect.scoped(program).pipe(
        Effect.provide(layers(app.getPath("userData"))),
        Effect.tapCause((cause) => Effect.logError("the app stopped", cause)),
      ),
    )
    // On quit, the program's scope closes first (the tray goes, the stream closes, windows are
    // destroyed), then the app exits; quitting again after holding a quit back does nothing.
    let closing = false
    app.on("will-quit", (event) => {
      event.preventDefault()
      if (closing) return
      closing = true
      void Effect.runPromiseExit(Fiber.interrupt(fiber).pipe(Effect.timeout("3 seconds"))).then((exit) => {
        if (Exit.isFailure(exit)) console.error("slopmax: the app did not stop cleanly")
        app.exit(0)
      })
    })
  })
}
