//! Wall-clock time: UTC instants and signed durations, with RFC 3339 and
//! HTTP-date parsing. Exactly what slopmax needs, without a date crate.

use std::fmt;
use std::ops::{Add, Sub};
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize, Serializer};

const NANOS_PER_SEC: i64 = 1_000_000_000;
const SECS_PER_DAY: i64 = 86_400;

/// A signed span of time with nanosecond precision.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SignedDuration(i64);

impl SignedDuration {
    pub const ZERO: Self = Self(0);

    pub const fn from_secs(secs: i64) -> Self {
        Self(secs.saturating_mul(NANOS_PER_SEC))
    }

    pub const fn from_mins(mins: i64) -> Self {
        Self::from_secs(mins.saturating_mul(60))
    }

    pub const fn from_hours(hours: i64) -> Self {
        Self::from_secs(hours.saturating_mul(3_600))
    }

    pub const fn from_millis(millis: i64) -> Self {
        Self(millis.saturating_mul(1_000_000))
    }

    /// Fractional seconds; out-of-range values saturate.
    pub fn from_secs_f64(secs: f64) -> Self {
        Self((secs * NANOS_PER_SEC as f64) as i64)
    }

    /// Whole seconds, rounded toward zero.
    pub const fn as_secs(self) -> i64 {
        self.0 / NANOS_PER_SEC
    }

    pub const fn as_millis(self) -> i64 {
        self.0 / 1_000_000
    }

    pub const fn is_positive(self) -> bool {
        self.0 > 0
    }
}

/// A UTC instant with nanosecond precision, covering the years 1678–2261.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

impl Timestamp {
    pub const UNIX_EPOCH: Self = Self(0);
    /// Later than any real instant; useful as a sort key for "never".
    pub const MAX: Self = Self(i64::MAX);

    pub fn now() -> Self {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(since) => Self(i64::try_from(since.as_nanos()).unwrap_or(i64::MAX)),
            Err(before) => Self(-i64::try_from(before.duration().as_nanos()).unwrap_or(i64::MAX)),
        }
    }

    /// Seconds since the Unix epoch, or `None` when out of range.
    pub const fn from_second(secs: i64) -> Option<Self> {
        match secs.checked_mul(NANOS_PER_SEC) {
            Some(nanos) => Some(Self(nanos)),
            None => None,
        }
    }

    /// Milliseconds since the Unix epoch, or `None` when out of range.
    pub const fn from_millisecond(millis: i64) -> Option<Self> {
        match millis.checked_mul(1_000_000) {
            Some(nanos) => Some(Self(nanos)),
            None => None,
        }
    }

    /// Whole seconds since the Unix epoch, rounded down.
    pub const fn as_second(self) -> i64 {
        self.0.div_euclid(NANOS_PER_SEC)
    }

    pub const fn as_millisecond(self) -> i64 {
        self.0.div_euclid(1_000_000)
    }

    /// `self - earlier`; negative when `earlier` is actually later.
    pub const fn duration_since(self, earlier: Self) -> SignedDuration {
        SignedDuration(self.0.saturating_sub(earlier.0))
    }

    /// Parses an IMF-fixdate HTTP date such as `Sun, 06 Nov 1994 08:49:37 GMT`.
    pub fn from_http_date(text: &str) -> Option<Self> {
        let rest = text.trim().split_once(", ")?.1;
        let mut parts = rest.split(' ');
        let day: u32 = parts.next()?.parse().ok()?;
        let month = parts.next()?;
        let month = MONTHS.iter().position(|m| *m == month)? as u32 + 1;
        let year: i64 = parts.next()?.parse().ok()?;
        let clock = parts.next()?;
        if parts.next()? != "GMT" || parts.next().is_some() {
            return None;
        }
        let mut clock = clock.split(':').map(|n| n.parse::<u32>().ok());
        let (hour, minute, second) = (clock.next()??, clock.next()??, clock.next()??);
        if clock.next().is_some() {
            return None;
        }
        let civil = Civil {
            year,
            month,
            day,
            hour,
            minute,
            second,
        };
        civil.to_timestamp(0, 0)
    }

    /// RFC 3339 in UTC with exactly three fractional digits, for aligned
    /// log lines: `2026-10-04T07:20:00.250Z`.
    pub fn display_millis(self) -> impl fmt::Display {
        struct Millis(Timestamp);
        impl fmt::Display for Millis {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                let (c, nanos) = self.0.civil();
                write!(
                    f,
                    "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                    c.year,
                    c.month,
                    c.day,
                    c.hour,
                    c.minute,
                    c.second,
                    nanos / 1_000_000
                )
            }
        }
        Millis(self)
    }

    fn civil(self) -> (Civil, u32) {
        let secs = self.as_second();
        let nanos = self.0.rem_euclid(NANOS_PER_SEC) as u32;
        let (year, month, day) = civil_from_days(secs.div_euclid(SECS_PER_DAY));
        let of_day = secs.rem_euclid(SECS_PER_DAY) as u32;
        let civil = Civil {
            year,
            month,
            day,
            hour: of_day / 3_600,
            minute: of_day / 60 % 60,
            second: of_day % 60,
        };
        (civil, nanos)
    }
}

