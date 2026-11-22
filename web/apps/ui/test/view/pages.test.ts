import { describe, expect, test } from "bun:test"
import { destinationOf, navigationGroups, keyFromHash, pageHash, Pages, parsePage } from "../../src/view/pages.ts"

describe("pages", () => {
  test("group stable destinations and highlight the owning sidebar entry", () => {
    expect(navigationGroups.map(({ label, entries }) => [label, entries.map((entry) => entry.label)])).toEqual([
      ["Workspace", ["Quota", "Accounts"]],
      ["Activity", ["Analytics", "Requests"]],
      ["Proxy", ["Connections", "Settings"]],
    ])
    expect(destinationOf(Pages.provider("codex", "account"))).toBe("accounts")
    expect(destinationOf(Pages.addAccount)).toBe("accounts")
    expect(destinationOf(Pages.quotaHistory)).toBe("quota")
    expect(destinationOf(Pages.performance)).toBe("analytics")
    expect(destinationOf(Pages.requests)).toBe("requests")
    expect(destinationOf(Pages.connections("clients"))).toBe("connections")
    expect(destinationOf(Pages.diagnostics)).toBe("diagnostics")
  })

  test("live in the address's fragment, so a reload or a link lands on the same page", () => {
    expect(pageHash(Pages.provider("codex"))).toBe("#/codex")
    expect(pageHash(Pages.diagnostics)).toBe("#/diagnostics")
    expect(parsePage("#/codex")).toEqual(Pages.provider("codex"))
    expect(parsePage("#/settings")).toEqual(Pages.settings)
    expect(parsePage("#/agents")).toEqual(Pages.connections("agents"))
    expect(parsePage("#/access")).toEqual(Pages.connections("clients"))
    expect(parsePage(pageHash(Pages.connections("clients")))).toEqual(Pages.connections("clients"))
    expect(parsePage("#/quota/history")).toEqual(Pages.quotaHistory)
    expect(parsePage("#/accounts")).toEqual(Pages.accounts)
    expect(parsePage("#/accounts/add")).toEqual(Pages.addAccount)
    expect(parsePage("#/codex?account=name%20with%20spaces")).toEqual(Pages.provider("codex", "name with spaces"))
    expect(parsePage("")).toEqual(Pages.overview)
    expect(parsePage("#/nowhere")).toEqual(Pages.overview)
  })

  test("the web dashboard takes its key out of the address and leaves the rest", () => {
    expect(keyFromHash("#key=sm-abc")).toEqual({ key: "sm-abc", rest: "" })
    expect(keyFromHash("#/usage&key=sm-abc")).toEqual({ key: "sm-abc", rest: "#/usage" })
    expect(keyFromHash("#key=sm%2Fx&/codex")).toEqual({ key: "sm/x", rest: "#/codex" })
    expect(keyFromHash("#/usage")).toEqual({ rest: "#/usage" })
    expect(keyFromHash("#key=")).toEqual({ rest: "" })
  })
})
