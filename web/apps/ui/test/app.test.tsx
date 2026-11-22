// The whole app drawn in happy-dom against the stub API: the gate, the
// pages, the account menu, the settings table read from what the API
// serves, the add-account form's errors, and the keyboard.
import { useBrowser } from "./support/dom.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { Event, LedgerRecord, Report, UpstreamFailed, Usage, Window } from "@slopmax/client"
import { DateTime } from "effect"
import { act } from "react"
import { account, emptyReport, ownerKey } from "./support/fixtures.ts"
import { control, draw, type Drawn, press, settle, shows, showsSoon, type } from "./support/render.tsx"

useBrowser()

let drawn: Drawn | undefined
afterEach(async () => {
  await drawn?.close()
  drawn = undefined
})

const web = async (at?: string) => {
  drawn = await draw({
    stub: { key: ownerKey },
    host: { key: ownerKey },
    ...(at === undefined ? {} : { at }),
  })
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
    expect(shows("Subscription limits")).toBe(true)
    expect(
      shows("New sessions go to ben@studio.dev · a weekly or monthly limit resets within a day with quota left"),
    ).toBe(true)
    expect(control("Quota").getAttribute("aria-current")).toBe("page")
    expect(control("Accounts").getAttribute("href")).toBe("#/accounts")
  })

  test("the overview shows separate weekly and 5-hour reset opportunities", async () => {
    await web()
    await showsSoon("Next reset with quota left")
    expect(shows("45%")).toBe(true)
    expect(shows("Pace to use it all")).toBe(true)
    expect(shows("Est. value if unused")).toBe(true)
    expect(shows("$20.77")).toBe(true)
    expect(control("5-hour").getAttribute("aria-description")).toMatch(/^Next reset in/)
    await press("5-hour")
    await showsSoon("38%")
    expect(control("5-hour").getAttribute("aria-pressed")).toBe("true")
  })

  test("usage figures switch a single chart and keep their selection across ranges", async () => {
    await web("#/usage")
    await showsSoon("Usage over time")
    expect(document.getElementById("usage-trend")?.getAttribute("aria-label")).toBe("Tokens")
    const value = [...document.querySelectorAll<HTMLButtonElement>('button[aria-controls="usage-trend"]')].find(
      (button) => button.textContent?.startsWith("Value at API prices"),
    )
    expect(value).toBeDefined()
    await act(async () => value?.click())
    expect(value?.getAttribute("aria-pressed")).toBe("true")
    expect(document.getElementById("usage-trend")?.getAttribute("aria-label")).toBe("Value at API prices")
    await press("Today")
    await showsSoon("yesterday by this hour")
    expect(document.getElementById("usage-trend")?.getAttribute("aria-label")).toBe("Value at API prices")
  })

  test("request activity opens the selected date range in Requests", async () => {
    await web("#/usage")
    await press("Today")
    await showsSoon("yesterday by this hour")
    await press("7 days")
    await showsSoon("in the previous 7 days")
    await press("View requests")
    await showsSoon("Any outcome")
    expect(location.hash).toBe("#/requests")
    expect(control("7 days").getAttribute("aria-pressed")).toBe("true")
  })

  test("the page scrolls in its own pane, which holds what is positioned in it, so the window never scrolls too", async () => {
    await web("#/requests")
    await press("7 days")
    await showsSoon("Export CSV")
    const pane = document.querySelector("[data-slot=dashboard-scroll]")
    if (pane === null) throw new Error("no scrolling pane")
    // An absolute element (sr-only text, say) is placed by its nearest positioned
    // ancestor; one outside the pane would stretch the window past it.
    const positioned = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/
    const holder = (element: Element) => {
      let at = element.parentElement
      while (at !== null && !positioned.test(at.className)) at = at.parentElement
      return at
    }
    const hidden = [...pane.querySelectorAll(".sr-only")]
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.filter((e) => !pane.contains(holder(e))).map((e) => e.textContent)).toEqual([])
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

  test("a subscription's page forecasts its pool, and each account shows its day and what its windows served", async () => {
    await web("#/claude")
    await showsSoon("Weekly pool", 5_000)
    expect(shows("Resets ahead")).toBe(true)
    expect(shows("Runs dry")).toBe(true)
    expect(shows("$1,622 so far")).toBe(true)
    expect(document.querySelectorAll('[role=img][aria-label*="in the last day"]').length).toBe(3)
    await press("5-hour")
    await showsSoon("5-hour pool")
  })

  test("the Requests page looks back over the ledger, filters it, opens a request, and exports it", async () => {
    const { host } = await web("#/requests")
    await press("7 days")
    await showsSoon("at API prices", 5_000)
    expect(shows("saved by failover")).toBe(true)
    // The live feed's Clear belongs to the live feed.
    expect(() => control("Clear")).toThrow()
    const filters = control("Filters")
    expect(filters.getAttribute("aria-expanded")).toBe("false")
    await press("Filters")
    expect(filters.getAttribute("aria-expanded")).toBe("true")
    expect(control("Account")).toBeDefined()
    await press("Filters")
    const first = document.querySelector<HTMLElement>('button[aria-label^="Details of the request"]')
    await act(async () => first?.click())
    await showsSoon("Accounts tried")
    expect(shows("At API prices")).toBe(true)
    await press("Close")
    await press("Export CSV")
    await settle(() => host.recorded.files.length === 1, "the export")
    expect(host.recorded.files[0]?.name).toMatch(/^slopmax-requests-.*\.csv$/)
    expect(host.recorded.files[0]?.text.split("\n")[0]).toContain("time,agent,machine,provider")
  })

  test("live arrivals preserve the open request and switching ranges preserves the toolbar", async () => {
    const { stub } = await web("#/requests")
    const publish = (model: string) =>
      stub.publish(
        Event.cases.Request.make({
          record: LedgerRecord.cases.Request.make({
            at: DateTime.nowUnsafe(),
            provider: "claude",
            model,
            status: 200,
            usage: Usage.zero,
            ms: 10,
            attempts: 1,
            via: "http",
          }),
        }),
      )
    await act(async () => publish("first-live-request"))
    await showsSoon("first-live-request")
    const trigger = document.querySelector<HTMLButtonElement>('tbody button[aria-label^="Details of the request"]')
    if (trigger === null) throw new Error("the first request has no detail button")
    await act(async () => trigger.click())
    await showsSoon("Request details")
    await act(async () => publish("next-live-request"))
    await showsSoon("next-live-request")
    expect(trigger.isConnected).toBe(true)
    await press("Close")

    const range = control("7 days")
    const filters = control("Filters")
    await press("Filters")
    await press("7 days")
    expect(control("7 days")).toBe(range)
    expect(control("Filters")).toBe(filters)
    expect(filters.getAttribute("aria-expanded")).toBe("true")
  })

  test("hiding email addresses masks them on every page until it is turned off", async () => {
    await web("#/settings")
    await showsSoon("Hide email addresses")
    await press("Hide email addresses")
    await act(async () => {
      location.hash = "#/claude"
    })
    await showsSoon("a•••@s•••.dev")
    // The page itself; Sonner keeps toasts from earlier tests in the body.
    expect(document.querySelector("main")?.textContent).not.toContain("ana@studio.dev")
  })

  test("the overview says when a newer slopmax is out, and copies the command that updates this install", async () => {
    const { host } = await web()
    await showsSoon("slopmax 0.5.0 is out")
    expect(document.querySelector('[data-slot="alert"] code')?.textContent).toContain("slopmax update")
    await press("Copy command")
    await showsSoon("Copied the update command.")
    expect(host.recorded.copied).toContain("slopmax update")
  })

  test("a limited account can be checked again now, and comes back when its limit has passed", async () => {
    await web("#/claude")
    await showsSoon("Limited · back in")
    await press("Check ops@studio.dev now")
    await showsSoon("ops@studio.dev is back in rotation.")
    expect(drawn?.stub.calls.some((call) => call.endpoint === "check")).toBe(true)
  })

  test("performance shows account health and today's failures, with a drilldown to Requests", async () => {
    await web("#/performance")
    await showsSoon("Account health", 5_000)
    await showsSoon("Failed today")
    await press("See all")
    await showsSoon("Filters")
    expect(control("Outcome").querySelector('[data-slot="select-value"]')?.textContent).toBe("Failed")
    expect(location.hash).toBe("#/requests")
  })

  test("opening an account's limit resets lists them with what one clears", async () => {
    await web("#/codex")
    await showsSoon("2 limit resets")
    // A signed-out account offers its sign-in on its own row.
    expect(() => control("Sign in again to lab@studio.dev")).not.toThrow()
    await press("2 limit resets on ana@studio.dev")
    await showsSoon("Each one resets this account's 5-hour and weekly windows at once.")
    expect(shows("Expires in")).toBe(true)
  })

  test("the settings page draws each live setting the API serves, and a switch changes it", async () => {
    drawn = await draw({
      stub: { key: ownerKey },
      host: { key: ownerKey, permission: "denied" },
      at: "#/settings",
    })
    await showsSoon("Paid API fallback")
    const fallbackDetail = document.getElementById(control("Paid API fallback").getAttribute("aria-describedby") ?? "")
    expect(fallbackDetail?.textContent).toContain("incur charges")
    expect(fallbackDetail?.textContent).toContain("names its API provider or no subscription matches")
    expect(shows("Proxy switches and steppers autosave to config.toml. Strategy saves on Apply.")).toBe(true)
    expect(shows("Expiring resets and unused weekly quota.")).toBe(true)
    expect(shows("Blocked")).toBe(true)
    expect(() => control("Notify me")).toThrow()
    expect(shows("Reset first")).toBe(true)
    expect(() => control("Increase session timeout")).toThrow()
    expect(shows("Round robin")).toBe(false)
    expect(shows("Configure delivery under [notify] in config.toml.")).toBe(true)
    expect(() => control("Send a test notification")).toThrow()
    await press("Change strategy")
    await showsSoon("Round robin")
    expect(control("Reset first").getAttribute("aria-describedby")).toContain("-current")
    expect(control("Fill first").getAttribute("aria-describedby")).toContain("-default")
    await press("Fill first")
    expect(drawn?.stub.calls.some((call) => call.endpoint === "change")).toBe(false)
    await press("Cancel")
    await press("Change strategy")
    expect(control("Apply strategy").hasAttribute("disabled")).toBe(true)
    await press("Fill first")
    await press("Apply strategy")
    await settle(() => drawn?.stub.calls.some((call) => call.endpoint === "change") === true, "the routing change")
    expect(drawn?.stub.calls.find((call) => call.endpoint === "change")?.payload).toEqual({ strategy: "fill-first" })
    await press("Advanced proxy settings")
    await showsSoon("Session timeout")
    const interval = control("Increase polling interval").getAttribute("aria-describedby") ?? ""
    expect(document.getElementById(interval)?.textContent).toBe("Current value 5 min")
    for (const title of ["Warm ChatGPT windows", "Usage polling", "Refresh sign-ins", "Codex WebSockets"]) {
      expect(shows(title)).toBe(true)
    }
    await press("Warm ChatGPT windows")
    await showsSoon("Idle ChatGPT windows start as they reset.")
    expect(drawn?.stub.calls.filter((call) => call.endpoint === "change").at(-1)?.payload).toEqual({
      warmWindows: true,
    })
    await press("Increase session timeout")
    await showsSoon("A session keeps its account through 2 h idle.")
  })

  test("an empty API provider opens a form scoped to that provider", async () => {
    await web("#/openai")
    await showsSoon("No OpenAI API accounts")
    expect(control("Add OpenAI API key").getAttribute("href")).toBe("#/accounts/add?provider=openai")
    await act(async () => {
      location.hash = "#/accounts/add?provider=openai"
    })
    await showsSoon("Make OpenAI API models available through this proxy.")
    expect(control("Back to OpenAI API").getAttribute("href")).toBe("#/openai")
    expect(document.querySelector('[role=group][aria-label="Provider"]')).toBeNull()
    await type("Paste an API key", "sk-openai-test")
    await press("Add key")
    await showsSoon("OpenAI API added.")
    expect(drawn?.stub.calls.find((call) => call.endpoint === "add")?.payload).toMatchObject({
      _tag: "Key",
      provider: "openai",
    })
  })

  test("a refused key shows why under the form, not as a toast", async () => {
    await web("#/accounts/add")
    await showsSoon("Add an account")
    drawn?.stub.failNext(
      "add",
      new UpstreamFailed({
        message: "the key was refused: 401 invalid x-api-key",
      }),
    )
    await type("Paste an API key", "sk-ant-wrong")
    await press("Add key")
    await settle(() => document.querySelector("[role=alert]") !== null, "the refusal")
    expect(document.querySelector("[role=alert]")?.textContent).toBe("The key was refused: 401 invalid x-api-key")
  })

  test("a client key is shown once, and revoking one asks first", async () => {
    await web("#/access")
    await showsSoon("laptop")
    await type("Key name", "phone")
    await press("Create key")
    await showsSoon("The key phone")
    await press("Done")
    await settle(() => !shows("The key phone"), "the key hidden")
    await press("Revoke the key laptop…")
    await showsSoon("Agents using this key are refused from now on.")
    await press("Revoke")
    await showsSoon("laptop revoked.")
  })

  test("dashboard destinations stay stable and highlight contextual routes", async () => {
    await web("#/codex?account=codex-00000001")
    const primary = document.querySelector('nav[aria-label="Dashboard"]')
    expect([...(primary?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual([
      "Quota",
      "Accounts",
      "Analytics",
      "Requests",
      "Connections",
      "Settings",
    ])
    expect(control("Accounts").getAttribute("aria-current")).toBe("location")
    expect(control("All accounts").getAttribute("href")).toBe("#/accounts")
    await act(async () => {
      location.hash = "#/accounts"
    })
    await showsSoon("API keys and endpoints")
    expect(control("Accounts").getAttribute("aria-current")).toBe("page")
    expect(control("Manage accounts for Anthropic API").getAttribute("href")).toBe("#/anthropic")
    expect(document.querySelector('main a[href^="#/anthropic?account="]')?.textContent).toContain("Team API key")
    expect(control("Add account").getAttribute("href")).toBe("#/accounts/add")
    const ben = [...document.querySelectorAll("main a")].find((link) => link.textContent?.includes("ben@studio.dev"))
    expect(ben?.textContent).toContain("19% left · Weekly")

    await act(async () => {
      location.hash = "#/requests"
    })
    await showsSoon("Any outcome")
    expect(control("Requests").getAttribute("aria-current")).toBe("page")
  })

  test("proxy status opens diagnostics and client access points to the provider form", async () => {
    await web("#/access")
    await showsSoon("Add a provider account")
    expect(control("Connections").getAttribute("aria-current")).toBe("location")
    expect(control("Diagnostics · Running 0.4.0").getAttribute("href")).toBe("#/diagnostics")
    expect(control("Add a provider account").getAttribute("href")).toBe("#/accounts/add")
  })

  test("past resets live under quota and share the date range with analytics", async () => {
    await web("#/quota/history")
    await showsSoon("Unused subscription quota")
    expect(control("Quota").getAttribute("aria-current")).toBe("location")
    expect(control("Past resets").getAttribute("aria-current")).toBe("page")
    await press("30 days")
    await act(async () => {
      location.hash = "#/usage"
    })
    await showsSoon("Answered requests")
    expect(control("Analytics").getAttribute("aria-current")).toBe("page")
    expect(control("30 days").getAttribute("aria-pressed")).toBe("true")
    expect(shows("Unused subscription quota")).toBe(false)
  })

  test("Accounts includes a tight shared limit without a reported reset", async () => {
    await web("#/accounts")
    const now = DateTime.nowUnsafe()
    const resetsAt = DateTime.add(now, { hours: 1 })
    const claude = account({
      id: "claude-00000009",
      name: "work",
      provider: "claude",
      windows: [
        Window.of("5h", 40, resetsAt),
        Window.of("7d", 95),
        Window.of("7d", 99, resetsAt, "Opus"),
        Window.of("30d", 100, DateTime.subtract(now, { hours: 1 })),
      ],
    })
    await act(async () => {
      drawn?.stub.setReport(new Report({ ...emptyReport(now), accounts: [claude] }))
    })
    await showsSoon("5% left · Weekly")
    expect(shows("Reset time unavailable")).toBe(true)
  })

  test("a proxy with only API accounts explains where to see activity", async () => {
    await web()
    const metered = account({
      id: "compat-00000001",
      provider: "compat",
      name: "Local models",
    })
    await act(async () => {
      drawn?.stub.setReport(
        new Report({
          ...emptyReport(DateTime.nowUnsafe()),
          accounts: [metered],
        }),
      )
    })
    await showsSoon("No subscription quota to track")
    expect(control("View accounts").getAttribute("href")).toBe("#/accounts")
    expect(control("View usage").getAttribute("href")).toBe("#/usage")
    await act(async () => {
      location.hash = "#/accounts"
    })
    await showsSoon("Local models")
    expect(shows("Billed per token")).toBe(false)
  })

  test("a slopmax with no accounts says how to add one", async () => {
    drawn = await draw({
      stub: { key: ownerKey, scenario: "empty" },
      host: { key: ownerKey },
    })
    await showsSoon("No accounts yet")
    expect(control("Accounts").getAttribute("href")).toBe("#/accounts")
  })
})

describe("what the dashboard says while waiting, failing or quiet", () => {
  test("a wrong key typed into the gate is checked first, so the dashboard never opens for it", async () => {
    drawn = await draw({ stub: { key: ownerKey } })
    await showsSoon("Open the slopmax dashboard")
    await type("Owner key", "sm-wrong")
    await press("Open")
    await showsSoon("slopmax refused that key")
    expect(shows("Looking for the proxy")).toBe(false)
    expect(shows("Running 0.4.0")).toBe(false)
    expect(document.querySelector("code")?.textContent).toBe("slopmax dashboard")
  })

  test("while slopmax does not answer, the agents say so rather than pulse, and Settings agrees with the masthead", async () => {
    drawn = await draw({
      stub: { key: ownerKey },
      host: { key: ownerKey },
      at: "#/agents",
      prepare: (stub) => stub.failNext("events", new UpstreamFailed({ message: "the proxy went away" })),
    })
    await showsSoon("Agents can be connected once it answers again.")
    await act(async () => {
      location.hash = "#/settings"
    })
    await showsSoon("Status")
    expect(shows("Looking for the proxy")).toBe(false)
    expect(control("Diagnostics · Reconnecting…")).toBeDefined()
    expect(document.querySelector("main")?.textContent).toContain("Reconnecting…")
    await showsSoon("Running 0.4.0")
  })

  test("a new sign-in shows under Subscriptions before its limits are read", async () => {
    await web()
    const fresh = account({
      id: "claude-00000009",
      provider: "claude",
      name: "new@studio.dev",
    })
    await act(async () => {
      drawn?.stub.setReport(new Report({ ...emptyReport(DateTime.nowUnsafe()), accounts: [fresh] }))
    })
    await showsSoon("Limits not read yet: slopmax reads them on the first request, or press Refresh.")
    expect(shows("Subscription limits")).toBe(true)
    await act(async () => {
      location.hash = "#/claude"
    })
    await showsSoon("new@studio.dev")
    expect(shows("Limits not read yet")).toBe(true)
  })

  test("empty analytics links to coding agents inside Connections", async () => {
    drawn = await draw({
      stub: { key: ownerKey, scenario: "empty" },
      host: { key: ownerKey },
      at: "#/usage",
    })
    await showsSoon("No requests recorded in this range")
    await press("Connect an agent")
    await settle(() => location.hash === "#/connections?section=agents", "coding agents in Connections")
    // Installed agents first; a connected one says so once.
    await showsSoon("Not connected")
    expect(shows("Goes through slopmax")).toBe(false)
    expect(shows("Connected")).toBe(true)
  })

  test("a refresh spins and cannot be pressed again until it is answered", async () => {
    drawn = await draw({
      stub: { key: ownerKey, latency: "150 millis" },
      host: { key: ownerKey },
    })
    await showsSoon("Running 0.4.0", 5_000)
    await press("Refresh")
    expect(control("Refresh").hasAttribute("disabled")).toBe(true)
    await press("Refresh")
    await showsSoon("Usage and limit resets read again.")
    expect(drawn.stub.calls.filter((call) => call.endpoint === "refresh")).toHaveLength(1)
  })

  test("adding a key says it is being checked, and a taken key name keeps what was typed", async () => {
    drawn = await draw({
      stub: { key: ownerKey, latency: "150 millis" },
      host: { key: ownerKey },
      at: "#/accounts/add",
    })
    // Changes wait for slopmax to answer on the event stream.
    await showsSoon("Running 0.4.0", 5_000)
    await type("Paste an API key", "sk-ant-good")
    await press("Add key")
    await showsSoon("Checking key…")
    await showsSoon("Anthropic API added.")
    await act(async () => {
      location.hash = "#/access"
    })
    await showsSoon("Create key", 5_000)
    await type("Key name", "laptop")
    await press("Create key")
    await showsSoon("There is already a key named laptop")
    const name = document.querySelector<HTMLInputElement>("input[placeholder='e.g. laptop']")
    expect(name?.value).toBe("laptop")
    expect(name?.getAttribute("aria-invalid")).toBe("true")
  })

  test("a priority that is not a whole number keeps the dialog open and says what it takes", async () => {
    await web("#/claude")
    await showsSoon("Across 3 accounts, weighted by plan")
    await press("More for ana@studio.dev")
    await settle(() => document.querySelector("[role=menuitem]") !== null, "the menu")
    await press("Priority (0)…")
    await showsSoon("Higher tiers are used first")
    await type("Priority", "high")
    await press("Save")
    await showsSoon("Enter a whole number, such as 2.")
    expect(shows("Higher tiers are used first")).toBe(true)
    await type("Priority", "3")
    await press("Save")
    await showsSoon("ana@studio.dev is at priority 3.")
  })
})
