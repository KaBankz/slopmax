import { describe, expect, test } from "bun:test"
import { Health, TailnetView } from "@slopmax/client"
import { Option } from "effect"
import { adminCommand, machinesCard, onTheHub, tailnetAccess } from "../../src/view/tailnet.ts"

const health = (fields: Partial<ConstructorParameters<typeof Health>[0]>) =>
  Option.some(new Health({ version: "0.10.0", ...fields }))

describe("the tailnet's gate", () => {
  test("opens on view or admin, only for a request that came over the tailnet", () => {
    expect(tailnetAccess(health({ via: "tailnet", access: "view" }))).toEqual(Option.some("view"))
    expect(tailnetAccess(health({ via: "tailnet", access: "admin" }))).toEqual(Option.some("admin"))
    expect(tailnetAccess(health({ via: "tailnet", access: "use" }))).toEqual(Option.none())
    expect(tailnetAccess(health({ via: "tailnet", access: "none" }))).toEqual(Option.none())
    expect(tailnetAccess(health({ via: "tailnet" }))).toEqual(Option.none())
    expect(tailnetAccess(health({ via: "local", access: "admin" }))).toEqual(Option.none())
    expect(tailnetAccess(health({ access: "admin" }))).toEqual(Option.none())
    expect(tailnetAccess(Option.none())).toEqual(Option.none())
  })

  test("names the machine to make an admin, when the hub knows it", () => {
    expect(adminCommand(Option.some("laptop"))).toBe("slopmax tailscale admins add laptop")
    expect(adminCommand(Option.none())).toBe("slopmax tailscale admins add <machine>")
  })

  test("knows when the page is open on the hub itself, which can't be its own admin", () => {
    const origin = "https://hub.example.ts.net:7567"
    expect(onTheHub(Option.some("hub"), origin)).toBe(true)
    expect(onTheHub(Option.some("Hub"), "https://HUB.example.ts.net")).toBe(true)
    expect(onTheHub(Option.some("laptop"), origin)).toBe(false)
    expect(onTheHub(Option.none(), origin)).toBe(false)
    expect(onTheHub(Option.some("hub"), "")).toBe(false)
  })
})

describe("the Other machines card", () => {
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

  test("a published hub: its address, how it is reached, who needs no key, its admins, and setup elsewhere", () => {
    const card = machinesCard(published)
    expect(card.rows.map((row) => [row.title, row.value])).toEqual([
      ["Address", "https://hub.example.ts.net:7567"],
      ["Reached through", "slopmax's socket"],
      ["No key for", "you@github"],
      ["Admins", "desk"],
      ["On another machine", "slopmax setup --hub hub"],
    ])
    expect(card.problem).toBeUndefined()
    expect(card.start).toBeUndefined()
  })

  test("over loopback, or with no logins, every machine needs a key", () => {
    const loopback = machinesCard(
      new TailnetView({ ...published, transport: "loopback", identity: false, admins: [] }),
    ).rows
    expect(loopback.find((row) => row.title === "Reached through")?.value).toBe("127.0.0.1")
    expect(loopback.find((row) => row.title === "No key for")?.value).toBe("No one")
    expect(loopback.find((row) => row.title === "Admins")?.detail).toBe(
      "To let a machine manage slopmax: slopmax tailscale admins add <machine>.",
    )
  })

  test("a problem keeps its fix, and an unpublished hub says how to publish it", () => {
    const off = machinesCard(
      new TailnetView({
        tailscale: "signedOut",
        identity: false,
        users: [],
        admins: [],
        funnel: false,
        problem: { text: "Tailscale here is signed out", fix: "tailscale up" },
      }),
    )
    expect(off.rows).toEqual([])
    expect(off.problem).toEqual({ text: "Tailscale here is signed out", fix: "tailscale up" })
    expect(off.start).toBe("On the hub: slopmax tailscale on")
    const missing = machinesCard(
      new TailnetView({ tailscale: "missing", identity: false, users: [], admins: [], funnel: false }),
    )
    expect(missing.start).toBe("On the hub: slopmax tailscale on")
    expect(missing.problem).toBeUndefined()
  })
})
