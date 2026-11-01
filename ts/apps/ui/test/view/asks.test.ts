import { describe, expect, test } from "bun:test"
import { LimitReset, Window } from "@slopmax/domain"
import { DateTime } from "effect"
import { askOwn, askPriority, askRedeem, askRemove, askRename, askRevoke, readPriority } from "../../src/view/asks.ts"
import { account } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")
const at = (minutes: number) => DateTime.add(now, { minutes })

const ana = account({
  id: "codex-1",
  provider: "codex",
  name: "ana@studio.dev",
  email: "ana@studio.dev",
  priority: 2,
  follows: "Codex",
  windows: [Window.of("5h", 40, at(90)), Window.of("7d", 0, at(5_000)), Window.of("7d", 60, at(5_000), "gpt-6")],
  resets: [new LimitReset({ id: "r1", title: "Limit reset", expiresAt: at(1_800) })],
})

describe("what the app asks before changing an account", () => {
  test("refreshing here instead of following a tool", () => {
    expect(askOwn(ana)).toMatchObject({
      title: "Refresh ana@studio.dev here?",
      body: "slopmax follows Codex's copy of this account's tokens now. From here on slopmax refreshes them itself, and stops reading Codex's copy.",
      confirm: "Refresh here",
      danger: false,
    })
  })

  test("a priority, read as a whole number or nothing", () => {
    expect(askPriority(ana)).toMatchObject({
      title: "Set priority",
      body: "Higher tiers are used first; within a tier the strategy decides. ana@studio.dev is at 2.",
      field: { value: "2", kind: "number" },
    })
    expect(readPriority(" -3 ")).toBe(-3)
    expect(readPriority("")).toBeUndefined()
    expect(readPriority("1.5")).toBeUndefined()
  })

  test("a name, empty to show the email again", () => {
    expect(askRename(ana).field).toEqual({ label: "Name", value: "", placeholder: "ana@studio.dev", kind: "text" })
    const named = account({ id: "c", provider: "claude", name: "work", email: "w@x.dev" })
    expect(askRename(named).field?.value).toBe("work")
  })

  test("removing an account, and revoking a key, warn that they cannot be undone", () => {
    expect(askRemove(ana)).toMatchObject({ title: "Remove ana@studio.dev?", confirm: "Remove", danger: true })
    expect(askRevoke("laptop")).toMatchObject({ title: "Revoke laptop?", confirm: "Revoke", danger: true })
  })

  test("redeeming a limit reset says what it spends, when it would expire, and each window now", () => {
    expect(askRedeem(ana, "r1", now, zone)).toEqual({
      title: "Redeem a limit reset?",
      body: "This spends “Limit reset” on ana@studio.dev and resets its windows now. It would expire Nov 1, 18:00.",
      facts: ["Its windows now", "5-hour: 40% used · resets anyway in 1h30m", "Weekly: 0% used"],
      confirm: "Redeem",
      danger: false,
    })
  })
})
