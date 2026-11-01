import { describe, expect, test } from "bun:test"
import { Bounds } from "@slopmax/domain/desktop"
import { webPreferences } from "../src/main/electron.ts"
import { isPageName, isWebAddress, openingBounds, pageUrl, windowOptions } from "../src/main/window.ts"

const screen = [{ x: 0, y: 25, width: 1440, height: 875 }]

describe("the main window", () => {
  test("opens 1160 × 800 centered the first time", () => {
    expect(openingBounds(undefined, screen)).toEqual({ width: 1160, height: 800 })
  })

  test("opens where it last was, at that size", () => {
    const saved = new Bounds({ width: 1000, height: 700, x: 100, y: 80 })
    expect(openingBounds(saved, screen)).toEqual({ width: 1000, height: 700, x: 100, y: 80 })
  })

  test("is centered again when its last place is off every display", () => {
    const saved = new Bounds({ width: 1000, height: 700, x: 3000, y: 80 })
    expect(openingBounds(saved, screen)).toEqual({ width: 1000, height: 700 })
  })

  test("is never smaller than 880 × 560", () => {
    expect(openingBounds(new Bounds({ width: 300, height: 200 }), screen)).toEqual({ width: 880, height: 560 })
  })

  test("on macOS keeps the traffic lights inset in the UI's title bar; elsewhere carries the app's icon", () => {
    const bounds = { width: 1160, height: 800 }
    const mac = windowOptions({ places: { here: "/app", platform: "darwin" }, bounds, dark: false })
    expect(mac).toMatchObject({
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 19 },
      title: "slopmax",
    })
    const linux = windowOptions({ places: { here: "/app", platform: "linux" }, bounds, dark: true })
    expect(linux).toMatchObject({ icon: "/app/icons/icon.png", minWidth: 880, minHeight: 560 })
    expect(linux.titleBarStyle).toBeUndefined()
    expect(linux.backgroundColor).not.toBe(mac.backgroundColor)
  })

  test("its renderer is isolated and sandboxed, with only the preload's bridge", () => {
    expect(webPreferences({ here: "/app", platform: "linux" })).toMatchObject({
      preload: "/app/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    })
  })

  test("pages live in the address's fragment on the app's origin", () => {
    expect(pageUrl("settings")).toBe("app://slopmax/#/settings")
    expect(isPageName("overview")).toBe(true)
    expect(isPageName("claude")).toBe(true)
    expect(isPageName("../etc")).toBe(false)
    expect(isPageName("")).toBe(false)
  })

  test("only web addresses open in the system's browser", () => {
    expect(isWebAddress("https://claude.ai/oauth/authorize")).toBe(true)
    expect(isWebAddress("http://127.0.0.1:7567/slopmax/")).toBe(true)
    expect(isWebAddress("file:///etc/passwd")).toBe(false)
    expect(isWebAddress("javascript:alert(1)")).toBe(false)
    expect(isWebAddress("not an address")).toBe(false)
  })
})
