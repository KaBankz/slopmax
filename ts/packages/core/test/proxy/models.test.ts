import { describe, expect, it } from "bun:test"

import { wantsList } from "../../src/proxy/models.ts"

describe("proxy/models", () => {
  it("claude_code_and_codex_keep_their_own_lists", () => {
    const headers = new Headers()
    expect(wantsList(headers, "limit=20")).toBe(true)
    expect(wantsList(headers, "client_version=0.159.3")).toBe(false)
    headers.set("anthropic-version", "2023-06-01")
    expect(wantsList(headers, "")).toBe(false)
    const claude = new Headers({ "user-agent": "claude-cli/2.1.287 (external, cli)" })
    expect(wantsList(claude, "limit=1000")).toBe(false)
  })
})
