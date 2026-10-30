// Numbers printed byte for byte as Rust prints them, so the CLI, the app,
// the dashboard, and the JSON slopmax writes read the same as the Rust's.
// `toFixed` and `String(x)` differ from Rust on exact ties (`0.125` to two
// places is `0.12` in Rust, `0.13` in JS), on whole floats (`25.0` vs `25`),
// and on where exponents start.

// A finite, non-negative value as `0.{digits} × 10^point`, digits without
// leading or trailing zeros (zero is `"0"` at point 1).
interface Decimal {
  readonly digits: string
  readonly point: number
}

const ZERO: Decimal = { digits: "0", point: 1 }

// Reads what `String`, `toPrecision`, or `${n}e${q}` print.
const decimal = (text: string): Decimal => {
  const e = text.indexOf("e")
  const mantissa = e < 0 ? text : text.slice(0, e)
  const exponent = e < 0 ? 0 : Number(text.slice(e + 1))
  const dot = mantissa.indexOf(".")
  const whole = dot < 0 ? mantissa : mantissa.slice(0, dot)
  let digits = dot < 0 ? whole : whole + mantissa.slice(dot + 1)
  let point = whole.length + exponent
  let lead = 0
  while (lead < digits.length && digits.charCodeAt(lead) === 48) lead++
  if (lead === digits.length) return ZERO
  digits = digits.slice(lead)
  point -= lead
  let end = digits.length
  while (digits.charCodeAt(end - 1) === 48) end--
  return { digits: digits.slice(0, end), point }
}

const view = new DataView(new ArrayBuffer(8))

// `a` (finite, non-negative) as `mantissa × 2^exponent`, exactly.
const binary = (a: number): readonly [bigint, number] => {
  view.setFloat64(0, a)
  const high = view.getUint32(0)
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(view.getUint32(4))
  const biased = high >>> 20
  return biased === 0 ? [mantissa, -1074] : [mantissa | (1n << 52n), biased - 1075]
}

// Whether `a` is exactly `units × 10^exponent`.
const exactly = (a: number, units: bigint, exponent: number): boolean => {
  const [mantissa, e] = binary(a)
  const left = (mantissa << BigInt(Math.max(e, 0))) * 10n ** BigInt(Math.max(-exponent, 0))
  const right = (units << BigInt(Math.max(-e, 0))) * 10n ** BigInt(Math.max(exponent, 0))
  return left === right
}

// How a value exactly halfway between two shortest candidates is settled:
// Rust's own formatting takes the larger, ryu (serde_json) the even one.
type Ties = "up" | "even"

// The value of `units × 10^exponent`, units in decimal digits.
const scaled = (units: string, exponent: number): Decimal => {
  let end = units.length
  while (end > 1 && units.charCodeAt(end - 1) === 48) end--
  return { digits: units.slice(0, end), point: units.length + exponent }
}

// Whether `a` (finite, positive) could lie exactly halfway between two
// candidates of `units × 10^exponent`. That midpoint ends in a 5 at
// `10^(exponent - 1)`, so `a` would have exactly `1 - exponent` fractional
// digits (one per binary fractional digit) or, for `exponent >= 1`, be an
// integer too large for every integer near it to be exact (below 2^53 for an
// f64, 2^24 for an f32, half an ulp is at most 0.5 and no tie fits).
const mayTie = (a: number, exponent: number, f32: boolean): boolean => {
  view.setFloat64(0, a)
  const high = view.getUint32(0)
  const low = view.getUint32(4)
  const biased = high >>> 20
  const top = (high & 0xfffff) | (biased === 0 ? 0 : 0x100000)
  const zeros = low !== 0 ? 31 - Math.clz32(low & -low) : 63 - Math.clz32(top & -top)
  const fraction = Math.max(0, -((biased === 0 ? -1074 : biased - 1075) + zeros))
  if (fraction === 0) return exponent >= 1 && a >= (f32 ? 16_777_216 : 9_007_199_254_740_992)
  return fraction === 1 - exponent
}

// Whether `a`'s significand is a power of two, where the interval of values
// that round to it is twice as wide above as below.
const powerOfTwo = (a: number): boolean => {
  view.setFloat64(0, a)
  return (view.getUint32(0) & 0xfffff) === 0 && view.getUint32(4) === 0
}

