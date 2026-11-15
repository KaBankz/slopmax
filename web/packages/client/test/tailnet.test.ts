import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Schema } from "effect"
import {
  Access,
  AdminMachine,
  Health,
  hubTarget,
  LedgerRecord,
  reaches,
  Summary,
  SummaryBy,
  TailnetPatch,
  TailnetView,
  TailscaleState,
} from "../src/index.ts"
import { strict } from "../src/settings.ts"

const decodeView = Schema.decodeUnknownSync(TailnetView, strict)
const encodeView = Schema.encodeSync(TailnetView)

const published: typeof TailnetView.Encoded = {
  tailscale: "running",
  url: "https://hub.example.ts.net:7567",
  transport: "socket",
  identity: true,
  host: "hub",
  users: ["you@github"],
  admins: [{ machine: "laptop", id: "nAbCdEf1CNTRL" }],
  funnel: false,
}

describe("the tailnet's view", () => {
  it("reads a published hub, and writes it back as the daemon does", () => {
    const view = decodeView(published)
    expect(view.admins[0]).toEqual(new AdminMachine({ machine: "laptop", id: "nAbCdEf1CNTRL" }))
    expect(view.problem).toBeUndefined()
    expect(encodeView(view)).toEqual(published)
  })

  it("reads one without the fields the daemon leaves out, and keeps them out", () => {
    const missing: typeof TailnetView.Encoded = {
      tailscale: "missing",
      identity: false,
      users: [],
      admins: [],
      funnel: false,
      problem: { text: "Tailscale isn't installed here" },
    }
    const view = decodeView(missing)
    expect([view.url, view.transport, view.host, view.problem?.fix]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ])
    expect(encodeView(view)).toEqual(missing)
    const fixed = decodeView({ ...missing, problem: { text: "HTTPS is off", fix: "slopmax tailscale on" } })
    expect(fixed.problem?.fix).toBe("slopmax tailscale on")
  })

  it("knows every state and transport the daemon names, and no others", () => {
    expect(TailscaleState.literals).toEqual([
      "missing",
      "down",
      "signedOut",
      "off",
      "needsApproval",
      "running",
      "unknown",
    ])
    for (const tailscale of TailscaleState.literals) {
      expect(decodeView({ ...published, tailscale }).tailscale).toBe(tailscale)
    }
    expect(decodeView({ ...published, transport: "loopback" }).transport).toBe("loopback")
    expect(() => decodeView({ ...published, tailscale: "Running" })).toThrow()
    expect(() => decodeView({ ...published, transport: "tcp" })).toThrow()
    expect(() => decodeView({ ...published, extra: 1 })).toThrow()
  })

  it("names the hub for `slopmax setup --hub`", () => {
    expect(hubTarget(decodeView(published))).toBe("hub")
    const { host: _host, ...nameless } = published
    expect(hubTarget(decodeView(nameless))).toBe("hub")
    const { url: _url, ...unpublished } = nameless
    expect(hubTarget(decodeView(unpublished))).toBeUndefined()
  })

  it("gives the whole address when the hub is on another port, where setup does not look", () => {
    const elsewhere = { ...published, url: "https://hub.example.ts.net:7568" }
    expect(hubTarget(decodeView(elsewhere))).toBe("https://hub.example.ts.net:7568")
    expect(hubTarget(decodeView({ ...published, url: "https://hub.example.ts.net" }))).toBe(
      "https://hub.example.ts.net",
    )
  })
})

describe("tailnet patches", () => {
  it("carry only what they change", () => {
    const encode = Schema.encodeSync(TailnetPatch)
    expect(encode(new TailnetPatch({ users: ["you@github"] }))).toEqual({ users: ["you@github"] })
    expect(encode(new TailnetPatch({}))).toEqual({})
    const admins = { admins: [{ machine: "laptop", id: "nAbC" }] }
    expect(encode(Schema.decodeUnknownSync(TailnetPatch)(admins))).toEqual(admins)
  })
})

describe("access", () => {
  it("ranks none, use, view, admin", () => {
    expect(Access.literals).toEqual(["none", "use", "view", "admin"])
    expect(reaches("admin", "view")).toBe(true)
    expect(reaches("view", "view")).toBe(true)
    expect(reaches("use", "view")).toBe(false)
    expect(reaches("none", "use")).toBe(false)
  })
})

describe("/healthz", () => {
  const decode = Schema.decodeUnknownSync(Health)

  it("reads an older proxy's answer, which says nothing of the caller", () => {
    const old = decode({ status: "ok", service: "slopmax", version: "0.9.0", pid: 42 })
    expect([old.version, old.pid, old.access, old.via, old.machine]).toEqual([
      "0.9.0",
      42,
      undefined,
      undefined,
      undefined,
    ])
  })

  it("reads what the hub says of a machine on the tailnet", () => {
    const seen = decode({
      status: "ok",
      service: "slopmax",
      version: "0.10.0",
      owner: false,
      access: "view",
      via: "tailnet",
      login: "you@github",
      machine: "laptop",
    })
    expect([seen.pid, seen.access, seen.via, seen.login, seen.machine]).toEqual([
      undefined,
      "view",
      "tailnet",
      "you@github",
      "laptop",
    ])
    expect(() => decode({ version: "0.10.0", access: "root" })).toThrow()
  })
})

describe("the ledger by machine", () => {
  const line = {
    _tag: "Request",
    at: "2026-11-01T00:00:00Z",
    provider: "claude",
    status: 200,
    usage: {},
    ms: 4,
    attempts: 1,
    via: "http",
  }

  it("reads requests with and without the machine that sent them", () => {
    const decode = Schema.decodeUnknownSync(LedgerRecord, strict)
    const from = decode({ ...line, machine: "laptop" })
    const owner = decode(line)
    expect(from._tag === "Request" ? from.machine : "").toBe("laptop")
    expect(owner._tag === "Request" ? owner.machine : "").toBeUndefined()
    expect(Schema.encodeSync(LedgerRecord)(owner)).not.toHaveProperty("machine")
  })

  it("groups usage by machine", () => {
    expect(SummaryBy.literals).toContain("machine")
    const summary = Schema.decodeUnknownSync(
      Summary,
      strict,
    )({
      range: "7d",
      by: "machine",
      since: "2026-11-01T00:00:00Z",
      rows: [
        { key: "hub", totals: { requests: 96 } },
        { key: "laptop", totals: { requests: 412 } },
      ],
      total: { requests: 508 },
    })
    expect(summary.rows.map((row) => row.key)).toEqual(["hub", "laptop"])
  })
})
