import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { Effect, Result, Schema } from "effect"
import { TestClock } from "effect/testing"

import {
  civilFromDays,
  daysFromCivil,
  ParseError,
  SignedDuration,
  Timestamp,
  TimestampFromString,
} from "../src/time.ts"

const parse = (text: string): Timestamp => {
  const r = Timestamp.parse(text)
  if (Result.isFailure(r)) throw new Error(`${text} should parse`)
  return r.success
}

const fromSecond = (secs: number): Timestamp => {
  const t = Timestamp.fromSecond(secs)
  if (t === undefined) throw new Error(`${secs} is out of range`)
  return t
}

describe("time (Rust tests)", () => {
  it("parses_rfc3339_with_offsets_and_fractions", () => {
    expect(parse("1970-01-01T00:00:00Z")).toBe(Timestamp.UNIX_EPOCH)
    expect(Timestamp.asSecond(parse("2026-10-05T04:00:00+00:00"))).toBe(1_791_172_800)
    expect(Timestamp.asMillisecond(parse("2026-10-04T07:20:00.250378+00:00"))).toBe(1_791_098_400_250)
    expect(parse("2026-01-01T00:00:00-05:00")).toBe(parse("2026-01-01T05:00:00Z"))
    expect(parse("2026-01-01 05:30:00+0530")).toBe(parse("2026-01-01T00:00:00z"))
    expect(Timestamp.asSecond(parse("2024-02-29T12:00:00Z"))).toBe(1_709_208_000)
    expect(Timestamp.asMillisecond(parse("1969-12-31T23:59:59.5Z"))).toBe(-500)
  })

  it("rejects_malformed_timestamps", () => {
    for (const bad of [
      "",
      "2026-10-04",
      "2026-10-04T07:20:00",
      "2026-02-30T00:00:00Z",
      "2025-02-29T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-10-04T24:00:00Z",
      "2026-10-04T07:20:00.Z",
      "2026-10-04T07:20:00+25:00",
      "2026-10-04T07:20:00Zjunk",
      "２026-10-04T07:20:00Z",
    ]) {
      expect(Result.isFailure(Timestamp.parse(bad)), `${JSON.stringify(bad)} should not parse`).toBe(true)
    }
  })

  it("displays_minimal_rfc3339", () => {
    expect(Timestamp.display(Timestamp.UNIX_EPOCH)).toBe("1970-01-01T00:00:00Z")
    const t = fromSecond(1_791_580_389)
    expect(Timestamp.display(t)).toBe("2026-10-09T21:13:09Z")
    expect(Timestamp.display(Timestamp.add(t, SignedDuration.fromMillis(250)))).toBe("2026-10-09T21:13:09.25Z")
    expect(Timestamp.display(Timestamp.fromMillisecond(-1) ?? 0)).toBe("1969-12-31T23:59:59.999Z")
    expect(Timestamp.displayMillis(t)).toBe("2026-10-09T21:13:09.000Z")
  })

  // The Rust adds 123_456_789 ns; timestamps here hold milliseconds, so the
  // round trip is checked with the 123 ms they keep (see NOT-PORTED.md).
  it("round_trips_through_text_and_serde", () => {
    const encode = Schema.encodeSync(TimestampFromString)
    const decode = Schema.decodeUnknownSync(TimestampFromString)
    for (const secs of [0, 1, -1, 951_782_400, 1_709_208_000, 4_102_444_800]) {
      const t = Timestamp.add(fromSecond(secs), SignedDuration.fromMillis(123))
      expect(parse(Timestamp.display(t))).toBe(t)
      const json = JSON.stringify(encode(t))
      expect(decode(JSON.parse(json))).toBe(t)
    }
    // What jiff wrote in v0.1 state files still reads back.
    expect(Timestamp.asMillisecond(decode(JSON.parse(`"2026-10-04T03:12:24.855123456Z"`)))).toBe(1_791_083_544_855)
  })

  it("civil_conversion_matches_known_days", () => {
    const known: ReadonlyArray<readonly [number, readonly [number, number, number]]> = [
      [0, [1970, 1, 1]],
      [-1, [1969, 12, 31]],
      [11_016, [2000, 2, 29]],
      [20_730, [2026, 10, 4]],
      [-719_468, [0, 3, 1]],
    ]
    for (const [days, date] of known) {
      expect(civilFromDays(days)).toEqual(date)
      expect(daysFromCivil(date[0], date[1], date[2])).toBe(days)
    }
  })

  it("dates_shift_by_offset", () => {
    const t = parse("2026-10-04T23:30:00Z")
    expect(Timestamp.date(t, SignedDuration.ZERO)).toEqual([2026, 10, 4])
    expect(Timestamp.date(t, SignedDuration.fromHours(1))).toEqual([2026, 10, 5])
    expect(Timestamp.date(t, SignedDuration.fromHours(-24))).toEqual([2026, 10, 3])
    // Whatever the machine's zone, the offset is within a day.
    expect(Math.abs(SignedDuration.asSecs(Timestamp.localOffset(t)))).toBeLessThanOrEqual(14 * 3_600)
  })

  it("parses_http_dates", () => {
    expect(Timestamp.fromHttpDate("Sun, 06 Nov 1994 08:49:37 GMT")).toBe(Timestamp.fromSecond(784_111_777))
    expect(Timestamp.fromHttpDate("Sun, 06 Nov 1994 08:49:37 PST")).toBeUndefined()
    expect(Timestamp.fromHttpDate("120")).toBeUndefined()
  })

  it("arithmetic_saturates_and_measures", () => {
    const t = fromSecond(100)
    expect(Timestamp.durationSince(Timestamp.add(t, SignedDuration.fromMins(2)), t)).toBe(SignedDuration.fromSecs(120))
    expect(SignedDuration.asSecs(Timestamp.durationSince(t, Timestamp.add(t, SignedDuration.fromSecs(5))))).toBe(-5)
    expect(Timestamp.add(Timestamp.MAX, SignedDuration.fromHours(1))).toBe(Timestamp.MAX)
    expect(Timestamp.fromSecond(Number(9_223_372_036_854_775_807n))).toBeUndefined()
    expect(SignedDuration.isPositive(SignedDuration.fromSecsF64(0.5))).toBe(true)
    expect(SignedDuration.asMillis(SignedDuration.fromSecsF64(1.5))).toBe(1_500)
  })
})

