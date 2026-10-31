// JSON as the Rust reads and writes it with serde_json (1.0.151, with
// `preserve_order` and without `float_roundtrip`), over the engine's own
// JSON.parse and JSON.stringify.
//
// Objects keep their keys in insertion order in both, and strings escape
// the same way. Numbers are where they part: serde_json keeps an integer an
// integer and a float a float (`1.0` stays `1.0`, where JavaScript writes
// `1`), keeps integers past 2^53 exact, reads floats with its own fast
// algorithm, and refuses numbers out of range, lone surrogates, and nesting
// deeper than 127. `read` gives each number the value and text serde_json
// would, as a plain number when JavaScript writes it the same, else as a
// raw JSON value (`JSON.rawJSON`) that `JSON.stringify` writes verbatim.
// When the text is not JSON, the error is serde_json's, word for word.
import { Result } from "effect"

import { fmt } from "@slopmax/common"

declare const RawJsonBrand: unique symbol

/** A number kept as serde_json writes it: `1.0`, `-0.0`, `18446744073709551615`. */
export interface RawJson {
  readonly rawJSON: string
  readonly [RawJsonBrand]: true
}

/** A JSON value: serde_json's `Value`. */
export type Json = null | boolean | number | string | RawJson | Json[] | JsonObject

/** A JSON object; its keys keep their order. */
export interface JsonObject {
  [key: string]: Json
}

interface Source {
  readonly source?: string
}

interface NativeJson {
  rawJSON(text: string): RawJson
  isRawJSON(value: unknown): value is RawJson
  parse(text: string, reviver: (this: unknown, key: string, value: unknown, context: Source) => unknown): unknown
}

const native = JSON as unknown as NativeJson

/** A number written exactly as `text`. */
export const raw = (text: string): RawJson => native.rawJSON(text)

/** An `f64` as serde_json writes it (`1.0`, `0.7`, `1e+16`). */
export const f64Value = (x: number): number | RawJson => {
  const text = fmt.json(x)
  return !Number.isInteger(x) && text === String(x) ? x : raw(text)
}

// ---- reading values -------------------------------------------------------

export const isObject = (v: Json | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !native.isRawJSON(v)

/** `value.get(key)`: the member of an object, or undefined. */
export const get = (v: Json | undefined, key: string): Json | undefined =>
  isObject(v) && Object.hasOwn(v, key) ? v[key] : undefined

/** `as_str`. */
export const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined)

/** `as_bool`. */
export const bool = (v: Json | undefined): boolean | undefined => (typeof v === "boolean" ? v : undefined)

/** `value.get(key).and_then(Value::as_str).unwrap_or("")`. */
export const strOf = (v: Json | undefined, key: string): string => str(get(v, key)) ?? ""

/** `as_array`. */
export const array = (v: Json | undefined): Json[] | undefined => (Array.isArray(v) ? v : undefined)

const U64_LIMIT = 2 ** 64

/** `as_u64`: a non-negative integer (never a float, even `1.0`). */
export const u64 = (v: Json | undefined): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < U64_LIMIT ? v : undefined
  if (v !== undefined && native.isRawJSON(v) && /^[0-9]+$/.test(v.rawJSON)) return Number(v.rawJSON)
  return undefined
}

/** `as_u64().unwrap_or(0)`, for token counts. */
export const count = (v: Json | undefined): number => u64(v) ?? 0

/** `as_f64`: any number. */
export const f64 = (v: Json | undefined): number | undefined => {
  if (typeof v === "number") return v
  if (v !== undefined && native.isRawJSON(v)) return Number(v.rawJSON)
  return undefined
}

/** `a.or_else(|| b)`: `a` unless it is missing (a `null` is not missing). */
export const or = (a: Json | undefined, b: Json | undefined): Json | undefined => (a !== undefined ? a : b)

/** Present and not `null` (`is_some_and(|v| !v.is_null())`). */
export const isSome = (v: Json | undefined): v is Exclude<Json, null> => v !== undefined && v !== null

