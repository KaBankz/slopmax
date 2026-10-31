import { describe, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect, Result, Schema } from "effect"

import { SignedDuration, Timestamp } from "@slopmax/common"
import { Client } from "@slopmax/net"

import { Account, Tokens } from "../src/account.ts"
import { NotifySettings, parse } from "../src/config.ts"
import {
  DEFAULT_EVENTS,
  Event,
  EventSchema,
  type Kind,
  nudges,
  send,
  type Subject,
  wants,
  Watcher,
} from "../src/notify.ts"
import { AccountState } from "../src/pool.ts"
import type { ProviderId } from "../src/provider/mod.ts"
import { json, Mock, noEnv, Seen } from "../src/testkit.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"
import { tempDirs } from "./support/temp.ts"

const tempDir = tempDirs()

const account = (provider: ProviderId, email: string): Account =>
  Account.assignId({ ...Account.make(provider, Tokens.empty(), 0), email })

const limited = (until: Timestamp): AccountState => ({ ...AccountState.empty(), blockedUntil: until })

const credit = (id: string, expires: Timestamp) => ({ id, expiresAt: expires })

const kinds = (events: ReadonlyArray<Event>): Array<Kind> => events.map((e) => e.event)

describe("notify", () => {
  it("reports_each_change_once", () => {
    const now = Timestamp.fromSecond(1_800_000_000) ?? 0
    const later = Timestamp.add(now, SignedDuration.fromHours(2))
    const a = account("claude", "a@x.dev")
    const b = account("claude", "b@x.dev")
    const accounts = [a, b]
    const states = new Map<string, AccountState>()
    const watcher = new Watcher()
    const look = (list: ReadonlyArray<Account>) =>
      watcher.changes(list, (id) => states.get(id) ?? AccountState.empty(), now)

    // The first look takes stock, even of a limited account.
    states.set(a.id, limited(later))
    expect(look(accounts)).toEqual([])
    expect(look(accounts)).toEqual([])

    // The last ready account going down is one event for the provider.
    states.set(b.id, limited(later))
    const events = look(accounts)
    expect(kinds(events)).toEqual(["exhausted"])
    expect(events[0]?.until).toBe(later)
    expect(events[0]?.message.startsWith("Every Claude account")).toBe(true)
    expect(look(accounts)).toEqual([])

    // One coming back is both its own news and the provider's.
    states.delete(a.id)
    expect(kinds(look(accounts))).toEqual(["available", "recovered"])

    // A sign-out names the fix.
    const signedOut = { ...a, authError: "refresh token revoked" }
    const out = look([signedOut, b])
    expect(kinds(out)).toEqual(["signed-out", "exhausted"])
    expect(out[0]?.message).toContain("slopmax login claude")
  })

  it("disabled_accounts_are_ignored", () => {
    const now = Timestamp.fromSecond(1_800_000_000) ?? 0
    const a = account("codex", "a@x.dev")
    const off = { ...account("codex", "b@x.dev"), disabled: true }
    const watcher = new Watcher()
    expect(watcher.changes([a, off], () => AccountState.empty(), now)).toEqual([])
    const blocked = (id: string) =>
      id === a.id ? limited(Timestamp.add(now, SignedDuration.fromMins(5))) : AccountState.empty()
    expect(kinds(watcher.changes([a, off], blocked, now))).toEqual(["exhausted"])
  })

  it("settings_filter_events", () => {
    const settings = NotifySettings.default()
    expect(NotifySettings.isEnabled(settings)).toBe(false)
    expect(wants(settings, "exhausted") && !wants(settings, "limited")).toBe(true)
    const limitedOnly = { ...settings, events: ["limited" as const] }
    expect(wants(limitedOnly, "limited") && !wants(limitedOnly, "exhausted")).toBe(true)
    expect(wants(limitedOnly, "test")).toBe(true)
    const parsed = Result.getOrThrow(parse('[notify]\ncommand = "true"\nevents = ["signed-out"]'))
    expect(parsed.notify.events).toEqual(["signed-out"])
  })

  it.live("commands_get_the_event_in_variables", () =>
    Effect.gen(function* () {
      const dir = tempDir("notify")
      const out = join(dir, "out")
      const settings: NotifySettings = {
        ...NotifySettings.default(),
        command: `printf '%s|%s' "$SLOPMAX_EVENT" "$SLOPMAX_MESSAGE" > '${out}'`,
      }
      const http = yield* Client.builder().build().pipe(Effect.provide(noEnv))
      const event = Event.test(yield* Timestamp.now)
      yield* send(settings, http, event)
      expect(readFileSync(out, "utf8")).toBe("test|slopmax notifications are working.")

      const failing: NotifySettings = { ...NotifySettings.default(), command: "echo nope >&2; exit 3" }
      const error = yield* Effect.flip(send(failing, http, event))
      expect(error.message).toContain("nope")
    }),
  )

  it("nudges_name_lapsing_resets_and_spare_weeks_once_each", () => {
    const now = Timestamp.fromSecond(1_000_000) ?? 0
    const hours = (h: number) => Timestamp.add(now, SignedDuration.fromHours(h))
    const state: AccountState = {
      ...AccountState.empty(),
      credits: { credits: [credit("soon", hours(5)), credit("later", hours(72))], listedAt: now },
      limits: {
        windows: [
          { span: "5h", used: 0.0, resetsAt: hours(2) },
          { span: "7d", used: 40.0, resetsAt: hours(10) },
          { span: "7d", model: "Fable", used: 0.0, resetsAt: hours(10) },
        ],
        observedAt: now,
      },
    }
    const subject: Subject = {
      id: "claude-1",
      name: "work@x.dev",
      provider: "claude",
      plan: "max 20x",
      off: false,
      state,
    }
    const plans = {}
    const found = nudges([subject], false, plans, now)
    expect(found.map(([, e]) => e.event)).toEqual(["reset-expiring", "quota-unused"])
    const reset = found[0]?.[1]
    expect(reset?.message).toContain("slopmax redeem work@x.dev")
    expect(reset?.until).toBe(hours(5))
    // 60% of a $200 plan's week: about $28.
    const spare = found[1]?.[1].message
    expect(spare).toContain("60% of it unused, about $28 of its plan")
    const worth = found[1]?.[1].worth ?? 0
    expect(Math.abs(worth - ((200.0 * 12.0) / 52.0) * 0.6)).toBeLessThan(1e-9)

    // With auto-redeem on, slopmax spends the reset itself.
    expect(nudges([subject], true, plans, now).length).toBe(1)

    // Each is told once.
    const watcher = new Watcher()
    expect(watcher.newNudges(nudges([subject], false, plans, now)).length).toBe(2)
    expect(watcher.newNudges(nudges([subject], false, plans, now))).toEqual([])
    const restarted = Watcher.remembering(watcher.told())
    expect(restarted.newNudges(nudges([subject], false, plans, now))).toEqual([])

    // A week nearly spent, an account switched off, or a week far from its
    // reset is not worth a word.
    const spent: AccountState = {
      ...state,
      limits: {
        ...state.limits,
        windows: state.limits.windows.map((w, i) => (i === 1 ? { ...w, used: 90.0 } : w)),
      },
    }
    expect(nudges([{ ...subject, state: spent }], true, plans, now).length).toBe(0)
    expect(nudges([{ ...subject, off: true }], false, plans, now)).toEqual([])
    expect(nudges([subject], true, plans, Timestamp.sub(now, SignedDuration.fromHours(48)))).toEqual([])
  })
})

