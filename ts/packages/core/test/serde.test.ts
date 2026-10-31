import { describe, expect, it } from "bun:test"

import { Schema } from "effect"

import { json } from "@slopmax/wire"

import { byteOrder, i64, JsonValue, swapRemove } from "../src/serde.ts"

const at = (text: string): number | undefined => i64(json.parse(text))

const bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))

describe("serde, beyond the Rust tests", () => {
  it("as_i64 takes integers that fit, never floats", () => {
    expect(at("42")).toBe(42)
    expect(at("-7")).toBe(-7)
    expect(at("9223372036854775807")).toBe(2 ** 63)
    expect(at("9223372036854775808")).toBeUndefined()
    expect(at("-9223372036854775808")).toBe(-(2 ** 63))
    expect(at("3.0")).toBeUndefined()
    expect(at("1e3")).toBeUndefined()
    expect(at("3.5")).toBeUndefined()
    expect(at('"3"')).toBeUndefined()
    expect(at('{"rawJSON":"42"}')).toBeUndefined()
    expect(i64(undefined)).toBeUndefined()
  })

  it("removing a key moves the last one into its place, as serde_json's preserve_order map does", () => {
    const object: json.JsonObject = { a: 1, b: 2, c: 3, d: 4 }
    expect(swapRemove(object, "b")).toBe(true)
    expect(Object.keys(object)).toEqual(["a", "d", "c"])
    expect(object).toEqual({ a: 1, d: 4, c: 3 })
    expect(swapRemove(object, "c")).toBe(true)
    expect(Object.keys(object)).toEqual(["a", "d"])
    expect(swapRemove(object, "zz")).toBe(false)
    expect(Object.keys(object)).toEqual(["a", "d"])
  })

  it("strings sort by UTF-8 bytes, as a BTreeMap keeps them", () => {
    const words = ["b", "a", "ab", "", "\u{1F600}", "\uFFFD", "\uE000", "z", "é", "A"]
    expect(words.toSorted(byteOrder)).toEqual(words.toSorted(bytes))
    expect(words.toSorted(byteOrder)).toEqual(["", "A", "a", "ab", "b", "z", "é", "\uE000", "\uFFFD", "\u{1F600}"])
    expect(byteOrder("same", "same")).toBe(0)
  })

  it("a JSON value is any JSON and nothing else", () => {
    const is = Schema.is(JsonValue)
    for (const value of [null, true, 1.5, "s", [1, [null]], { a: { b: [] } }, json.raw("1.0")]) {
      expect(is(value)).toBe(true)
    }
    for (const value of [undefined, 1n, Number.NaN, () => 1, [undefined], { a: Symbol("x") }]) {
      expect(is(value)).toBe(false)
    }
  })
})
