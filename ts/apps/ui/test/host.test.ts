// The two hosts: the web dashboard keeps its key for the tab and its
// preferences and told notices in the browser; the desktop window reads and
// saves its preferences through the main process and decodes what it says.
import { browser, useBrowser } from "./support/dom.ts"
import { describe, expect, test } from "bun:test"
import type { DesktopBridge, ProxyState } from "@slopmax/domain/desktop"
import { DesktopPrefs } from "@slopmax/domain/desktop"
import { Effect, Option, Schema, Stream } from "effect"
import { desktopHost, UiPrefs, webHost } from "../src/host.ts"

useBrowser()

describe("preferences", () => {
  test("missing settings take their defaults", () => {
    expect(Schema.decodeUnknownSync(UiPrefs)({})).toEqual(
      new UiPrefs({ appearance: "system", sidebarWidth: 220, sidebarHidden: false, notifications: true }),
    )
    expect(Schema.decodeUnknownSync(UiPrefs)({ sidebarHidden: true }).sidebarWidth).toBe(220)
  })
})

describe("the web dashboard's host", () => {
  test("keeps the key for this tab only, and forgets it when asked", () => {
    browser.sessionStorage.clear()
    const host = webHost()
    expect(Effect.runSync(host.key)).toEqual(Option.none())
    Effect.runSync(host.saveKey("sm-abc"))
    expect(Effect.runSync(host.key)).toEqual(Option.some("sm-abc"))
    expect(browser.sessionStorage.getItem("slopmax-key")).toBe("sm-abc")
    expect(browser.localStorage.getItem("slopmax-key")).toBeNull()
    Effect.runSync(host.forgetKey)
    expect(Effect.runSync(host.key)).toEqual(Option.none())
  })

  test("remembers its preferences and told notices in the browser, and starts afresh from anything broken", () => {
    browser.localStorage.clear()
    const host = webHost()
    expect(Effect.runSync(host.prefs)).toEqual(UiPrefs.defaults)
    Effect.runSync(host.savePrefs(new UiPrefs({ ...UiPrefs.defaults, appearance: "dark" })))
    expect(Effect.runSync(webHost().prefs).appearance).toBe("dark")
    Effect.runSync(host.saveTold(["a|b|"]))
    expect(Effect.runSync(webHost().told)).toEqual(["a|b|"])
    browser.localStorage.setItem("slopmax-prefs", "{not json")
    browser.localStorage.setItem("slopmax-notified", "42")
    expect(Effect.runSync(webHost().prefs)).toEqual(UiPrefs.defaults)
    expect(Effect.runSync(webHost().told)).toEqual([])
  })
})

const bridge = (saved: Array<unknown>, options: { readonly tellAtOnce?: boolean } = {}): DesktopBridge => {
  const listeners: Array<(state: typeof ProxyState.Encoded) => void> = []
  return {
    proxyState: () => Promise.resolve({ _tag: "Running", version: "0.4.0" }),
    onProxyState: (listener) => {
      listeners.push(listener)
      if (options.tellAtOnce ?? true) {
        queueMicrotask(() => {
          for (const tell of listeners) {
            tell({ _tag: "Stopped" })
            // Something main should never send is dropped, not passed on.
            Reflect.apply(tell, undefined, [{ _tag: "Exploded" }])
          }
        })
      }
      return () => listeners.splice(0)
    },
    offline: () => Promise.reject(new Error("unused")),
    proxy: () => Promise.resolve({ ok: false, message: "the CLI is missing" }),
    service: () => Promise.resolve({ ok: true, message: "{}" }),
    openExternal: () => {},
    prefs: {
      get: () => Promise.resolve({ sidebarWidth: 260, appearance: "light", notifications: false }),
      set: (prefs) => {
        saved.push(prefs)
        return Promise.resolve()
      },
    },
    panelHeight: () => {},
    onMenu: () => () => {},
    openWindow: () => {},
    quit: () => {},
  }
}

