import { describe, expect } from "bun:test"
import { it } from "@slopmax/test"
import { DateTime, Option, Result, Schema } from "effect"
import { formatInstant, Instant, parseInstant } from "../src/index.ts"

const millis = (text: string) => Option.map(parseInstant(text), DateTime.toEpochMillis)
const at = (ms: number) => DateTime.makeUnsafe(ms)

describe("Instant", () => {
  it("reads RFC 3339 with any offset, a space or lowercase separator, and any fraction", () => {
    expect(millis("1970-01-01T00:00:00Z")).toEqual(Option.some(0))
    expect(millis("2026-10-05T04:00:00+00:00")).toEqual(Option.some(1_791_172_800_000))
    expect(millis("2026-10-04T07:20:00.250378+00:00")).toEqual(Option.some(1_791_098_400_250))
    expect(millis("2026-01-01T00:00:00-05:00")).toEqual(millis("2026-01-01T05:00:00Z"))
    expect(millis("2026-01-01 05:30:00+0530")).toEqual(millis("2026-01-01T00:00:00z"))
    expect(millis("  2024-02-29t12:00:00Z ")).toEqual(Option.some(1_709_208_000_000))
    expect(millis("1969-12-31T23:59:59.5Z")).toEqual(Option.some(-500))
    // A leap second reads as the second before it.
    expect(millis("2016-12-31T23:59:60Z")).toEqual(millis("2016-12-31T23:59:59Z"))
    // Times written with nanoseconds still read, to the millisecond.
    expect(millis("2026-10-04T03:12:24.855123456Z")).toEqual(Option.some(1_791_083_544_855))
  })

  it("refuses text that is not an instant", () => {
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
      expect(parseInstant(bad)).toEqual(Option.none())
    }
  })

  it("writes UTC with only the fraction digits a time needs", () => {
    expect(formatInstant(at(0))).toBe("1970-01-01T00:00:00Z")
    expect(formatInstant(at(1_791_580_389_000))).toBe("2026-10-09T21:13:09Z")
    expect(formatInstant(at(1_791_580_389_250))).toBe("2026-10-09T21:13:09.25Z")
    expect(formatInstant(at(1_791_580_390_000))).toBe("2026-10-09T21:13:10Z")
    expect(formatInstant(at(-1))).toBe("1969-12-31T23:59:59.999Z")
    const zoned = DateTime.makeZonedUnsafe(0, { timeZone: DateTime.zoneMakeOffset(3_600_000) })
    expect(formatInstant(zoned)).toBe("1970-01-01T00:00:00Z")
  })

  it("round trips through text and JSON", () => {
    const decode = Schema.decodeUnknownSync(Instant)
    const encode = Schema.encodeSync(Instant)
    for (const seconds of [0, 1, -1, 951_782_400, 1_709_208_000, 4_102_444_800]) {
      const time = at(seconds * 1000 + 123)
      expect(DateTime.toEpochMillis(Option.getOrThrow(parseInstant(formatInstant(time))))).toBe(seconds * 1000 + 123)
      expect(DateTime.toEpochMillis(decode(JSON.parse(JSON.stringify(encode(time)))))).toBe(seconds * 1000 + 123)
    }
  })

  it("says a malformed time is not an RFC 3339 timestamp", () => {
    const result = Schema.decodeUnknownResult(Instant)("yesterday")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain("invalid RFC 3339 timestamp")
  })

  it("reads each date onto its own day, across leap years and before 1970", () => {
    for (const [date, days] of [
      ["1970-01-01", 0],
      ["1969-12-31", -1],
      ["2000-02-29", 11_016],
      ["2026-10-04", 20_730],
      ["1600-03-01", -135_080],
    ] as const) {
      expect(millis(`${date}T00:00:00Z`)).toEqual(Option.some(days * 86_400_000))
    }
  })

  it("shifts dates by the zone they are read in", () => {
    const t = Option.getOrThrow(parseInstant("2026-10-04T23:30:00Z"))
    const dateIn = (hours: number) =>
      DateTime.formatIsoDate(DateTime.setZone(t, DateTime.zoneMakeOffset(hours * 3_600_000)))
    expect(dateIn(0)).toBe("2026-10-04")
    expect(dateIn(1)).toBe("2026-10-05")
    expect(dateIn(-24)).toBe("2026-10-03")
  })
})

describe("parseHttpDate", () => {})
