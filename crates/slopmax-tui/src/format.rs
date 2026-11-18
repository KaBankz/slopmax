//! The small words the pages are made of: times on the local clock, money,
//! counts, and the titles of usage windows, worded as the dashboard words
//! them.

use slopmax_client::api::ledger::Sender;
use slopmax_client::api::report::Window;
use slopmax_client::api::{Instant, Span, Tone};
use slopmax_common::human;
use slopmax_common::time::SignedDuration;

/// The moment a frame is drawn, and the local clock's offset from UTC, so
/// every time on screen agrees and tests can fix both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Now {
    pub at: Instant,
    pub offset: SignedDuration,
}

impl Now {
    pub fn local() -> Self {
        let at = Instant::now();
        Self {
            at,
            offset: at.local_offset(),
        }
    }

    /// The local day it is, as days since 1970-01-01.
    pub fn today(&self) -> i64 {
        self.day(self.at)
    }

    /// The local day `at` falls on, as days since 1970-01-01.
    fn day(&self, at: Instant) -> i64 {
        (at + self.offset).as_second().div_euclid(86_400)
    }

    /// `14:05` on the local clock.
    pub fn hm(&self, at: Instant) -> String {
        let (h, m) = at.time_of_day(self.offset);
        format!("{h:02}:{m:02}")
    }

    /// `14:05:09` on the local clock.
    pub fn hms(&self, at: Instant) -> String {
        let (h, m) = at.time_of_day(self.offset);
        let s = (at + self.offset).as_second().rem_euclid(60);
        format!("{h:02}:{m:02}:{s:02}")
    }

    /// When `at` comes: `22:59` today, `Wed 20:27` within the next six
    /// days, `Nov 3` otherwise.
    pub fn clock(&self, at: Instant) -> String {
        let ahead = self.day(at) - self.day(self.at);
        match ahead {
            0 => self.hm(at),
            1..=6 => format!("{} {}", weekday(self.day(at)), self.hm(at)),
            _ => self.month_day(at),
        }
    }

    /// When `at` was: `14:05:09` today, `Wed 14:05` this week, `Nov 3`.
    pub fn stamp(&self, at: Instant) -> String {
        let back = self.day(self.at) - self.day(at);
        match back {
            0 => self.hms(at),
            1..=6 => format!("{} {}", weekday(self.day(at)), self.hm(at)),
            _ => self.month_day(at),
        }
    }

    /// When `at` was, to the minute: `14:05` today, `Wed 14:05` this week,
    /// `Nov 3` before.
    pub fn clock_back(&self, at: Instant) -> String {
        match self.day(self.at) - self.day(at) {
            0 => self.hm(at),
            1..=6 => format!("{} {}", weekday(self.day(at)), self.hm(at)),
            _ => self.month_day(at),
        }
    }

    /// `Nov 3`.
    pub fn month_day(&self, at: Instant) -> String {
        let (_, month, day) = at.date(self.offset);
        let name = MONTHS.get(month as usize - 1).copied().unwrap_or("?");
        format!("{name} {day}")
    }

    /// Time left until `at`: `2h05m`, or `now` once it has passed.
    pub fn until(&self, at: Instant) -> String {
        human::until(at, self.at)
    }

    /// How long ago `at` was, coarsely: `just now`, `3m ago`, `2h ago`.
    pub fn ago(&self, at: Instant) -> String {
        let secs = self.at.duration_since(at).as_secs().max(0);
        match secs {
            s if s < 60 => "just now".into(),
            s if s < 3_600 => format!("{}m ago", s / 60),
            s if s < 86_400 => format!("{}h ago", s / 3_600),
            s => format!("{}d ago", s / 86_400),
        }
    }
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The weekday of a day counted from 1970-01-01, a Thursday.
fn weekday(day: i64) -> &'static str {
    ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(day + 3).rem_euclid(7) as usize]
}

/// `1,204`.
pub fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// `1.2M`.
pub fn compact(n: u64) -> String {
    human::compact(n)
}

/// `$1,204` from a thousand up, `$412.30` below.
pub fn dollars(amount: f64) -> String {
    if amount >= 1000.0 {
        format!("${}", grouped(amount.round() as u64))
    } else {
        format!("${amount:.2}")
    }
}

