import { describe, expect } from "bun:test"
import { AccountId } from "@slopmax/domain"
import { it } from "@slopmax/test"
import { DateTime, Duration, Option } from "effect"
import { common, pairStates, ReplayBook, restoreReasoning } from "../../src/index.ts"

const { Event } = common

const a = AccountId.make("codex-a")
const b = AccountId.make("codex-b")
const now = DateTime.makeUnsafe("2026-10-31T00:00:00Z")

describe("ReplayBook", () => {
  it("gives reasoning state back only to the account that issued it", () => {
    const book = ReplayBook.empty.remember("call_1", a, "gAAA", now)
    expect(book.recall("call_1", a, now)).toEqual(Option.some("gAAA"))
    expect(book.recall("call_1", b, now)).toEqual(Option.none())
    expect(book.recall("call_2", a, now)).toEqual(Option.none())
    expect(ReplayBook.empty.size).toBe(0)
  })

  it("holds at most 4096 calls, the first remembered going first", () => {
    let book = ReplayBook.empty.remember("call_1", a, "gAAA", now)
    for (let i = 0; i < ReplayBook.max + 10; i++) book = book.remember(`c${i}`, a, "", now)
    expect(book.size).toBe(ReplayBook.max)
    expect(book.recall("call_1", a, now)).toEqual(Option.none())
    expect(book.recall("c9", a, now)).toEqual(Option.none())
    expect(book.recall("c10", a, now)).toEqual(Option.some(""))
    expect(book.recall(`c${ReplayBook.max + 9}`, a, now)).toEqual(Option.some(""))
  })

  it("keeps a call's place when it is remembered again, with the newer state", () => {
    let book = ReplayBook.empty.remember("first", a, "old", now)
    for (let i = 1; i < ReplayBook.max; i++) book = book.remember(`c${i}`, a, "", now)
    book = book.remember("first", b, "new", now)
    expect(book.size).toBe(ReplayBook.max)
    expect(book.recall("first", b, now)).toEqual(Option.some("new"))
    // One more new call still pushes out the oldest: the one remembered first, again or not.
    book = book.remember("last", a, "", now)
    expect(book.recall("first", b, now)).toEqual(Option.none())
    expect(book.recall("c1", a, now)).toEqual(Option.some(""))
  })

  it("forgets state two hours after it was remembered", () => {
    const book = ReplayBook.empty.remember("call_1", a, "gAAA", now)
    const later = (millis: number) => DateTime.addDuration(now, Duration.millis(millis))
    expect(book.recall("call_1", a, later(Duration.toMillis(ReplayBook.ttl) - 1))).toEqual(Option.some("gAAA"))
    expect(book.recall("call_1", a, later(Duration.toMillis(ReplayBook.ttl)))).toEqual(Option.none())
  })

  it("is a value: remembering leaves the book it started from as it was", () => {
    const empty = ReplayBook.empty
    const one = empty.remember("c", a, "s", now)
    expect(empty.recall("c", a, now)).toEqual(Option.none())
    expect(one.recall("c", a, now)).toEqual(Option.some("s"))
  })
})

const call = (id: string) => Event.Call({ call: { id, name: "f", input: "{}", kind: "function" } })

describe("pairStates", () => {
  it("hands over each reasoning state with the call that followed it, once", () => {
    const pairs: Array<readonly [string, string]> = []
    const watch = pairStates((callId, state) => pairs.push([callId, state]))
    for (const event of [
      call("before"),
      Event.State({ state: "s1" }),
      Event.Text({ text: "x" }),
      call("c1"),
      call("c2"),
      Event.State({ state: "s2" }),
      Event.State({ state: "s3" }),
      call("c3"),
    ]) {
      watch(event)
    }
    expect(pairs).toEqual([
      ["c1", "s1"],
      ["c3", "s3"],
    ])
  })
})

describe("restoreReasoning", () => {
  it("puts remembered state back before the first call of each turn it led to", () => {
    const request: common.Request = {
      ...common.emptyRequest("m"),
      messages: [
        { role: "user", parts: [{ _tag: "Text", text: "go" }] },
        {
          role: "assistant",
          parts: [
            { _tag: "Text", text: "Running." },
            { _tag: "Call", id: "c1", name: "f", input: "{}", kind: "function" },
            { _tag: "Call", id: "c2", name: "f", input: "{}", kind: "function" },
          ],
        },
        { role: "assistant", parts: [{ _tag: "Call", id: "forgotten", name: "f", input: "{}", kind: "function" }] },
      ],
    }
    const book = ReplayBook.empty.remember("c1", a, "gAAA", now).remember("c2", a, "gBBB", now)
    const restored = restoreReasoning(request, (callId) => book.recall(callId, a, now))
    expect(restored.messages[1]?.parts.map((part) => part._tag)).toEqual(["Text", "Reasoning", "Call", "Call"])
    expect(restored.messages[1]?.parts[1]).toEqual({ _tag: "Reasoning", text: "", opaque: "gAAA" })
    expect(restored.messages[2]).toBe(request.messages[2])
    expect(restoreReasoning(request, () => Option.none())).toBe(request)
  })
})
