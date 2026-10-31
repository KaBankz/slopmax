import { describe, expect, it } from "bun:test"

import {
  clientVersion,
  rejectsAccountState,
  reportsUsageLimit,
  stripAccountState,
  upstreamHeaders,
} from "../../../src/provider/codex/wire.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (b: Uint8Array | undefined): string => (b === undefined ? "" : new TextDecoder().decode(b))

describe("provider/codex/wire", () => {
  it("upstream_headers_swap_credentials_and_add_version", () => {
    const client = new Headers({
      authorization: "Bearer sm-local",
      "user-agent": "codex_exec/0.159.3 (Amazon Linux; x86_64) unknown (codex_exec; 0.159.3)",
      "x-codex-turn-state": "sticky",
      "session-id": "s",
      host: "127.0.0.1:7567",
    })
    const out = upstreamHeaders(client, "tok", "ws-1", true)
    expect(out.get("authorization")).toBe("Bearer tok")
    expect(out.get("chatgpt-account-id")).toBe("ws-1")
    expect(out.get("version")).toBe("0.159.3")
    expect(out.get("session-id")).toBe("s")
    expect(out.has("x-codex-turn-state")).toBe(false)
    expect(out.has("host")).toBe(false)
    expect(out.get("accept-encoding")).toBe("identity")
  })

  it("strips_encrypted_reasoning_but_keeps_summaries", () => {
    const body = bytes(
      '{"model":"m","input":[{"type":"reasoning","summary":[{"type":"summary_text","text":"s"}],"encrypted_content":"gAAA"},{"type":"message","role":"user","content":[]}],"stream":true}',
    )
    const out = JSON.parse(text(stripAccountState(body))) as {
      input: Array<Record<string, unknown> & { summary?: Array<{ text: string }> }>
    }
    expect(out.input[0]?.encrypted_content).toBeUndefined()
    expect(out.input[0]?.summary?.[0]?.text).toBe("s")
    // Key order is preserved for the backend's routing fields.
    expect(Object.keys(out)).toEqual(["model", "input", "stream"])
    expect(stripAccountState(bytes('{"input":[]}'))).toBeUndefined()
  })

  it("recognizes_account_state_rejections", () => {
    expect(rejectsAccountState(bytes('{"error":{"code":"invalid_encrypted_content"}}'))).toBe(true)
    expect(rejectsAccountState(bytes("reasoning `encrypted_content` was not issued to this caller"))).toBe(true)
    expect(rejectsAccountState(bytes("Item with id 'rs_123' not found."))).toBe(true)
    expect(rejectsAccountState(bytes('{"error":{"code":"context_length_exceeded"}}'))).toBe(false)
  })
})

describe("provider/codex/wire, beyond the Rust tests", () => {
  it("versions come from Codex's own agents only, and the client's version wins", () => {
    expect(clientVersion(new Headers({ "user-agent": "codex_cli_rs/0.50.0 (Mac OS)" }))).toBe("0.50.0")
    expect(clientVersion(new Headers({ "user-agent": "curl/8.7.1" }))).toBeUndefined()
    expect(clientVersion(new Headers({ "user-agent": "codex_exec/0.50" }))).toBeUndefined()
    const kept = upstreamHeaders(
      new Headers({ "user-agent": "codex_exec/1.2.3", version: "9.9.9" }),
      "t",
      undefined,
      false,
    )
    expect(kept.get("version")).toBe("9.9.9")
    expect(kept.has("chatgpt-account-id")).toBe(false)
    expect(reportsUsageLimit(bytes("Your Usage Limit Has Been Reached"))).toBe(true)
    expect(reportsUsageLimit(bytes("bad gateway"))).toBe(false)
  })

  it("dropping a previous response moves the last key into its place, as serde_json does", () => {
    const out = stripAccountState(bytes('{"previous_response_id":"r1","model":"m","input":[],"stream":true}'))
    expect(text(out)).toBe('{"stream":true,"model":"m","input":[]}')
    expect(stripAccountState(bytes("not json"))).toBeUndefined()
    // Numbers keep the form serde_json gives them.
    expect(text(stripAccountState(bytes('{"previous_response_id":"r","temperature":1.0}')))).toBe('{"temperature":1.0}')
  })
})
