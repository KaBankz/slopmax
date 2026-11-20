// The web dashboard's host: it keeps its key for the tab, its preferences
// and told notices in the browser, and opens links in a new tab.
import { browser, useBrowser } from "./support/dom.ts"
import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { UiPrefs, webHost } from "../src/host.ts"

useBrowser()

describe("preferences", () => {
  test("missing settings take their defaults", () => {
    expect(Schema.decodeUnknownSync(UiPrefs)({})).toEqual(
      new UiPrefs({
        appearance: "system",
        hideEmails: false,
      }),
    )
    const oldPrefs = { appearance: "dark", hideEmails: true, sidebarWidth: 235, sidebarHidden: true }
    expect(Schema.decodeUnknownSync(UiPrefs)(oldPrefs)).toEqual(new UiPrefs({ appearance: "dark", hideEmails: true }))
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
    // Preferences saved before a field was dropped still read.
    browser.localStorage.setItem("slopmax-prefs", JSON.stringify({ appearance: "light", notifications: true }))
    expect(Effect.runSync(webHost().prefs).appearance).toBe("light")
    browser.localStorage.setItem("slopmax-prefs", "{not json")
    browser.localStorage.setItem("slopmax-notified", "42")
    expect(Effect.runSync(webHost().prefs)).toEqual(UiPrefs.defaults)
    expect(Effect.runSync(webHost().told)).toEqual([])
  })
})

describe("the web dashboard's links", () => {
  test("open in a new tab cut off from the page, and say so only when the browser blocked it", () => {
    const realOpen = browser.open
    const calls: Array<ReadonlyArray<unknown>> = []
    const tab: { opener: unknown } = { opener: browser }
    let blocked = false
    Object.defineProperty(browser, "open", {
      value: (...args: ReadonlyArray<unknown>) => (calls.push(args), blocked ? null : tab),
      configurable: true,
      writable: true,
    })
    try {
      const host = webHost()
      expect(Effect.runSync(host.openExternal("https://example.com/"))).toBe(true)
      expect(calls).toEqual([["https://example.com/", "_blank"]])
      expect(tab.opener).toBeNull()
      blocked = true
      expect(Effect.runSync(host.openExternal("https://example.com/"))).toBe(false)
    } finally {
      Object.defineProperty(browser, "open", { value: realOpen, configurable: true, writable: true })
    }
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
