import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"

import { asciiLowercase, debug, padCenter, padEnd, padStart, take, trim, truncate, width } from "../src/text.ts"

describe("text", () => {
  it("debug quotes and escapes as {:?} of a str", () => {
    expect(debug("proxy.local:3128")).toBe('"proxy.local:3128"')
    expect(debug('a"b\\c')).toBe('"a\\"b\\\\c"')
    expect(debug("tab\tcr\rnl\nnul\0")).toBe('"tab\\tcr\\rnl\\nnul\\0"')
    expect(debug("it's é 🦀")).toBe('"it\'s é 🦀"')
    expect(debug("\u001b[0m\u200b\u00a0\u0301")).toBe('"\\u{1b}[0m\\u{200b}\\u{a0}\\u{301}"')
  })

  it("width counts characters, not UTF-16 units", () => {
    expect(width("")).toBe(0)
    expect(width("abc")).toBe(3)
    expect(width("café")).toBe(4)
    expect(width("🦀🦀")).toBe(2)
    expect("🦀🦀".length).toBe(4)
    expect(width("a\uD800b")).toBe(3)
  })

  it("take and truncate cut at characters", () => {
    expect(take("🦀ab", 2)).toBe("🦀a")
    expect(take("abc", 5)).toBe("abc")
    expect(take("abc", 0)).toBe("")
    expect(take("\uD800a🦀b", 3)).toBe("\uD800a🦀")
    expect(take("🦀🦀", 1)).toBe("🦀")
    expect(take("a\uDC00🦀", 9)).toBe("a\uDC00🦀")
    expect(truncate("abcdef", 4)).toBe("abc…")
    expect(truncate("abcd", 4)).toBe("abcd")
    expect(truncate("🦀🦀🦀🦀🦀", 3)).toBe("🦀🦀…")
    expect(truncate("abc", 1)).toBe("…")
    expect(truncate("abc", 0)).toBe("")
  })

  it("padding lines up by characters, as {:<w$}, {:>w$}, and {:^w$}", () => {
    expect(padEnd("🦀", 3)).toBe("🦀  ")
    expect(padStart("é", 3)).toBe("  é")
    expect(padEnd("abcd", 2)).toBe("abcd")
    expect(padCenter("ab", 5)).toBe(" ab  ")
    expect(padCenter("🦀", 4)).toBe(" 🦀  ")
  })

  it("trim follows Rust's whitespace", () => {
    expect(trim(" \t\n x y \r\n")).toBe("x y")
    expect(trim("\u0085x　")).toBe("x")
    expect(trim(" x ")).toBe("x")
    // U+FEFF is not whitespace to Rust, though JS's trim drops it.
    expect(trim("﻿x")).toBe("﻿x")
    expect(trim("x")).toBe("x")
    expect(trim("   ")).toBe("")
  })

  it("asciiLowercase changes only A to Z", () => {
    expect(asciiLowercase("WARNING")).toBe("warning")
    expect(asciiLowercase("İNFO")).toBe("İnfo")
    expect(asciiLowercase("K")).toBe("K")
  })
})
