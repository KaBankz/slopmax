// The app's state and actions against the stub API: the report arriving on
// the event stream, every action's call and what it says, sign-in steps,
// a refused key, browser notifications, and the desktop's proxy states.
import { afterEach, describe, expect, test } from "bun:test"
import { Event, LedgerRecord, Notice, UpstreamFailed, Usage } from "@slopmax/domain"
import { ImportOutcome, ImportResult } from "@slopmax/domain/api"
import { OfflineView, ProxyState } from "@slopmax/domain/desktop"
import { DateTime, Effect, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ownerKeyAtom } from "../src/api.ts"
import {
  addAccount,
  changeAccount,
  changeSettings,
  enterKey,
  eventsAtom,
  feedAtom,
  importLogins,
  importText,
  keyRefusedAtom,
  liveAtom,
  makeKey,
  newKeyAtom,
  offlineAtom,
  pasteAddress,
  proxyAtom,
  redeem,
  refresh,
  reportAtom,
  shownReportAtom,
  signIn,
  signInAtom,
  toastsAtom,
} from "../src/atoms.ts"
import { type Harness, harness, until } from "./support/app.ts"
import { emptyReport, fixtureDoctor, ownerKey } from "./support/fixtures.ts"

let open: Harness | undefined
afterEach(async () => {
  await open?.close()
  open = undefined
})

/** A harness for the web dashboard, its stream watched and its first report in. */
const started = async (options: Parameters<typeof harness>[0] = {}) => {
  const h = harness({ stub: { key: ownerKey, ...options.stub }, host: { key: ownerKey, ...options.host } })
  open = h
  h.registry.mount(eventsAtom)
  await until(() => Option.isSome(h.registry.get(reportAtom)), "the first report")
  return h
}

const toasts = (h: Harness) => h.registry.get(toastsAtom).map((toast) => [toast.text, toast.error])

describe("the event stream", () => {
  test("brings the proxy's version and its report, and then each answered request", async () => {
    const h = await started()
    expect(h.registry.get(liveAtom)).toEqual({ _tag: "Running", version: "0.4.0" })
    expect(h.registry.get(proxyAtom)).toEqual({ _tag: "Running", version: "0.4.0" })
    const record = LedgerRecord.cases.Request.make({
      at: DateTime.nowUnsafe(),
      provider: "claude",
      status: 200,
      usage: Usage.zero,
      ms: 10,
      attempts: 1,
      via: "http",
    })
    h.stub.publish(Event.cases.Request.make({ record }))
    await until(() => h.registry.get(feedAtom).length === 1, "the request in the feed")
  })

  test("a report the proxy pushes replaces the one shown", async () => {
    const h = await started()
    h.stub.setReport(emptyReport(DateTime.nowUnsafe()))
    await until(() => Option.exists(h.registry.get(reportAtom), (r) => r.accounts.length === 0), "the new report")
  })

  test("says it is reconnecting when the stream drops, and is back a second later", async () => {
    const h = harness({ stub: { key: ownerKey }, host: { key: ownerKey } })
    open = h
    h.stub.failNext("events", new UpstreamFailed({ message: "the proxy went away" }))
    h.registry.mount(eventsAtom)
    await until(() => h.registry.get(liveAtom)._tag === "Reconnecting", "reconnecting")
    // The proxy serves the dashboard, so a dropped stream is a wait, never a stopped proxy.
    expect(h.registry.get(proxyAtom)._tag).toBe("Checking")
    await until(() => h.registry.get(liveAtom)._tag === "Running", "running again", 3_000)
  })

  test("a refused key is forgotten, so the dashboard asks for it again", async () => {
    const h = harness({ stub: { key: ownerKey }, host: { key: "sm-wrong" } })
    open = h
    h.registry.mount(eventsAtom)
    await until(() => Option.isNone(h.registry.get(ownerKeyAtom)), "the key forgotten")
    expect(Option.isNone(await Effect.runPromise(h.host.host.key))).toBe(true)
    // The gate says the key was refused, until another is given.
    expect(h.registry.get(keyRefusedAtom)).toBe(true)
    h.registry.set(enterKey, ownerKey)
    expect(h.registry.get(keyRefusedAtom)).toBe(false)
  })
})

