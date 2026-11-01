import { describe, expect, test } from "bun:test"
import { DateTime, Option, Schema } from "effect"
import { Report } from "@slopmax/domain"
import { ProxyState } from "@slopmax/domain/desktop"
import { menuTemplate, poolLine, stateLine, trayMenu, trayText } from "../src/main/tray.ts"

const now = DateTime.makeUnsafe("2026-11-01T09:00:00Z")

const report = Schema.decodeUnknownSync(Report)({
  version: "0.4.0",
  live: true,
  generatedAt: "2026-11-01T09:00:00Z",
  strategy: "fill-first",
  accounts: [],
  pools: [
    {
      provider: "claude",
      accounts: 2,
      windows: [
        { span: "5h", used: 42, resetsAt: "2026-11-01T11:00:00Z", weighted: false },
        { span: "7d", used: 18, resetsAt: "2026-11-05T09:00:00Z", weighted: false },
      ],
      scoped: [],
      shares: {},
    },
    { provider: "codex", accounts: 1, windows: [], scoped: [], shares: {} },
  ],
  nudges: [],
})

const pool = (at: number) => {
  const found = report.pools[at]
  if (found === undefined) throw new Error(`no pool ${at}`)
  return found
}

const running = ProxyState.cases.Running.make({ version: "0.4.0" })
const stopped = ProxyState.cases.Stopped.make({})

const startItem = (state: ProxyState) =>
  trayMenu(Option.none(), state, now).find((item) => item._tag === "Command" && item.action === "start")

describe("the tray item", () => {
  test("reads slopmax until a report arrives, then each pool's 5-hour use", () => {
    expect(trayText(Option.none(), running, now)).toEqual({ title: "slopmax", tooltip: "slopmax" })
    expect(trayText(Option.some(report), running, now).title).toBe("Claude 42% · ChatGPT —")
  })

  test("says how the proxy stands instead of last numbers while it is not running on this release", () => {
    expect(trayText(Option.some(report), stopped, now)).toEqual({ title: "Stopped", tooltip: "The proxy is stopped" })
    expect(trayText(Option.some(report), ProxyState.cases.Starting.make({}), now)).toEqual({
      title: "slopmax",
      tooltip: "Starting the proxy…",
    })
    expect(
      trayText(
        Option.some(report),
        ProxyState.cases.OtherVersion.make({ running: "0.3.0", bundled: "0.4.0", service: true }),
        now,
      ).title,
    ).toBe("Restart needed")
    expect(stateLine(ProxyState.cases.Starting.make({}))).toBe("Starting the proxy…")
    expect(stateLine(ProxyState.cases.OtherVersion.make({ running: "0.3.0", bundled: "0.4.0", service: true }))).toBe(
      "The proxy runs slopmax 0.3.0; this app is 0.4.0",
    )
  })

  test("a pool reads as one line of its windows", () => {
    expect(poolLine(pool(0), now)).toBe("Claude: 5-hour 42% · weekly 18%")
    expect(poolLine(pool(1), now)).toBe("ChatGPT: no usage read yet")
    // A window whose reset has passed is empty again.
    expect(poolLine(pool(0), DateTime.makeUnsafe("2026-11-01T12:00:00Z"))).toBe("Claude: 5-hour 0% · weekly 18%")
  })

  test("on Linux its menu has the state, the pools, Open, Settings, Stop while running, and Quit", () => {
    const labels = trayMenu(Option.some(report), running, now).map((item) =>
      item._tag === "Separator" ? "—" : item.label,
    )
    expect(labels).toEqual([
      "The proxy is running",
      "Claude: 5-hour 42% · weekly 18%",
      "ChatGPT: no usage read yet",
      "—",
      "Open slopmax",
      "Settings…",
      "Stop the proxy",
      "—",
      "Quit slopmax",
    ])
  })

  test("shows the pools only while the proxy runs", () => {
    const lines = trayMenu(Option.some(report), stopped, now).filter((item) => item._tag === "Line")
    expect(lines.map((item) => item.label)).toEqual(["The proxy is stopped"])
  })

  test("offers Start while stopped, and holds it while starting", () => {
    expect(startItem(stopped)).toMatchObject({ label: "Start the proxy", enabled: true })
    expect(startItem(ProxyState.cases.Starting.make({}))).toMatchObject({ enabled: false })
  })

  test("its menu's commands run their actions, and lines are only read", () => {
    const acted: Array<string> = []
    const template = menuTemplate(trayMenu(Option.none(), stopped, now), (action) => acted.push(action))
    expect(template[0]).toEqual({ label: "The proxy is stopped", enabled: false })
    // Electron calls a click with the item, its window and the event; these clicks need none of them.
    for (const item of template) if (item.click !== undefined) Reflect.apply(item.click, undefined, [])
    expect(acted).toEqual(["open", "settings", "start", "quit"])
  })
})
