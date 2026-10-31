import { describe, expect } from "bun:test"

import { it } from "@slopmax/test"
import { Effect, HashMap, Schema } from "effect"

import { SignedDuration, type Timestamp } from "@slopmax/common"

import { Account, type Pins, Tokens } from "../src/account.ts"
import { type Limits, Window } from "../src/limits.ts"
import {
  AccountState,
  DEFAULT_BLOCK,
  DEFAULT_THROTTLE,
  Inner,
  isUnmeasured,
  type Pick,
  Pool,
  Reason,
  State,
  StateSchema,
} from "../src/pool.ts"
import type { Credit } from "../src/provider/credits.ts"
import type { ProviderId } from "../src/provider/mod.ts"
// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "./support/fakes.ts"

const ts = (secs: number): Timestamp => secs * 1000

const account = (provider: ProviderId, org: string, added: number): Account =>
  Account.assignId({ ...Account.make(provider, Tokens.empty(), ts(added)), orgId: org, accountId: org })

const window = (span: string, used: number, resets: number | undefined): Window => ({
  span,
  used,
  ...(resets === undefined ? {} : { resetsAt: ts(resets) }),
})

const limits = (windows: ReadonlyArray<Window>): Limits => ({ windows, observedAt: ts(1000) })

const pool = (strategy: Parameters<typeof Pool.make>[0], accounts: ReadonlyArray<Account>) =>
  Effect.gen(function* () {
    const made = yield* Pool.make(strategy, SignedDuration.fromHours(1), State.empty())
    yield* made.sync(accounts, {})
    return made
  })

const request = (session: string | undefined, extra: Partial<Pick> = {}): Pick => ({
  provider: "claude",
  session,
  ...extra,
})

const sticky = (affinity: boolean | undefined) => request("s", { affinity })

const forModel = (model: string) => request(undefined, { model })

const hours = (h: number) => 1000 + h * 3600

const pick = (p: Pool, session: string | undefined, now: number) =>
  Effect.map(p.pick(request(session), ts(now)), (c) => c.account.id)