describe("actions", () => {
  test("refresh reads usage again and says so", async () => {
    const h = await started()
    h.run(refresh, undefined)
    await until(() => toasts(h).length === 1, "the toast")
    expect(toasts(h)).toEqual([["Usage and limit resets read again.", false]])
    expect(h.stub.calls.map((call) => call.endpoint)).toContain("refresh")
  })

  test("account changes take the report they answer and say what they did", async () => {
    const h = await started()
    h.run(changeAccount, { _tag: "Pin", id: "claude-1a2b3c4d" })
    await until(() => toasts(h).length === 1, "the pin's toast")
    expect(toasts(h)[0]).toEqual(["New Claude sessions go to ana@studio.dev.", false])
    const pinned = Option.getOrUndefined(h.registry.get(reportAtom))?.accounts.find((a) => a.id === "claude-1a2b3c4d")
    expect(pinned?.pinned).toBe(true)
    h.run(changeAccount, { _tag: "Enable", id: "claude-5e6f7a8b", on: false })
    await until(() => toasts(h).length === 2, "the disable's toast")
    expect(toasts(h)[1]).toEqual(["ben@studio.dev disabled.", false])
    h.run(changeAccount, { _tag: "Priority", id: "claude-5e6f7a8b", priority: 3 })
    await until(() => toasts(h).length === 3, "the priority's toast")
    expect(toasts(h)[2]).toEqual(["ben@studio.dev is at priority 3.", false])
    expect(h.stub.calls.filter((c) => c.endpoint === "update").map((c) => c.payload)).toEqual([
      { disabled: true },
      { priority: 3 },
    ])
  })

  test("two changes made before the first is answered are both made, and both told", async () => {
    const h = await started({ stub: { latency: "150 millis" } })
    h.run(changeAccount, { _tag: "Enable", id: "claude-1a2b3c4d", on: false })
    h.run(changeAccount, { _tag: "Enable", id: "claude-5e6f7a8b", on: false })
    h.run(changeSettings, { websockets: false })
    h.run(changeSettings, { warmWindows: false })
    await until(() => toasts(h).length === 4, "four toasts")
    expect(toasts(h).map(([text]) => text)).toEqual(
      expect.arrayContaining(["ana@studio.dev disabled.", "ben@studio.dev disabled."]),
    )
    expect(h.stub.calls.filter((c) => c.endpoint === "update")).toHaveLength(2)
    expect(h.stub.calls.filter((c) => c.endpoint === "change").map((c) => c.payload)).toEqual(
      expect.arrayContaining([{ websockets: false }, { warmWindows: false }]),
    )
  })

  test("a failure says what went wrong, and stays until dismissed", async () => {
    const h = await started()
    h.stub.failNext("redeem", new UpstreamFailed({ message: "ChatGPT answered 503" }))
    h.run(redeem, { id: "codex-3a4b5c6d" })
    await until(() => toasts(h).length === 1, "the failure")
    expect(toasts(h)).toEqual([["Could not redeem a limit reset: ChatGPT answered 503", true]])
  })

  test("redeeming a limit reset says what it came to", async () => {
    const h = await started()
    h.run(redeem, { id: "codex-3a4b5c6d", reset: "rst_1" })
    await until(() => toasts(h).length === 1, "the outcome")
    expect(toasts(h)).toEqual([["Redeemed. ana@studio.dev's windows are reset.", false]])
    expect(h.stub.calls.find((c) => c.endpoint === "redeem")?.payload).toEqual({ reset: "rst_1" })
  })

  test("adding a key that is refused answers its error to the form, not as a toast", async () => {
    const h = await started()
    h.stub.failNext("add", new UpstreamFailed({ message: "the key was refused: 401 invalid x-api-key" }))
    h.registry.mount(addAccount)
    h.registry.set(addAccount, { _tag: "Key", provider: "anthropic", key: "sk-ant-bad" })
    await until(() => AsyncResult.isFailure(h.registry.get(addAccount)), "the refusal")
    expect(toasts(h)).toEqual([])
    h.registry.set(addAccount, { _tag: "Key", provider: "anthropic", key: "sk-ant-good", label: "Team" })
    await until(() => AsyncResult.isSuccess(h.registry.get(addAccount)), "the account")
    expect(toasts(h)).toEqual([["Team added.", false]])
  })

  test("a live setting is sent, and what it does now is said", async () => {
    const h = await started()
    h.run(changeSettings, { strategy: "fill-first" })
    await until(() => toasts(h).length === 1, "the toast")
    expect(toasts(h)).toEqual([["slopmax now routes fill first.", false]])
    expect(h.stub.calls.find((c) => c.endpoint === "change")?.payload).toEqual({ strategy: "fill-first" })
  })

  test("a client key is shown once when made", async () => {
    const h = await started()
    h.run(makeKey, { name: " phone ", models: ["gpt-*"] })
    await until(() => Option.isSome(h.registry.get(newKeyAtom)), "the new key")
    expect(String(Option.getOrUndefined(h.registry.get(newKeyAtom))?.name)).toBe("phone")
    expect(toasts(h)).toEqual([["Made the key phone.", false]])
  })

  test("importing says how many of the logins found were saved", async () => {
    const h = await started()
    h.run(importLogins, undefined)
    await until(() => toasts(h).length === 1, "the toast")
    expect(toasts(h)).toEqual([["Imported 1 account of 2 logins found.", false]])
  })

  test("counts of imported accounts agree with what was found", () => {
    const report = emptyReport(DateTime.nowUnsafe())
    const failed = ImportOutcome.cases.Failed.make({ source: "codex", origin: "~/.codex", message: "x" })
    expect(importText(new ImportResult({ outcomes: [], report }))).toBe("No logins found to import.")
    expect(importText(new ImportResult({ outcomes: [failed], report }))).toBe("Imported 0 accounts of 1 logins found.")
  })
})