/// What some requests came to at API prices: `—` when none could be
/// priced, `$12.30+` when some could not.
pub fn priced(cost: f64, unpriced: u64, requests: u64) -> String {
    if unpriced > 0 && unpriced >= requests && requests > 0 {
        "—".into()
    } else if unpriced > 0 {
        format!("{}+", dollars(cost))
    } else {
        dollars(cost)
    }
}

/// `42%`.
pub fn percent(used: f64) -> String {
    format!("{used:.0}%")
}

/// `1 request`, `1,204 requests`.
pub fn count(n: u64, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{} {noun}s", grouped(n))
    }
}

/// `900 ms` below a second, `4.2 s` from one.
pub fn millis(ms: f64) -> String {
    if ms < 1000.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{:.1} s", ms / 1000.0)
    }
}

/// `5-hour`, `Weekly` or `Monthly`.
pub fn span_title(span: Span) -> &'static str {
    match span {
        Span::FiveHours => "5-hour",
        Span::Week => "Weekly",
        Span::Month => "Monthly",
    }
}

/// `Weekly`, or `Weekly · Fable` for a window on one model.
pub fn window_title(span: Span, model: Option<&str>) -> String {
    match model {
        Some(model) => format!("{} · {model}", span_title(span)),
        None => span_title(span).into(),
    }
}

/// Every word capitalized: `max 20x` → `Max 20x`.
pub fn title_case(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `a`, `a and b`, or `a, b, and c`.
pub fn listed(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} and {b}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

fn span_seconds(span: Span) -> i64 {
    match span {
        Span::FiveHours => 5 * 3_600,
        Span::Week => 7 * 86_400,
        Span::Month => 30 * 86_400,
    }
}

/// A window's use against spending it evenly until it resets: `Runs out
/// ~Wed 14:20 at the pace so far` when ahead of an even spend, else how
/// much is in reserve. The pool's forecast measures the recent pace instead.
pub fn pace(window: &Window, now: &Now) -> Option<(String, Tone)> {
    let used = window.used_at(now.at);
    let resets = window.upcoming_reset(now.at)?;
    let length = span_seconds(window.span);
    let passed = length - resets.duration_since(now.at).as_secs();
    let elapsed = passed as f64 / length as f64;
    if !(0.03..1.0).contains(&elapsed) || used >= 100.0 {
        return None;
    }
    let ahead = used - elapsed * 100.0;
    if ahead.abs() < 5.0 {
        return Some(("On pace".into(), Tone::Muted));
    }
    if ahead > 0.0 {
        let rate = used / passed as f64;
        let out = now.at + SignedDuration::from_secs(((100.0 - used) / rate) as i64);
        return Some((
            format!("Runs out ~{} at the pace so far", now.clock(out)),
            Tone::Warn,
        ));
    }
    Some((format!("{:.0}% in reserve", -ahead), Tone::Muted))
}

/// The agent that sent a request, by name.
pub fn agent_title(agent: Sender) -> &'static str {
    match agent {
        Sender::ClaudeCode => "Claude Code",
        Sender::Codex => "Codex",
        Sender::Slopmax => "slopmax",
    }
}

