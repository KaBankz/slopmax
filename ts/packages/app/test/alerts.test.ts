import { describe, expect } from "bun:test"
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { it } from "@slopmax/test"
import { Effect } from "effect"

import { ids, type notify, time } from "@slopmax/core"

import { Alert, title, Told } from "../src/alerts.ts"

type Timestamp = time.Timestamp
const { SignedDuration, Timestamp } = time

const event = (kind: notify.Kind, until: Timestamp): notify.Event => ({
  event: kind,
  provider: "codex",
  account: "codex0",
  until,
  message: "A limit reset on codex0 expires; redeem it with `slopmax redeem codex0`.",
  at: until,
})

const second = (secs: number): Timestamp => Timestamp.fromSecond(secs) ?? 0

// A directory of its own under the system's temporary directory, removed after.
const scratch = (name: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = join(tmpdir(), `slopmax-${name}-${process.pid}-${ids.token()}`)
      mkdirSync(dir, { recursive: true })
      return dir
    }),
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

describe("alerts", () => {
  it("a_nudge_is_told_once", () => {
    const now = second(1_000_000)
    const later = Timestamp.add(now, SignedDuration.fromHours(18))
    const found = (): Array<notify.Nudge> => [["reset:a:1", event("reset-expiring", later)]]

    let [told, changed, fresh] = Told.fresh(Told.default(), found(), now)
    expect(changed).toBe(true)
    expect(fresh.length).toBe(1)
    // The next look finds the same nudge: nothing to tell or save.
    ;[told, changed, fresh] = Told.fresh(told, found(), Timestamp.add(now, SignedDuration.fromSecs(2)))
    expect(!changed && fresh.length === 0).toBe(true)

    // Another nudge is told beside it.
    const more = [...found(), ["unused:b:7d:9", event("quota-unused", later)] as const]
    ;[, , fresh] = Told.fresh(told, more, now)
    expect(fresh.length).toBe(1)
    expect(fresh[0]?.[0]).toBe("unused:b:7d:9")
    expect(fresh[0]?.[1].event).toBe("quota-unused")
  })

  it.live("what_was_told_outlasts_a_restart_until_its_moment_passes", () =>
    Effect.gen(function* () {
      const now = second(1_000_000)
      const later = Timestamp.add(now, SignedDuration.fromHours(18))
      const path = join(yield* scratch("told"), "told")

      let [told] = Told.fresh(Told.default(), [["reset:a:1", event("reset-expiring", later)]], now)
      told = { ...told, enabled: false }
      yield* Told.save(told, path)

      const again = yield* Told.load(path)
      expect(again).toEqual(told)
      const [still, , fresh] = Told.fresh(again, [["reset:a:1", event("reset-expiring", later)]], now)
      // Told before the restart.
      expect(fresh).toEqual([])

      // Once it has passed, it is forgotten, and saved so.
      const [after, changed, none] = Told.fresh(still, [], Timestamp.add(later, SignedDuration.fromSecs(1)))
      expect(changed && none.length === 0).toBe(true)
      expect(after.keys.size).toBe(0)
    }),
  )

  it.live("a_missing_or_broken_file_starts_afresh_with_notifications_on", () =>
    Effect.gen(function* () {
      const missing = yield* Told.load("/nonexistent/slopmax/told")
      expect(missing.enabled && missing.keys.size === 0).toBe(true)
      const path = join(yield* scratch("broken"), "told")
      writeFileSync(path, "garbage\nkey\tnot a time\n")
      const broken = yield* Told.load(path)
      expect(broken.enabled && broken.keys.size === 0).toBe(true)
    }),
  )

  it("a_notification_reads_plainly", () => {
    const now = second(1_000_000)
    const reset = event("reset-expiring", now)
    expect(title(reset.event)).toBe("Limit reset expiring")
    expect(title("quota-unused")).toBe("Quota going unused")
    const alert = Alert.of("reset:a:1", reset)
    expect(alert.key).toBe("reset:a:1")
    expect(alert.title).toBe("Limit reset expiring")
    expect(alert.body).toBe("A limit reset on codex0 expires; redeem it with slopmax redeem codex0.")
  })
})

describe("alerts, beyond the Rust tests", () => {
  it.live("the told file is one line of whether, then a key and a second per line, owner-only", () =>
    Effect.gen(function* () {
      const path = join(yield* scratch("format"), "desktop-notified")
      const keys = new Map([
        ["unused:b", second(2_000)],
        ["reset:a", second(1_000)],
      ])
      yield* Told.save({ enabled: true, keys }, path)
      expect(readFileSync(path, "utf8")).toBe("enabled = true\nreset:a\t1000\nunused:b\t2000\n")
      expect(statSync(path).mode & 0o777).toBe(0o600)
      // Only exactly `false` turns them off; CRLF endings and stray lines read.
      writeFileSync(path, "enabled = no\r\nk\t+5\r\nbare\n")
      const read = yield* Told.load(path)
      expect(read.enabled).toBe(true)
      expect([...read.keys]).toEqual([["k", second(5)]])
    }),
  )

  it("every kind has a title", () => {
    const kinds: ReadonlyArray<readonly [notify.Kind, string]> = [
      ["exhausted", "Every account is limited"],
      ["recovered", "Accounts are back"],
      ["signed-out", "Sign in again"],
      ["limited", "Account limited"],
      ["available", "Account available"],
      ["test", "slopmax"],
    ]
    for (const [kind, said] of kinds) expect(title(kind)).toBe(said)
  })

  it("a nudge without a moment is remembered until now", () => {
    const now = second(1_000)
    const [told] = Told.fresh(Told.default(), [["k", { event: "quota-unused", message: "m", at: now }]], now)
    expect(told.keys.get("k")).toBe(now)
  })
})
