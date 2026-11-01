import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { isMenuAction, isProxyState, menuActions } from "../src/channels.ts"
import {
  externalOf,
  pageOf,
  panelHeightOf,
  prefsOf,
  proxyActionOf,
  serviceActionOf,
  trusted,
} from "../src/main/bridge.ts"
import { notRunning } from "../src/main/protocol.ts"

describe("the window's calls to main", () => {
  test("are taken only from the app's own pages", () => {
    expect(trusted("app://slopmax/#/overview")).toBe(true)
    expect(trusted("app://slopmax/")).toBe(true)
    expect(trusted("http://127.0.0.1:7567/slopmax/")).toBe(false)
    expect(trusted("app://slopmax.evil/")).toBe(false)
    expect(trusted(undefined)).toBe(false)
  })

  test("name a proxy or service action main knows, and nothing else", () => {
    expect(proxyActionOf("restart")).toEqual(Option.some("restart"))
    expect(proxyActionOf("rm -rf")).toEqual(Option.none())
    expect(serviceActionOf("install")).toEqual(Option.some("install"))
    expect(serviceActionOf(42)).toEqual(Option.none())
  })

  test("give the panel a sensible height, rounded up", () => {
    expect(panelHeightOf(512.2)).toEqual(Option.some(513))
    expect(panelHeightOf(-1)).toEqual(Option.none())
    expect(panelHeightOf(Number.NaN)).toEqual(Option.none())
    expect(panelHeightOf("600")).toEqual(Option.none())
  })

  test("open pages by name, and only web addresses in the browser", () => {
    expect(pageOf("usage")).toEqual(Option.some("usage"))
    expect(pageOf("../../etc")).toEqual(Option.none())
    expect(externalOf("https://auth.openai.com/authorize")).toEqual(Option.some("https://auth.openai.com/authorize"))
    expect(externalOf("file:///etc/passwd")).toEqual(Option.none())
  })

  test("preferences decode with their defaults, and a bad value is refused", () => {
    expect(Option.map(prefsOf({ sidebarHidden: true }), (prefs) => prefs.sidebarHidden)).toEqual(Option.some(true))
    expect(prefsOf({ appearance: "neon" })).toEqual(Option.none())
    expect(prefsOf("not prefs")).toEqual(Option.none())
  })
})

describe("main's messages to the window", () => {
  test("pass on only menu actions the window knows", () => {
    for (const action of menuActions) expect(isMenuAction(action)).toBe(true)
    expect(isMenuAction("format-disk")).toBe(false)
    expect(isMenuAction(undefined)).toBe(false)
  })

  test("pass on only states with the shape the window expects", () => {
    expect(isProxyState({ _tag: "Running", version: "0.4.0" })).toBe(true)
    expect(isProxyState({ _tag: "Running" })).toBe(false)
    expect(isProxyState({ _tag: "OtherVersion", running: "0.3.0", bundled: "0.4.0", service: false })).toBe(true)
    expect(isProxyState({ _tag: "OtherVersion", running: "0.3.0" })).toBe(false)
    expect(isProxyState({ _tag: "Stopped" })).toBe(true)
    expect(isProxyState({ _tag: "Exploded" })).toBe(false)
    expect(isProxyState(null)).toBe(false)
  })

  test("a call while no proxy runs is answered 503, which the window reads as the proxy being down", async () => {
    const answer = notRunning()
    expect(answer.status).toBe(503)
    expect(await answer.json()).toEqual({ _tag: "NotRunning", message: "the proxy is not running" })
  })
})