/// Text cut to `width` columns, with an ellipsis when cut.
pub fn fit(text: &str, width: usize) -> String {
    use ratatui::text::Line;
    if Line::from(text).width() <= width {
        return text.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = Line::from(c.to_string()).width();
        if used + w + 1 > width {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

/// A name cut to `width` columns as [`fit`] cuts text, but keeping a
/// trailing `(label)` whole where it fits, so `a@b.dev (Work)` loses its
/// address first: `a@b… (Work)`.
pub fn fit_name(name: &str, width: usize) -> String {
    use ratatui::text::Line;
    if Line::from(name).width() <= width {
        return name.to_owned();
    }
    match name.strip_suffix(')').and_then(|n| n.rsplit_once(" (")) {
        Some((base, label)) if !base.is_empty() => {
            let label = format!(" ({label})");
            let room = width.saturating_sub(Line::from(label.as_str()).width());
            // At least a few letters of the address, else plain cutting.
            if room >= 4 {
                format!("{}{label}", fit(base, room))
            } else {
                fit(name, width)
            }
        }
        _ => fit(name, width),
    }
}

/// Burn as `0.9%/h`, finer below a tenth, and `0%/h` for none.
pub fn rate(per_hour: f64) -> String {
    let text = if per_hour < 0.1 {
        format!("{per_hour:.2}")
    } else {
        format!("{per_hour:.1}")
    };
    if text.parse::<f64>().is_ok_and(|v| v == 0.0) {
        "0%/h".into()
    } else {
        format!("{text}%/h")
    }
}

/// The end of `text` that fits in `width` columns, after an ellipsis when
/// the start is cut: where a cursor typing at the end stays in view.
pub fn tail(text: &str, width: usize) -> String {
    use ratatui::text::Line;
    if Line::from(text).width() <= width {
        return text.to_owned();
    }
    if width == 0 {
        return String::new();
    }
    let mut kept = Vec::new();
    let mut used = 0;
    for c in text.chars().rev() {
        let w = Line::from(c.to_string()).width();
        if used + w + 1 > width {
            break;
        }
        kept.push(c);
        used += w;
    }
    std::iter::once('…').chain(kept.into_iter().rev()).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_name_keeps_its_label_as_it_is_cut() {
        assert_eq!(fit_name("a@b.dev (Work)", 20), "a@b.dev (Work)");
        assert_eq!(
            fit_name("someone@example.dev (Work)", 16),
            "someone@… (Work)"
        );
        assert_eq!(fit_name("someone@example.dev", 10), "someone@e…");
    }

    #[test]
    fn a_rate_of_nothing_reads_as_zero() {
        assert_eq!(rate(0.004), "0%/h");
        assert_eq!(rate(0.05), "0.05%/h");
        assert_eq!(rate(1.26), "1.3%/h");
    }

    use super::*;

    fn at(secs: i64) -> Instant {
        Instant::from_second(secs).unwrap()
    }

    /// Sunday 2026-11-01 12:00 UTC.
    fn now() -> Now {
        Now {
            at: "2026-11-01T12:00:00Z".parse().unwrap(),
            offset: SignedDuration::ZERO,
        }
    }

    #[test]
    fn times_read_as_the_clock_on_the_wall() {
        let now = now();
        let base = now.at.as_second();
        assert_eq!(now.clock(at(base + 3_600)), "13:00");
        assert_eq!(now.clock(at(base + 86_400)), "Mon 12:00");
        assert_eq!(now.clock(at(base + 10 * 86_400)), "Nov 11");
        assert_eq!(now.stamp(at(base - 5)), "11:59:55");
        assert_eq!(now.stamp(at(base - 86_400)), "Sat 12:00");
        assert_eq!(now.ago(at(base - 125)), "2m ago");
        assert_eq!(now.until(at(base + 7_500)), "2h05m");
        let east = Now {
            offset: SignedDuration::from_hours(13),
            ..now
        };
        assert_eq!(east.clock(at(base)), "01:00");
    }

    #[test]
    fn money_and_counts_read_as_on_the_dashboard() {
        assert_eq!(grouped(1_204_000), "1,204,000");
        assert_eq!(grouped(12), "12");
        assert_eq!(dollars(412.3), "$412.30");
        assert_eq!(dollars(1204.4), "$1,204");
        assert_eq!(priced(1.0, 2, 2), "—");
        assert_eq!(priced(1.0, 1, 2), "$1.00+");
        assert_eq!(count(1, "request"), "1 request");
        assert_eq!(count(3, "request"), "3 requests");
        assert_eq!(millis(900.0), "900 ms");
        assert_eq!(millis(4_200.0), "4.2 s");
        assert_eq!(title_case("max 20x"), "Max 20x");
        assert_eq!(listed(&["a".into(), "b".into(), "c".into()]), "a, b, and c");
        assert_eq!(fit("claude@example.com", 8), "claude@…");
        assert_eq!(fit("short", 8), "short");
        assert_eq!(tail("claude@example.com", 8), "…ple.com");
        assert_eq!(tail("short", 8), "short");
    }

    #[test]
    fn a_window_ahead_of_an_even_spend_runs_out_before_it_resets() {
        let now = now();
        // Half the 5 hours gone, 80% used: out in 37.5 minutes.
        let window = Window {
            span: Span::FiveHours,
            model: None,
            used: 80.0,
            resets_at: Some(now.at + SignedDuration::from_secs(9_000)),
        };
        assert_eq!(
            pace(&window, &now),
            Some(("Runs out ~12:37 at the pace so far".into(), Tone::Warn))
        );
        let easy = Window {
            used: 20.0,
            ..window.clone()
        };
        assert_eq!(
            pace(&easy, &now),
            Some(("30% in reserve".into(), Tone::Muted))
        );
    }
}