// The shortest digits `units × 10^exponent` that read back as `a`, the
// closest such when several do: what Rust's Display, Debug, and ryu start
// from. For an f64, JS's `String(number)` gives these. For an f32, the
// nearest `p`-digit number is tried for each `p`, and at powers of two,
// where the interval is lopsided, its neighbours too.
const shortest = (a: number, f32: boolean, ties: Ties): Decimal => {
  if (a === 0) return ZERO
  let units = ""
  let exponent = 0
  if (f32 && !powerOfTwo(a)) {
    // If the nearest `p`-digit number reads back, so does the nearest with
    // more digits (it is no further), so the least `p` can be bisected.
    let lo = 1
    let hi = 9
    while (lo < hi) {
      const p = (lo + hi) >> 1
      if (Math.fround(Number(a.toPrecision(p))) === a) hi = p
      else lo = p + 1
    }
    const near = decimal(a.toPrecision(lo))
    units = near.digits.padEnd(lo, "0")
    exponent = near.point - lo
  } else if (f32) {
    for (let p = 1; p <= 9; p++) {
      const text = a.toPrecision(p)
      const near = decimal(text)
      const q = near.point - p
      if (Math.fround(Number(text)) === a) {
        units = near.digits.padEnd(p, "0")
        exponent = q
        break
      }
      const n = BigInt(near.digits.padEnd(p, "0"))
      const found = [n - 1n, n + 1n].find((c) => Math.fround(Number(`${c}e${q}`)) === a)
      if (found !== undefined) {
        units = String(found)
        exponent = q
        break
      }
    }
  } else {
    const d = decimal(String(a))
    if (!mayTie(a, d.point - d.digits.length, false)) return d
    units = d.digits
    exponent = d.point - d.digits.length
  }
  if (f32 && !mayTie(a, exponent, true)) return scaled(units, exponent)
  return settle(a, f32, ties, BigInt(units), exponent)
}

// A candidate on the other side, exactly as close, is a tie to settle.
// Parsing the midpoint is a cheap test; the exact one runs only when it passes.
const settle = (a: number, f32: boolean, ties: Ties, units: bigint, exponent: number): Decimal => {
  const readsBack = (c: bigint): boolean => {
    const v = Number(`${c}e${exponent}`)
    return f32 ? Math.fround(v) === a : v === a
  }
  for (const other of [units + 1n, units - 1n]) {
    const low = other > units ? units : other
    const mid = low * 10n + 5n
    if (Number(`${mid}e${exponent - 1}`) === a && exactly(a, mid, exponent - 1) && readsBack(other)) {
      const larger = other > units ? other : units
      return scaled(String(ties === "up" ? larger : other % 2n === 0n ? other : units), exponent)
    }
  }
  return scaled(String(units), exponent)
}

const sign = (x: number): string => (x < 0 || Object.is(x, -0) ? "-" : "")

const nonFinite = (x: number): string | undefined =>
  x !== x ? "NaN" : x === Infinity ? "inf" : x === -Infinity ? "-inf" : undefined

