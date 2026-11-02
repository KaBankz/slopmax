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

/// How long until [`until`]`(at, now)` reads differently: a second while
/// it shows seconds, the rest of the minute while it shows minutes, the
/// rest of the hour beyond. `None` once it reads `now` for good. A front
/// end redraws a countdown then, and not every second.
pub fn next_change(at: Timestamp, now: Timestamp) -> Option<SignedDuration> {
    let left = at.duration_since(now).as_secs();
    // The text changes when the time left drops below a whole minute (or
    // hour), a second after it reaches one.
    let wait = match left {
        ..=0 => return None,
        1..3_600 => 1,
        3_600..86_400 => left % 60 + 1,
        _ => left % 3_600 + 1,
    };
    Some(SignedDuration::from_secs(wait))
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

#[cfg(test)]
mod next_change_tests {
    use super::*;

    #[test]
    fn a_countdown_changes_when_its_text_does() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let at = |secs: i64| now + SignedDuration::from_secs(secs);
        let wait = |secs: i64| next_change(at(secs), now).map(|d| d.as_secs());
        assert_eq!(wait(-5), None);
        assert_eq!(wait(0), None);
        assert_eq!(wait(59), Some(1));
        assert_eq!(wait(3_599), Some(1));
        // 1h00m30s reads `1h00m` until 59m59s, 31 seconds on.
        assert_eq!(wait(3_630), Some(31));
        assert_eq!(wait(7_200), Some(1));
        // 2d1h + 10 minutes reads `2d1h` until 2d0h, 601 seconds on.
        assert_eq!(wait(2 * 86_400 + 3_600 + 600), Some(601));
        // Each wait ends where the text changes.
        for secs in [61, 3_600, 3_601, 3_661, 86_400, 90_000, 200_123] {
            let before = until(at(secs), now);
            let step = next_change(at(secs), now).unwrap();
            let later = now + step;
            assert_ne!(until(at(secs), later), before, "{secs}");
            let just_before = later - SignedDuration::from_secs(1);
            assert_eq!(until(at(secs), just_before), before, "{secs}");
        }
    }
}
