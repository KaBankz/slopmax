// The whole app drawn in happy-dom against the stub API: the gate, the
// pages, the account menu, the settings table read from what the API
// serves, the add-account form's errors, the keyboard, the desktop's offline
// mode and the menu bar's panel.
import { useBrowser } from "./support/dom.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { UpstreamFailed } from "@slopmax/client"
import { OfflineView, ProxyState } from "@slopmax/client/desktop"
import { DateTime } from "effect"
import { act } from "react"
import { emptyReport, fixtureDoctor, ownerKey } from "./support/fixtures.ts"
import { control, draw, type Drawn, key, press, settle, shows, showsSoon, type } from "./support/render.tsx"

useBrowser()

let drawn: Drawn | undefined
afterEach(async () => {
  await drawn?.close()
  drawn = undefined
})

const web = async (at?: string) => {
  drawn = await draw({ stub: { key: ownerKey }, host: { key: ownerKey }, ...(at === undefined ? {} : { at }) })
  await showsSoon("Running 0.4.0")
  return drawn
}

describe("the web dashboard", () => {
  test("asks for the owner key first, and opens once it is given", async () => {
    drawn = await draw({ stub: { key: ownerKey } })
    await showsSoon("Open the slopmax dashboard")
    await type("Owner key", ownerKey)
    await press("Open")
    await showsSoon("5 of 7 accounts are ready")
  })

  test("a refused key brings the gate back saying so, and a key handed over in the address opens it", async () => {
    drawn = await draw({ stub: { key: ownerKey }, host: { key: "sm-wrong" } })
    await showsSoon("slopmax refused that key")
    expect(document.querySelector("input[aria-label='Owner key']")?.getAttribute("aria-invalid")).toBe("true")
    // A second `slopmax dashboard` reuses the tab: the key arrives in the fragment while the gate shows.
    await act(async () => {
      location.hash = `#key=${ownerKey}`
    })
    await showsSoon("5 of 7 accounts are ready")
    expect(location.hash.includes("key=")).toBe(false)
  })

  test("while the proxy does not answer, the page says so rather than calling it stopped", async () => {
    drawn = await draw({
      stub: { key: ownerKey },
      host: { key: ownerKey },
      prepare: (stub) => stub.failNext("events", new UpstreamFailed({ message: "the proxy went away" })),
    })
    await showsSoon("slopmax is not answering")
    expect(shows("The proxy is stopped")).toBe(false)
    expect(shows("Start the proxy")).toBe(false)
    await showsSoon("Running 0.4.0")
  })

  test("the overview says how the accounts stand and what wants a look", async () => {
    await web()
    await showsSoon("5 of 7 accounts are ready")
    expect(shows("lab@studio.dev needs signing in again")).toBe(true)
    expect(shows("A limit reset on ana@studio.dev expires in")).toBe(true)
    expect(shows("Subscriptions")).toBe(true)
    expect(shows("New sessions → ben@studio.dev · its quota resets soonest")).toBe(true)
    // The sidebar has a row per provider with accounts.
    expect(document.querySelector('[data-page="anthropic"]')?.textContent).toBe("Anthropic API1")
    await showsSoon("Saved by failover")
  })

  test("a provider page lists its accounts, and the account menu pins one", async () => {
    await web("#/claude")
    await showsSoon("Across 3 accounts, weighted by plan")
    await press("More for ana@studio.dev")
    await settle(() => document.querySelector("[role=menuitem]") !== null, "the menu")
    await press("Use for new sessions")
    await showsSoon("New Claude sessions go to ana@studio.dev.")
    expect(drawn?.stub.calls.some((call) => call.endpoint === "pin")).toBe(true)
    await showsSoon("Let slopmax choose")
  })

  test("opening an account's limit resets lists them with what one clears", async () => {
    await web("#/codex")
    await showsSoon("2 limit resets")
    // A signed-out account offers its sign-in on its own row.
    expect(() => control("Sign in to lab@studio.dev again")).not.toThrow()
    await press("2 limit resets on ana@studio.dev")
    await showsSoon("Each one resets this account's 5-hour and weekly windows at once.")
    expect(shows("Expires in")).toBe(true)
  })

  test("the settings page draws each live setting the API serves, and a switch changes it", async () => {
    await web("#/settings")
    await showsSoon("Session timeout")
    for (const title of [
      "Warm ChatGPT windows",
      "Overflow to API keys",
      "Usage polling",
      "Refresh sign-ins",
      "Codex WebSockets",
    ]) {
      expect(shows(title)).toBe(true)
    }
    expect(shows("Reset first")).toBe(true)
    await press("Warm ChatGPT windows")
    await showsSoon("Idle ChatGPT windows start as they reset.")
    expect(drawn?.stub.calls.find((call) => call.endpoint === "change")?.payload).toEqual({ warmWindows: true })
    await press("More Session timeout")
    await showsSoon("A session keeps its account through 2 h idle.")
  })

  test("a refused key shows why under the form, not as a toast", async () => {
    await web("#/access")
    await showsSoon("Add an account")
    drawn?.stub.failNext("add", new UpstreamFailed({ message: "the key was refused: 401 invalid x-api-key" }))
    await type("Paste an API key", "sk-ant-wrong")
    await press("Add key")
    await settle(() => document.querySelector("[role=alert]") !== null, "the refusal")
    expect(document.querySelector("[role=alert]")?.textContent).toBe("The key was refused: 401 invalid x-api-key")
  })

  test("a client key is shown once, and revoking one asks first", async () => {
    await web("#/access")
    await showsSoon("laptop")
    await type("Name, such as laptop", "phone")
    await press("Create key")
    await showsSoon("The key phone")
    await press("Done")
    await settle(() => !shows("The key phone"), "the key hidden")
    await press("Revoke the key laptop…")
    await showsSoon("Agents using this key are refused from now on.")
    await press("Revoke")
    await showsSoon("laptop revoked.")
  })

  test("a digit opens the page at that place in the sidebar, and the arrows move through them", async () => {
    await web()
    await key("3")
    await settle(() => location.hash === "#/codex", "the ChatGPT page")
    await settle(() => document.querySelector("[aria-current=page]")?.getAttribute("data-page") === "codex", "the row")
    await key("ArrowDown", document.querySelector("[aria-current=page]") ?? window)
    await settle(() => location.hash === "#/anthropic", "the next page")
    await key(",")
    await settle(() => location.hash === "#/settings", "settings")
  })

  test("a slopmax with no accounts says how to add one", async () => {
    drawn = await draw({ stub: { key: ownerKey, scenario: "empty" }, host: { key: ownerKey } })
    await showsSoon("No accounts yet")
    expect(shows("None yet")).toBe(true)
  })
})

