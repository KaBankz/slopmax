// Notices posted as the system's notifications: the ones that ask someone to
// act (a provider out of accounts or back, a sign-in to redo, a limit reset or
// quota about to go unused), and the test notice, which exists to check that
// notifications arrive. The daemon tells each notice once over its event
// stream; a newer one under the same key replaces the one still showing.
// Clicking one brings the window forward. Posting follows the Notifications
// preference, on every system Electron can post on.
import type { Notification } from "electron"
import { Context, Effect, FiberSet, Layer } from "effect"
import { defaultNoticeKinds, type Notice, type NoticeKind } from "@slopmax/domain"
import { noticeBody, noticeTitle } from "@slopmax/domain/format"
import { AppPlaces, Electron } from "./electron.ts"
import { MainWindow } from "./window.ts"
import { Prefs } from "./prefs.ts"

/** Whether a kind of notice is posted: the kinds that need someone to act, and the test. */
export const posted = (kind: NoticeKind): boolean => kind === "test" || defaultNoticeKinds.includes(kind)

/** A notification as the system shows it. */
export interface Posting {
  readonly title: string
  readonly body: string
  /** Posting again under the same key replaces it. */
  readonly key: string
}

export const postingFor = (notice: Notice): Posting => ({
  title: noticeTitle(notice.kind),
  body: noticeBody(notice),
  key: notice.key,
})

export interface Shape {
  /** Posts a notice from the daemon, if its kind is one people act on and notifications are on. */
  readonly notice: (notice: Notice) => Effect.Effect<void>
  /** Posts something the app itself has to say (the proxy would not start). */
  readonly say: (posting: Posting) => Effect.Effect<void>
}

const make = Effect.gen(function* () {
  const electron = yield* Electron
  const places = yield* AppPlaces
  const prefs = yield* Prefs
  // macOS and Windows show the app's own icon; Linux shows this one.
  const icon = places.platform === "linux" ? { icon: `${places.here}/icons/icon.png` } : {}
  const window = yield* MainWindow
  const run = yield* FiberSet.makeRuntime<never>()
  // The notifications still showing, by key; holding them also keeps their click handlers alive.
  const showing = new Map<string, Notification>()

  const say: Shape["say"] = (posting) =>
    Effect.gen(function* () {
      if (!(yield* prefs.get).notifications || !electron.Notification.isSupported()) return
      showing.get(posting.key)?.close()
      const shown = new electron.Notification({ title: posting.title, body: posting.body, ...icon })
      shown.on("click", () => run(window.show()))
      shown.on("close", () => {
        if (showing.get(posting.key) === shown) showing.delete(posting.key)
      })
      showing.set(posting.key, shown)
      shown.show()
    })

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const shown of showing.values()) shown.close()
      showing.clear()
    }),
  )

  return {
    notice: (notice) => (posted(notice.kind) ? say(postingFor(notice)) : Effect.void),
    say,
  } satisfies Shape
})

export class Notifications extends Context.Service<Notifications, Shape>()("slopmax-desktop/Notifications") {
  static readonly layer: Layer.Layer<Notifications, never, Electron | AppPlaces | Prefs | MainWindow> = Layer.effect(
    Notifications,
    make,
  )
}
