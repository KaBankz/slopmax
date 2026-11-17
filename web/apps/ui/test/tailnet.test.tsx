// The web dashboard opened from another machine over the tailnet: its
// identity opens it without a key, a machine that may only look sees
// everything read-only, the Access page shows how other machines reach
// slopmax, and the Usage page sums usage by machine.
import { useBrowser } from "./support/dom.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { Internal, SummaryRow, TailnetView, tailnetToken, Totals, Unauthorized } from "@slopmax/client"
import { Effect, Option } from "effect"
import { UiPrefs } from "../src/host.ts"
import { ownerKey, version } from "./support/fixtures.ts"
import { control, draw, type Drawn, press, settle, shows, showsSoon } from "./support/render.tsx"
import type { StubOptions } from "./support/stub-api.ts"

useBrowser()

let drawn: Drawn | undefined
afterEach(async () => {
  await drawn?.close()
  drawn = undefined
})

/** What `/healthz` answers a machine on the tailnet that sent the tailnet token. */
/** A button on the page itself, not the sidebar: the sidebar has a "Claude" of its own. */
const inPage = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("main button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  )

const overTailnet = (access: string) => ({
  status: "ok",
  service: "slopmax",
  version,
  owner: false,
  access,
  via: "tailnet",
  login: "you@github",
  machine: "laptop",
})

/** The calls only an admin may make, which a page that may only look never sends. */
const adminCalls = ["settings", "keys", "agents", "doctor", "refresh"]

const published = new TailnetView({
  tailscale: "running",
  url: "https://hub.example.ts.net:7567",
  transport: "socket",
  identity: true,
  host: "hub",
  users: ["you@github"],
  admins: [{ machine: "desk", id: "nDESK1CNTRL" }],
  funnel: false,
})

const fromTailnet = async (stub: StubOptions, at = "#/overview") => {
  drawn = await draw({ stub, at })
  await showsSoon("Running 0.4.0")
  return drawn
}

describe("opened over the tailnet without a key", () => {
  test("a machine that may view opens the dashboard read-only, holding the tailnet token for this tab only", async () => {
    const page = await fromTailnet({ health: overTailnet("view") })
    expect(shows("Open the slopmax dashboard")).toBe(false)
    expect(page.stub.calls.find((call) => call.endpoint === "healthz")?.authorization).toBe(`Bearer ${tailnetToken}`)
    // The token is never kept in the tab's storage: closing the tab forgets it.
    expect(Option.isNone(Effect.runSync(page.host.host.key))).toBe(true)
    await showsSoon("5 of 7 accounts are ready")
    expect(shows("Read-only from this machine. On the hub: slopmax tailscale admin add laptop")).toBe(true)
    expect(control("Refresh usage").hasAttribute("disabled")).toBe(true)
    expect(page.stub.calls.some((call) => adminCalls.includes(call.endpoint))).toBe(false)
  })

  test("read-only, the controls that change things are disabled and the pages say why", async () => {
    const page = await fromTailnet({ health: overTailnet("view"), tailnet: published }, "#/access")
    await showsSoon("Add an account")
    for (const name of ["Claude", "ChatGPT with a code", "Import", "Add key", "Create key"]) {
      expect([name, inPage(name)?.hasAttribute("disabled")]).toEqual([name, true])
    }
    expect(shows("Read-only from this machine.")).toBe(true)
    await showsSoon("Other machines")
    location.hash = "#/agents"
    await showsSoon("Agents on this machine use the hub")
    location.hash = "#/settings"
    await showsSoon("changed on the hub, or from a machine that may manage it")
    location.hash = "#/diagnostics"
    await showsSoon("Run slopmax doctor on the hub")
    location.hash = "#/claude"
    await showsSoon("Across 3 accounts, weighted by plan")
    expect(control("More for ana@studio.dev").hasAttribute("disabled")).toBe(true)
    expect(page.stub.calls.some((call) => adminCalls.includes(call.endpoint))).toBe(false)
  })

  test("an admin machine opens it with nothing held back", async () => {
    const page = await fromTailnet({ health: overTailnet("admin") }, "#/settings")
    await showsSoon("Session timeout")
    expect(shows("Read-only from this machine")).toBe(false)
    expect(shows("Open the slopmax dashboard")).toBe(false)
    expect(page.stub.calls.some((call) => call.endpoint === "settings")).toBe(true)
  })

  test("asks for the key when the hub takes nothing more than use, or does not know the machine", async () => {
    for (const health of [
      overTailnet("use"),
      overTailnet("none"),
      // Not over the tailnet: a local request with the token says only that it is not the owner key.
      { status: "ok", service: "slopmax", version, pid: 42, owner: false, access: "none" },
      // An older proxy says nothing of the caller.
      { status: "ok", service: "slopmax", version, pid: 42, owner: false },
    ]) {
      drawn = await draw({ stub: { key: ownerKey, health } })
      await showsSoon("Open the slopmax dashboard")
      expect(shows("slopmax refused that key")).toBe(false)
      expect(drawn.stub.calls.some((call) => call.endpoint === "events")).toBe(false)
      await drawn.close()
      drawn = undefined
    }
  })

  test("a key never needs the tailnet: the dashboard opens on it without asking /healthz", async () => {
    drawn = await draw({ stub: { key: ownerKey, health: overTailnet("view") }, host: { key: ownerKey } })
    await showsSoon("Running 0.4.0")
    expect(drawn.stub.calls.some((call) => call.endpoint === "healthz")).toBe(false)
    expect(shows("Read-only from this machine")).toBe(false)
  })

  test("refused once in, it asks /healthz again before asking for a key", async () => {
    const page = await fromTailnet({ health: overTailnet("view") })
    // The hub stops taking this machine: it ends the stream, and refuses it from then on.
    page.stub.setHealth({ status: "ok", service: "slopmax", version, owner: false, access: "none", via: "tailnet" })
    page.stub.refuseAll(true)
    page.stub.endStreams()
    await showsSoon("Open the slopmax dashboard", 5_000)
    expect(page.stub.calls.filter((call) => call.endpoint === "healthz").length).toBe(2)
    expect(shows("slopmax refused that key")).toBe(false)
  })

  test("refused once in but still taken, it opens again with what the hub now allows", async () => {
    const page = await fromTailnet({ health: overTailnet("admin") })
    expect(shows("Read-only from this machine")).toBe(false)
    page.stub.setHealth(overTailnet("view"))
    // The daemon refuses a machine it knows with 403, not 401.
    page.stub.failNext("events", new Unauthorized({ message: "this machine may not change slopmax" }), 403)
    page.stub.endStreams()
    await showsSoon("Read-only from this machine", 5_000)
    expect(page.stub.calls.filter((call) => call.endpoint === "healthz").length).toBe(2)
    expect(shows("Open the slopmax dashboard")).toBe(false)
  })

  test("refused again straight after, it asks for a key rather than asking /healthz round and round", async () => {
    const page = await fromTailnet({ health: overTailnet("admin") })
    page.stub.refuseAll(true)
    page.stub.endStreams()
    await showsSoon("Open the slopmax dashboard", 5_000)
    expect(page.stub.calls.filter((call) => call.endpoint === "healthz").length).toBe(2)
  })
})

/** The Access page, opened with the owner key. */
const access = async (stub: StubOptions) => {
  drawn = await draw({ stub: { key: ownerKey, ...stub }, host: { key: ownerKey }, at: "#/access" })
  await showsSoon("Client keys")
  return drawn
}

describe("the Other machines card", () => {
  test("shows the address, who needs no key, the admins, and the command for another machine", async () => {
    const page = await access({ tailnet: published })
    await showsSoon("Other machines")
    for (const text of [
      "https://hub.example.ts.net:7567",
      "slopmax's socket",
      "you@github",
      "desk",
      "slopmax setup --hub hub",
    ]) {
      expect(shows(text)).toBe(true)
    }
    expect(shows("On the hub: slopmax tailscale on")).toBe(false)
    control("Copy slopmax setup --hub hub").click()
    await settle(() => page.host.recorded.copied.includes("slopmax setup --hub hub"), "the copy")
  })

  test("masks the logins that are email addresses while emails are hidden", async () => {
    drawn = await draw({
      stub: { key: ownerKey, tailnet: new TailnetView({ ...published, users: ["ana@studio.dev", "you@github"] }) },
      host: { key: ownerKey, prefs: new UiPrefs({ ...UiPrefs.defaults, hideEmails: true }) },
      at: "#/access",
    })
    await showsSoon("a•••@s•••.dev, you@github")
    expect(document.querySelector("main")?.textContent).not.toContain("ana@studio.dev")
  })

  test("says what is wrong, and its fix", async () => {
    const page = await access({
      tailnet: new TailnetView({
        ...published,
        funnel: true,
        problem: {
          text: "Tailscale Funnel exposes port 7567 to the internet",
          fix: "tailscale funnel --https=7567 off",
        },
      }),
    })
    await showsSoon("Tailscale Funnel exposes port 7567 to the internet")
    expect(shows("tailscale funnel --https=7567 off")).toBe(true)
    control("Copy the fix").click()
    await settle(() => page.host.recorded.copied.includes("tailscale funnel --https=7567 off"), "the copy")
  })

  test("without Tailscale, or before slopmax is published, says how to publish it", async () => {
    await access({
      tailnet: new TailnetView({
        tailscale: "missing",
        identity: false,
        users: [],
        admins: [],
        funnel: false,
        problem: {
          text: "Tailscale isn't installed here",
          fix: "Install Tailscale from https://tailscale.com/download",
        },
      }),
    })
    await showsSoon("On the hub: slopmax tailscale on")
    expect(shows("Tailscale isn't installed here")).toBe(true)
    expect(shows("slopmax setup --hub")).toBe(false)
  })

  test("an older proxy without the endpoint leaves the card out", async () => {
    const page = await access({})
    await settle(() => page.stub.calls.some((call) => call.endpoint === "tailnet"), "the tailnet call")
    await showsSoon("Revoke…")
    // Long enough for the 404 to be read and drawn.
    const drawnBy = Date.now() + 100
    await settle(() => Date.now() > drawnBy, "the answer")
    expect(shows("Other machines")).toBe(false)
    expect(shows("Could not read the tailnet")).toBe(false)
  })

  test("any other failure says so, with a way to try again", async () => {
    drawn = await draw({
      stub: { key: ownerKey, tailnet: published },
      host: { key: ownerKey },
      at: "#/access",
      prepare: (stub) => stub.failNext("tailnet", new Internal({ message: "tailscale status didn't answer in time" })),
    })
    await showsSoon("Could not read the tailnet")
    expect(shows("Tailscale status didn't answer in time")).toBe(true)
    await press("Try again")
    await showsSoon("slopmax setup --hub hub")
  })
})

const row = (key: string, requests: number, input: number) =>
  new SummaryRow({ key, totals: new Totals({ ...Totals.zero, requests, input }) })

describe("usage by machine", () => {
  test("the Usage page sums usage by the machine that sent it", async () => {
    drawn = await draw({
      stub: { key: ownerKey, machines: [row("this machine", 96, 88_100), row("laptop", 412, 310_200)] },
      host: { key: ownerKey },
      at: "#/usage",
    })
    await showsSoon("Machines")
    expect(drawn.stub.calls.find((call) => call.endpoint === "summary")?.payload).toMatchObject({ by: "machine" })
    expect(shows("laptop")).toBe(true)
    expect(shows("412 requests")).toBe(true)
  })

  test("leaves it out while only this machine uses slopmax", async () => {
    drawn = await draw({ stub: { key: ownerKey }, host: { key: ownerKey }, at: "#/usage" })
    await showsSoon("Agents")
    await settle(() => drawn?.stub.calls.some((call) => call.endpoint === "summary") === true, "the summary")
    expect(shows("Machines")).toBe(false)
  })
})