// Plain positional notation with at least `minFraction` fractional digits.
const positional = ({ digits, point }: Decimal, minFraction: number): string => {
  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`
  if (point >= digits.length) {
    const whole = digits + "0".repeat(point - digits.length)
    return minFraction > 0 ? `${whole}.${"0".repeat(minFraction)}` : whole
  }
  return `${digits.slice(0, point)}.${digits.slice(point)}`
}

const scientific = ({ digits, point }: Decimal, plus: boolean): string => {
  const exponent = point - 1
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
  return `${mantissa}e${plus && exponent >= 0 ? "+" : ""}${exponent}`
}

// ryu's layout, which serde_json uses: positional up to `limit` integer
// digits and down to `low` leading zeros, else `1e+16`, `1.5e-7`.
const ryu = (d: Decimal, limit: number, low: number): string => {
  const { digits, point } = d
  const k = point - digits.length
  if (k >= 0 && point <= limit) return `${digits}${"0".repeat(k)}.0`
  if (point > 0 && point <= limit) return `${digits.slice(0, point)}.${digits.slice(point)}`
  if (point > low && point <= 0) return `0.${"0".repeat(-point)}${digits}`
  return scientific(d, true)
}

// Rust's Debug switches to exponent form outside [1e-4, 1e16).
const general = (x: number, d: Decimal): string => {
  const a = Math.abs(x)
  return (a !== 0 && a < 1e-4) || a >= 1e16 ? scientific(d, false) : positional(d, 1)
}

/** Rust's `{}` for an `f64`: shortest digits, never an exponent (`25`, `0.1`, `-0`). */
export const display = (x: number): string =>
  nonFinite(x) ?? sign(x) + positional(shortest(Math.abs(x), false, "up"), 0)

/** Rust's `{:?}` for an `f64`: `25.0`, `0.1`, `1e16`, `1e-5`. */
export const debug = (x: number): string => nonFinite(x) ?? sign(x) + general(x, shortest(Math.abs(x), false, "up"))

/** Rust's `{:e}` for an `f64`: `2.5e1`, `1e-7`. */
export const lowerExp = (x: number): string =>
  nonFinite(x) ?? sign(x) + scientific(shortest(Math.abs(x), false, "up"), false)

/** `serde_json`'s text for an `f64`: `25.0`, `0.1`, `1e+16`, `1e-6`; `null` when not finite. */
export const json = (x: number): string =>
  Number.isFinite(x) ? sign(x) + ryu(shortest(Math.abs(x), false, "even"), 16, -5) : "null"

/** Rust's `{}` for an `f32` (`x` is rounded to the nearest `f32` first). */
export const display32 = (x: number): string => {
  const f = Math.fround(x)
  return nonFinite(f) ?? sign(f) + positional(shortest(Math.abs(f), true, "up"), 0)
}

/** Rust's `{:?}` for an `f32`: `0.8333333`, `25.0`. */
export const debug32 = (x: number): string => {
  const f = Math.fround(x)
  return nonFinite(f) ?? sign(f) + general(f, shortest(Math.abs(f), true, "up"))
}

/** `serde_json`'s text for an `f32`: `0.8333333`, `1e+13`, `1e-7`; `null` when not finite. */
export const json32 = (x: number): string => {
  const f = Math.fround(x)
  return Number.isFinite(f) ? sign(f) + ryu(shortest(Math.abs(f), true, "even"), 13, -6) : "null"
}

// The exact binary value of `a` rounded half to even at `places` digits.
const exactFixed = (a: number, places: number): string => {
  const [mantissa, exponent] = binary(a)
  const widened = mantissa * 10n ** BigInt(places)
  let units: bigint
  if (exponent >= 0) {
    units = widened << BigInt(exponent)
  } else {
    const shift = BigInt(-exponent)
    units = widened >> shift
    const rest = widened - (units << shift)
    const half = 1n << (shift - 1n)
    if (rest > half || (rest === half && (units & 1n) === 1n)) units += 1n
  }
  const text = units.toString().padStart(places + 1, "0")
  return places === 0 ? text : `${text.slice(0, -places)}.${text.slice(-places)}`
}

/**
 * Rust's `{:.N}` for an `f64`: the exact binary value rounded half to even
 * (`0.125` → `0.12`, `2.5` → `2`, `1.005` → `1.00`), with a `-` kept on
 * negatives that round to zero (`-0.0`). For an `f32`, pass `Math.fround(x)`.
 */
export const fixed = (x: number, places: number): string => {
  const special = nonFinite(x)
  if (special !== undefined) return special
  const a = Math.abs(x)
  let body: string
  if (a < 1e21 && places < 100) {
    // `toFixed` is exact too, but breaks ties upward. A tie shows as a
    // trailing 5 one place further; only then is the slow path needed.
    body = a.toFixed(places)
    if (a.toFixed(places + 1).endsWith("5")) body = exactFixed(a, places)
  } else {
    body = exactFixed(a, places)
  }
  return sign(x) + body
}

/** Rust's `{:0W}` for an integer: zero-padded to `width`, the sign counted in it (`-05`). */
export const zeroPad = (n: number, width: number): string => {
  const digits = String(Math.abs(n))
  return n < 0 ? `-${digits.padStart(width - 1, "0")}` : digits.padStart(width, "0")
}

// `whole.frac` in a unit of `scale`, the fraction's trailing zeros dropped.
const unit = (whole: bigint, frac: bigint, scale: bigint, suffix: string): string => {
  let digits = ""
  let rest = frac
  let step = scale / 10n
  while (rest > 0n && step > 0n) {
    digits += String(rest / step)
    rest %= step
    step /= 10n
  }
  return `${whole}${digits === "" ? "" : `.${digits}`}${suffix}`
}

/**
 * Rust's `{:?}` for a `Duration` (`100ms`, `1.5s`, `600s`, `10µs`, `0ns`):
 * the largest unit the value reaches, with every nonzero fractional digit.
 * Takes nanoseconds.
 */
export const debugDuration = (nanos: bigint): string => {
  if (nanos >= 1_000_000_000n) return unit(nanos / 1_000_000_000n, nanos % 1_000_000_000n, 1_000_000_000n, "s")
  if (nanos >= 1_000_000n) return unit(nanos / 1_000_000n, nanos % 1_000_000n, 1_000_000n, "ms")
  if (nanos >= 1_000n) return unit(nanos / 1_000n, nanos % 1_000n, 1_000n, "µs")
  return `${nanos}ns`
}
