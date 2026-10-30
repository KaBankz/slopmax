import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { decode, encode, percentDecode } from "../src/form.ts"

describe("form", () => {
  it("encodes_like_the_whatwg_serializer", () => {
    expect(
      encode([
        ["scope", "user:profile user:inference"],
        ["redirect_uri", "http://localhost:1455/auth/callback"],
      ]),
    ).toBe("scope=user%3Aprofile+user%3Ainference&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback")
    expect(encode([["a*-._~", "é"]])).toBe("a*-._%7E=%C3%A9")
    expect(encode([])).toBe("")
  })

  it("decodes_pairs_and_tolerates_malformed_escapes", () => {
    expect(decode("code=ab%2Fc+d&state=s&&flag")).toEqual([
      ["code", "ab/c d"],
      ["state", "s"],
      ["flag", ""],
    ])
    expect(decode("x=%zz%4")).toEqual([["x", "%zz%4"]])
    expect(decode("x=%C3%A9")).toEqual([["x", "é"]])
  })

  it("encodes as URLSearchParams does, byte for byte", () => {
    const pairs: Array<[string, string]> = [
      ["k ~!'()", "a+b=c&d"],
      ["emoji", "🦀 \n\t"],
      ["", ""],
    ]
    expect(encode(pairs)).toBe(new URLSearchParams(pairs).toString())
  })

  it("percent_decode leaves + alone and replaces invalid UTF-8", () => {
    expect(percentDecode("p%40ss+word")).toBe("p@ss+word")
    expect(decode("x=a%FFb")).toEqual([["x", "a�b"]])
    expect(decode("=v&k")).toEqual([
      ["", "v"],
      ["k", ""],
    ])
  })
})
