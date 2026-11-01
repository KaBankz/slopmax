// Main's side of `window.slopmaxDesktop`. Only the app's own pages may call
// it (a frame on `app://slopmax/`), and every argument is decoded with its
// Schema before main acts on it: the window is not trusted with more than
// these few things. Changes of the proxy's state are told to every window.
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"
import { Effect, FiberSet, Layer, Option, Schema, Stream } from "effect"
import { DesktopPrefs, OfflineView, ProxyAction, ProxyState, ServiceAction, ShellResult } from "@slopmax/domain/desktop"
import { channels } from "../channels.ts"
import { Electron } from "./electron.ts"
import { Engine, withKey } from "./engine.ts"
import { Panel } from "./panel.ts"
import { Prefs } from "./prefs.ts"
import { origin } from "./protocol.ts"
import { isPageName, isWebAddress, MainWindow } from "./window.ts"

/** Whether a call comes from one of the app's own pages. */
export const trusted = (frameUrl: string | undefined): boolean =>
  frameUrl !== undefined && frameUrl.startsWith(`${origin}/`)

/** The panel's content height: a positive number of points, within any display. */
const PanelHeight = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThan(10_000))
/** A page of the UI, by name. */
const PageName = Schema.String.check(Schema.makeFilter(isPageName))
/** An address for the system's browser: the web only. */
const WebAddress = Schema.String.check(Schema.makeFilter(isWebAddress))

export const panelHeightOf = (value: unknown): Option.Option<number> =>
  Option.map(Schema.decodeUnknownOption(PanelHeight)(value), Math.ceil)
export const pageOf = Schema.decodeUnknownOption(PageName)
export const externalOf = Schema.decodeUnknownOption(WebAddress)

export const proxyActionOf = Schema.decodeUnknownOption(ProxyAction)
export const serviceActionOf = Schema.decodeUnknownOption(ServiceAction)
export const prefsOf = Schema.decodeUnknownOption(DesktopPrefs)

/**
 * Preferences the window sends, over the ones main holds: the window keeps
 * the sidebar, the appearance and notifications; the window's bounds are main's.
 */
export const mergePrefs = (sent: DesktopPrefs, held: DesktopPrefs): DesktopPrefs =>
  new DesktopPrefs({
    sidebarWidth: sent.sidebarWidth,
    sidebarHidden: sent.sidebarHidden,
    appearance: sent.appearance,
    notifications: sent.notifications,
    ...(held.bounds === undefined ? {} : { bounds: held.bounds }),
  })

const encodeState = Schema.encodeSync(ProxyState)
const encodeResult = Schema.encodeSync(ShellResult)
const encodePrefs = Schema.encodeSync(DesktopPrefs)
const encodeOffline = Schema.encodeEffect(OfflineView)

/** The address of the page that sent a call; none when it has gone. */
const frameOf = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame?.url

const refused = new ShellResult({ ok: false, message: "the app does not know that action" })

const make = Effect.gen(function* () {
  const electron = yield* Electron
  const engine = yield* Engine
  const prefs = yield* Prefs
  const window = yield* MainWindow
  const panel = yield* Panel
  const ask = yield* FiberSet.makeRuntimePromise<never>()
  const tell = yield* FiberSet.makeRuntime<never>()
  const { ipcMain } = electron

  /** Answers a call from a trusted page; any other caller is refused. */
  const answer = <A>(channel: string, respond: (event: IpcMainInvokeEvent, value: unknown) => Effect.Effect<A>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        ipcMain.handle(channel, (event, value: unknown) =>
          trusted(frameOf(event))
            ? ask(respond(event, value))
            : Promise.reject(new Error("not one of the app's pages")),
        ),
      ),
      () => Effect.sync(() => ipcMain.removeHandler(channel)),
    )

  /** Acts on a message from a trusted page; anything else is dropped. */
  const hear = (channel: string, act: (event: IpcMainEvent, value: unknown) => Effect.Effect<void>) => {
    const listener = (event: IpcMainEvent, value: unknown) => {
      if (trusted(frameOf(event))) tell(act(event, value))
    }
    return Effect.acquireRelease(
      Effect.sync(() => ipcMain.on(channel, listener)),
      () => Effect.sync(() => ipcMain.removeListener(channel, listener)),
    )
  }

  yield* answer(channels.proxyState, () => Effect.map(engine.state, encodeState))
  yield* answer(channels.offline, () =>
    engine.offline.pipe(
      Effect.flatMap(encodeOffline),
      // A rejection reaches the window as a failed call, which shows why.
      Effect.catch((error) => Effect.die(new Error(error.message))),
    ),
  )
  yield* answer(channels.proxy, (_, value) =>
    Option.match(proxyActionOf(value), {
      onNone: () => Effect.succeed(encodeResult(refused)),
      onSome: (action) => Effect.map(engine.act(action), encodeResult),
    }),
  )
  yield* answer(channels.service, (_, value) =>
    Option.match(serviceActionOf(value), {
      onNone: () => Effect.succeed(encodeResult(refused)),
      onSome: (action) => Effect.map(engine.service(action), encodeResult),
    }),
  )
  yield* answer(channels.prefsGet, () => Effect.map(prefs.get, encodePrefs))
  yield* answer(channels.prefsSet, (_, value) =>
    Option.match(prefsOf(value), {
      onNone: () => Effect.void,
      onSome: (sent) => prefs.update((held) => mergePrefs(sent, held)),
    }),
  )

  yield* hear(channels.openExternal, (_, value) =>
    Effect.gen(function* () {
      const url = externalOf(value)
      if (Option.isNone(url)) return
      // The proxy's own dashboard opens with the owner key, which only main holds.
      const keyed = Option.flatMap(yield* engine.running, (connection) => withKey(url.value, connection))
      yield* Effect.promise(() => electron.shell.openExternal(Option.getOrElse(keyed, () => url.value))).pipe(
        Effect.catchCause(() => Effect.logWarning(`could not open ${url.value} in a browser`)),
      )
    }),
  )
  yield* hear(channels.panelHeight, (event, value) =>
    Effect.gen(function* () {
      const height = panelHeightOf(value)
      if (Option.isSome(height) && (yield* panel.owns(event.sender.id))) yield* panel.fit(height.value)
    }),
  )
  yield* hear(channels.openWindow, (_, value) =>
    Option.match(pageOf(value), { onNone: () => Effect.void, onSome: (page) => window.show(page) }),
  )
  yield* hear(channels.quit, () => Effect.sync(() => electron.app.quit()))

  // Every window hears each change of the proxy's state.
  yield* engine.changes.pipe(
    Stream.runForEach((state) =>
      Effect.sync(() => {
        const told = encodeState(state)
        for (const open of electron.BrowserWindow.getAllWindows()) {
          if (!open.isDestroyed()) open.webContents.send(channels.proxyStateChanged, told)
        }
      }),
    ),
    Effect.forkScoped,
  )
})

/** The bridge's handlers, registered for as long as the app runs; it gives nothing else. */
export const bridgeLayer: Layer.Layer<never, never, Electron | Engine | Prefs | MainWindow | Panel> =
  Layer.effectDiscard(make)
