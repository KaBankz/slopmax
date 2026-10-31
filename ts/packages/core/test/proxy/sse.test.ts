import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Stream } from "effect"

import { Outcome } from "@slopmax/wire"

import { Tap, tapped } from "../../src/proxy/sse.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe("proxy/sse", () => {
  it("claude_usage_merges_start_and_delta", () => {
    const tap = Tap.make("messages")
    const stream =
      "event: message_start\n" +
      `data: {"type":"message_start","message":{"usage":{"input_tokens":2095,"cache_creation_input_tokens":7185,"cache_read_input_tokens":355598,"output_tokens":1}}}` +
      "\n\nevent: content_block_delta\n" +
      `data: {"type":"content_block_delta","delta":{"text":"hi"}}` +
      "\n\nevent: message_delta\n" +
      `data: {"type":"message_delta","usage":{"output_tokens":15}}` +
      "\n\n"
    // Split mid-line to exercise buffering.
    const all = bytes(stream)
    tap.feed(all.subarray(0, 70))
    tap.feed(all.subarray(70))
    const outcome = tap.finish()
    expect(outcome.usage).toEqual({
      requests: 1,
      inputTokens: 2095,
      outputTokens: 15,
      cacheReadTokens: 355_598,
      cacheWriteTokens: 7185,
    })
    expect(outcome.exhausted).toBe(false)
  })

  it("codex_usage_separates_cached_input", () => {
    const tap = Tap.make("responses")
    tap.feed(
      bytes(
        `data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":25},"output_tokens":40,"total_tokens":140}}}`,
      ),
    )
    tap.feed(bytes("\n\n"))
    const usage = tap.finish().usage
    expect([usage.inputTokens, usage.cacheReadTokens, usage.outputTokens]).toEqual([75, 25, 40])
  })

  it("whole_json_responses_report_usage", () => {
    const headers = new Headers({ "content-type": "application/json" })
    let tap = Tap.forResponse("messages", headers)
    tap.feed(bytes(`{"type":"message","content":[],"usage":{"input_tokens":12,`))
    tap.feed(bytes(`"output_tokens":3,"cache_read_input_tokens":40}}`))
    let usage = tap.finish().usage
    expect([usage.inputTokens, usage.outputTokens, usage.cacheReadTokens]).toEqual([12, 3, 40])

    tap = Tap.forResponse("responses", headers)
    tap.feed(
      bytes(
        `{"object":"response","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":20},"output_tokens":5}}`,
      ),
    )
    usage = tap.finish().usage
    expect([usage.inputTokens, usage.cacheReadTokens, usage.outputTokens]).toEqual([30, 20, 5])

    headers.set("content-encoding", "gzip")
    tap = Tap.forResponse("messages", headers)
    tap.feed(Uint8Array.of(0x1f, 0x8b))
    expect(tap.finish().usage.requests).toBe(1)
  })

  it("codex_in_stream_usage_limit_is_exhaustion", () => {
    const tap = Tap.make("responses")
    tap.feed(bytes(`data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n`))
    expect(tap.finish().exhausted).toBe(true)
  })

  it.effect("tapped_stream_reports_once_even_when_dropped", () =>
    Effect.gen(function* () {
      const seen: Array<Outcome> = []
      const chunks = Stream.concat(
        Stream.make(bytes(`data: {"type":"message_delta","usage":{"output_tokens":3}}\n`)),
        Stream.make(bytes("data: tail\n")),
      )
      const body = yield* tapped(chunks, Tap.make("messages"), (outcome, first) =>
        Effect.sync(() => {
          expect(first).toBeDefined()
          seen.push(outcome)
        }),
      )
      const first = yield* Stream.runHead(body)
      expect(first._tag).toBe("Some")
      expect(seen.length).toBe(1)
      expect(seen[0]?.usage.outputTokens).toBe(3)
    }),
  )
})

describe("proxy/sse, beyond the Rust tests", () => {
  it.effect("a tapped stream reports once: at its end, when it fails, or when it was never read", () =>
    Effect.gen(function* () {
      const seen: Array<Outcome> = []
      const done = (outcome: Outcome) => Effect.sync(() => void seen.push(outcome))
      yield* Stream.runDrain(yield* tapped(Stream.make(bytes("data: {}\n")), Tap.make("messages"), done))
      expect(seen.length).toBe(1)
      const failing = Stream.concat(Stream.make(bytes("x")), Stream.fail("broken"))
      yield* Effect.flip(Stream.runDrain(yield* tapped(failing, Tap.make("messages"), done)))
      expect(seen.length).toBe(2)
      // A body never read reports when its scope closes, and only then.
      yield* Effect.scoped(Effect.asVoid(tapped(Stream.make(bytes("x")), Tap.make("messages"), done)))
      expect(seen.length).toBe(3)
    }),
  )

  it("only data lines that mention usage, errors, or failure are parsed; overlong lines are skipped", () => {
    const tap = Tap.make("messages")
    // Not parsed: it names none of the three, though it holds usage-shaped JSON.
    tap.feed(bytes(`data: {"type":"message_delta","x":{"output_tokens":9}}\n`))
    tap.feed(bytes(`data: {"type":"message_delta","usage":{"output_tokens":2}}\n`))
    // A line buffered across chunks past 16 MiB is skipped whole.
    tap.feed(bytes(`data: {"type":"message_delta","usage":{"output_tokens":5},"pad":"${"x".repeat(16 * 1024 * 1024)}`))
    tap.feed(bytes(`"}\n`))
    expect(tap.finish().usage.outputTokens).toBe(2)
  })
})
