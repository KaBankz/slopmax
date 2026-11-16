import { describe, expect, test } from "bun:test"
import {
  AccountId,
  AgentWiring,
  LedgerRecord,
  type LoginEvent,
  Notice,
  type RequestRecord,
  Usage,
} from "@slopmax/client"
import { DateTime } from "effect"
import {
  agentLine,
  agentsInOrder,
  anyWired,
  cannotChange,
  feedRow,
  feedSize,
  needsProxy,
  type ProxyState,
  proxyLabel,
  pushFeed,
  secs,
  shownProxy,
  signInDone,
  signInView,
  startSignIn,
  stepSignIn,
  tell,
  toldSize,
} from "../../src/view/live.ts"
import { addToast, showing, visibleToasts } from "../../src/view/toasts.ts"
import { fixtureAccounts } from "../support/fixtures.ts"

const now = DateTime.makeUnsafe("2026-10-31T12:00:00Z")
const zone = DateTime.zoneMakeNamedUnsafe("UTC")

const agent = (wired: boolean, wiredTo?: string) =>
  new AgentWiring({
    id: "codex",
    title: "Codex",
    installed: true,
    configPath: "~/.codex/config.toml",
    wired,
    backedUp: false,
    ...(wiredTo === undefined ? {} : { wiredTo }),
  })

const record = (fields: Partial<RequestRecord> = {}) =>
  LedgerRecord.cases.Request.make({
    at: DateTime.makeUnsafe("2026-10-31T09:05:07Z"),
    account: AccountId.make("claude-1a2b3c4d"),
    provider: "claude",
    model: "claude-sonnet-5",
    status: 200,
    usage: new Usage({ requests: 1, input: 1_000, output: 500, cacheRead: 40_000, cacheWrite: 0 }),
    ms: 6_020,
    firstByteMs: 840,
    attempts: 1,
    agent: "claude-code",
    via: "http",
    ...fields,
  })

const name = (id: string) => (id === "claude-1a2b3c4d" ? "ana@studio.dev" : id)

const notice = (key: string, until?: string) =>
  new Notice({
    kind: "reset-expiring",
    key,
    account: key,
    message: "m",
    at: now,
    ...(until === undefined ? {} : { until: DateTime.makeUnsafe(until) }),
  })

describe("sign-in", () => {
  test("progress moves the step along, and notes gather", () => {
    let signIn = startSignIn("codex")
    expect(signIn.step).toEqual({ _tag: "Starting" })
    const steps: ReadonlyArray<LoginEvent> = [
      { _tag: "Authorize", title: "ChatGPT", url: "https://auth.example/a", port: 1455, opened: true },
      { _tag: "Note", text: "The browser did not open; open the address yourself." },
      { _tag: "DeviceCode", url: "https://auth.example/device", code: "AB12-CD34" },
    ]
    signIn = stepSignIn(signIn, steps[0] ?? steps[1] ?? never())
    expect(signIn.step).toEqual({ _tag: "Authorize", url: "https://auth.example/a", opened: true, port: 1455 })
    signIn = stepSignIn(stepSignIn(signIn, steps[1] ?? never()), steps[2] ?? never())
    expect(signIn.step).toEqual({ _tag: "DeviceCode", url: "https://auth.example/device", code: "AB12-CD34" })
    expect(signIn.notes).toEqual(["The browser did not open; open the address yourself."])
  })

  test("says what to do next at each step", () => {
    const start = startSignIn("claude")
    expect(signInView(start)).toEqual({ title: "Signing in to Claude", detail: "Starting…", notes: "" })
    const opened = {
      ...start,
      step: { _tag: "Authorize" as const, url: "https://claude.ai/x", opened: true, port: 54545 },
    }
    expect(signInView(opened)).toMatchObject({
      detail: "Finish signing in to Claude in your browser, which opened this address:",
      link: "https://claude.ai/x",
      paste: { action: "Use address" },
    })
    expect(signInView({ ...opened, step: { ...opened.step, opened: false } }).detail).toBe(
      "Open this address in a browser and sign in to Claude:",
    )
    // Port 0: no browser on the proxy's machine, so the page shows a code to paste.
    expect(signInView({ ...opened, step: { ...opened.step, opened: false, port: 0 } })).toMatchObject({
      detail: "Open this address in any browser, sign in to Claude, and paste the code it shows:",
      link: "https://claude.ai/x",
      paste: { hint: "Paste the code the page shows", action: "Use code" },
    })
    const code = { ...start, step: { _tag: "DeviceCode" as const, url: "https://x/device", code: "QX7F" } }
    expect(signInView(code)).toMatchObject({
      detail: "Open https://x/device and enter this code:",
      code: "QX7F",
      codePage: "https://x/device",
    })
    expect(signInView(code).link).toBeUndefined()
  })

  test("its end says who was connected, or why it failed", () => {
    const [ana] = fixtureAccounts(now)
    if (ana === undefined) throw new Error("no fixture")
    expect(signInDone({ _tag: "Done", account: ana, isNew: true })).toEqual({
      text: "Connected ana@studio.dev.",
      error: false,
    })
    expect(signInDone({ _tag: "Done", account: ana, isNew: false })?.text).toBe("Updated ana@studio.dev.")
    expect(signInDone({ _tag: "Failed", message: "the state did not match" })).toEqual({
      text: "Sign-in failed: the state did not match",
      error: true,
    })
    expect(signInDone({ _tag: "Note", text: "x" })).toBeUndefined()
  })
})

const checking: ProxyState = { _tag: "Checking" }
const running: ProxyState = { _tag: "Running", version: "0.4.0" }

