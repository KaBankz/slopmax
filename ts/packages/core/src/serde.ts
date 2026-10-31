// serde's rules for the JSON files slopmax owns, as Schema pieces: an
// `Option` field may be absent or `null` on read and is left out when it
// has no value, and an `f64` is written as serde_json writes it (`40.0`,
// not `40`), so files read the same whichever build wrote them.
import { Option, Schema, SchemaGetter } from "effect"

import { json } from "@slopmax/wire"

/** A number kept as serde_json writes it (wire's `json.RawJson`). */
export interface Raw {
  readonly rawJSON: string
}

export const isRaw = (u: unknown): u is Raw =>
  typeof u === "object" && u !== null && "rawJSON" in u && typeof u.rawJSON === "string"

const RawSchema = Schema.declare(isRaw)

/** An `f64`: any JSON number on read; written as serde_json writes it. */
export const F64: Schema.Codec<number, number | Raw> = Schema.Union([Schema.Number, RawSchema]).pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transform((v: number | Raw) => (typeof v === "number" ? v : Number(v.rawJSON))),
    encode: SchemaGetter.transform((x: number): number | Raw => json.f64Value(x)),
  }),
)

const isJson = (u: unknown): u is json.Json => {
  if (u === null || typeof u === "boolean" || typeof u === "string") return true
  if (typeof u === "number") return Number.isFinite(u)
  if (Array.isArray(u)) return u.every(isJson)
  if (typeof u !== "object") return false
  return isRaw(u) || Object.values(u).every(isJson)
}

/** A `serde_json::Value`: any JSON. */
export const JsonValue: Schema.declare<json.Json> = Schema.declare(isJson)

/** An unsigned integer, as serde reads a `u64`. */
export const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

/** A `u32`. */
export const U32 = Count.check(Schema.isLessThanOrEqualTo(2 ** 32 - 1))

/** A `u16`. */
export const U16 = Count.check(Schema.isLessThanOrEqualTo(2 ** 16 - 1))

/**
 * `#[serde(default, skip_serializing_if = "Option::is_none")]`: the key may
 * be absent or `null`, and is left out when there is no value.
 */
export const opt = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(Schema.NullOr(Schema.toEncoded(schema))).pipe(
    Schema.decodeTo(Schema.optionalKey(schema), {
      decode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"] | null>) =>
        Option.filter(o, (v): v is S["Encoded"] => v !== null),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) => o),
    }),
  )

/**
 * `#[serde(default, skip_serializing_if = "Vec::is_empty")]`: a list that
 * may be absent (read as empty) and is left out when empty.
 */
export const list = <S extends Schema.Top>(item: S) =>
  Schema.optionalKey(Schema.Array(Schema.toEncoded(item))).pipe(
    Schema.decodeTo(Schema.Array(item), {
      decode: SchemaGetter.transformOptional((o: Option.Option<ReadonlyArray<S["Encoded"]>>) =>
        Option.some(Option.getOrElse(o, (): ReadonlyArray<S["Encoded"]> => [])),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<ReadonlyArray<S["Encoded"]>>) =>
        Option.filter(o, (items) => items.length > 0),
      ),
    }),
  )

/**
 * `#[serde(default = …, skip_serializing_if = …)]`: a key that may be
 * absent (read as `value`) and is left out when it holds `value`.
 */
export const defaulted = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  Schema.optionalKey(Schema.toEncoded(schema)).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) =>
        Option.some(Option.getOrElse(o, () => value)),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) => Option.filter(o, (v) => v !== value)),
    }),
  )

/** `#[serde(default)]` on a field that is always written. */
export const withDefault = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  Schema.optionalKey(Schema.toEncoded(schema)).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) =>
        Option.some(Option.getOrElse(o, () => value)),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) => o),
    }),
  )

/**
 * `#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]`: a map
 * that may be absent (read as empty) and is left out when empty.
 */
export const record = <S extends Schema.Top>(value: S) => {
  const encoded = Schema.Record(Schema.String, Schema.toEncoded(value))
  const decoded = Schema.Record(Schema.String, value)
  // The two sides are the same map; TypeScript cannot see it through the generics.
  type Map = typeof encoded.Type
  type To = typeof decoded.Encoded
  return Schema.optionalKey(encoded).pipe(
    Schema.decodeTo(decoded, {
      decode: SchemaGetter.transformOptional((o: Option.Option<Map>) =>
        // An absent map reads as an empty one.
        Option.some(Option.getOrElse(o, (): Map => ({}) as Map) as unknown as To),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<To>) =>
        Option.filter(o as unknown as Option.Option<Map>, (map) => Object.keys(map).length > 0),
      ),
    }),
  )
}

/**
 * `#[serde(default, skip_serializing_if = …)]` for any value: absent reads
 * as `fallback`; left out when `isDefault` says so.
 */
export const omitWhen = <S extends Schema.Top>(
  schema: S,
  fallback: S["Encoded"],
  isDefault: (encoded: S["Encoded"]) => boolean,
) =>
  Schema.optionalKey(Schema.toEncoded(schema)).pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) =>
        Option.some(Option.getOrElse(o, () => fallback)),
      ),
      encode: SchemaGetter.transformOptional((o: Option.Option<S["Encoded"]>) =>
        Option.filter(o, (v) => !isDefault(v)),
      ),
    }),
  )

/**
 * Rust's order for strings, which a `BTreeMap<String, _>` keeps: by UTF-8
 * bytes, which is code point order. UTF-16 order differs only where a
 * surrogate pair meets a character from U+E000 up, so those are compared
 * as the code points they make.
 */
export const byteOrder = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    if (x >= 0xd800 && y >= 0xd800) return codePointRank(x) - codePointRank(y)
    return x - y
  }
  return a.length - b.length
}

// Surrogates sort after the rest of the BMP, as the code points past it they encode.
const codePointRank = (unit: number): number => (unit >= 0xe000 ? unit - 0x800 : unit + 0x2000)

/** Pretty JSON as serde_json writes it (two-space indent), with a final newline. */
export const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** One compact JSON line, as `serde_json::to_string` writes it. */
export const compact = (value: unknown): string => JSON.stringify(value)

/**
 * `Map::remove` on a serde_json object, which slopmax builds with
 * `preserve_order`: a swap-remove, so the object's last key takes the
 * removed key's place. Returns whether the key was there.
 */
export const swapRemove = (object: json.JsonObject, key: string): boolean => {
  if (!Object.hasOwn(object, key)) return false
  const keys = Object.keys(object)
  const entries = keys.map((k): [string, json.Json | undefined] => [k, object[k]])
  const last = entries.pop()
  const at = keys.indexOf(key)
  if (last !== undefined && at < entries.length) entries[at] = last
  for (const k of keys) delete object[k]
  for (const [k, v] of entries) if (v !== undefined) object[k] = v
  return true
}

const I64_TEXT = /^-?[0-9]+$/

/**
 * `Value::as_i64`: an integer that fits in an `i64`, never a float (not
 * even `3.0`, which wire's reader keeps as written).
 */
export const i64 = (v: json.Json | undefined): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) < 2 ** 63 ? v : undefined
  // Past a plain number, wire's `f64` reads only a number kept as written.
  if (json.f64(v) === undefined) return undefined
  const text = (v as json.RawJson).rawJSON
  if (!I64_TEXT.test(text)) return undefined
  const n = BigInt(text)
  return n >= -(2n ** 63n) && n < 2n ** 63n ? Number(n) : undefined
}
