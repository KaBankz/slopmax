// Instants as slopmax writes and reads them.
//
// Every file and API body carries times as RFC 3339 text in UTC. Reading is
// strict about the shape (a date alone, or a time without an offset, is not an
// instant) but takes what other programs write: any offset, a space or a
// lowercase `t` between date and time, and any number of fraction digits.
// Writing gives only the fraction digits a time needs, so whole seconds read
// `…:09Z`.
import { DateTime, Option } from "effect"

// The shape, with every field in range and an offset required. The platform's
// date parser reads the text once it fits; the shape is checked first because
// that parser also takes a date alone, or a time with no zone, and reads them
// as local time.
const rfc3339 =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])[Tt ](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/

/** Whether the month has that day: the date parser would roll `02-30` over into March. */
const dayExists = (year: number, month: number, day: number): boolean =>
  day <= 28 || DateTime.getPartUtc(DateTime.makeUnsafe({ year, month, day }), "day") === day

/** Reads an RFC 3339 instant, or nothing when the text is not one. */
export const parseInstant = (text: string): Option.Option<DateTime.Utc> => {
  const trimmed = text.trim()
  const fits =
    rfc3339.test(trimmed) &&
    dayExists(Number(trimmed.slice(0, 4)), Number(trimmed.slice(5, 7)), Number(trimmed.slice(8, 10)))
  if (!fits) return Option.none()
  // The shape guarantees a zone, so the text goes to the date parser as it is,
  // except that a leap second reads as the second before it. Only seconds can
  // be `:60` in a text that fits the shape.
  const epochMillis = Date.parse(trimmed.replace(":60", ":59"))
  return Number.isNaN(epochMillis) ? Option.none() : Option.some(DateTime.makeUnsafe(epochMillis))
}

/** RFC 3339 in UTC with only the fraction digits needed: `2026-10-09T21:13:09Z`, `…:09.25Z`. */
export const formatInstant = (at: DateTime.DateTime): string =>
  DateTime.formatIso(DateTime.toUtc(at)).replace(/\.(\d*?)0*Z$/, (_, kept: string) => (kept === "" ? "Z" : `.${kept}Z`))