describe("the proxy and agents", () => {
  test("the proxy's label says how it stands, and what needs it running waits for it", () => {
    expect(proxyLabel(checking)).toEqual({ text: "Looking for the proxy…", tone: "muted" })
    expect(proxyLabel(running)).toEqual({ text: "Running 0.4.0", tone: "good" })
    // While the window is still finding out, it waits rather than saying anything.
    expect(needsProxy(checking)).toBeUndefined()
    expect(needsProxy(running)).toBeUndefined()
    // Once the stream has dropped, it says slopmax is not answering rather than pulse.
    expect(needsProxy(checking, true)).toBe("slopmax is not answering")
  })

  test("a page that may only look says so before anything about the proxy", () => {
    expect(cannotChange(running, false, true)).toBe("Read-only from this machine")
    expect(cannotChange(checking, true, true)).toBe("Read-only from this machine")
    expect(cannotChange(running, false, false)).toBeUndefined()
    expect(cannotChange(checking, true, false)).toBe("slopmax is not answering")
  })

  test("the proxy's label follows the stream, the same in the sidebar and Settings", () => {
    expect(shownProxy(checking, "Reconnecting")).toEqual({ text: "Reconnecting…", tone: "warn" })
    expect(shownProxy(checking, "Connecting")).toEqual({ text: "Connecting…", tone: "muted" })
    expect(shownProxy(running, "Running").text).toBe("Running 0.4.0")
  })

  test("agents read plainly", () => {
    // Connected says so in its label alone.
    expect(agentLine(agent(true, "http://127.0.0.1:7567"))).toEqual({ connected: true })
    expect(agentLine(new AgentWiring({ ...agent(false), installed: false })).text).toBe(
      "Not installed on this machine. Connecting writes its settings now, so it goes through slopmax once installed.",
    )
    const missing = new AgentWiring({ ...agent(false), id: "claude-code", title: "Claude Code", installed: false })
    expect(agentsInOrder([missing, agent(false)]).map((a) => a.title)).toEqual(["Codex", "Claude Code"])
    expect(anyWired([missing, agent(false)])).toBe(false)
    expect(anyWired([agent(true)])).toBe(true)
    expect(agentLine(agent(false, "https://gateway.example"))).toEqual({
      text: "Goes to https://gateway.example",
      connected: false,
    })
    expect(agentLine(agent(false))).toEqual({ text: "Goes straight to its provider", connected: false })
  })
})

describe("live requests", () => {
  test("each row says who sent it, where it went, and how it went", () => {
    expect(feedRow(record(), name, zone)).toEqual({
      time: "09:05:07",
      who: "Claude Code",
      model: "claude-sonnet-5",
      status: "200",
      failed: false,
      detail: "ana@studio.dev",
      tokens: "41.5k",
      took: "840 ms · 6.02 s",
    })
    const rescued = feedRow(record({ attempts: 2, via: "socket", agent: "slopmax" }), name, zone)
    expect(rescued.detail).toBe("ana@studio.dev · after failover · WebSocket")
    // Another machine's request says which machine sent it.
    expect(feedRow(record({ machine: "laptop", attempts: 2 }), name, zone).detail).toBe(
      "ana@studio.dev · from laptop · after failover",
    )
    expect(rescued.who).toBe("Warmup")
    const { account: _account, ...unplacedFields } = record({ status: 429, usage: Usage.zero })
    const unplaced = feedRow(LedgerRecord.cases.Request.make(unplacedFields), name, zone)
    expect(unplaced).toMatchObject({ failed: true, detail: "no account free", tokens: "—" })
    expect(secs(420)).toBe("420 ms")
    expect(secs(12_340)).toBe("12.3 s")
  })

  test("keeps the newest two hundred, newest first", () => {
    let feed = pushFeed([], record(), 0)
    for (let seq = 1; seq <= feedSize + 5; seq++) feed = pushFeed(feed, record(), seq)
    expect(feed.length).toBe(feedSize)
    expect(feed[0]?.seq).toBe(feedSize + 5)
  })
})

describe("notices a browser has shown", () => {
  test("each notice is told once per browser, and the browser remembers the newest two hundred", () => {
    const first = tell([], [notice("a", "2026-11-01T00:00:00Z"), notice("a", "2026-11-01T00:00:00Z"), notice("b")])
    expect(first.fresh.map((n) => n.key)).toEqual(["a", "b"])
    const again = tell(first.told, [notice("a", "2026-11-01T00:00:00Z"), notice("c")])
    expect(again.fresh.map((n) => n.key)).toEqual(["c"])
    const many = Array.from({ length: toldSize + 10 }, (_, i) => `x|${i}|`)
    expect(tell(many, [notice("d")]).told.length).toBe(toldSize)
  })
})

describe("toasts", () => {
  test("a toast clears itself after a few seconds; a failure stays until dismissed", () => {
    const shown = addToast(addToast([], "Pinned.", false, 0), "Could not pin.", true, 1_000)
    expect(visibleToasts(shown, 5_000).map((t) => t.text)).toEqual(["Pinned.", "Could not pin."])
    expect(visibleToasts(shown, 6_500).map((t) => t.text)).toEqual(["Could not pin."])
    expect(shown.every((toast) => showing(toast, 1_000))).toBe(true)
  })

  test("the same words are not shown twice, and the oldest give way past four", () => {
    let toasts = addToast([], "Copied.", false, 0)
    toasts = addToast(toasts, "Copied.", false, 10)
    expect(toasts.length).toBe(1)
    for (const text of ["a", "b", "c", "d"]) toasts = addToast(toasts, text, true, 20)
    expect(toasts.map((t) => t.text)).toEqual(["a", "b", "c", "d"])
  })
})

const never = (): never => {
  throw new Error("missing step")
}