describe("the desktop window", () => {
  test("while the proxy is stopped, shows what was saved and a way to start it", async () => {
    drawn = await draw({
      host: {
        kind: "desktop",
        proxy: ProxyState.cases.Stopped.make({}),
        offline: new OfflineView({ report: emptyReport(DateTime.nowUnsafe()), doctor: fixtureDoctor() }),
      },
    })
    await showsSoon("The proxy is stopped")
    await press("Start the proxy")
    await settle(() => drawn?.host.recorded.proxy.includes("start") === true, "the start")
    await showsSoon("Started the proxy.")
  })

  test("the menu bar's panel shows the pools and the app's commands", async () => {
    drawn = await draw({ host: { kind: "desktop" }, at: "#/panel" })
    await showsSoon("Open slopmax")
    await showsSoon("2 of 3 ready")
    expect(shows("Quit slopmax")).toBe(true)
    await press("Open slopmax")
    expect(drawn.host.recorded.opened).toContain("window:overview")
  })

  test("a menu's Settings… opens Settings, and its sidebar item hides the sidebar at once", async () => {
    drawn = await draw({ host: { kind: "desktop" } })
    await showsSoon("Running 0.4.0")
    drawn.host.menu("open-settings")
    await settle(() => location.hash === "#/settings", "settings")
    drawn.host.menu("toggle-sidebar")
    await settle(() => drawn?.host.recorded.saved.at(-1)?.sidebarHidden === true, "the sidebar hidden")
  })
})
