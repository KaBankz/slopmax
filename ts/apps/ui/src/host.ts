// Where the app runs: a browser tab served by the proxy (the web dashboard),
// or the desktop app's window. The pages are the same; the host decides how
// the owner key is held, how links open, how notices reach people, and
// whether there is a desktop main process to start the proxy and read it
// while it is stopped.
import { type DesktopBridge, DesktopPrefs, OfflineView, ProxyState, ShellResult } from "@slopmax/domain/desktop"
import type { MenuAction, ProxyAction, ServiceAction } from "@slopmax/domain/desktop"
import { Context, Data, Effect, Layer, Option, Queue, Schema, Stream, Struct } from "effect"

/** The desktop's main process did not answer a call (it is gone, or its bridge is older than the window). */
export class MainFailed extends Data.TaggedError("MainFailed")<{ readonly message: string }> {}

/** Whether a browser lets this page post notifications. */
export type Permission = "granted" | "denied" | "default" | "unsupported"

/** The desktop main process, its answers decoded. */
export interface Desktop {
  /** Where the proxy stands now, then each change main tells of. */
  readonly proxyStates: Stream.Stream<ProxyState>
  readonly offline: Effect.Effect<OfflineView, MainFailed | Schema.SchemaError>
  readonly proxy: (action: ProxyAction) => Effect.Effect<ShellResult>
  readonly service: (action: ServiceAction) => Effect.Effect<ShellResult>
  readonly menu: Stream.Stream<MenuAction>
  readonly panelHeight: (px: number) => Effect.Effect<void>
  readonly openWindow: (page: string) => Effect.Effect<void>
  readonly quit: Effect.Effect<void>
}

export interface HostShape {
  readonly kind: "web" | "desktop"
  /** Where slopmax's API is: this page's own origin in both hosts. */
  readonly origin: string
  /** The owner key the web dashboard holds for this tab; the desktop's main process adds it instead. */
  readonly key: Effect.Effect<Option.Option<string>>
  readonly saveKey: (key: string) => Effect.Effect<void>
  readonly forgetKey: Effect.Effect<void>
  /** Opens an address in the system's browser; false when it could not. */
  readonly openExternal: (url: string) => Effect.Effect<boolean>
  readonly copy: (text: string) => Effect.Effect<boolean>
  readonly permission: Effect.Effect<Permission>
  readonly askPermission: Effect.Effect<Permission>
  /** Posts a notification, replacing an earlier one with the same tag. */
  readonly notify: (title: string, body: string, tag: string) => Effect.Effect<void>
  /** The notices this browser has shown, so each shows once. */
  readonly told: Effect.Effect<ReadonlyArray<string>>
  readonly saveTold: (told: ReadonlyArray<string>) => Effect.Effect<void>
  /** How the window looks and where its sidebar stands. */
  readonly prefs: Effect.Effect<UiPrefs>
  readonly savePrefs: (prefs: UiPrefs) => Effect.Effect<void>
  readonly desktop: Option.Option<Desktop>
}

/**
 * The preferences the page keeps: the web dashboard in this browser, the
 * desktop app in its own file. They are the desktop's preferences without the
 * window's bounds, which only main sees. `notifications` is whether the
 * desktop app posts notices; a browser asks for permission instead.
 */
export class UiPrefs extends Schema.Class<UiPrefs>("UiPrefs")(Struct.omit(DesktopPrefs.fields, ["bounds"])) {
  static readonly defaults: UiPrefs = Schema.decodeUnknownSync(UiPrefs)({})
}

export class Host extends Context.Service<Host, HostShape>()("@slopmax/ui/Host") {}

const keyItem = "slopmax-key"
const toldItem = "slopmax-notified"
const prefsItem = "slopmax-prefs"

const Told = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeTold = Schema.decodeUnknownOption(Told)
const encodeTold = Schema.encodeSync(Told)
const PrefsJson = Schema.fromJsonString(UiPrefs)
const decodePrefsJson = Schema.decodeUnknownOption(PrefsJson)
const encodePrefsJson = Schema.encodeSync(PrefsJson)

/** Storage can be refused (private windows, a locked-down browser); slopmax then just forgets. */
const storage = (pick: () => Storage) => ({
  get: (item: string) =>
    Effect.sync(() => {
      try {
        return Option.fromNullishOr(pick().getItem(item))
      } catch {
        return Option.none<string>()
      }
    }),
  set: (item: string, value: string) =>
    Effect.sync(() => {
      try {
        pick().setItem(item, value)
      } catch {
        // Nothing to do: the value lives only as long as the page.
      }
    }),
  remove: (item: string) =>
    Effect.sync(() => {
      try {
        pick().removeItem(item)
      } catch {
        // As above.
      }
    }),
})

/** Copies text; false where the page may not (no clipboard on a plain-http address, or refused). */
const copyText = (text: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

const permissionNow = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission)