describe("signing in", () => {
  test("opens the address it is given, shows each step, and says who was connected", async () => {
    const h = await started()
    h.run(signIn, { provider: "claude" })
    await until(() => Option.exists(h.registry.get(signInAtom), (s) => s.step._tag === "Authorize"), "the address")
    const step = Option.getOrUndefined(h.registry.get(signInAtom))?.step
    expect(step).toMatchObject({ _tag: "Authorize", opened: true })
    expect(h.host.recorded.opened[0]).toStartWith("https://claude.ai/oauth/authorize")
    h.run(pasteAddress, "http://localhost:54545/callback?code=c&state=s")
    await until(() => Option.isNone(h.registry.get(signInAtom)), "the end of the sign-in")
    expect(toasts(h)).toEqual([["Connected new@studio.dev.", false]])
  })

  test("a device code sign-in shows its code", async () => {
    const h = await started()
    h.run(signIn, { provider: "codex", device: true })
    await until(() => Option.exists(h.registry.get(signInAtom), (s) => s.step._tag === "DeviceCode"), "the code")
    expect(h.stub.calls.find((c) => c.endpoint === "login")?.payload).toEqual({
      provider: "codex",
      device: true,
      noBrowser: false,
    })
  })
})

describe("notifications in a browser", () => {
  test("each nudge is posted once, titled for its kind and without backticks", async () => {
    const h = await started({ host: { permission: "granted" } })
    await until(() => h.host.recorded.notified.length === 1, "the notification")
    expect(h.host.recorded.notified[0]).toMatchObject({ title: "Quota going unused" })
    expect(h.host.recorded.notified[0]?.body).not.toContain("`")
    // The same nudge again, in the next report, is not posted again.
    h.stub.setReport(h.stub.report())
    const notice = new Notice({
      kind: "exhausted",
      key: "x",
      message: "Every Claude account is limited.",
      at: DateTime.nowUnsafe(),
    })
    h.stub.publish(Event.cases.Notice.make({ notice }))
    await until(() => h.host.recorded.notified.length === 2, "the notice")
    expect(h.host.recorded.notified.map((n) => n.title)).toEqual(["Quota going unused", "Every account is limited"])
  })

  test("nothing is posted until the browser allows it", async () => {
    const h = await started({ host: { permission: "default" } })
    h.stub.setReport(h.stub.report())
    await Bun.sleep(50)
    expect(h.host.recorded.notified).toEqual([])
  })
})

describe("the desktop window", () => {
  test("follows the proxy's state as the main process tells it", async () => {
    const h = harness({ host: { kind: "desktop", proxy: ProxyState.cases.Starting.make({}) } })
    open = h
    h.registry.mount(proxyAtom)
    await until(() => h.registry.get(proxyAtom)._tag === "Starting", "starting")
    h.host.setProxy(ProxyState.cases.Running.make({ version: "0.4.0" }))
    await until(() => h.registry.get(proxyAtom)._tag === "Running", "running")
  })

  test("shows the report and doctor read from disk while the proxy is stopped", async () => {
    const report = emptyReport(DateTime.nowUnsafe())
    const h = harness({
      host: {
        kind: "desktop",
        proxy: ProxyState.cases.Stopped.make({}),
        offline: new OfflineView({ report, doctor: fixtureDoctor() }),
      },
    })
    open = h
    h.registry.mount(shownReportAtom)
    await until(() => Option.isSome(h.registry.get(shownReportAtom)), "the offline report")
    expect(AsyncResult.getOrElse(h.registry.get(offlineAtom), () => Option.none()).pipe(Option.isSome)).toBe(true)
  })
})
