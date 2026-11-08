import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import {
  clampWidth,
  dragSidebar,
  keyFromHash,
  movePage,
  pageHash,
  pageOrder,
  Pages,
  pageTitle,
  parseRoute,
  providersWithAccounts,
  toggleSidebar,
} from "../../src/view/pages.ts"
import { emptyReport, fixtureReport } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")

describe("pages", () => {
  test("run in sidebar order: the overview, a page per provider with accounts, activity, then setup", () => {
    expect(pageOrder(fixtureReport(now)).map(pageTitle)).toEqual([
      "Overview",
      "Claude",
      "ChatGPT",
      "Anthropic API",
      "Compatible endpoint",
      "Usage",
      "Performance",
      "Requests",
      "Agents",
      "Access",
      "Diagnostics",
      "Settings",
    ])
    expect(providersWithAccounts(emptyReport(now))).toEqual([])
    expect(pageOrder(undefined)[1]).toEqual(Pages.usage)
  })

  test("the arrow keys move through them and stop at either end", () => {
    const order = pageOrder(fixtureReport(now))
    expect(movePage(order, Pages.overview, 1)).toEqual(Pages.provider("claude"))
    expect(movePage(order, Pages.overview, -1)).toEqual(Pages.overview)
    expect(movePage(order, Pages.settings, 1)).toEqual(Pages.settings)
    // A provider page whose accounts are gone starts over at the top.
    expect(movePage(pageOrder(emptyReport(now)), Pages.provider("xai"), 1)).toEqual(Pages.overview)
  })

  test("live in the address's fragment, so a reload or a link lands on the same page", () => {
    expect(pageHash(Pages.provider("codex"))).toBe("#/codex")
    expect(pageHash(Pages.diagnostics)).toBe("#/diagnostics")
    expect(parseRoute("#/codex")).toEqual({ _tag: "Page", page: Pages.provider("codex") })
    expect(parseRoute("#/settings")).toEqual({ _tag: "Page", page: Pages.settings })
    expect(parseRoute("#/panel")).toEqual({ _tag: "Panel" })
    expect(parseRoute("")).toEqual({ _tag: "Page", page: Pages.overview })
    expect(parseRoute("#/nowhere")).toEqual({ _tag: "Page", page: Pages.overview })
  })

  test("the web dashboard takes its key out of the address and leaves the rest", () => {
    expect(keyFromHash("#key=sm-abc")).toEqual({ key: "sm-abc", rest: "" })
    expect(keyFromHash("#/usage&key=sm-abc")).toEqual({ key: "sm-abc", rest: "#/usage" })
    expect(keyFromHash("#key=sm%2Fx&/codex")).toEqual({ key: "sm/x", rest: "#/codex" })
    expect(keyFromHash("#/usage")).toEqual({ rest: "#/usage" })
    expect(keyFromHash("#key=")).toEqual({ rest: "" })
  })
})

describe("the sidebar", () => {
  test("the keyboard shows and hides it at once; its button slides it", () => {
    const shown = { hidden: false, width: 220, instant: false }
    expect(toggleSidebar(shown, "keyboard")).toEqual({ hidden: true, width: 220, instant: true })
    expect(toggleSidebar(shown, "button")).toEqual({ hidden: true, width: 220, instant: false })
    expect(toggleSidebar(toggleSidebar(shown, "keyboard"), "keyboard").hidden).toBe(false)
  })

  test("dragging its edge sets its width within limits, and far enough left hides it", () => {
    const shown = { hidden: false, width: 220, instant: false }
    expect(dragSidebar(shown, 260, 220)).toEqual({ hidden: false, width: 260, instant: true })
    expect(dragSidebar(shown, 600, 220).width).toBe(340)
    expect(dragSidebar(shown, 150, 220).width).toBe(190)
    // Hiding keeps the width the drag began with, for when it shows again.
    expect(dragSidebar(shown, 100, 250)).toEqual({ hidden: true, width: 250, instant: true })
    expect(clampWidth(Number.NaN)).toBe(220)
  })
})
