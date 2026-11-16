// Where the app runs: a browser tab served by the proxy (the web dashboard).
// The host holds the owner key, opens links, posts notices, and keeps the
// preferences, so tests can stand in for the browser.
import { withDefault } from "@slopmax/client"
import { Context, Effect, Layer, Option, Schema } from "effect"

/** Whether a browser lets this page post notifications. */
export type Permission = "granted" | "denied" | "default" | "unsupported"

export interface HostShape {
  /** Where slopmax's API is: this page's own origin. */
  readonly origin: string
  /**
   * The owner key the web dashboard holds for this tab. The tailnet token a
   * page opened over the tailnet uses is never kept here: it lives in the
   * page's memory only.
   */
  readonly key: Effect.Effect<Option.Option<string>>
  readonly saveKey: (key: string) => Effect.Effect<void>
  readonly forgetKey: Effect.Effect<void>
  /** Opens an address in the system's browser; false when it could not. */
  readonly openExternal: (url: string) => Effect.Effect<boolean>
  readonly copy: (text: string) => Effect.Effect<boolean>
  /** Offers text to save as a file named `name`; false when it could not. */
  readonly save: (name: string, text: string, type: string) => Effect.Effect<boolean>
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
}

export const Appearance = Schema.Literals(["system", "light", "dark"])
export type Appearance = typeof Appearance.Type

/**
 * The preferences the page keeps in this browser; a field left out takes its
 * default. Whether notices are posted is the browser's permission, not a
 * preference.
 */
export class UiPrefs extends Schema.Class<UiPrefs>("UiPrefs")({
  sidebarWidth: Schema.Finite.pipe(withDefault(220)),
  sidebarHidden: Schema.Boolean.pipe(withDefault(false)),
  appearance: Appearance.pipe(withDefault("system")),
  /** Whether email addresses are masked wherever they show, for screen sharing. */
  hideEmails: Schema.Boolean.pipe(withDefault(false)),
}) {
  /** Every preference at the default it takes when the page has none saved. */
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

/** Hands text to the browser as a download. */
const saveText = (name: string, text: string, type: string): Effect.Effect<boolean> =>
  Effect.try(() => {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const link = document.createElement("a")
    link.href = url
    link.download = name
    link.click()
    // The download has its own copy by the time the page goes on.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  }).pipe(Effect.orElseSucceed(() => false))

const permissionNow = (): Permission => (typeof Notification === "undefined" ? "unsupported" : Notification.permission)

/** The web dashboard's host. The key arrives once in the fragment (`#key=…`) and is kept for the tab. */
export const webHost = (): HostShape => {
  const session = storage(() => sessionStorage)
  const local = storage(() => localStorage)
  return {
    origin: location.origin,
    key: session.get(keyItem).pipe(Effect.map(Option.filter((key) => key !== ""))),
    saveKey: (key) => session.set(keyItem, key),
    forgetKey: session.remove(keyItem),
    openExternal: (url) => Effect.sync(() => window.open(url, "_blank", "noopener,noreferrer") !== null),
    copy: copyText,
    save: saveText,
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
  }
}

export const hostLayer = (host: HostShape): Layer.Layer<Host> => Layer.succeed(Host, host)