describe("pool", () => {
  it.effect("round_robin_takes_turns_within_the_top_tier", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const reserve = { ...account("claude", "c", 3), priority: -1 }
      const p = yield* pool("round-robin", [a, b, reserve])
      const turns: Array<string> = []
      for (let i = 0; i < 4; i++) turns.push(yield* pick(p, undefined, 1000))
      expect(turns).toEqual([a.id, b.id, a.id, b.id])
      // The reserve tier serves only once the top tier cannot.
      yield* p.block(a.id, ts(5000), undefined, "limit")
      yield* p.block(b.id, ts(5000), undefined, "limit")
      expect(yield* pick(p, undefined, 1000)).toBe(reserve.id)
    }),
  )

  it.effect("reset_windows_are_told_once_with_what_was_used", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const p = yield* pool("fill-first", [a])
      yield* p.observe(a.id, limits([window("7d", 70.0, 5_000), window("5h", 10.0, 9_000)]), ts(1000))
      expect(yield* p.takeLapses(ts(2_000))).toEqual([])
      // The week's time passes with no reading since.
      const lapsed = yield* p.takeLapses(ts(6_000))
      expect(lapsed.length).toBe(1)
      expect([lapsed[0]?.[1].span, lapsed[0]?.[1].used]).toEqual(["7d", 70.0])
      expect(yield* p.takeLapses(ts(6_500))).toEqual([])
      // A reading of the next 5-hour period shows that one ended too.
      yield* p.observe(a.id, limits([window("5h", 1.0, 30_000)]), ts(9_500))
      const next = yield* p.takeLapses(ts(9_500))
      expect(next.length).toBe(1)
      expect([next[0]?.[1].span, next[0]?.[1].used]).toEqual(["5h", 10.0])
    }),
  )

  it.effect("next_says_who_a_new_session_would_get_and_why", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("reset-first", [a, b])
      const next = () => p.next("claude", ts(1000))
      // Neither has a window running: the less used, as placement does.
      expect((yield* next())?.reason).toBe("most-room")
      yield* p.observe(b.id, limits([window("5h", 40.0, 1000 + 3600)]), ts(1000))
      expect(yield* next()).toEqual({ account: b.id, reason: "resets-soonest" })
      // Previewing changes nothing: the pick agrees.
      expect(yield* pick(p, "s", 1000)).toBe(b.id)
      yield* p.block(b.id, ts(5000), undefined, "limit")
      expect((yield* next())?.reason).toBe("only-ready")
      yield* p.sync([a, b], { claude: a.id })
      expect((yield* next())?.reason).toBe("pinned")
      yield* p.block(a.id, ts(5000), undefined, "limit")
      expect(yield* p.next("claude", ts(1000))).toBeUndefined()
      expect(yield* p.next("codex", ts(1000))).toBeUndefined()
    }),
  )

  it.effect("without_affinity_a_session_is_placed_afresh_but_its_move_is_known", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("round-robin", [a, b])
      yield* p.setRouting({ ...(yield* p.routing), affinity: false })
      const first = yield* p.pick(sticky(undefined), ts(1000))
      expect([first.account.id, first.movedFrom]).toEqual([a.id, undefined])
      // Placed afresh, on the next account, which must drop the first's state.
      const second = yield* p.pick(sticky(undefined), ts(1001))
      expect(second.account.id).toBe(b.id)
      expect(second.movedFrom).toBe(a.id)
      // The request may ask for affinity anyway.
      const third = yield* p.pick(sticky(true), ts(1002))
      expect([third.account.id, third.movedFrom]).toEqual([b.id, undefined])
    }),
  )

  it.effect("a_shorter_session_ttl_forgets_sessions_sooner", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("round-robin", [a, b])
      expect(yield* pick(p, "s", 1000)).toBe(a.id)
      yield* p.setRouting({ ...(yield* p.routing), sessionTtl: SignedDuration.fromMins(1) })
      // Within a minute the session keeps its account; after, it is new.
      expect(yield* pick(p, "s", 1030)).toBe(a.id)
      expect(yield* pick(p, "s", 1200)).toBe(b.id)
      expect((yield* p.sessionCounts(ts(1200))).size).toBe(1)
    }),
  )

  it.effect("reset_first_spends_the_window_that_expires_soonest", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const c = account("claude", "c", 3)
      const p = yield* pool("reset-first", [a, b, c])
      // a: idle. b: 5h window resets in 3h. c: weekly resets in 2 days.
      yield* p.observe(a.id, limits([window("5h", 0.0, undefined)]), ts(1000))
      yield* p.observe(b.id, limits([window("5h", 60.0, 1000 + 3 * 3600)]), ts(1000))
      yield* p.observe(c.id, limits([window("7d", 30.0, 1000 + 2 * 86_400)]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
    }),
  )

  it.effect("reset_first_saves_a_week_about_to_be_lost_before_any_5_hour_window", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("reset-first", [a, b])
      // a: busy, its 5-hour window resets in 4h, its week in 6 days.
      yield* p.observe(a.id, limits([window("5h", 10.0, hours(4)), window("7d", 50.0, hours(144))]), ts(1000))
      // b: no 5-hour window running, but 80% of a week lost in 10h.
      yield* p.observe(b.id, limits([window("7d", 20.0, hours(10))]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
      expect((yield* p.next("claude", ts(1000)))?.reason).toBe("week-ends-soonest")
      // A week two days out is no emergency: the 5-hour window goes first.
      yield* p.observe(b.id, limits([window("7d", 20.0, hours(48))]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(a.id)
      // A full week is nothing to save.
      yield* p.observe(b.id, limits([window("7d", 100.0, hours(10)), window("5h", 0.0, undefined)]), ts(1000))
      expect((yield* p.next("claude", ts(1000)))?.reason).not.toBe("week-ends-soonest")
    }),
  )

  it.effect("fill_first_drains_in_order", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("fill-first", [b, a])
      expect(yield* pick(p, undefined, 1000)).toBe(a.id)
      yield* p.block(a.id, ts(5000), undefined, "limit")
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
      // Returns after the reset.
      expect(yield* pick(p, undefined, 6000)).toBe(a.id)
    }),
  )

  it.effect("least_used_prefers_headroom_and_ranks_unknown_last", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const c = account("claude", "c", 3)
      const p = yield* pool("least-used", [a, b, c])
      yield* p.observe(a.id, limits([window("7d", 80.0, 9000)]), ts(1000))
      yield* p.observe(b.id, limits([window("7d", 20.0, 9000)]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
    }),
  )

  it.effect("sessions_stick_until_their_account_cannot_serve", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("least-used", [a, b])
      yield* p.observe(a.id, limits([window("7d", 10.0, 9000)]), ts(1000))
      yield* p.observe(b.id, limits([window("7d", 50.0, 9000)]), ts(1000))
      expect(yield* pick(p, "s1", 1000)).toBe(a.id)

      // a becomes the busier account, but the session stays put.
      yield* p.observe(a.id, limits([window("7d", 90.0, 9000)]), ts(1001))
      expect(yield* pick(p, "s1", 1002)).toBe(a.id)
      // New sessions place freshly.
      expect(yield* pick(p, "s2", 1002)).toBe(b.id)

      // Once a is refused, the session moves and reports where it came from.
      yield* p.block(a.id, ts(5000), undefined, "limit")
      const choice = yield* p.pick(request("s1"), ts(1003))
      expect(choice.account.id).toBe(b.id)
      // The move is reported, so account-bound state can be dropped up front.
      expect(choice.movedFrom).toBe(a.id)
    }),
  )

  it.effect("sessions_survive_a_restart", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const first = yield* pool("least-used", [a, b])
      yield* first.observe(a.id, limits([window("7d", 90.0, 9000)]), ts(1000))
      yield* first.observe(b.id, limits([window("7d", 10.0, 9000)]), ts(1000))
      expect(yield* pick(first, "s1", 1000)).toBe(b.id)

      const [state] = yield* first.snapshot(ts(1001))
      const text = JSON.stringify(Schema.encodeSync(StateSchema)(state))
      const restored = yield* Pool.make(
        "least-used",
        SignedDuration.fromHours(1_000_000),
        Schema.decodeUnknownSync(StateSchema)(JSON.parse(text)),
      )
      yield* restored.sync([a, b], {})
      // b is now the busier account, but the session stays on it.
      yield* restored.observe(b.id, limits([window("7d", 95.0, 9000)]), ts(1001))
      expect(yield* pick(restored, "s1", 1002)).toBe(b.id)
    }),
  )

  it.effect("moved_from_reports_a_session_leaving_its_account", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("fill-first", [a, b])
      expect(yield* pick(p, "s", 1000)).toBe(a.id)
      const choice = yield* p.pick(request("s", { exclude: [a.id] }), ts(1001))
      expect(choice.account.id).toBe(b.id)
      expect(choice.movedFrom).toBe(a.id)
    }),
  )

  it.effect("sessions_expire_after_ttl", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("fill-first", [a, b])
      yield* p.block(a.id, ts(1500), undefined, "limit")
      expect(yield* pick(p, "s", 1000)).toBe(b.id)
      // Within the TTL the session stays on b even though a is back.
      expect(yield* pick(p, "s", 2000)).toBe(b.id)
      // After an idle hour it is placed afresh.
      expect(yield* pick(p, "s", 2000 + 3601)).toBe(a.id)
    }),
  )

  it.effect("priority_tiers_and_pins_come_before_strategy", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = { ...account("claude", "b", 2), priority: 5 }
      const p = yield* pool("fill-first", [a, b])
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
      yield* p.sync([a, b], { claude: a.id })
      expect(yield* pick(p, undefined, 1000)).toBe(a.id)
    }),
  )

  it.effect("known_exhaustion_is_skipped_without_a_request", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("fill-first", [a, b])
      yield* p.observe(a.id, limits([window("5h", 100.0, 4000)]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
      expect(yield* pick(p, undefined, 4001)).toBe(a.id)
    }),
  )

  it.effect("unavailable_reports_the_earliest_return", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("fill-first", [a, b])
      yield* p.block(a.id, ts(9000), undefined, "limit")
      yield* p.block(b.id, ts(7000), undefined, "limit")
      const err = yield* Effect.flip(pick(p, undefined, 1000))
      expect(err.until).toBe(ts(7000))
    }),
  )

  it.effect("model_blocks_only_affect_that_model", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const p = yield* pool("fill-first", [a])
      yield* p.block(a.id, ts(9000), "claude-fable", "overage cap")
      expect(yield* Effect.isFailure(p.pick(forModel("claude-fable"), ts(1000)))).toBe(true)
      expect(yield* Effect.isSuccess(p.pick(forModel("claude-sonnet"), ts(1000)))).toBe(true)
    }),
  )

  it.effect("fresh_reading_lifts_a_block_early", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const p = yield* pool("fill-first", [a])
      yield* p.block(a.id, ts(90_000), undefined, "limit")
      expect(yield* Effect.isFailure(pick(p, undefined, 1000))).toBe(true)
      yield* p.observe(a.id, limits([window("7d", 40.0, 90_000)]), ts(1000))
      expect(yield* pick(p, undefined, 1000)).toBe(a.id)
    }),
  )

  it.effect("disabled_and_signed_out_accounts_are_skipped", () =>
    Effect.gen(function* () {
      const a = { ...account("claude", "a", 1), disabled: true }
      const b = { ...account("claude", "b", 2), authError: "revoked" }
      const p = yield* pool("fill-first", [a, b])
      const err = yield* Effect.flip(pick(p, undefined, 1000))
      expect(err.reason).toContain("disabled")
    }),
  )

  it.effect("blocks_on_tried_accounts_still_report_when_the_pool_frees_up", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const p = yield* pool("fill-first", [a])
      yield* p.block(a.id, ts(5000), undefined, "limit")
      const err = yield* Effect.flip(p.pick(request(undefined, { exclude: [a.id] }), ts(1000)))
      expect(err.until).toBe(ts(5000))
    }),
  )

  it.effect("credits_count_from_their_list_and_leave_it_when_redeemed", () =>
    Effect.gen(function* () {
      const a = account("codex", "a", 1)
      const p = yield* pool("fill-first", [a])
      const credit = (id: string, expires: number): Credit => ({ id, grantedAt: ts(0), expiresAt: ts(expires) })
      const counted: Limits = { ...limits([window("5h", 100.0, 4000)]), resetCredits: 2 }
      yield* p.observe(a.id, counted, ts(1000))
      // Before a list, the usage's count stands.
      expect(AccountState.creditsLeft(yield* p.state(a.id), ts(1000))).toBe(2)
      yield* p.recordCredits(a.id, [credit("soon", 2000), credit("later", 9000)], ts(1000))
      const state = yield* p.state(a.id)
      expect(AccountState.creditsLeft(state, ts(1000))).toBe(2)
      // One that has lapsed no longer counts.
      expect(AccountState.creditsLeft(state, ts(3000))).toBe(1)

      yield* p.recordReset(a.id, ts(1500), "soon")
      const after = yield* p.state(a.id)
      expect(AccountState.unexpiredCredits(after, ts(1500)).map((c) => c.id)).toEqual(["later"])
      // The list and the count agree still, so nothing asks for a new list.
      expect(after.limits.resetCredits).toBe(1)
      expect(after.credits?.counted).toBe(1)
      expect(after.limits.windows[0]?.used).toBe(0.0)
    }),
  )
})

