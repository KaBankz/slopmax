// A host for tests: the web dashboard's or the desktop window's, with storage
// in memory and every link opened, text copied and notification posted
// recorded, so a test can check what the app did outside the page.
import type { MenuAction, ProxyState, ShellResult } from "@slopmax/client/desktop"
import { OfflineView } from "@slopmax/client/desktop"
import { Effect, Option, PubSub, Stream } from "effect"
import { type Desktop, type HostShape, type Permission, UiPrefs } from "../../src/host.ts"

export interface Recorded {
  readonly opened: Array<string>
  readonly copied: Array<string>
  readonly notified: Array<{ readonly title: string; readonly body: string; readonly tag: string }>
  readonly saved: Array<UiPrefs>
  readonly proxy: Array<string>
  readonly service: Array<string>
}

export interface TestHost {
  readonly host: HostShape
  readonly recorded: Recorded
  /** Moves the desktop's proxy to another state, as main would tell the window. */
  readonly setProxy: (state: ProxyState) => void
  /** Sends a menu action, as the app's menus and keys would. */
  readonly menu: (action: MenuAction) => void
}

export interface TestHostOptions {
  readonly kind?: "web" | "desktop"
  readonly key?: string
  readonly permission?: Permission
  readonly told?: ReadonlyArray<string>
  readonly proxy?: ProxyState
  readonly offline?: OfflineView
  readonly shell?: (action: string) => ShellResult
  readonly service?: { readonly installed: boolean; readonly running: boolean }
}

export const testHost = (options: TestHostOptions = {}): TestHost => {
  const recorded: Recorded = { opened: [], copied: [], notified: [], saved: [], proxy: [], service: [] }
  let key = Option.fromUndefinedOr(options.key)
  let told = options.told ?? []
  let prefs = UiPrefs.defaults
  let state: ProxyState = options.proxy ?? { _tag: "Running", version: "0.4.0" }
  const states = Effect.runSync(PubSub.unbounded<ProxyState>())
  const menus = Effect.runSync(PubSub.unbounded<MenuAction>())
  const shell = options.shell ?? ((action: string) => ({ ok: true, message: action }))
  const desktop: Desktop = {
    proxyStates: Stream.concat(Stream.fromEffect(Effect.sync(() => state)), Stream.fromPubSub(states)),
    offline: Effect.sync(() => Option.fromUndefinedOr(options.offline)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.die(new Error("no offline view in this test")),
          onSome: Effect.succeed,
        }),
      ),
    ),
    proxy: (action) =>
      Effect.sync(() => {
        recorded.proxy.push(action)
        return shell(action)
      }),
    service: (action) =>
      Effect.sync(() => {
        recorded.service.push(action)
        return action === "status" && options.service !== undefined
          ? { ok: true, message: JSON.stringify(options.service) }
          : shell(action)
      }),
    menu: Stream.fromPubSub(menus),
    panelHeight: () => Effect.void,
    openWindow: (page) => Effect.sync(() => recorded.opened.push(`window:${page}`)),
    quit: Effect.void,
  }
  const host: HostShape = {
    kind: options.kind ?? "web",
    origin: "http://slopmax.test",
    key: Effect.sync(() => key),
    saveKey: (next) =>
      Effect.sync(() => {
        key = Option.some(next)
      }),
    forgetKey: Effect.sync(() => {
      key = Option.none()
    }),
    openExternal: (url) => Effect.sync(() => (recorded.opened.push(url), true)),
    copy: (text) => Effect.sync(() => (recorded.copied.push(text), true)),
    permission: Effect.succeed(options.permission ?? "default"),
    askPermission: Effect.succeed("granted"),
    notify: (title, body, tag) => Effect.sync(() => void recorded.notified.push({ title, body, tag })),
    told: Effect.sync(() => told),
    saveTold: (next) =>
      Effect.sync(() => {
        told = next
      }),
    prefs: Effect.sync(() => prefs),
    savePrefs: (next) =>
      Effect.sync(() => {
        prefs = next
        recorded.saved.push(next)
      }),
    desktop: options.kind === "desktop" ? Option.some(desktop) : Option.none(),
  }
  return {
    host,
    recorded,
    setProxy: (next) => {
      state = next
      Effect.runSync(PubSub.publish(states, next))
    },
    menu: (action) => {
      Effect.runSync(PubSub.publish(menus, action))
    },
  }
}