impl Add<SignedDuration> for Timestamp {
    type Output = Self;

    fn add(self, rhs: SignedDuration) -> Self {
        Self(self.0.saturating_add(rhs.0))
    }
}

impl Sub<SignedDuration> for Timestamp {
    type Output = Self;

    fn sub(self, rhs: SignedDuration) -> Self {
        Self(self.0.saturating_sub(rhs.0))
    }
}

/// RFC 3339 in UTC, with only as many fractional digits as needed:
/// `2026-10-04T07:20:00Z`, `2026-10-04T07:20:00.25Z`.
impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (c, nanos) = self.civil();
        write!(
            f,
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
            c.year, c.month, c.day, c.hour, c.minute, c.second
        )?;
        if nanos > 0 {
            let digits = format!("{nanos:09}");
            write!(f, ".{}", digits.trim_end_matches('0'))?;
        }
        f.write_str("Z")
    }
}

/// The text is not an RFC 3339 timestamp with an offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseError;

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid RFC 3339 timestamp")
    }
}

impl std::error::Error for ParseError {}

/// RFC 3339: `2026-10-04T07:20:00.250378+00:00`, `2026-10-04 07:20:00Z`.
impl FromStr for Timestamp {
    type Err = ParseError;

    fn from_str(text: &str) -> Result<Self, ParseError> {
        let b = text.trim().as_bytes();
        let num = |range: std::ops::Range<usize>| -> Result<u32, ParseError> {
            let digits = b.get(range).ok_or(ParseError)?;
            if !digits.iter().all(u8::is_ascii_digit) {
                return Err(ParseError);
            }
            Ok(digits.iter().fold(0, |n, d| n * 10 + u32::from(d - b'0')))
        };
        let sep = |at: usize, allowed: &[u8]| match b.get(at) {
            Some(c) if allowed.contains(c) => Ok(()),
            _ => Err(ParseError),
        };
        sep(4, b"-")?;
        sep(7, b"-")?;
        sep(10, b"Tt ")?;
        sep(13, b":")?;
        sep(16, b":")?;
        let civil = Civil {
            year: i64::from(num(0..4)?),
            month: num(5..7)?,
            day: num(8..10)?,
            hour: num(11..13)?,
            minute: num(14..16)?,
            second: num(17..19)?.min(59),
        };

        let mut at = 19;
        let mut nanos = 0;
        if b.get(at) == Some(&b'.') {
            let digits = b[at + 1..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .count();
            if digits == 0 {
                return Err(ParseError);
            }
            for (i, d) in b[at + 1..at + 1 + digits].iter().enumerate().take(9) {
                nanos += u32::from(d - b'0') * 10u32.pow(8 - i as u32);
            }
            at += 1 + digits;
        }
        let offset = match &b[at..] {
            [b'Z' | b'z'] => 0,
            [sign @ (b'+' | b'-'), h1, h2, b':', m1, m2]
            | [sign @ (b'+' | b'-'), h1, h2, m1, m2] => {
                let digits = [*h1, *h2, *m1, *m2];
                if !digits.iter().all(u8::is_ascii_digit) {
                    return Err(ParseError);
                }
                let hours = i64::from((h1 - b'0') * 10 + (h2 - b'0'));
                let mins = i64::from((m1 - b'0') * 10 + (m2 - b'0'));
                if hours > 23 || mins > 59 {
                    return Err(ParseError);
                }
                let secs = hours * 3_600 + mins * 60;
                if *sign == b'-' { -secs } else { secs }
            }
            _ => return Err(ParseError),
        };
        civil.to_timestamp(offset, nanos).ok_or(ParseError)
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        text.parse().map_err(serde::de::Error::custom)
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// A proleptic Gregorian date and time of day.
struct Civil {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}

impl Civil {
    /// The instant this local time denotes at `offset` seconds east of UTC,
    /// or `None` if a field is out of range.
    fn to_timestamp(&self, offset: i64, nanos: u32) -> Option<Timestamp> {
        let valid = (1..=12).contains(&self.month)
            && (1..=days_in_month(self.year, self.month)).contains(&self.day)
            && self.hour < 24
            && self.minute < 60
            && self.second < 60;
        if !valid {
            return None;
        }
        let days = days_from_civil(self.year, self.month, self.day);
        let secs = days * SECS_PER_DAY
            + i64::from(self.hour * 3_600 + self.minute * 60 + self.second)
            - offset;
        let nanos = secs
            .checked_mul(NANOS_PER_SEC)?
            .checked_add(i64::from(nanos))?;
        Some(Timestamp(nanos))
    }
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let month_from_march = i64::from((month + 9) % 12);
    let day_of_year = (153 * month_from_march + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_from_march + 2) / 5 + 1) as u32;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Timestamp {
        text.parse()
            .unwrap_or_else(|_| panic!("{text} should parse"))
    }

    #[test]
    fn parses_rfc3339_with_offsets_and_fractions() {
        assert_eq!(parse("1970-01-01T00:00:00Z"), Timestamp::UNIX_EPOCH);
        assert_eq!(
            parse("2026-10-05T04:00:00+00:00").as_second(),
            1_791_172_800
        );
        assert_eq!(
            parse("2026-10-04T07:20:00.250378+00:00").as_millisecond(),
            1_791_098_400_250
        );
        assert_eq!(
            parse("2026-01-01T00:00:00-05:00"),
            parse("2026-01-01T05:00:00Z")
        );
        assert_eq!(
            parse("2026-01-01 05:30:00+0530"),
            parse("2026-01-01T00:00:00z")
        );
        assert_eq!(parse("2024-02-29T12:00:00Z").as_second(), 1_709_208_000);
        assert_eq!(parse("1969-12-31T23:59:59.5Z").as_millisecond(), -500);
    }

    #[test]
    fn rejects_malformed_timestamps() {
        for bad in [
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
        ] {
            assert!(
                bad.parse::<Timestamp>().is_err(),
                "{bad:?} should not parse"
            );
        }
    }

    #[test]
    fn displays_minimal_rfc3339() {
        assert_eq!(Timestamp::UNIX_EPOCH.to_string(), "1970-01-01T00:00:00Z");
        let t = Timestamp::from_second(1_791_580_389).unwrap();
        assert_eq!(t.to_string(), "2026-10-09T21:13:09Z");
        assert_eq!(
            (t + SignedDuration::from_millis(250)).to_string(),
            "2026-10-09T21:13:09.25Z"
        );
        assert_eq!(
            Timestamp::from_millisecond(-1).unwrap().to_string(),
            "1969-12-31T23:59:59.999Z"
        );
        assert_eq!(t.display_millis().to_string(), "2026-10-09T21:13:09.000Z");
    }

    #[test]
    fn round_trips_through_text_and_serde() {
        for secs in [0, 1, -1, 951_782_400, 1_709_208_000, 4_102_444_800] {
            let t = Timestamp::from_second(secs).unwrap() + SignedDuration(123_456_789);
            assert_eq!(parse(&t.to_string()), t);
            let json = serde_json::to_string(&t).unwrap();
            assert_eq!(serde_json::from_str::<Timestamp>(&json).unwrap(), t);
        }
        // What jiff wrote in v0.1 state files still reads back.
        assert_eq!(
            serde_json::from_str::<Timestamp>(r#""2026-10-04T03:12:24.855123456Z""#)
                .unwrap()
                .as_millisecond(),
            1_791_083_544_855
        );
    }

    #[test]
    fn civil_conversion_matches_known_days() {
        for (days, date) in [
            (0, (1970, 1, 1)),
            (-1, (1969, 12, 31)),
            (11_016, (2000, 2, 29)),
            (20_730, (2026, 10, 4)),
            (-719_468, (0, 3, 1)),
        ] {
            assert_eq!(civil_from_days(days), date);
            assert_eq!(days_from_civil(date.0, date.1, date.2), days);
        }
    }

    #[test]
    fn parses_http_dates() {
        assert_eq!(
            Timestamp::from_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Timestamp::from_second(784_111_777)
        );
        assert_eq!(
            Timestamp::from_http_date("Sun, 06 Nov 1994 08:49:37 PST"),
            None
        );
        assert_eq!(Timestamp::from_http_date("120"), None);
    }

    #[test]
    fn arithmetic_saturates_and_measures() {
        let t = Timestamp::from_second(100).unwrap();
        assert_eq!(
            (t + SignedDuration::from_mins(2)).duration_since(t),
            SignedDuration::from_secs(120)
        );
        assert_eq!(
            t.duration_since(t + SignedDuration::from_secs(5)).as_secs(),
            -5
        );
        assert_eq!(
            Timestamp::MAX + SignedDuration::from_hours(1),
            Timestamp::MAX
        );
        assert_eq!(Timestamp::from_second(i64::MAX), None);
        assert!(SignedDuration::from_secs_f64(0.5).is_positive());
        assert_eq!(SignedDuration::from_secs_f64(1.5).as_millis(), 1_500);
    }
}
