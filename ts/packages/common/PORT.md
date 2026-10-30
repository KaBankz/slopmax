# @slopmax/common: port notes

The TypeScript port of `crates/slopmax-common`.

## Files

| Rust                                                     | TypeScript     | Notes                                                                                                                                                                                              |
| -------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib.rs`                                             | `src/index.ts` | Modules as namespaces (`time`, `human`, `ids`, `log`, plus `fmt`, `text`); `Timestamp`, `SignedDuration`, `ParseError`, `TimestampFromString` also at the top level. The package exports `.` only. |
| `src/time.rs`                                            | `src/time.ts`  | `Timestamp` and `SignedDuration` are a type plus an object of functions each (`Timestamp.parse`, `Timestamp.display`, …). serde is `TimestampFromString`, a `Schema`.                              |
| `src/human.rs`                                           | `src/human.ts` | One to one.                                                                                                                                                                                        |
| `src/ids.rs`                                             | `src/ids.ts`   | `random(n)` takes the length as an argument (Rust's const generic); `uuidV4` is `crypto.randomUUID()`.                                                                                             |
| `src/log.rs`                                             | `src/log.ts`   | Functions in place of macros, plus an Effect `Logger` and `layer`.                                                                                                                                 |
| (std's `{:.N}`, `{}`, `{:?}`, `{:e}`; serde_json floats) | `src/fmt.ts`   | New: numbers printed byte for byte as Rust prints them.                                                                                                                                            |
| (std's `chars()`, `{:<w$}`, `str::trim`)                 | `src/text.ts`  | New: width, cutting, and padding by characters.                                                                                                                                                    |

## Tests

|                                                | Count                                    |
| ---------------------------------------------- | ---------------------------------------- |
| Rust tests in `crates/slopmax-common`          | 17                                       |
| Ported with the Rust name                      | 17 (4 adapted, see `test/NOT-PORTED.md`) |
| Added for contract clauses and the new modules | 34                                       |
| Passing                                        | 51 of 51                                 |

`test/fmt.test.ts` also checks 850 values against
`test/fixtures/fmt-golden.tsv`, printed by rustc 1.99 and serde_json 1.0.151
from random f64 and f32 values, decimal-looking values, exact halves, powers
of two, and values exactly halfway between two shortest candidates. The
generator is `test/fixtures/fmt-golden.rs`.

## Contract items

| ID      | Where                                                                                                                                   | Tests                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| COM-001 | `time.ts` `Timestamp`, `saturate`                                                                                                       | `arithmetic_saturates_and_measures`, "durations truncate toward zero and saturate"                                                   |
| COM-002 | `Timestamp.display`, `TimestampFromString`                                                                                              | `displays_minimal_rfc3339`, `round_trips_through_text_and_serde`, "display drops trailing zeros…"                                    |
| COM-003 | `Timestamp.displayMillis`                                                                                                               | `displays_minimal_rfc3339`, "lines read {time} {LABEL} {message}…"                                                                   |
| COM-004 | `Timestamp.parse`                                                                                                                       | `parses_rfc3339_with_offsets_and_fractions`, `rejects_malformed_timestamps`, "parsing trims…", "parsing keeps to the years…"         |
| COM-005 | `Timestamp.fromHttpDate`                                                                                                                | `parses_http_dates`, "http dates are strict IMF-fixdate in GMT"                                                                      |
| COM-006 | `Timestamp.date`, `timeOfDay`, `midnight`, `daysFromCivil`, `civilFromDays`                                                             | `civil_conversion_matches_known_days`, `dates_shift_by_offset`, "calendar helpers work at an offset"                                 |
| COM-007 | `Timestamp.localOffset`                                                                                                                 | `dates_shift_by_offset`, "the local offset follows the zone, daylight saving included"                                               |
| COM-008 | `SignedDuration`                                                                                                                        | `arithmetic_saturates_and_measures`, "durations truncate toward zero and saturate"                                                   |
| COM-010 | `ids.ts`                                                                                                                                | `shapes`, "tokens are base64url…", "sha256 matches the standard vectors"                                                             |
| COM-011 | `log.ts`                                                                                                                                | the five Rust log tests, "lines read…", "the last directive…", "init reads SLOPMAX_LOG…", "Effect's log calls go through the layer…" |
| COM-012 | `human.ts` (with `fmt.fixed`)                                                                                                           | `durations_use_two_units`, `until_reports_now_when_passed`, `counts_keep_three_figures`, "counts round half to even at one decimal"  |
| COM-020 | `log.init` reads `SLOPMAX_LOG` and `NO_COLOR` through `Config`                                                                          | "init reads SLOPMAX_LOG…"                                                                                                            |
| COM-021 | `ParseError` (message `invalid RFC 3339 timestamp`, also the `Schema` issue); `ids.random` throws `operating system RNG is unavailable` | "a parse failure says invalid RFC 3339 timestamp"                                                                                    |

## What the other packages get

- `fmt.fixed(x, n)`: Rust's `{:.N}`, exact value rounded half to even
  (`0.125` → `0.12`, `-0.04` → `-0.0`). Use it wherever the Rust writes
  `{:.N}`; never `toFixed`. For an `f32` pass `Math.fround(x)`.
- `fmt.display` / `fmt.debug` / `fmt.lowerExp`: Rust's `{}`, `{:?}`, `{:e}`
  for `f64` (`25`, `25.0`, `2.5e1`); `display32` / `debug32` for `f32`.
- `fmt.json` / `fmt.json32`: serde_json's float text (`25.0`, `1e+16`,
  `0.8333333`, `null` when not finite), for byte-identical JSON and headers.
  Build the JSON around it; `JSON.stringify` writes `25`.
- `fmt.zeroPad(n, w)`: `{:0w}`.
- `fmt.debugDuration(nanos)`: `{:?}` of a `Duration` (`100ms`, `1.5s`).
- `text.width` / `take` / `truncate` / `padEnd` / `padStart` / `padCenter`:
  by code points, as `chars()` and `{:<w$}` count. `text.trim` is Rust's
  `str::trim`; `text.asciiLowercase` is `to_ascii_lowercase`; `text.debug`
  is `{:?}` of a `str`.
- `Timestamp.now` is `Clock.currentTimeMillis` (TestClock drives it);
  `Timestamp.nowUnsafe()` reads the system clock for code outside Effect.
- `TimestampFromString` for every timestamp slopmax stores (state.json,
  ledger lines, account files). Encoding fails on a number that is not a
  whole millisecond, so nothing is written that would not read back.
- `log.layer(Level.Info)` at the edge of `serve`, `log.layer(Level.Warn)`
  for other commands, as the Rust's `main` picks. It also sets Effect's
  `MinimumLogLevel` from the level read, so disabled `Effect.logDebug` calls
  are dropped before an entry is built.
- The CLI's edge should provide
  `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`: Rust's `var_os`
  counts a variable set to the empty string as set (`NO_COLOR=`), and
  Effect's default provider reads it as unset.

## Deviations from the Rust, and why

- **Milliseconds, not nanoseconds.** DECISIONS.md settles timestamps as epoch
  milliseconds. Parsing accepts any number of fractional digits and cuts to
  the millisecond (rounding down, as `as_millisecond` does); display prints at
  most three digits. The accepted range is still the Rust's i64 of nanoseconds
  (text past `2262-04-11T23:47:16.854775807Z` is rejected). Timestamps
  saturate at -9 223 372 036 855 and 9 223 372 036 854 ms, i64::MIN and
  i64::MAX nanoseconds read as `as_millisecond` reads them (rounding down);
  durations at ±9 223 372 036 854 ms, as `as_millis` (toward zero) reads
  them. So `Timestamp.MAX` prints as `2262-04-11T23:47:16.854Z` where the
  Rust prints `…16.854775807Z`, and sums that land within a millisecond of
  the ends can differ from the Rust's by that millisecond.
- **`SignedDuration` is a millisecond number**, not an Effect `Duration`.
  The Rust's is a plain saturating integer used in instant arithmetic all over
  the pool and the ledger; a number keeps that allocation-free and comparable
  with `===`, and any millisecond number is already a `Duration.Input`, so it
  passes straight to `Effect.sleep` and `Schedule`. `fromSecsF64` keeps whole
  milliseconds, so spans under 1 ms are zero (the Rust keeps nanoseconds).
- **Optional results are `T | undefined`**, Rust's `Option` in the plain
  functions (`fromSecond`, `fromHttpDate`, `midnight`). `Timestamp.parse`
  returns `Result<Timestamp, ParseError>` as `FromStr` does.
- **The logger also serves Effect.** The Rust's process-wide level and color
  stay module state (`configure`, `enabled`, `write`, `error`/`warn`/`info`).
  `init` reads the environment through `Config` so tests set it with a
  `ConfigProvider`; `logger`/`layer` route `Effect.log*` into the same format
  and level (Effect's `Fatal` → `ERROR`, `Trace` → `DEBUG`), with the time
  from the fiber's Clock.
- **`NO_COLOR` set to the empty string** counts as set, as in Rust, when the
  edge provides `ConfigProvider.fromEnv({ preserveEmptyStrings: true })`
  (tested). Under Effect's default provider, which drops empty values, it
  reads as unset. Every non-empty value turns color off either way.
- **Local offset** is the instant's local fields (`getHours`, …, `getSeconds`)
  read back as UTC, less the instant: like `localtime_r`'s `tm_gmtoff`, it
  honors daylight saving at that instant and keeps the seconds of old
  local-mean-time offsets (Monrovia's -0:44:30 in 1970), which
  `getTimezoneOffset` cuts to whole minutes. The zone data is the runtime's
  (ICU) rather than the system's, so the two may disagree on a zone's
  history before 1970. Windows returns zero to match the Rust; dropping that
  check is all it takes to follow the Windows zone.
- **The logger's level is read once into Effect.** `log.layer` gives Effect's
  `MinimumLogLevel` the level `init` read (`Off` → `None`, `Debug` →
  `Trace`); a later `log.configure` changes the plain functions and the
  logger's own check, not Effect's minimum.
- **`sha256`** also takes a string (hashed as UTF-8).

## Performance

Bun 1.4.4, per call: `Timestamp.parse` 180 ns (`…Z`), 235 ns (nine
fractional digits and an offset), 45 ns on bad text; decoding through
`TimestampFromString` 390 ns; `fmt.json` 410 ns on a random f64, 105 ns on
an integer; `fmt.debug` 490 ns; `fmt.json32` 1.4 µs; `localOffset` 160 ns.

- `parse` shares one `ParseError` failure (it carries no data) and reads
  digits in place; building an Error, with its stack, on every call was more
  than half its cost.
- `fmt`'s shortest digits run the exact tie check (BigInt) only when the
  value could be a tie: it must have exactly one more fractional digit than
  the candidate, or be an integer at or above 2^53 (2^24 for an f32). An
  f32's digit count is bisected. A differential run of 7.8 million values
  (random bits, decimals, halves, powers of two, large integers) against the
  first version gave identical digits.

## Left for later

- `text.debug` (`{:?}` of a `str`) classifies characters with the runtime's
  Unicode tables (`\p{…}`), which can differ from the Rust's for characters
  assigned in a Unicode version only one of them knows.