describe("pool, beyond the Rust tests", () => {
  it("default_block_and_throttle", () => {
    expect(DEFAULT_BLOCK).toBe(SignedDuration.fromMins(5))
    expect(DEFAULT_THROTTLE).toBe(SignedDuration.fromSecs(30))
  })

  it("state_json_is_written_as_rust_writes_it", () => {
    const state: State = {
      accounts: {
        "claude-b": {
          ...AccountState.empty(),
          limits: { windows: [Window.make("5h", 40, ts(2000))], observedAt: ts(1000), resetCredits: 2 },
          blockedUntil: ts(3000),
          modelBlocks: [{ model: "claude-fable", until: ts(4000) }],
          lastError: "limit",
          credits: { credits: [{ id: "c1", expiresAt: ts(9000) }], listedAt: ts(1000) },
        },
        "claude-a": AccountState.empty(),
      },
      sessions: [{ provider: "claude", session: "s", account: "claude-a", lastUsed: ts(1000) }],
      agents: { claude: "claude-cli/2.1.0 (external, cli)" },
    }
    expect(JSON.stringify(Schema.encodeSync(StateSchema)(state))).toBe(
      '{"accounts":{"claude-b":{"limits":{"windows":[{"span":"5h","used":40.0,"resets_at":"1970-01-01T00:33:20Z"}],' +
        '"observed_at":"1970-01-01T00:16:40Z","reset_credits":2},"blocked_until":"1970-01-01T00:50:00Z",' +
        '"model_blocks":[{"model":"claude-fable","until":"1970-01-01T01:06:40Z"}],"last_error":"limit",' +
        '"usage":{"requests":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0},' +
        '"credits":{"credits":[{"id":"c1","expires_at":"1970-01-01T02:30:00Z"}],"listed_at":"1970-01-01T00:16:40Z"}},' +
        '"claude-a":{"limits":{},"usage":{"requests":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,' +
        '"cache_write_tokens":0}}},"sessions":[{"provider":"claude","session":"s","account":"claude-a",' +
        '"last_used":"1970-01-01T00:16:40Z"}],"agents":{"claude":"claude-cli/2.1.0 (external, cli)"}}',
    )
    // Every field has a default, so an empty file loads.
    expect(Schema.decodeUnknownSync(StateSchema)({})).toEqual(State.empty())
    expect(JSON.stringify(Schema.encodeSync(StateSchema)(State.empty()))).toBe('{"accounts":{}}')
  })

  it.effect("snapshots_keep_known_accounts_in_order_and_say_when_they_changed", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* Pool.make("fill-first", SignedDuration.fromHours(1), State.empty())
      // Before the first sync every account is unknown: all state is kept.
      yield* p.recordError("gone", "x")
      expect(Object.keys((yield* p.snapshot(ts(1)))[0].accounts)).toEqual(["gone"])
      yield* p.sync([b, a], {})
      yield* p.block(b.id, ts(10), "m", "cap")
      yield* p.recordError(a.id, "boom")
      const [state, dirty] = yield* p.snapshot(ts(20))
      expect(dirty).toBe(true)
      expect(Object.keys(state.accounts)).toEqual([a.id, b.id].toSorted())
      // An expired model block is dropped.
      expect(state.accounts[b.id]?.modelBlocks).toEqual([])
      expect((yield* p.snapshot(ts(20)))[1]).toBe(false)
    }),
  )

  it.effect("housekeeping_takes_no_turn_and_sync_releases_moved_pins", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const b = account("claude", "b", 2)
      const p = yield* pool("round-robin", [a, b])
      const house = request(undefined, { housekeeping: true })
      expect((yield* p.pick(house, ts(1000))).account.id).toBe(a.id)
      expect((yield* p.pick(house, ts(1000))).account.id).toBe(a.id)
      expect(yield* pick(p, "s", 1000)).toBe(a.id)
      expect(yield* pick(p, undefined, 1000)).toBe(b.id)
      // A changed pin releases the provider's sessions.
      yield* p.sync([a, b], { claude: b.id })
      expect((yield* p.sessionCounts(ts(1000))).size).toBe(0)
      // A removed account releases its sessions too.
      yield* p.sync([a, b], { claude: b.id })
      expect(yield* pick(p, "t", 1000)).toBe(b.id)
      yield* p.sync([a], { claude: b.id })
      expect((yield* p.sessionCounts(ts(1000))).size).toBe(0)
    }),
  )

  it.effect("no_accounts_says_how_to_connect_one_and_failures_say_why", () =>
    Effect.gen(function* () {
      const p = yield* pool("fill-first", [])
      const none = yield* Effect.flip(pick(p, undefined, 1000))
      expect(none.reason).toBe("no claude accounts connected; run `slopmax login claude`")
      expect(none.until).toBeUndefined()
      const a = account("claude", "a", 1)
      yield* p.sync([a], {})
      const tried = yield* Effect.flip(p.pick(request(undefined, { exclude: [a.id] }), ts(1000)))
      expect(tried.reason).toBe("every claude account failed this request")
      yield* p.block(a.id, ts(5000), undefined, "limit")
      expect((yield* Effect.flip(pick(p, undefined, 1000))).reason).toBe("every claude account is rate limited")
    }),
  )

  it.effect("blocks_only_extend_and_clearing_returns_the_models", () =>
    Effect.gen(function* () {
      const a = account("claude", "a", 1)
      const p = yield* pool("fill-first", [a])
      yield* p.block(a.id, ts(9000), undefined, "first")
      yield* p.block(a.id, ts(5000), undefined, "second")
      yield* p.block(a.id, ts(9000), "m", "cap")
      yield* p.block(a.id, ts(4000), "m", "cap")
      yield* p.throttle(a.id, ts(800))
      yield* p.throttle(a.id, ts(700))
      const state = yield* p.state(a.id)
      expect(state.blockedUntil).toBe(ts(9000))
      expect(state.modelBlocks).toEqual([{ model: "m", until: ts(9000) }])
      expect(state.throttledUntil).toBe(ts(800))
      expect(state.lastError).toBe("cap")
      expect(yield* p.clearBlocks(a.id)).toEqual(["m"])
      const cleared = yield* p.state(a.id)
      expect([cleared.blockedUntil, cleared.throttledUntil, cleared.modelBlocks]).toEqual([undefined, undefined, []])
      yield* p.recordSuccess(a.id, ts(1000))
      expect((yield* p.state(a.id)).lastError).toBeUndefined()
      expect((yield* p.state(a.id)).lastUsed).toBe(ts(1000))
    }),
  )

  it.effect("agents_seen_are_kept_and_mark_the_pool_changed_once", () =>
    Effect.gen(function* () {
      const p = yield* pool("fill-first", [])
      yield* p.snapshot(0)
      yield* p.sawAgent("claude", "claude-cli/2.1.0")
      expect(yield* p.agent("claude")).toBe("claude-cli/2.1.0")
      expect((yield* p.snapshot(0))[1]).toBe(true)
      yield* p.sawAgent("claude", "claude-cli/2.1.0")
      expect((yield* p.snapshot(0))[1]).toBe(false)
    }),
  )

  it("an_unmeasured_account_scores_last", () => {
    expect(isUnmeasured(AccountState.empty(), 0)).toBe(true)
    expect(isUnmeasured({ ...AccountState.empty(), limits: limits([window("5h", 10, undefined)]) }, 0)).toBe(false)
  })

  it("reasons_read_as_people_say_them", () => {
    expect(Reason.text("pinned")).toBe("pinned for new sessions")
    expect(Reason.text("next-in-turn")).toBe("next in turn")
  })

  it("inner_is_a_value_the_pool_changes_by_replacing", () => {
    const a = account("claude", "a", 1)
    const start = Inner.sync(Inner.make("fill-first", SignedDuration.fromHours(1), State.empty(), 0), [a], {} as Pins)
    const [result, after] = Inner.pick(start, request("s"), ts(1))
    expect(result._tag).toBe("Success")
    expect(HashMap.size(start.sessions)).toBe(0)
    expect(HashMap.size(after.sessions)).toBe(1)
  })
})
