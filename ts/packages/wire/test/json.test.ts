// json.ts: serde_json's reading and writing over the engine's JSON.
// test/golden.test.ts compares it with serde_json itself; these pin the
// pieces the formats lean on.
import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Result } from "effect"

import * as json from "../src/json.ts"

const read = (text: string): string => {
  const r = json.read(text)
  return Result.isSuccess(r) ? json.stringify(r.success) : `error: ${r.failure}`
}

describe("json", () => {
  it("numbers keep serde_json's kind: floats stay floats, big integers stay exact", () => {
    expect(read("[1.0, 1, -0, 0.5, 1e2, 12345678901234567890, -9223372036854775808, 1e16]")).toBe(
      "[1.0,1,-0.0,0.5,100.0,12345678901234567890,-9223372036854775808,1e+16]",
    )
  })

  it("a number in any place, after any whitespace, reads as serde_json reads it", () => {
    // Text without such numbers skips the reviver; these must not.
    expect(read("-0")).toBe("-0.0")
    expect(read(' {"a" :\n\t-0 , "b":\r\n 2.5E1,"c":[ 9007199254740993 ],"d":"x:1.5"}')).toBe(
      '{"a":-0.0,"b":25.0,"c":[9007199254740993],"d":"x:1.5"}',
    )
    expect(read('[0,{"id":"msg_3e9","n":12}]')).toBe('[0,{"id":"msg_3e9","n":12}]')
    expect(read('["\\ud83d\\ude00"]')).toBe('["\u{1F600}"]')
    // Text with a lone surrogate (bytes never decode to one) is refused.
    expect(read('["\ud800"]')).toStartWith("error:")
  })

  it("as_u64 refuses floats, negatives, and what u64 cannot hold; as_f64 reads any number", () => {
    const value = json.parse('{"a":1000,"b":1000.0,"c":-1,"d":18446744073709551615,"e":18446744073709551616,"f":"1"}')
    expect(["a", "b", "c", "d", "e", "f"].map((k) => json.u64(json.get(value, k)))).toEqual([
      1000,
      undefined,
      undefined,
      Number("18446744073709551615"),
      undefined,
      undefined,
    ])
    expect(["a", "b", "c", "f"].map((k) => json.f64(json.get(value, k)))).toEqual([1000, 1000, -1, undefined])
    expect(json.count(json.get(value, "b"))).toBe(0)
  })

  it("floats are written as serde_json writes an f64", () => {
    expect(json.stringify([json.f64Value(1), json.f64Value(0.7), json.f64Value(1e16), json.f64Value(-0)])).toBe(
      "[1.0,0.7,1e+16,-0.0]",
    )
    expect(json.f64Value(0.7)).toBe(0.7)
  })

  it("errors are serde_json's, for text and for bytes", () => {
    expect(read("{\n  nope")).toBe("error: key must be a string at line 2 column 3")
    const bytes = json.read(new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]))
    expect(Result.isFailure(bytes) && bytes.failure).toBe("invalid unicode code point at line 1 column 4")
    expect(read('["\\ud83d"]')).toBe("error: unexpected end of hex escape at line 1 column 9")
    expect(read('{"\\udc00":1}')).toBe("error: lone leading surrogate in hex escape at line 1 column 8")
    expect(read("[1e309]")).toBe("error: number out of range at line 1 column 6")
    expect(json.scan(new TextEncoder().encode('{"a":[1,{"b":null}]}'))).toBeUndefined()
  })

  it("members are read only from objects, and only their own", () => {
    const value = json.parse('{"a":null,"__proto__":{"x":1}}')
    expect(json.get(value, "a")).toBeNull()
    expect(json.get(value, "toString")).toBeUndefined()
    expect(json.get(json.get(value, "__proto__"), "x")).toBe(1)
    expect(json.get([1], "length")).toBeUndefined()
    expect(json.get(json.raw("1.0"), "rawJSON")).toBeUndefined()
    expect(json.isObject(json.raw("1.0"))).toBe(false)
  })

  it("or keeps a null, isSome does not", () => {
    expect(json.or(null, 1)).toBeNull()
    expect(json.or(undefined, 1)).toBe(1)
    expect(json.isSome(null)).toBe(false)
    expect(json.isSome(0)).toBe(true)
  })
})
