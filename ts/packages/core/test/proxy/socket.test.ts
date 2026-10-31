import { describe, expect, it } from "bun:test"

import { Timestamp } from "@slopmax/common"
import { json } from "@slopmax/wire"

import { newTurn, outgoing, refusal, routingModel } from "../../src/proxy/socket.ts"

const parse = (text: string): json.Json => json.parse(text) ?? null

describe("proxy/socket", () => {
  it("the_routing_hint_names_the_model", () => {
    const headers = new Headers()
    expect(routingModel(headers)).toBeUndefined()
    headers.set("x-codex-routing-hint", "model=gpt-6-sol;tier=priority")
    expect(routingModel(headers)).toBe("gpt-6-sol")
  })

  it("spent_accounts_close_the_socket_and_request_errors_pass", () => {
    const now = Timestamp.fromSecond(1_000) ?? 0
    const spent = parse(`{"type":"error","status":429,"error":{"type":"usage_limit_reached","resets_at":5000}}`)
    expect(refusal(spent, now)).toEqual({ _tag: "Exhausted", until: Timestamp.fromSecond(5_000), model: undefined })
    const busy = parse(`{"type":"response.failed","response":{"error":{"code":"server_is_overloaded"}}}`)
    expect(refusal(busy, now)).toEqual({ _tag: "Throttled", until: undefined })
    const request = parse(`{"type":"response.failed","response":{"error":{"code":"context_length_exceeded"}}}`)
    expect(refusal(request, now)).toBeUndefined()
  })

  it("moved_sockets_drop_old_account_state", () => {
    const turn = newTurn()
    const create = JSON.stringify({
      type: "response.create",
      model: "gpt-6-sol",
      previous_response_id: "resp_1",
      input: [{ type: "reasoning", summary: [], encrypted_content: "gAAA" }],
      client_metadata: { "x-codex-turn-state": "sticky", session_id: "s" },
    })
    const kept = outgoing(create, turn, false, 0)
    expect(kept).toBe(create)
    expect(turn.model).toBe("gpt-6-sol")
    const moved = JSON.parse(outgoing(create, turn, true, 0))
    expect(moved.previous_response_id).toBeUndefined()
    expect(moved.input[0].encrypted_content).toBeUndefined()
    expect(moved.client_metadata["x-codex-turn-state"]).toBeUndefined()
    expect(moved.client_metadata.session_id).toBe("s")
  })
})

describe("proxy/socket, beyond the Rust tests", () => {
  it("other turns and other messages pass untouched", () => {
    const turn = newTurn()
    expect(outgoing("not json", turn, true, 0)).toBe("not json")
    const other = `{"type":"response.cancel","previous_response_id":"r"}`
    expect(outgoing(other, turn, true, 0)).toBe(other)
    expect(turn.started).toBeUndefined()
    const clean = `{"type":"response.create","model":"m","input":[]}`
    expect(outgoing(clean, turn, true, 7)).toBe(clean)
    expect(turn.started).toBe(7)
  })

  it("every spent code closes; every busy code throttles", () => {
    for (const code of ["usage_limit_reached", "usage_limit_exceeded", "usage_not_included", "insufficient_quota"]) {
      expect(refusal(parse(`{"type":"error","error":{"code":"${code}"}}`), 0)?._tag).toBe("Exhausted")
    }
    for (const code of ["server_is_overloaded", "slow_down", "rate_limit_exceeded"]) {
      expect(refusal(parse(`{"type":"error","error":{"type":"${code}"}}`), 0)?._tag).toBe("Throttled")
    }
  })
})
