import { describe, expect, it } from "bun:test"

import { find, findStr, isValid, keys, type Range, Seg, splice } from "../../src/proxy/rawjson.ts"

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const at = (body: Uint8Array, range: Range | undefined): string =>
  range === undefined ? "<none>" : new TextDecoder().decode(body.subarray(range.start, range.end))

describe("rawjson", () => {
  it("finds_nested_values", () => {
    const body = bytes(String.raw`{"a":{"b":[10,{"c":"x\"y"}]},"d":true}`)
    const path = [Seg.Key("a"), Seg.Key("b"), Seg.Index(1), Seg.Key("c")]
    expect(at(body, find(body, path))).toBe(String.raw`"x\"y"`)
    expect(findStr(body, path)).toBe('x"y')
    expect(at(body, find(body, [Seg.Key("d")]))).toBe("true")
    expect(find(body, [Seg.Key("missing")])).toBeUndefined()
    expect(find(body, [Seg.Key("a"), Seg.Key("b"), Seg.Index(9)])).toBeUndefined()
  })

  it("strings_end_only_at_unescaped_quotes", () => {
    const body = bytes(String.raw`{"a":"x\\\"y\\","b":[1,"]",{"c":"}"}],"model":"m","model":"later"}`)
    expect(at(body, find(body, ["model"]))).toBe('"m"')
    expect(at(body, find(body, ["b", 2, "c"]))).toBe('"}"')
    expect(find(bytes(String.raw`{"a":"open\"}`), ["b"])).toBeUndefined()
    expect(find(bytes(String.raw`{"a":"x\"`), ["a"])).toBeUndefined()
    expect(find(bytes(String.raw`{"a":"x\\`), ["a"])).toBeUndefined()
  })

  it("splice_replaces_in_place", () => {
    const body = bytes('{"model":"a","keep":1}')
    const range = find(body, ["model"])
    if (range === undefined) throw new Error("model not found")
    expect(new TextDecoder().decode(splice(body, range, '"bb"'))).toBe('{"model":"bb","keep":1}')
  })
})

describe("rawjson, beyond the Rust tests", () => {
  it("keys lists every top-level key in order, repeats included, raw with their quotes", () => {
    const body = bytes(String.raw`{"model":"a", "input" : {"model":"x"}, "model":"b","model":1}`)
    expect((keys(body) ?? []).map((r) => at(body, r))).toEqual(['"model"', '"input"', String.raw`"model"`, '"model"'])
    expect(keys(bytes("{}"))).toEqual([])
    expect(keys(bytes("[1]"))).toBeUndefined()
    expect(keys(bytes(`{"a":1,}`))).toBeUndefined()
  })

  it("keys compare by raw bytes, an empty path is the whole value, and validity is serde_json's", () => {
    const body = bytes(' {"m\\u006fdel":"escaped","model":"plain"} ')
    expect(findStr(body, ["model"])).toBe("plain")
    expect(at(body, find(body, []))).toBe('{"m\\u006fdel":"escaped","model":"plain"}')
    expect(findStr(bytes('{"n":5}'), ["n"])).toBeUndefined()
    expect(findStr(bytes(String.raw`{"s":"\ud800"}`), ["s"])).toBeUndefined()
    expect(findStr(bytes('{"s":"é\\n"}'), ["s"])).toBe("é\n")
    expect(isValid(bytes('{"a":[1,2,{"b":null}]}'))).toBe(true)
    expect(isValid(bytes('{"a":'))).toBe(false)
    expect(isValid(bytes("{} x"))).toBe(false)
    expect(find(bytes("[]"), [0])).toBeUndefined()
    expect(find(bytes("{}"), ["a"])).toBeUndefined()
  })

  it("validity is serde_json's IgnoredAny: grammar only, no depth limit, numbers and escapes unconverted", () => {
    const deep = (n: number): Uint8Array => bytes("[".repeat(n) + "]".repeat(n))
    for (const n of [1, 127, 128, 129, 500, 5000]) expect(isValid(deep(n))).toBe(true)
    expect(isValid(bytes(`${'{"a":'.repeat(3000)}1${"}".repeat(3000)}`))).toBe(true)
    // A string cut mid-emoji still routes by model.
    const cut = bytes(String.raw`{"text":"abc\ud83d","model":"claude-x"}`)
    expect(isValid(cut)).toBe(true)
    expect(findStr(cut, ["model"])).toBe("claude-x")
    const valid = [
      String.raw`"\ud83d"`,
      "1e400",
      "-1e-400",
      "123456789012345678901234567890",
      "-0",
      "0.5E+3",
      ' \t\r\n{ "a" : [ true , false , null ] } \n',
      String.raw`"\"\\\/\b\f\n\r\téꯍ"`,
      String.raw`"\u007f\u0000"`,
      '"\u007f"',
    ]
    for (const text of valid) expect([text, isValid(bytes(text))]).toEqual([text, true])
    expect(isValid(new Uint8Array([0x22, 0xff, 0x22]))).toBe(true)
    expect(isValid(new Uint8Array([0x7b, 0x22, 0xc3, 0x22, 0x3a, 0x31, 0x7d]))).toBe(true)
    const invalid = [
      "",
      " ",
      "01",
      "-",
      "-a",
      "+1",
      "1.",
      ".5",
      "1e",
      "1e+",
      "0x10",
      "nul",
      "True",
      "[1,]",
      "[1 2]",
      '{"a":1,}',
      '{"a" 1}',
      "{1:2}",
      '{"a"}',
      "[",
      "[}",
      '{"a":1]',
      "]",
      String.raw`"\x41"`,
      String.raw`"\u12G4"`,
      String.raw`"\u12"`,
      '"tab\there"',
      '"line\nbreak"',
      '"a',
      "[] []",
      "1 2",
      "﻿1",
    ]
    for (const text of invalid) expect([text, isValid(bytes(text))]).toEqual([text, false])
  })
})