describe("time (contract details)", () => {
  it("parsing trims, reads leap seconds as 59, and ignores digits past nine", () => {
    expect(parse("  2026-10-04T07:20:00Z\n")).toBe(parse("2026-10-04T07:20:00Z"))
    expect(parse("2026-10-04t07:20:00Z")).toBe(parse("2026-10-04T07:20:00Z"))
    expect(parse("2016-12-31T23:59:60Z")).toBe(parse("2016-12-31T23:59:59Z"))
    expect(parse("2026-10-04T07:20:00.1234567899999Z")).toBe(parse("2026-10-04T07:20:00.123Z"))
    expect(parse("2026-10-04T07:20:00.9999999Z")).toBe(parse("2026-10-04T07:20:00.999Z"))
    expect(parse("2026-10-04T07:20:00-0000")).toBe(parse("2026-10-04T07:20:00Z"))
    expect(parse("2026-10-04T07:20:00+23:59")).toBe(parse("2026-10-03T07:21:00Z"))
    for (const bad of [
      "2026-10-04T07:20:00+24:00",
      "2026-10-04T07:20:00+05:60",
      "2026-10-04T07:20:00+5:00",
      "2026-10-04T07:20:00+05:0a",
      "2026-10-04T07:20:00.5",
      "2026-10-04T07:60:00Z",
      "2026-00-04T07:20:00Z",
      "2026-10-00T07:20:00Z",
      "2026/10/04T07:20:00Z",
      "2026-10-04X07:20:00Z",
    ]) {
      expect(Result.isFailure(Timestamp.parse(bad)), bad).toBe(true)
    }
  })

  it("parsing keeps to the years the Rust's nanosecond range holds", () => {
    expect(Result.isFailure(Timestamp.parse("1677-01-01T00:00:00Z"))).toBe(true)
    expect(Result.isFailure(Timestamp.parse("2263-01-01T00:00:00Z"))).toBe(true)
    // i64::MAX nanoseconds is 2262-04-11T23:47:16.854775807Z.
    expect(Result.isSuccess(Timestamp.parse("2262-04-11T23:47:16.854775807Z"))).toBe(true)
    expect(Result.isFailure(Timestamp.parse("2262-04-11T23:47:16.854775808Z"))).toBe(true)
    expect(Result.isSuccess(Timestamp.parse("1678-01-01T00:00:00Z"))).toBe(true)
    expect(Timestamp.display(Timestamp.MAX)).toBe("2262-04-11T23:47:16.854Z")
  })

  it("a parse failure says invalid RFC 3339 timestamp", () => {
    const r = Timestamp.parse("yesterday")
    expect(Result.isFailure(r)).toBe(true)
    if (Result.isFailure(r)) {
      expect(r.failure).toBeInstanceOf(ParseError)
      expect(r.failure).toMatchObject({ _tag: "ParseError" })
      expect(r.failure.message).toBe("invalid RFC 3339 timestamp")
    }
    expect(() => Schema.decodeUnknownSync(TimestampFromString)("yesterday")).toThrow("invalid RFC 3339 timestamp")
    expect(() => Schema.decodeUnknownSync(TimestampFromString)(5)).toThrow()
  })

  it("only whole milliseconds encode, so what is written reads back", () => {
    const encode = Schema.encodeSync(TimestampFromString)
    expect(encode(1_500)).toBe("1970-01-01T00:00:01.5Z")
    expect(() => encode(1.5)).toThrow()
    expect(() => encode(Number.NaN)).toThrow()
    expect(() => encode(Infinity)).toThrow()
  })

  it("display drops trailing zeros and keeps at most milliseconds", () => {
    const t = fromSecond(1_791_580_389)
    expect(Timestamp.display(Timestamp.add(t, 100))).toBe("2026-10-09T21:13:09.1Z")
    expect(Timestamp.display(Timestamp.add(t, 120))).toBe("2026-10-09T21:13:09.12Z")
    expect(Timestamp.display(Timestamp.add(t, 123))).toBe("2026-10-09T21:13:09.123Z")
    expect(Timestamp.displayMillis(Timestamp.add(t, 250))).toBe("2026-10-09T21:13:09.250Z")
    expect(Timestamp.display(-1_500)).toBe("1969-12-31T23:59:58.5Z")
  })

  it("http dates are strict IMF-fixdate in GMT", () => {
    expect(Timestamp.fromHttpDate("  Sun, 06 Nov 1994 08:49:37 GMT ")).toBe(784_111_777_000)
    // Rust's integer parsing takes a leading `+`.
    expect(Timestamp.fromHttpDate("Sun, +6 Nov 1994 08:49:37 GMT")).toBe(784_111_777_000)
    for (const bad of [
      "Sunday, 06-Nov-94 08:49:37 GMT",
      "Sun Nov  6 08:49:37 1994",
      "Sun, 06 nov 1994 08:49:37 GMT",
      "Sun, 06 Nov 1994 08:49:37 GMT extra",
      "Sun, 06 Nov 1994 08:49 GMT",
      "Sun, 06 Nov 1994 08:49:37:00 GMT",
      "Sun, 31 Nov 1994 08:49:37 GMT",
      "Sun, 06  Nov 1994 08:49:37 GMT",
    ]) {
      expect(Timestamp.fromHttpDate(bad), bad).toBeUndefined()
    }
  })

  it("calendar helpers work at an offset", () => {
    const t = parse("2026-10-04T23:30:00Z")
    expect(Timestamp.timeOfDay(t, SignedDuration.ZERO)).toEqual([23, 30])
    expect(Timestamp.timeOfDay(t, SignedDuration.fromMins(45))).toEqual([0, 15])
    expect(Timestamp.midnight(2026, 10, 5, SignedDuration.fromHours(2))).toBe(parse("2026-10-04T22:00:00Z"))
    expect(Timestamp.midnight(2026, 10, 5, SignedDuration.fromHours(-5))).toBe(parse("2026-10-05T05:00:00Z"))
    expect(Timestamp.midnight(2026, 2, 29, SignedDuration.ZERO)).toBeUndefined()
    expect(Timestamp.date(-1, SignedDuration.ZERO)).toEqual([1969, 12, 31])
  })

  it("the local offset follows the zone, daylight saving included", () => {
    if (process.platform === "win32") return
    const saved = process.env.TZ
    try {
      process.env.TZ = "America/New_York"
      expect(Timestamp.localOffset(parse("2026-01-15T12:00:00Z"))).toBe(SignedDuration.fromHours(-5))
      expect(Timestamp.localOffset(parse("2026-07-15T12:00:00Z"))).toBe(SignedDuration.fromHours(-4))
      process.env.TZ = "Asia/Kolkata"
      expect(Timestamp.localOffset(parse("2026-07-15T12:00:00Z"))).toBe(SignedDuration.fromMins(330))
      process.env.TZ = "UTC"
      expect(Timestamp.localOffset(parse("2026-07-15T12:00:00Z"))).toBe(0)
      // Local mean time keeps its seconds, as `tm_gmtoff` does.
      process.env.TZ = "Africa/Monrovia"
      expect(Timestamp.localOffset(Timestamp.UNIX_EPOCH)).toBe(SignedDuration.fromSecs(-(44 * 60 + 30)))
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it("durations truncate toward zero and saturate", () => {
    expect(SignedDuration.asSecs(SignedDuration.fromMillis(-1_500))).toBe(-1)
    expect(SignedDuration.asSecs(SignedDuration.fromMillis(1_999))).toBe(1)
    expect(SignedDuration.fromHours(1)).toBe(3_600_000)
    expect(SignedDuration.fromSecsF64(Number.NaN)).toBe(0)
    expect(SignedDuration.fromSecsF64(Infinity)).toBe(Timestamp.MAX)
    expect(SignedDuration.fromSecs(-1e300)).toBe(-Timestamp.MAX)
    // i64::MIN nanoseconds, read as milliseconds rounding down (`as_millisecond`).
    expect(Timestamp.sub(-Timestamp.MAX, SignedDuration.fromHours(1))).toBe(-9_223_372_036_855)
    expect(Timestamp.display(Timestamp.sub(0, SignedDuration.fromSecs(-1e300)))).toBe(Timestamp.display(Timestamp.MAX))
    expect(Timestamp.display(Timestamp.sub(-Timestamp.MAX, SignedDuration.fromHours(1)))).toBe(
      "1677-09-21T00:12:43.145Z",
    )
    expect(Timestamp.fromMillisecond(Timestamp.MAX + 1)).toBeUndefined()
    expect(Timestamp.fromSecond(-9_223_372_036)).toBe(-9_223_372_036_000)
    expect(Timestamp.fromSecond(-9_223_372_037)).toBeUndefined()
  })

  it.effect("now reads the Clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_791_580_389_250)
      expect(Timestamp.display(yield* Timestamp.now)).toBe("2026-10-09T21:13:09.25Z")
    }),
  )
})
