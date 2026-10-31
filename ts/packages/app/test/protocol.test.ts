import { describe, expect } from "bun:test"

import { it } from "@slopmax/test"
import { Result } from "effect"

import { Account, Config, doctor, history, pool, report, Tokens } from "@slopmax/core"

import { model } from "../src/host.ts"
import { Doctor, Proxy, type Snapshot, Step } from "../src/lib.ts"
import * as protocol from "../src/protocol.ts"

const ts = (secs: number): number => secs * 1_000

// Every action, once.
const ACTIONS: ReadonlyArray<protocol.Action> = [
  { _tag: "SignIn", provider: "claude" },
  { _tag: "AddKey", provider: "anthropic", key: "sk-ant-x" },
  { _tag: "AddEndpoint", url: "http://localhost:8080/v1/", dialect: "chat", models: ["local-*"], key: "" },
  { _tag: "AddEndpoint", url: "http://gw", dialect: "messages", models: [], key: "k", label: "gateway" },
  { _tag: "AddClientKey", name: "laptop", models: ["claude-*"] },
  { _tag: "RevokeKey", name: "laptop" },
  { _tag: "DismissNewKey" },
  { _tag: "CheckSetup" },
  { _tag: "Own", account: "claude0" },
  { _tag: "Paste", address: "http://localhost:1455/auth/callback?code=x" },
  { _tag: "CancelSignIn" },
  { _tag: "Import" },
  { _tag: "Pin", account: "claude0" },
  { _tag: "UnpinAll" },
  { _tag: "SetDisabled", account: "claude0", disabled: true },
  { _tag: "SetPriority", account: "claude0", priority: -2 },
  { _tag: "Rename", account: "claude0", label: "work" },
  { _tag: "Rename", account: "claude0" },
  { _tag: "Remove", account: "claude0" },
  { _tag: "ConnectAgent", agent: "codex" },
  { _tag: "DisconnectAgent", agent: "claude" },
  { _tag: "StartProxy" },
  { _tag: "StopProxy" },
  { _tag: "InstallService" },
  { _tag: "UninstallService" },
  { _tag: "Redeem", account: "codex0" },
  { _tag: "Set", setting: { _tag: "Strategy", value: "least-used" } },
  { _tag: "Set", setting: { _tag: "SessionTtlMins", value: 120 } },
  { _tag: "Set", setting: { _tag: "PollMins", value: 0 } },
  { _tag: "Set", setting: { _tag: "SessionAffinity", value: false } },
  { _tag: "Set", setting: { _tag: "RedeemExpiringCredits", value: false } },
  { _tag: "Set", setting: { _tag: "RedeemWhenExhausted", value: true } },
  { _tag: "Set", setting: { _tag: "WarmWindows", value: true } },
  { _tag: "Set", setting: { _tag: "PaidOverflow", value: true } },
  { _tag: "SetNotifications", on: false },
  { _tag: "Refresh" },
  { _tag: "LoadHistory", range: "month" },
  { _tag: "LoadToday" },
  { _tag: "OpenDashboard" },
  { _tag: "DismissNotice" },
  { _tag: "Window", shown: true },
]

/** A snapshot with something in every part. */
const busy = (): Snapshot => {
  const now = ts(100 * 86_400)
  const claude = Account.assignId({ ...Account.make("claude", Tokens.empty(), now), email: "a@x.dev", orgId: "a" })
  const codex = Account.assignId({
    ...Account.make("codex", Tokens.empty(), now),
    email: "c@x.dev",
    accountId: "c",
    link: { tool: "Codex", path: "/x" },
  })
  const state = (used: number, credits: boolean): pool.AccountState => ({
    ...pool.AccountState.empty(),
    limits: {
      windows: [
        { span: "5h", used, resetsAt: now + 3_600_000 },
        { span: "7d", used: 30, resetsAt: now + 3 * 86_400_000 },
        { span: "7d", model: "Fable", used: 100, resetsAt: now + 86_400_000 },
      ],
      observedAt: now,
    },
    lastUsed: now - 120_000,
    ...(credits
      ? { credits: { credits: [{ id: "x", expiresAt: now + 3_600_000, grantedAt: now }], listedAt: now } }
      : {}),
  })
  const built = report.build(
    [claude, codex],
    (id) => state(id === claude.id ? 95 : 40, id === codex.id),
    { claude: claude.id },
    new Map([[claude.id, 2]]),
    "reset-first",
    true,
    now,
  )
  const section = doctor.Section.make("Proxy")
  doctor.Section.add(section, "warn", "● `slopmax` is not running", "slopmax start")
  doctor.Section.add(section, "ok", "the key is set")
  return {
    proxy: Proxy.Running("0.3.0"),
    address: "http://127.0.0.1:7567",
    report: built,
    agents: [{ id: "codex", title: "Codex", wiring: { _tag: "Slopmax" } }],
    service: { installed: true, running: false, lingering: true },
    signIn: { provider: "codex", step: Step.DeviceCode("https://auth.example/device", "ABCD-1234"), notes: ["n"] },
    notice: { text: "Done.", error: false, shown: now },
    history: history.build([], "week", now - 7 * 86_400_000, now, {}, new Map()),
    today: undefined,
    redeeming: codex.id,
    config: {
      ...Config.default(),
      keys: [
        { name: "laptop", key: "sm-1", models: [] },
        { name: "ci", key: "sm-2", models: ["claude-*", "gpt-*"] },
      ],
    },
    notifications: false,
    newKey: { name: "ci", key: "sm-2" },
    doctor: Doctor.Done([section]),
  }
}

