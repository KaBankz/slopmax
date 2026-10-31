import { describe, expect, it } from "bun:test"

import { clientAgent, upstreamHeaders, withOauthBeta } from "../../../src/provider/claude/wire.ts"

describe("provider/claude/wire", () => {
  it("oauth_beta_is_added_once", () => {
    expect(withOauthBeta("claude-code-20250219, interleaved-thinking-2025-05-14")).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
    )
    expect(withOauthBeta(undefined)).toBe("oauth-2025-04-20")
    expect(withOauthBeta("oauth-2025-04-20,x")).toBe("oauth-2025-04-20,x")
  })

  it("claude_code_is_known_by_its_agent", () => {
    const headers = new Headers()
    expect(clientAgent(headers)).toBeUndefined()
    headers.set("user-agent", "claude-cli/2.1.291 (external, cli)")
    expect(clientAgent(headers)).toBe("claude-cli/2.1.291 (external, cli)")
    headers.set("user-agent", "curl/8.7.1")
    expect(clientAgent(headers)).toBeUndefined()
  })

  it("only_the_credential_changes", () => {
    const client = new Headers({
      authorization: "Bearer sm-key",
      "user-agent": "claude-cli/2.1.287 (external, cli)",
      "accept-encoding": "gzip, br",
      "x-app": "cli",
    })
    const out = upstreamHeaders(client, "account-token")
    expect(out.get("authorization")).toBe("Bearer account-token")
    expect(out.get("anthropic-beta")).toBe("oauth-2025-04-20")
    expect(out.get("user-agent")).toBe("claude-cli/2.1.287 (external, cli)")
    expect(out.get("accept-encoding")).toBe("gzip, br")
    expect(out.get("x-app")).toBe("cli")
    expect(out.has("x-client-request-id")).toBe(false)
  })
})

describe("provider/claude/wire, beyond the Rust tests", () => {
  it("slopmax's own headers, the slopmax key, and long agents stay behind", () => {
    const client = new Headers({ "x-api-key": "sm-key", "x-slopmax-affinity": "off", cookie: "c=1" })
    const out = upstreamHeaders(client, "t")
    expect([...out.keys()].toSorted()).toEqual(["anthropic-beta", "authorization"])
    expect(clientAgent(new Headers({ "user-agent": `claude-cli/${"9".repeat(200)}` }))).toBeUndefined()
  })
})
