import { describe, expect, test } from "bun:test"
import { defaultSettings, liveKeys, parseLive, Settings, settingsView } from "@slopmax/domain"
import { Option, Result } from "effect"
import { advancedRows, livePatch, namedElsewhere, restartLine, settingTitle } from "../../src/view/settings.ts"

const view = settingsView(defaultSettings("sm-test"))

describe("the settings page's live settings", () => {
  test("every live setting the API lists has a place: its own section or Advanced, each with its title", () => {
    const advanced = advancedRows(view).map((row) => row.name)
    expect([...namedElsewhere, ...advanced].toSorted()).toEqual([...liveKeys].toSorted())
    expect(advanced).toEqual([
      "sessionMinutes",
      "warmWindows",
      "paidOverflow",
      "pollMinutes",
      "refreshTokens",
      "websockets",
    ])
    for (const name of liveKeys) expect(settingTitle(name)).not.toBe("")
  })

  test("Advanced reads each row from the served settings: switches, and steppers of minutes", () => {
    const rows = advancedRows(view)
    expect(rows.find((row) => row.name === "sessionMinutes")).toEqual({
      _tag: "Minutes",
      name: "sessionMinutes",
      title: "Session timeout",
      detail: "Idle minutes before a session's account is forgotten.",
      value: 60,
      shown: "1 h",
      less: 30,
      more: 120,
    })
    const off = settingsView(new Settings({ ...defaultSettings("sm-test"), pollMinutes: 0, warmWindows: true }))
    const rowsOff = advancedRows(off)
    expect(rowsOff.find((row) => row.name === "pollMinutes")).toMatchObject({ shown: "Off", more: 1 })
    expect(rowsOff.find((row) => row.name === "pollMinutes")).not.toHaveProperty("less")
    expect(rowsOff.find((row) => row.name === "warmWindows")).toMatchObject({ _tag: "Switch", on: true })
  })

  test("a change is checked as the CLI checks it before it is sent", () => {
    expect(livePatch("sessionMinutes", 30)).toEqual(Option.some({ sessionMinutes: 30 }))
    expect(livePatch("strategy", "fill-first")).toEqual(Option.some({ strategy: "fill-first" }))
    // A session cannot keep its account for no minutes at all; the CLI refuses it in words.
    expect(Option.isNone(livePatch("sessionMinutes", 0))).toBe(true)
    expect(Result.isFailure(parseLive("sessionMinutes", "0"))).toBe(true)
    expect(Option.isNone(livePatch("strategy", "fastest"))).toBe(true)
  })

  test("a setting waiting for a restart is named", () => {
    expect(restartLine(view)).toBeUndefined()
    const waiting = settingsView(
      defaultSettings("sm-test"),
      new Settings({ ...defaultSettings("sm-test"), listen: "0.0.0.0:7567" }),
    )
    expect(restartLine(waiting)).toBe("listen changed in config.json; restart slopmax to use it.")
  })
})