describe("protocol", () => {
  it("every request survives a line", () => {
    ACTIONS.forEach((action, id) => {
      const line = protocol.encodeRequest({ id, action })
      expect(line.includes("\n")).toBe(false)
      const back = protocol.decodeRequest(line)
      expect(back._tag).toBe("Success")
      if (back._tag === "Success") expect(back.success).toEqual({ id, action })
    })
  })

  it("lines that are not requests are refused, with why", () => {
    for (const line of [
      "",
      "{}",
      "[]",
      '{"id":1}',
      '{"id":1,"action":{"_tag":"Pin"}}',
      '{"id":"1","action":{"_tag":"Refresh"}}',
      '{"id":1.5,"action":{"_tag":"Refresh"}}',
      '{"id":1,"action":{"_tag":"SignIn","provider":"nobody"}}',
      '{"id":1,"action":{"_tag":"Set","setting":{"_tag":"PollMins","value":"5"}}}',
    ]) {
      const decoded = protocol.decodeRequest(line)
      expect(decoded._tag).toBe("Failure")
      if (decoded._tag === "Failure") expect(decoded.failure.length).toBeGreaterThan(0)
    }
  })

  it("a view of everything survives a line, worded for the window", () => {
    const snapshot = busy()
    const now = ts(100 * 86_400)
    const drawn = model(snapshot, now)
    const line = Result.getOrThrow(protocol.encodeEvent({ _tag: "View", view: drawn }))
    const back = protocol.decodeEvent(line)
    expect(back._tag).toBe("Success")
    if (back._tag !== "Success" || back.success._tag !== "View") throw new Error("not a view")
    const v = back.success.view
    expect(v.proxy).toMatchObject({ state: "running", version: "0.3.0", running: true })
    expect(v.proxy.panel.text).toBe(v.status?.headline ?? "")
    expect(v.menuBar).toBe("Claude 95% · ChatGPT 40%")
    expect(v.providers.map((p) => [p.provider, p.count])).toEqual([
      ["claude", 1],
      ["codex", 1],
    ])
    const claude = v.groups[0]
    const row = claude?.accounts[0]
    // A full window fades its account's others; a scoped one at 100% waits alone.
    expect(claude?.limits).toEqual(["5-hour", "Weekly", "Weekly · Fable"])
    expect(row?.faded).toEqual([true, true, false])
    expect(row?.status.text).toBe("● active · 2 sessions · pinned")
    expect(row?.menu[0]).toEqual({
      _tag: "Choice",
      key: "unpin",
      label: "Stop pinning",
      enabled: true,
      action: { _tag: "UnpinAll" },
    })
    expect(claude?.pinned).toBe(true)
    expect(claude?.across).toBe("Across 1 account, average of accounts")
    const codex = v.groups[1]?.accounts[0]
    expect(codex?.credits).toMatchObject({
      redeeming: true,
      canRedeem: true,
      redeem: { _tag: "Redeem", account: codex?.id },
    })
    expect(
      codex?.menu.some((m) => m._tag === "Choice" && m.key === "own" && m.label === "Refresh here instead of Codex"),
    ).toBe(true)
    expect(v.agents[0]).toEqual({
      id: "codex",
      title: "Codex",
      line: "Goes through slopmax",
      state: { text: "Connected", tone: "good" },
      button: { label: "Disconnect", action: { _tag: "DisconnectAgent", agent: "codex" } },
    })
    expect(v.login).toMatchObject({ on: true, available: true, action: { _tag: "UninstallService" } })
    expect(v.login.detail).toContain("not running now")
    expect(v.signIn).toMatchObject({ title: "Signing in to ChatGPT", code: "ABCD-1234", notes: "n" })
    expect(v.keys).toEqual([
      { name: "laptop", models: "Any model" },
      { name: "ci", models: "claude-*, gpt-*" },
    ])
    expect(v.doctor.findings).toEqual([
      { section: "Proxy", text: "Slopmax is not running", tone: "warn", fix: "slopmax start" },
      { text: "The key is set", tone: "good" },
    ])
    expect(v.settings.notifications).toBe(false)
    expect(v.ranges.map((r) => r.title)).toEqual(["Today", "7 days", "30 days"])
    expect(v.history?.range).toBe("week")
    // serde's number forms arrive as plain numbers.
    expect(JSON.stringify(v.history?.data)).not.toContain("rawJSON")
    expect(v.today).toBeUndefined()
  })

  it("an event the protocol does not take is refused, not thrown", () => {
    const encoded = protocol.encodeEvent({ _tag: "Done", id: 1.5 })
    expect(Result.isFailure(encoded)).toBe(true)
  })

  it("every event survives a line", () => {
    const events: ReadonlyArray<protocol.Event> = [
      { _tag: "Hello", protocol: protocol.VERSION, version: "0.3.0" },
      { _tag: "Notify", key: "reset:a:1", title: "Limit reset expiring", body: "A limit reset…" },
      { _tag: "Prompt", signIn: { title: "Signing in to Claude", detail: "Starting…", notes: "" } },
      { _tag: "Prompt" },
      { _tag: "Done", id: 3 },
      { _tag: "Done", id: 4, error: "the action stopped" },
      { _tag: "Rejected", error: "Expected …" },
      { _tag: "Fatal", message: "invalid config" },
    ]
    for (const event of events) {
      const back = protocol.decodeEvent(Result.getOrThrow(protocol.encodeEvent(event)))
      expect(back._tag).toBe("Success")
      if (back._tag === "Success") expect(back.success).toEqual(event)
    }
  })
})
