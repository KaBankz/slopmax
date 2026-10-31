import { describe, expect, it } from "bun:test"

import { claims, encodeUnsigned, expiry } from "../../src/auth/jwt.ts"

describe("jwt", () => {
  it("decodes_claims_and_expiry", () => {
    const token = encodeUnsigned({ email: "a@b.c", exp: 1_900_000_000 })
    expect(claims(token)).toEqual({ email: "a@b.c", exp: 1_900_000_000 })
    expect(expiry(token)).toBe(1_900_000_000_000)
  })

  it("rejects_non_jwt", () => {
    expect(claims("not-a-jwt")).toBeUndefined()
    expect(claims("a.!!!.c")).toBeUndefined()
  })
})

describe("jwt, beyond the Rust tests", () => {
  it("decodes strictly, as the base64 crate does", () => {
    const payload = Buffer.from('{"a":1}').toString("base64url")
    expect(claims(`h.${payload}==.s`)).toEqual({ a: 1 })
    // The standard alphabet, and stray bits in the last character, are refused.
    expect(claims(`h.${Buffer.from('{"a":"??>"}').toString("base64")}.s`)).toBeUndefined()
    expect(claims("h.eyJhIjoxfQ.s")).toEqual({ a: 1 })
    expect(claims("h.eyJhIjoxfR.s")).toBeUndefined()
    expect(expiry(encodeUnsigned({ exp: 1.5 }))).toBeUndefined()
    expect(expiry(encodeUnsigned({ exp: "1" }))).toBeUndefined()
  })
})