const desktopOf = (host: ReturnType<typeof desktopHost>) => {
  const desktop = Option.getOrUndefined(host.desktop)
  if (desktop === undefined) throw new Error("no desktop")
  return desktop
}

describe("the desktop window's host", () => {
  test("reads its preferences from the main process, and saves them keeping the rest", async () => {
    const saved: Array<unknown> = []
    const host = desktopHost(bridge(saved))
    const prefs = await Effect.runPromise(host.prefs)
    expect(prefs).toEqual(
      new UiPrefs({ appearance: "light", sidebarWidth: 260, sidebarHidden: false, notifications: false }),
    )
    await Effect.runPromise(host.savePrefs(new UiPrefs({ ...prefs, sidebarHidden: true })))
    expect(Schema.decodeUnknownSync(DesktopPrefs)(saved[0])).toMatchObject({ sidebarHidden: true, sidebarWidth: 260 })
    // The window never holds the key; main adds it.
    expect(await Effect.runPromise(host.key)).toEqual(Option.none())
  })

  test("decodes the proxy's states as main tells them, dropping anything it cannot read", async () => {
    const desktop = desktopOf(desktopHost(bridge([])))
    // Main told of a change before its answer to "where does it stand" arrived: the change wins.
    const states = await Effect.runPromise(desktop.proxyStates.pipe(Stream.take(1), Stream.runCollect))
    expect(states).toEqual([{ _tag: "Stopped" }])
    expect(await Effect.runPromise(desktop.proxy("start"))).toEqual({ ok: false, message: "the CLI is missing" })
  })

  test("starts from where the proxy stands now when main tells of no change", async () => {
    const desktop = desktopOf(desktopHost(bridge([], { tellAtOnce: false })))
    const states = await Effect.runPromise(desktop.proxyStates.pipe(Stream.take(1), Stream.runCollect))
    expect(states).toEqual([{ _tag: "Running", version: "0.4.0" }])
  })

  test("falls back when main does not answer or answers what it cannot read, so the window still opens", async () => {
    const broken: DesktopBridge = {
      ...bridge([], { tellAtOnce: false }),
      proxyState: () => Promise.reject(new Error("ipc gone")),
      proxy: () => Promise.reject(new Error("ipc gone")),
      openExternal: () => {
        throw new Error("ipc gone")
      },
      prefs: {
        get: () => Promise.resolve(Reflect.apply(JSON.parse, undefined, ['{"sidebarWidth":"wide"}'])),
        set: () => Promise.reject(new Error("ipc gone")),
      },
    }
    const host = desktopHost(broken)
    expect(await Effect.runPromise(host.prefs)).toEqual(UiPrefs.defaults)
    await Effect.runPromise(host.savePrefs(UiPrefs.defaults))
    expect(await Effect.runPromise(host.openExternal("https://example.com"))).toBe(false)
    const desktop = desktopOf(host)
    expect(await Effect.runPromise(desktop.proxyStates.pipe(Stream.take(1), Stream.runCollect))).toEqual([
      { _tag: "Checking" },
    ])
    expect(await Effect.runPromise(desktop.proxy("start"))).toEqual({ ok: false, message: "ipc gone" })
  })
})

describe("the web dashboard's notifications and clipboard", () => {
  test("a browser that refuses to post a notification, or has no clipboard, does not break the page", async () => {
    const realNotification = globalThis.Notification
    const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    class Refusing {
      static permission = "granted"
      constructor() {
        throw new TypeError("Illegal constructor")
      }
    }
    Object.defineProperty(globalThis, "Notification", { value: Refusing, configurable: true, writable: true })
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    try {
      const host = webHost()
      expect(Effect.runSync(Effect.exit(host.notify("Title", "Body", "tag")))._tag).toBe("Success")
      expect(await Effect.runPromise(host.copy("text"))).toBe(false)
    } finally {
      Object.defineProperty(globalThis, "Notification", { value: realNotification, configurable: true, writable: true })
      if (realClipboard !== undefined) Object.defineProperty(navigator, "clipboard", realClipboard)
    }
  })
})
