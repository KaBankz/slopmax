import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Stream } from "effect"

import { body } from "@slopmax/net"
import { ir, translate } from "@slopmax/wire"

import { Replay, transcode, type Watch } from "../../src/proxy/transcode.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

const chunked = (chunks: ReadonlyArray<string>): Stream.Stream<Uint8Array> =>
  chunks.reduce<Stream.Stream<Uint8Array>>((all, c) => Stream.concat(all, Stream.make(bytes(c))), Stream.empty)

describe("proxy/transcode", () => {
  it.effect("chat_chunks_split_anywhere_become_messages_events", () =>
    Effect.gen(function* () {
      const upstream = chunked([
        'data: {"choices":[{"index":0,"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n',
        "\ndata: [DONE]\n\n",
      ])
      const seen: Array<ir.Event> = []
      const watch: Watch = (e) => void seen.push(e)
      const request = ir.Request.make()
      const out = transcode(
        upstream,
        false,
        translate.Decoder.make("chat", request),
        translate.Encoder.make("messages", "grok-4", false, 0),
        watch,
      )
      const text = new TextDecoder().decode(yield* body.read(out, Number.MAX_SAFE_INTEGER))
      expect(text).toContain(`"text":"Hello"`)
      expect(text).toContain("message_stop")
      expect(seen[0]).toEqual(ir.Event.Text("Hello"))
    }),
  )

  it("replay_is_per_account_and_bounded", () => {
    const replay = new Replay()
    replay.remember("call_1", "codex-a", "gAAA", 0)
    expect(replay.recall("call_1", "codex-a", 0)).toBe("gAAA")
    expect(replay.recall("call_1", "codex-b", 0)).toBeUndefined()
    for (let i = 0; i < Replay.MAX + 10; i++) replay.remember(`c${i}`, "codex-a", "", 0)
    expect(replay.size).toBeLessThanOrEqual(Replay.MAX)
    // The oldest went first.
    expect(replay.recall("call_1", "codex-a", 0)).toBeUndefined()
  })
})

describe("proxy/transcode, beyond the Rust tests", () => {
  it("replayed state lasts two hours, and remembering a call again keeps its place", () => {
    const replay = new Replay()
    replay.remember("a", "acct", "s1", 0)
    expect(replay.recall("a", "acct", 2 * 3600 * 1000 - 1)).toBe("s1")
    expect(replay.recall("a", "acct", 2 * 3600 * 1000)).toBeUndefined()
    for (let i = 1; i < Replay.MAX - 1; i++) replay.remember(`c${i}`, "acct", "", 0)
    // Remembered again, "a" keeps its place as the oldest.
    replay.remember("a", "acct", "s2", 0)
    replay.remember("new", "acct", "", 0)
    expect(replay.size).toBe(Replay.MAX)
    replay.remember("newer", "acct", "", 0)
    expect(replay.recall("a", "acct", 0)).toBeUndefined()
    expect(replay.recall("c1", "acct", 0)).toBe("")
  })

  it.effect("a broken upstream ends the answer as an error in the client's format", () =>
    Effect.gen(function* () {
      const upstream = Stream.concat(
        Stream.make(bytes('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n')),
        Stream.fail("connection reset"),
      )
      const request = ir.Request.make()
      const out = transcode(
        upstream,
        false,
        translate.Decoder.make("chat", request),
        translate.Encoder.make("messages", "grok-4", false, 0),
        () => {},
      )
      const text = new TextDecoder().decode(yield* body.read(out, Number.MAX_SAFE_INTEGER))
      expect(text).toContain(`"text":"Hi"`)
      expect(text).toContain("error")
    }),
  )
})
