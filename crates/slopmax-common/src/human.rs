//! Durations and counts in short forms for people, shared by every place
//! that shows them, so the CLI, the app, and messages to agents read alike.

use crate::time::{SignedDuration, Timestamp};

/// A duration in its two most significant units: `3d4h`, `2h05m`, `9m30s`.
pub fn duration(d: SignedDuration) -> String {
    let secs = d.as_secs().max(0);
    let (days, hours, mins, s) = (
        secs / 86_400,
        secs % 86_400 / 3_600,
        secs % 3_600 / 60,
        secs % 60,
    );
    match (days, hours, mins) {
        (0, 0, 0) => format!("{s}s"),
        (0, 0, m) => format!("{m}m{s:02}s"),
        (0, h, m) => format!("{h}h{m:02}m"),
        (d, h, _) => format!("{d}d{h}h"),
    }
}

/// Time remaining until `at`, or `now` once it has passed.
pub fn until(at: Timestamp, now: Timestamp) -> String {
    let left = at.duration_since(now);
    if left.is_positive() {
        duration(left)
    } else {
        "now".into()
    }
}

/// A count in about three significant figures: `1234567` → `1.2M`.
pub fn compact(n: u64) -> String {
    match n {
        n if n >= 1_000_000_000 => format!("{:.1}B", n as f64 / 1e9),
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_use_two_units() {
        let f = |s| duration(SignedDuration::from_secs(s));
        assert_eq!(f(42), "42s");
        assert_eq!(f(9 * 60 + 30), "9m30s");
        assert_eq!(f(2 * 3600 + 5 * 60 + 59), "2h05m");
        assert_eq!(f(3 * 86_400 + 4 * 3600 + 120), "3d4h");
        assert_eq!(f(-5), "0s");
    }

    #[test]
    fn until_reports_now_when_passed() {
        let now = Timestamp::from_second(1_000).unwrap();
        assert_eq!(until(Timestamp::from_second(900).unwrap(), now), "now");
        assert_eq!(until(Timestamp::from_second(1_090).unwrap(), now), "1m30s");
    }

    #[test]
    fn counts_keep_three_figures() {
        assert_eq!(compact(999), "999");
        assert_eq!(compact(12_345), "12.3k");
        assert_eq!(compact(1_234_567), "1.2M");
        assert_eq!(compact(5_000_000_000), "5.0B");
    }
}
