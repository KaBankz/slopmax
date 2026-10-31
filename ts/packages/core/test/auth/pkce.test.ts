import { describe, expect, it } from "bun:test"

import { challengeOf, Pkce } from "../../src/auth/pkce.ts"

describe("pkce", () => {
  it("challenge_matches_rfc7636_example", () => {
    // Appendix B of RFC 7636.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expect(challengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("verifier_is_url_safe_and_unique", () => {
    const a = Pkce.generate()
    const b = Pkce.generate()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.verifier.length).toBe(43)
    expect(/^[A-Za-z0-9_-]+$/.test(a.verifier)).toBe(true)
    expect(a.challenge).toBe(challengeOf(a.verifier))
  })
})
