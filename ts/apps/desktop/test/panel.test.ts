import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { barGap, blurCloses, edgeGap, needsRefit, panelWidth, placePanel, toggleVerdict } from "../src/main/panel.ts"

/** A 1440 × 900 display whose menu bar takes the top 25 points. */
const mac = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
/** A 1920 × 1080 display with a 40-point taskbar at the bottom. */
const windows = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}

describe("where the panel hangs", () => {
  test("340 wide, centered under the menu bar item, a little below the menu bar", () => {
    const placed = placePanel({ x: 1000, y: 2, width: 24, height: 22 }, mac, 500)
    expect(placed).toEqual({ x: 1012 - panelWidth / 2, y: 25 + barGap, width: panelWidth, height: 500 })
  })

  test("kept inside the display's edges when the item sits near one", () => {
    const right = placePanel({ x: 1420, y: 2, width: 20, height: 22 }, mac, 400)
    expect(right.x).toBe(1440 - panelWidth - edgeGap)
    const left = placePanel({ x: 0, y: 2, width: 20, height: 22 }, mac, 400)
    expect(left.x).toBe(edgeGap)
  })

  test("above a taskbar at the bottom of the screen", () => {
    const placed = placePanel({ x: 1700, y: 1048, width: 24, height: 24 }, windows, 500)
    expect(placed.y).toBe(1040 - 500 - barGap)
  })

  test("never taller than the work area leaves room for", () => {
    expect(placePanel({ x: 700, y: 2, width: 24, height: 22 }, mac, 5000).height).toBe(875 - 2 * barGap)
  })

  test("at the top right where the tray says nothing of where it is", () => {
    const placed = placePanel({ x: 0, y: 0, width: 0, height: 0 }, mac, 400)
    expect(placed).toEqual({ x: 1440 - panelWidth - edgeGap, y: 25 + barGap, width: panelWidth, height: 400 })
    expect(placePanel(undefined, mac, 400)).toEqual(placed)
  })

  test("grows for any taller content, and shrinks only past a point's change", () => {
    expect(needsRefit(500, 501)).toBe(true)
    expect(needsRefit(500, 499)).toBe(false)
    expect(needsRefit(500, 500)).toBe(false)
    expect(needsRefit(500, 420)).toBe(true)
  })
})

describe("opening and closing the panel", () => {
  test("a click on the item closes an open panel and opens a closed one", () => {
    expect(toggleVerdict({ visible: true, hiddenOnBlurAt: Option.none(), now: 1_000 })).toBe("hide")
    expect(toggleVerdict({ visible: false, hiddenOnBlurAt: Option.none(), now: 1_000 })).toBe("show")
  })

  test("the click that took focus from the open panel leaves it closed, rather than opening it again", () => {
    expect(toggleVerdict({ visible: false, hiddenOnBlurAt: Option.some(900), now: 1_000 })).toBe("stay")
    expect(toggleVerdict({ visible: false, hiddenOnBlurAt: Option.some(500), now: 1_000 })).toBe("show")
  })

  test("losing focus in the moment it opens does not close it", () => {
    expect(blurCloses(1_000, 1_100)).toBe(false)
    expect(blurCloses(1_000, 1_150)).toBe(true)
  })
})
