// `_tag` is how sum types are told apart here (CONVENTIONS.md).
/* oxlint-disable no-underscore-dangle */
import { describe, expect, it } from "bun:test"
import type { HttpServerResponse } from "effect/http"

import { Timestamp } from "@slopmax/common"
import { ir } from "@slopmax/wire"

// Loads the provider registry, which accounts ask for their identity.
// oxlint-disable-next-line import/no-unassigned-import
import "../../src/provider/registry.ts"
import { Unavailable } from "../../src/pool.ts"
import { outcomeDebug } from "../../src/proxy/app.ts"
import { modelsNamed, restoreReasoning, retold, sooner } from "../../src/proxy/forward.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/** The status and JSON body of a buffered reply. */
const read = (response: HttpServerResponse.HttpServerResponse): readonly [number, Record<string, unknown>] => {
  const body = response.body
  if (body._tag !== "Uint8Array") throw new Error(`not a buffered body: ${body._tag}`)
  return [response.status, JSON.parse(new TextDecoder().decode(body.body))]
}

/** The message an error reply carries, whatever its format. */
const message = (body: Record<string, unknown>): string => {
  const error = body.error as { message: string }
  return error.message
}

const at = (s: number): Timestamp => Timestamp.fromSecond(s) ?? 0
const none = (until: Timestamp | undefined, reason: string): Unavailable => new Unavailable({ until, reason })
const call = (id: string): ir.Part => ir.Part.Call({ id, name: "Bash", input: "{}", kind: "Function" })

describe("proxy/forward", () => {
  it("upstream_errors_are_retold_with_their_message", () => {
    const bodies = [
      `{"error":{"message":"from error.message"}}`,
      `{"response":{"error":{"message":"from response.error"}}}`,
      `{"error":"a bare error string"}`,
      `{"detail":"a detail"}`,
      `{"message":"a message"}`,
    ]
    const expected = ["from error.message", "from response.error", "a bare error string", "a detail", "a message"]
    bodies.forEach((body, i) => {
      const [status, reply] = read(retold("chat", 400, bytes(body)))
      expect(status).toBe(400)
      expect(message(reply)).toBe(expected[i] ?? "")
    })
  })

  it("a_failure_event_inside_a_stream_is_found", () => {
    const stream =
      'data: {"type":"response.created"}\n\n' +
      'data: {"type":"response.failed","response":{"error":{"message":"overloaded now"}}}\n\n'
    const [status, reply] = read(retold("chat", 200, bytes(stream)))
    expect(status).toBe(200)
    expect(message(reply)).toBe("overloaded now")
  })

  it("unreadable_errors_pass_their_first_500_bytes", () => {
    const [, reply] = read(retold("chat", 502, bytes("x".repeat(800))))
    expect(message(reply).length).toBe(500)
  })

  it("claude_code_hears_server_errors_as_overloaded", () => {
    const body = bytes(`{"error":{"message":"upstream broke"}}`)
    const [status, reply] = read(retold("messages", 502, body))
    expect(status).toBe(529)
    expect((reply.error as { type: string }).type).toBe("overloaded_error")
    expect(message(reply)).toBe("upstream broke")
    // Other formats keep the status, as do client errors.
    expect(read(retold("chat", 502, body))[0]).toBe(502)
    expect(read(retold("messages", 404, body))[0]).toBe(404)
  })

  it("the_earliest_return_wins_across_steps", () => {
    const first = sooner(undefined, none(at(500), "first"))
    expect(first.until).toBe(at(500))
    const both = sooner(first, none(at(300), "second"))
    expect(both.until).toBe(at(300))
    // The first step's reason is kept.
    expect(both.reason).toBe("first")
    expect(sooner(none(undefined, "a"), none(at(9), "b")).until).toBe(at(9))
    expect(sooner(first, none(undefined, "b")).until).toBe(at(500))
  })
})

describe("proxy/forward, beyond the Rust tests", () => {
  it("a body naming its model twice is told apart, escaped keys included", () => {
    expect(modelsNamed(bytes(`{"model":"a","input":[]}`))).toBe(1)
    expect(modelsNamed(bytes(`{"model":"a","model":"b"}`))).toBe(2)
    expect(modelsNamed(bytes(`{"model":"a","mod\\u0065l":"b"}`))).toBe(2)
    expect(modelsNamed(bytes(`{"input":{"model":"x"}}`))).toBe(0)
    expect(modelsNamed(bytes(`[1]`))).toBe(0)
  })

  it("reasoning state goes back before the first call it led to", () => {
    const request = ir.Request.make({
      messages: [
        { role: "Assistant", parts: [ir.Part.Text("hi"), call("call_1"), call("call_2")] },
        { role: "Assistant", parts: [call("call_9")] },
      ],
    })
    const restored = restoreReasoning(request, (id) => (id === "call_1" ? "enc-1" : undefined))
    expect(restored.messages[0]?.parts.map((p) => p._tag)).toEqual(["Text", "Reasoning", "Call", "Call"])
    expect(restored.messages[0]?.parts[1]).toEqual(ir.Part.Reasoning({ text: "", opaque: "enc-1" }))
    expect(restored.messages[1]?.parts.map((p) => p._tag)).toEqual(["Call"])
    expect(restoreReasoning(request, () => undefined)).toBe(request)
  })

  it("redemption outcomes are logged by their Rust names", () => {
    expect(outcomeDebug("reset")).toBe("Reset")
    expect(outcomeDebug("nothing_to_reset")).toBe("NothingToReset")
  })
})