/** Compact JSON text, as `serde_json::to_string` writes it. */
export const stringify = (v: Json): string => JSON.stringify(v)

// `<[u8]>::trim_ascii`: space, tab, line feed, form feed, carriage return.
const isAsciiSpace = (c: number | undefined): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d

/** `<[u8]>::trim_ascii`: `data` without leading or trailing ASCII whitespace. */
export const trimAscii = (data: Uint8Array): Uint8Array => {
  let start = 0
  let end = data.length
  while (start < end && isAsciiSpace(data[start])) start++
  while (end > start && isAsciiSpace(data[end - 1])) end--
  return start === 0 && end === data.length ? data : data.subarray(start, end)
}

// ---- parsing ---------------------------------------------------------------

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const encoder = new TextEncoder()

/** A number serde_json refuses; the scanner says where. */
class OutOfRange extends Error {}

/** JSON text serde_json refuses for a reason JSON.parse does not have. */
class Refused extends Error {}

const reviver = function (this: unknown, key: string, value: unknown, context: Source): unknown {
  if (!key.isWellFormed()) throw new Refused()
  if (typeof value === "number") {
    const source = context.source ?? String(value)
    // Short integers are what they look like (all but `-0`).
    if (source.length < 16 && !Object.is(value, -0) && !/[.eE]/.test(source)) return value
    return number(source)
  }
  if (typeof value === "string" && !value.isWellFormed()) throw new Refused()
  return value
}