/** The web dashboard's host. The key arrives once in the fragment (`#key=…`) and is kept for the tab. */
export const webHost = (): HostShape => {
  const session = storage(() => sessionStorage)
  const local = storage(() => localStorage)
  return {
    kind: "web",
    origin: location.origin,
    key: session.get(keyItem).pipe(Effect.map(Option.filter((key) => key !== ""))),
    saveKey: (key) => session.set(keyItem, key),
    forgetKey: session.remove(keyItem),
    openExternal: (url) => Effect.sync(() => window.open(url, "_blank", "noopener,noreferrer") !== null),
    copy: copyText,
    permission: Effect.sync(permissionNow),
    askPermission: Effect.tryPromise(async (): Promise<Permission> =>
      typeof Notification === "undefined" ? "unsupported" : Notification.requestPermission(),
    ).pipe(Effect.orElseSucceed((): Permission => "unsupported")),
    notify: (title, body, tag) =>
      Effect.try(() => {
        if (permissionNow() !== "granted") return
        // Posting is the point; the browser shows it, and a later one with the same tag replaces it.
        const posted = new Notification(title, { body, tag })
        posted.addEventListener("click", () => window.focus())
      }).pipe(
        // Some browsers post notifications only from a service worker and refuse here; the page then just shows it.
        Effect.ignore,
      ),
    told: local
      .get(toldItem)
      .pipe(Effect.map((text) => Option.flatMap(text, decodeTold).pipe(Option.getOrElse(() => [])))),
    saveTold: (told) => local.set(toldItem, encodeTold(told)),
    prefs: local
      .get(prefsItem)
      .pipe(Effect.map((text) => Option.flatMap(text, decodePrefsJson).pipe(Option.getOrElse(() => UiPrefs.defaults)))),
    savePrefs: (prefs) => local.set(prefsItem, encodePrefsJson(prefs)),
    desktop: Option.none(),
  }
}

const encodePrefs = Schema.encodeSync(DesktopPrefs)

/**
 * Asks main for something and decodes its answer. A call main does not answer
 * (the process is gone, the bridge is older) or an answer that does not
 * decode is a typed failure, so each caller picks what the window shows instead.
 */
const fromMain = <A, I>(schema: Schema.Codec<A, I>, call: () => Promise<I>) =>
  Effect.tryPromise({
    try: call,
    catch: (error) => new MainFailed({ message: error instanceof Error ? error.message : "the app did not answer" }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

/** What a shell action came to when main could not run it at all. */
const unanswered = (error: MainFailed | Schema.SchemaError): ShellResult =>
  new ShellResult({ ok: false, message: error.message })

/** Tells main something it need not answer; a bridge that throws only loses that message. */
const tell = (send: () => void): Effect.Effect<void> => Effect.try(send).pipe(Effect.ignore)

/** The desktop window's host, over the preload bridge. Notices are posted by the main process, not here. */
export const desktopHost = (bridge: DesktopBridge): HostShape => {
  const prefs = fromMain(DesktopPrefs, () => bridge.prefs.get()).pipe(Effect.orElseSucceed(() => DesktopPrefs.defaults))
  const shell = (call: () => Promise<typeof ShellResult.Encoded>) =>
    fromMain(ShellResult, call).pipe(Effect.catch((error) => Effect.succeed(unanswered(error))))
  const desktop: Desktop = {
    // It listens before it asks, so a change while the answer is on its way is not lost to a stale answer.
    proxyStates: Stream.callback<ProxyState>((queue) =>
      Effect.gen(function* () {
        let told = false
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            bridge.onProxyState((state) => {
              const decoded = Schema.decodeUnknownOption(ProxyState)(state)
              if (Option.isNone(decoded)) return
              told = true
              Queue.offerUnsafe(queue, decoded.value)
            }),
          ),
          (stop) => Effect.sync(stop),
        )
        const now = yield* fromMain(ProxyState, () => bridge.proxyState()).pipe(
          Effect.orElseSucceed((): ProxyState => ProxyState.cases.Checking.make({})),
        )
        if (!told) Queue.offerUnsafe(queue, now)
      }),
    ),
    offline: fromMain(OfflineView, () => bridge.offline()),
    proxy: (action) => shell(() => bridge.proxy(action)),
    service: (action) => shell(() => bridge.service(action)),
    menu: Stream.callback<MenuAction>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => bridge.onMenu((action) => Queue.offerUnsafe(queue, action))),
        (stop) => Effect.sync(stop),
      ),
    ),
    panelHeight: (px) => tell(() => bridge.panelHeight(px)),
    openWindow: (page) => tell(() => bridge.openWindow(page)),
    quit: tell(() => bridge.quit()),
  }
  return {
    kind: "desktop",
    origin: location.origin,
    key: Effect.succeed(Option.none()),
    saveKey: () => Effect.void,
    forgetKey: Effect.void,
    openExternal: (url) =>
      Effect.try(() => bridge.openExternal(url)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    copy: copyText,
    permission: Effect.succeed("unsupported"),
    askPermission: Effect.succeed("unsupported"),
    notify: () => Effect.void,
    told: Effect.succeed([]),
    saveTold: () => Effect.void,
    prefs: Effect.map(prefs, (p) => new UiPrefs(Struct.omit(p, ["bounds"]))),
    savePrefs: (next) =>
      prefs.pipe(
        Effect.flatMap((p) =>
          Effect.tryPromise(() => bridge.prefs.set(encodePrefs(new DesktopPrefs({ ...p, ...next })))),
        ),
        Effect.ignore,
      ),
    desktop: Option.some(desktop),
  }
}

declare global {
  interface Window {
    /** Present in the desktop app's window, put there by its preload script. */
    readonly slopmaxDesktop?: DesktopBridge
  }
}

/** The host this page runs in. */
export const detectHost = (): HostShape =>
  window.slopmaxDesktop === undefined ? webHost() : desktopHost(window.slopmaxDesktop)

export const hostLayer = (host: HostShape): Layer.Layer<Host> => Layer.succeed(Host, host)