describe("notify, beyond the Rust tests", () => {
  it("events_are_written_with_rusts_keys_and_omissions", () => {
    const encode = Schema.encodeSync(EventSchema)
    expect(JSON.stringify(encode(Event.test(0)))).toBe(
      '{"event":"test","message":"slopmax notifications are working.","at":"1970-01-01T00:00:00Z"}',
    )
    const full: Event = {
      event: "quota-unused",
      provider: "claude",
      account: "a@x.dev",
      until: 1000,
      message: "m",
      at: 0,
      worth: 28,
    }
    expect(JSON.stringify(encode(full))).toBe(
      '{"event":"quota-unused","provider":"claude","account":"a@x.dev","until":"1970-01-01T00:00:01Z",' +
        '"message":"m","at":"1970-01-01T00:00:00Z","worth":28.0}',
    )
    expect(DEFAULT_EVENTS).toEqual(["exhausted", "recovered", "signed-out", "reset-expiring", "quota-unused"])
  })

  it("a_limited_account_says_when_it_is_back_unless_the_provider_is_exhausted", () => {
    const now = Timestamp.fromSecond(1_800_000_000) ?? 0
    const a = account("claude", "a@x.dev")
    const b = account("claude", "b@x.dev")
    const states = new Map<string, AccountState>()
    const watcher = new Watcher()
    const look = () => watcher.changes([a, b], (id) => states.get(id) ?? AccountState.empty(), now)
    look()
    states.set(a.id, limited(Timestamp.add(now, SignedDuration.fromMins(90))))
    const events = look()
    expect(kinds(events)).toEqual(["limited"])
    expect(events[0]?.message).toMatch(/^a@x\.dev hit a usage limit; back in 1h30m \(\d\d:\d\d\)\.$/)
    // A removed account is forgotten, so it comes back without news.
    watcher.changes([b], (id) => states.get(id) ?? AccountState.empty(), now)
    states.delete(a.id)
    expect(look()).toEqual([])
  })

  it.live("webhooks_get_the_event_with_text_and_content", () =>
    Effect.gen(function* () {
      const mock = yield* Mock.start((seen) =>
        Seen.route(seen) === "/hook" ? json(200, {}) : json(500, { error: "down" }),
      )
      const http = yield* Client.builder().plainHttp().build().pipe(Effect.provide(noEnv))
      const event = Event.test(0)
      yield* send({ ...NotifySettings.default(), webhook: `${mock.url}/hook` }, http, event)
      const body = Seen.text(
        mock.seenAt("/hook")[0] ?? { method: "", path: "", headers: new Headers(), body: new Uint8Array() },
      )
      expect(body).toBe(
        '{"event":"test","message":"slopmax notifications are working.","at":"1970-01-01T00:00:00Z",' +
          '"text":"slopmax notifications are working.","content":"slopmax notifications are working."}',
      )
      // Both the webhook and the command are tried; their failures are joined.
      const both: NotifySettings = { ...NotifySettings.default(), webhook: `${mock.url}/down`, command: "exit 4" }
      const error = yield* Effect.flip(send(both, http, event))
      expect(error.message).toBe("webhook: HTTP 500 Internal Server Error; command: exit status: 4: ")
      // An event nobody asked for is not sent.
      yield* send({ ...NotifySettings.default(), webhook: `${mock.url}/down` }, http, { ...event, event: "limited" })
    }),
  )
})