// Text JSON.parse alone reads as serde_json does: no number with a fraction
// or an exponent, no `-0`, no integer of 16 digits or more (2^53 has 16),
// and no surrogate escape (`\uD800`–`\uDFFF`) that could be lone. A number
// follows `:`, `,`, `[`, or the start; a match inside a string only sends
// the text the slow way. Stream events almost never match, and the
// reviver costs several times the parse.
const REVIVE = /(?:^|[:,[])\s*(?:-0|-?[0-9]+[.eE]|-?[0-9]{16})|\\u[dD][89a-fA-F]/

/**
 * `serde_json::from_slice::<Value>`: the value, or serde_json's error text
 * (`expected value at line 1 column 1`).
 */
export const read = (input: Uint8Array | string): Result.Result<Json, string> => {
  let text: string
  if (typeof input === "string") {
    text = input
  } else {
    try {
      text = utf8.decode(input)
    } catch {
      return Result.fail(scan(input) ?? "invalid unicode code point")
    }
  }
  try {
    // Bytes decode only to well-formed text; a string may hold a lone surrogate.
    const plain = !REVIVE.test(text) && (typeof input !== "string" || text.isWellFormed())
    return Result.succeed((plain ? JSON.parse(text) : native.parse(text, reviver)) as Json)
  } catch {
    return Result.fail(scan(typeof input === "string" ? encoder.encode(input) : input) ?? "invalid JSON")
  }
}

/** `serde_json::from_slice::<Value>(…).ok()`. */
export const parse = (input: Uint8Array | string): Json | undefined => {
  const result = read(input)
  return Result.isSuccess(result) ? result.success : undefined
}

// ---- serde_json's reader ---------------------------------------------------

const enum C {
  Tab = 0x09,
  Newline = 0x0a,
  Return = 0x0d,
  Space = 0x20,
  Quote = 0x22,
  Plus = 0x2b,
  Comma = 0x2c,
  Minus = 0x2d,
  Dot = 0x2e,
  Slash = 0x2f,
  Zero = 0x30,
  Nine = 0x39,
  Colon = 0x3a,
  UpperE = 0x45,
  Open = 0x5b,
  Backslash = 0x5c,
  Close = 0x5d,
  LowerE = 0x65,
  LowerU = 0x75,
  Brace = 0x7b,
  CloseBrace = 0x7d,
}

class Syntax extends Error {}

const U64_MAX = 18_446_744_073_709_551_615n
const I32_MAX = 2_147_483_647
const POW10 = Array.from({ length: 309 }, (_, i) => Number(`1e${i}`))
const SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** serde_json's `Deserializer` over a byte slice, reduced to what errors need. */
class Reader {
  index = 0
  depth = 128
  constructor(readonly bytes: Uint8Array) {}

  private at(i: number): number {
    return i < this.bytes.length ? (this.bytes[i] ?? -1) : -1
  }

  private peek(): number {
    return this.at(this.index)
  }

  private next(): number {
    const b = this.at(this.index)
    if (b >= 0) this.index++
    return b
  }

  private position(i: number): string {
    const start = i === 0 ? 0 : this.bytes.lastIndexOf(C.Newline, i - 1) + 1
    let line = 1
    for (let j = 0; j < start; j++) if (this.bytes[j] === C.Newline) line++
    return `line ${line} column ${i - start}`
  }

  /** An error caused by the byte just read. */
  error(code: string): Syntax {
    return new Syntax(`${code} at ${this.position(this.index)}`)
  }

  /** An error caused by the byte about to be read. */
  peekError(code: string): Syntax {
    return new Syntax(`${code} at ${this.position(Math.min(this.bytes.length, this.index + 1))}`)
  }

  private whitespace(): number {
    for (;;) {
      const b = this.peek()
      if (b === C.Space || b === C.Newline || b === C.Tab || b === C.Return) this.index++
      else return b
    }
  }

  document(): void {
    this.value()
    if (this.whitespace() >= 0) throw this.peekError("trailing characters")
  }

  private value(): void {
    const peek = this.whitespace()
    if (peek < 0) throw this.peekError("EOF while parsing a value")
    switch (peek) {
      case 0x6e: // n
        this.index++
        return this.ident("ull")
      case 0x74: // t
        this.index++
        return this.ident("rue")
      case 0x66: // f
        this.index++
        return this.ident("alse")
      case C.Minus:
        this.index++
        this.number(false)
        return
      case C.Quote:
        this.index++
        return this.string()
      case C.Open:
        if (--this.depth === 0) throw this.peekError("recursion limit exceeded")
        this.index++
        this.seq()
        this.depth++
        return
      case C.Brace:
        if (--this.depth === 0) throw this.peekError("recursion limit exceeded")
        this.index++
        this.map()
        this.depth++
        return
      default:
        if (peek >= C.Zero && peek <= C.Nine) {
          this.number(true)
          return
        }
        throw this.peekError("expected value")
    }
  }

  private ident(rest: string): void {
    for (let i = 0; i < rest.length; i++) {
      const b = this.next()
      if (b < 0) throw this.error("EOF while parsing a value")
      if (b !== rest.charCodeAt(i)) throw this.error("expected ident")
    }
  }

  private seq(): void {
    let first = true
    for (;;) {
      const peek = this.whitespace()
      if (peek < 0) throw this.peekError("EOF while parsing a list")
      if (peek === C.Close) break
      if (first) {
        first = false
      } else if (peek === C.Comma) {
        this.index++
        const after = this.whitespace()
        if (after === C.Close) throw this.peekError("trailing comma")
        if (after < 0) throw this.peekError("EOF while parsing a value")
      } else {
        throw this.peekError("expected `,` or `]`")
      }
      this.value()
    }
    this.index++
  }

  private map(): void {
    let first = true
    for (;;) {
      const peek = this.whitespace()
      if (peek < 0) throw this.peekError("EOF while parsing an object")
      if (peek === C.CloseBrace) break
      if (first) {
        first = false
        if (peek !== C.Quote) throw this.peekError("key must be a string")
      } else if (peek === C.Comma) {
        this.index++
        const after = this.whitespace()
        if (after === C.CloseBrace) throw this.peekError("trailing comma")
        if (after < 0) throw this.peekError("EOF while parsing a value")
        if (after !== C.Quote) throw this.peekError("key must be a string")
      } else {
        throw this.peekError("expected `,` or `}`")
      }
      this.index++
      this.string()
      const colon = this.whitespace()
      if (colon < 0) throw this.peekError("EOF while parsing an object")
      if (colon !== C.Colon) throw this.peekError("expected `:`")
      this.index++
      this.value()
    }
    this.index++
  }

  private string(): void {
    const start = this.index
    for (;;) {
      let b = this.peek()
      while (b >= C.Space && b !== C.Quote && b !== C.Backslash) b = this.at(++this.index)
      if (b < 0) throw this.error("EOF while parsing a string")
      if (b === C.Quote) {
        const end = this.index++
        try {
          utf8.decode(this.bytes.subarray(start, end))
        } catch {
          throw this.error("invalid unicode code point")
        }
        return
      }
      this.index++
      if (b === C.Backslash) this.escape()
      else throw this.error("control character (\\u0000-\\u001F) found while parsing a string")
    }
  }

  private escape(): void {
    const ch = this.next()
    if (ch < 0) throw this.error("EOF while parsing a string")
    switch (ch) {
      case C.Quote:
      case C.Backslash:
      case C.Slash:
      case 0x62: // b
      case 0x66: // f
      case 0x6e: // n
      case 0x72: // r
      case 0x74: // t
        return
      case C.LowerU:
        return this.unicode()
      default:
        throw this.error("invalid escape")
    }
  }

  private hex(): number {
    if (this.bytes.length - this.index < 4) {
      this.index = this.bytes.length
      throw this.error("EOF while parsing a string")
    }
    let n = 0
    let ok = true
    for (let i = 0; i < 4; i++) {
      const b = this.bytes[this.index + i] ?? 0
      const d =
        b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1
      if (d < 0) ok = false
      n = n * 16 + d
    }
    this.index += 4
    if (!ok) throw this.error("invalid escape")
    return n
  }

  private unicode(): void {
    const n = this.hex()
    if (n >= 0xdc00 && n <= 0xdfff) throw this.error("lone leading surrogate in hex escape")
    if (n < 0xd800 || n > 0xdbff) return
    for (const expected of [C.Backslash, C.LowerU]) {
      const b = this.peek()
      if (b < 0) throw this.error("EOF while parsing a string")
      this.index++
      if (b !== expected) throw this.error("unexpected end of hex escape")
    }
    const n2 = this.hex()
    if (n2 < 0xdc00 || n2 > 0xdfff) throw this.error("lone leading surrogate in hex escape")
  }

  private digit(): number {
    const b = this.peek()
    return b >= C.Zero && b <= C.Nine ? b - C.Zero : -1
  }

  /** `parse_integer` and what follows: the number's value as JSON. */
  number(positive: boolean): number | RawJson {
    const first = this.next()
    if (first < 0) throw this.error("EOF while parsing a value")
    if (first === C.Zero) {
      if (this.digit() >= 0) throw this.peekError("invalid number")
      return this.rest(positive, 0n)
    }
    if (first < C.Zero || first > C.Nine) throw this.error("invalid number")
    let significand = BigInt(first - C.Zero)
    let digits = 1
    for (;;) {
      const d = this.digit()
      if (d < 0) return this.rest(positive, significand)
      if (digits >= 19 && significand * 10n + BigInt(d) > U64_MAX) return this.longInteger(positive, significand)
      this.index++
      significand = significand * 10n + BigInt(d)
      digits++
    }
  }

  // `parse_number`: an integer, unless a fraction or an exponent follows.
  private rest(positive: boolean, significand: bigint): number | RawJson {
    const b = this.peek()
    if (b === C.Dot) return f64Value(this.decimal(positive, significand, 0))
    if (b === C.LowerE || b === C.UpperE) return f64Value(this.exponent(positive, significand, 0))
    if (positive) return significand <= SAFE ? Number(significand) : raw(significand.toString())
    // Rust: `(significand as i64).wrapping_neg()`, a float on `-0` or below i64::MIN.
    if (significand === 0n || significand > 9_223_372_036_854_775_808n) {
      return f64Value(-Number(significand))
    }
    return significand <= SAFE ? -Number(significand) : raw(`-${significand}`)
  }

  private longInteger(positive: boolean, significand: bigint): RawJson | number {
    let exponent = 0
    for (;;) {
      const b = this.peek()
      if (b >= C.Zero && b <= C.Nine) {
        this.index++
        exponent++
      } else if (b === C.Dot) {
        return f64Value(this.decimal(positive, significand, exponent))
      } else if (b === C.LowerE || b === C.UpperE) {
        return f64Value(this.exponent(positive, significand, exponent))
      } else {
        return f64Value(this.fromParts(positive, significand, exponent))
      }
    }
  }

  private decimal(positive: boolean, significand: bigint, before: number): number {
    this.index++
    let after = 0
    for (let d = this.digit(); d >= 0; d = this.digit()) {
      const next = significand * 10n + BigInt(d)
      if (next > U64_MAX) {
        while (this.digit() >= 0) this.index++
        const b = this.peek()
        if (b === C.LowerE || b === C.UpperE) return this.exponent(positive, significand, before + after)
        return this.fromParts(positive, significand, before + after)
      }
      this.index++
      significand = next
      after--
    }
    if (after === 0) {
      if (this.peek() >= 0) throw this.peekError("invalid number")
      throw this.peekError("EOF while parsing a value")
    }
    const b = this.peek()
    if (b === C.LowerE || b === C.UpperE) return this.exponent(positive, significand, before + after)
    return this.fromParts(positive, significand, before + after)
  }

  private exponent(positive: boolean, significand: bigint, starting: number): number {
    this.index++
    let positiveExp = true
    const sign = this.peek()
    if (sign === C.Plus) {
      this.index++
    } else if (sign === C.Minus) {
      this.index++
      positiveExp = false
    }
    const next = this.next()
    if (next < 0) throw this.error("EOF while parsing a value")
    if (next < C.Zero || next > C.Nine) throw this.error("invalid number")
    let exp = next - C.Zero
    for (let d = this.digit(); d >= 0; d = this.digit()) {
      this.index++
      if (exp >= Math.floor(I32_MAX / 10) && (exp > Math.floor(I32_MAX / 10) || d > I32_MAX % 10)) {
        // `parse_exponent_overflow`: an error instead of infinity.
        if (significand !== 0n && positiveExp) throw this.error("number out of range")
        while (this.digit() >= 0) this.index++
        return positive ? 0 : -0
      }
      exp = exp * 10 + d
    }
    const total = positiveExp ? saturate(starting + exp) : saturate(starting - exp)
    return this.fromParts(positive, significand, total)
  }

  // `f64_from_parts` without `float_roundtrip`: one multiplication or
  // division by a power of ten, which can be a unit in the last place off
  // the correctly rounded value JavaScript reads.
  private fromParts(positive: boolean, significand: bigint, exponent: number): number {
    let f = Number(significand)
    for (;;) {
      const pow = POW10[Math.abs(exponent)]
      if (pow !== undefined) {
        if (exponent >= 0) {
          f *= pow
          if (!Number.isFinite(f)) throw this.error("number out of range")
        } else {
          f /= pow
        }
        break
      }
      if (f === 0) break
      if (exponent >= 0) throw this.error("number out of range")
      f /= 1e308
      exponent += 308
    }
    return positive ? f : -f
  }
}

const saturate = (n: number): number => Math.max(-I32_MAX - 1, Math.min(I32_MAX, n))

/** The value serde_json gives the number written `source`. */
const number = (source: string): number | RawJson => {
  const reader = new Reader(encoder.encode(source))
  const negative = source.charCodeAt(0) === C.Minus
  if (negative) reader.index = 1
  try {
    return reader.number(!negative)
  } catch {
    throw new OutOfRange()
  }
}

/** serde_json's error for `bytes`, or undefined when it would read them. */
export const scan = (bytes: Uint8Array): string | undefined => {
  try {
    new Reader(bytes).document()
    return undefined
  } catch (e) {
    if (e instanceof Syntax) return e.message
    throw e
  }
}
