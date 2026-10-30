//! Usage windows and refusals: the shared model providers parse into.
//!
//! Responses carry rate-limit headers and providers expose usage endpoints;
//! each provider folds its own formats into one [`Limits`] model of
//! percentage windows with reset times, which drives routing and the status
//! display. Refused requests are classified into a [`Refusal`]. The header
//! and time helpers here are shared by the provider parsers.

use http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::time::{SignedDuration, Timestamp};

/// A usage window, e.g. Claude's 5-hour session or ChatGPT's weekly limit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Window {
    /// Nominal length: `5h`, `7d`, or `30d`.
    pub span: String,
    /// Model the limit is scoped to, or `None` when it covers every request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Percent used, 0 to 100.
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<Timestamp>,
}

impl Window {
    pub(crate) fn new(span: &str, used: f64, resets_at: Option<Timestamp>) -> Self {
        Self {
            span: span.into(),
            model: None,
            used: used.clamp(0.0, 100.0),
            resets_at,
        }
    }

    /// Percent used at `now`; a window whose reset has passed starts over.
    pub fn used_at(&self, now: Timestamp) -> f64 {
        match self.resets_at {
            Some(at) if at <= now => 0.0,
            _ => self.used,
        }
    }

    /// The reset time, if it is still ahead.
    pub fn upcoming_reset(&self, now: Timestamp) -> Option<Timestamp> {
        self.resets_at.filter(|at| *at > now)
    }

    pub fn is_full(&self, now: Timestamp) -> bool {
        self.used_at(now) >= 100.0
    }

    /// Display label such as `5h`, `7d`, or `7d Fable`.
    pub fn label(&self) -> String {
        match &self.model {
            Some(model) => format!("{} {model}", self.span),
            None => self.span.clone(),
        }
    }

    fn same_slot(&self, other: &Window) -> bool {
        self.span == other.span && self.model == other.model
    }
}

/// Classifies a window by its length so the 5h/weekly/monthly split survives
/// plan changes (ChatGPT Pro has no 5-hour window; Team may be monthly).
pub(crate) fn span_for(seconds: i64) -> &'static str {
    const DAY: i64 = 86_400;
    match seconds {
        s if s < DAY => "5h",
        s if s >= 28 * DAY => "30d",
        _ => "7d",
    }
}

/// Last known usage windows for one account.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<Window>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_at: Option<Timestamp>,
    /// Codex: banked credits that reset a rate-limit window when redeemed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<u32>,
}

/// A window that ran out its time, and how much of it was used: what was
/// left is quota the reset threw away.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Lapse {
    pub span: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Percent used when it was last read before the reset.
    pub used: f64,
    pub ended_at: Timestamp,
}

/// Score for accounts with no usage data: worse than any real reading but
/// still selectable, so an unmeasured account never looks empty.
pub const UNKNOWN_SCORE: f64 = 101.0;

/// Age after which a reading without reset times no longer blocks.
const STALE_AFTER: SignedDuration = SignedDuration::from_mins(5);

impl Limits {
    /// A reading taken at `now`, or `None` when it carries no windows.
    pub(crate) fn observed(windows: Vec<Window>, now: Timestamp) -> Option<Self> {
        (!windows.is_empty()).then_some(Self {
            windows,
            observed_at: Some(now),
            reset_credits: None,
        })
    }

    /// Merges a newer observation. Windows it carries replace older readings
    /// of the same slot; slots it omits are kept unless their reset passed.
    pub fn merge(&mut self, newer: Limits) {
        let now = newer.observed_at.unwrap_or_else(Timestamp::now);
        self.windows.retain(|old| {
            !newer.windows.iter().any(|w| w.same_slot(old))
                && old.resets_at.is_none_or(|at| at > now)
        });
        self.windows.extend(newer.windows);
        self.windows
            .sort_by(|a, b| (span_rank(&a.span), &a.model).cmp(&(span_rank(&b.span), &b.model)));
        self.observed_at = newer.observed_at.or(self.observed_at);
        if newer.reset_credits.is_some() {
            self.reset_credits = newer.reset_credits;
        }
    }

    /// The windows of this reading that `newer`, taken at `now`, shows
    /// have reset: their time passed, or a later period of the same slot
    /// began. Each is reported once, as merging then drops it.
    pub fn lapsed(&self, newer: &Limits, now: Timestamp) -> Vec<Lapse> {
        self.windows
            .iter()
            .filter_map(|old| {
                let ended = old.resets_at?;
                let next_period = newer.windows.iter().any(|w| {
                    w.same_slot(old)
                        && w.resets_at
                            .is_some_and(|at| at > ended + SignedDuration::from_hours(1))
                });
                (ended <= now || next_period).then(|| Lapse {
                    span: old.span.clone(),
                    model: old.model.clone(),
                    used: old.used,
                    ended_at: ended,
                })
            })
            .collect()
    }

    /// Windows that apply to every request, as opposed to one model.
    fn shared(&self) -> impl Iterator<Item = &Window> {
        self.windows.iter().filter(|w| w.model.is_none())
    }

    /// Highest usage across shared windows, or [`UNKNOWN_SCORE`].
    pub fn score(&self, now: Timestamp) -> f64 {
        self.shared()
            .map(|w| w.used_at(now))
            .reduce(f64::max)
            .unwrap_or(UNKNOWN_SCORE)
    }

    /// Shared windows that are full. A full window without a reset time
    /// only counts while the reading is fresh, so stale data cannot park an
    /// account forever.
    fn full(&self, now: Timestamp) -> impl Iterator<Item = &Window> {
        let fresh = self
            .observed_at
            .is_some_and(|at| now.duration_since(at) < STALE_AFTER);
        self.shared()
            .filter(move |w| w.is_full(now) && (fresh || w.upcoming_reset(now).is_some()))
    }

    /// If a shared window is full, when the account is usable again: the
    /// latest reset among full windows, since every one of them must reopen.
    pub fn exhausted_until(&self, now: Timestamp) -> Option<Timestamp> {
        self.full(now).filter_map(|w| w.upcoming_reset(now)).max()
    }

    pub fn is_exhausted(&self, now: Timestamp) -> bool {
        self.full(now).next().is_some()
    }

    /// How soon this account's spare capacity is lost, for spending it
    /// first; earlier sorts first. A long window (week or month) with room
    /// left that resets within [`URGENT`] comes before everything: its
    /// unused quota is the plan's fee thrown away. Then the soonest started
    /// 5-hour window, whose quota is lost at its reset too, then the
    /// soonest long window.
    pub fn urgency(&self, now: Timestamp) -> Urgency {
        let spare = |w: &&Window| !w.is_full(now);
        let long = self
            .shared()
            .filter(|w| w.span != "5h")
            .filter(spare)
            .filter_map(|w| w.upcoming_reset(now))
            .min();
        let short = self
            .shared()
            .filter(|w| w.span == "5h" && w.used_at(now) > 0.0)
            .filter(spare)
            .filter_map(|w| w.upcoming_reset(now))
            .min();
        Urgency {
            week_ending: long.filter(|at| *at <= now + URGENT),
            short,
            long,
        }
    }

    /// The soonest moment some spare capacity on this account expires, if
    /// any is known to.
    pub fn expiring_at(&self, now: Timestamp) -> Option<Timestamp> {
        let urgency = self.urgency(now);
        urgency.week_ending.or(urgency.short).or(urgency.long)
    }
}

/// How close a long window's reset must be for its spare quota to come
/// before every 5-hour window's.
pub const URGENT: SignedDuration = SignedDuration::from_hours(24);

/// When an account's spare capacity is lost, as [`Limits::urgency`] orders
/// it: compare the fields in order, `None` last.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Urgency {
    /// A long window with room left that resets within [`URGENT`].
    pub week_ending: Option<Timestamp>,
    /// The soonest started 5-hour window with room left.
    pub short: Option<Timestamp>,
    /// The soonest long window with room left.
    pub long: Option<Timestamp>,
}

impl Urgency {
    /// A key that sorts the most urgent first.
    pub fn key(self) -> (Timestamp, Timestamp, Timestamp) {
        let last = |at: Option<Timestamp>| at.unwrap_or(Timestamp::MAX);
        (last(self.week_ending), last(self.short), last(self.long))
    }
}

/// One window of a pool of accounts, read as if they were one account.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PoolWindow {
    /// `5h`, `7d`, or `30d`.
    pub span: &'static str,
    /// Percent used: the mean of the accounts' usage.
    pub used: f64,
    /// When capacity next comes back: the soonest reset of a window in
    /// use.
    pub resets_at: Option<Timestamp>,
}

impl PoolWindow {
    /// The window's length in minutes, as Codex states it.
    pub fn minutes(&self) -> i64 {
        match self.span {
            "5h" => 300,
            "30d" => 43_200,
            _ => 10_080,
        }
    }
}

/// The windows of a pool of accounts, each given by its limits and whether
/// it sits out (a blocked account counts as full in its shortest window).
/// Accounts without a reading for a window are left out of its mean.
pub fn pooled<'a>(
    accounts: impl IntoIterator<Item = (&'a Limits, bool)>,
    now: Timestamp,
) -> Vec<PoolWindow> {
    pooled_by(accounts.into_iter().map(|(l, b)| (l, b, 1.0)), now)
}

/// [`pooled`], each account weighted by its share of the pool's capacity,
/// so a large plan's usage counts for more than a small one's.
pub fn pooled_by<'a>(
    accounts: impl IntoIterator<Item = (&'a Limits, bool, f64)>,
    now: Timestamp,
) -> Vec<PoolWindow> {
    let accounts: Vec<(&Limits, bool, f64)> = accounts.into_iter().collect();
    let mut windows = Vec::new();
    for span in ["5h", "7d", "30d"] {
        let readings: Vec<(f64, Option<Timestamp>, f64)> = accounts
            .iter()
            .filter_map(|(limits, blocked, weight)| {
                let window = limits.shared().find(|w| w.span == span)?;
                let shortest = limits.shared().map(|w| span_rank(&w.span)).min();
                let used = match blocked {
                    true if shortest == Some(span_rank(span)) => 100.0,
                    _ => window.used_at(now),
                };
                Some((used, window.upcoming_reset(now), *weight))
            })
            .collect();
        let weight: f64 = readings.iter().map(|r| r.2).sum();
        if readings.is_empty() || weight <= 0.0 {
            continue;
        }
        let used = readings.iter().map(|(used, _, w)| used * w).sum::<f64>() / weight;
        let resets_at = readings
            .iter()
            .filter(|(used, ..)| *used > 0.0)
            .filter_map(|(_, reset, _)| *reset)
            .min();
        windows.push(PoolWindow {
            span,
            used,
            resets_at,
        });
    }
    windows
}

fn span_rank(span: &str) -> u8 {
    match span {
        "5h" => 0,
        "7d" => 1,
        _ => 2,
    }
}

pub(crate) fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

pub(crate) fn header_f64(headers: &HeaderMap, name: &str) -> Option<f64> {
    header(headers, name)?
        .parse()
        .ok()
        .filter(|v: &f64| v.is_finite())
}

/// Parses a unix-seconds timestamp header.
pub(crate) fn header_time(headers: &HeaderMap, name: &str) -> Option<Timestamp> {
    let secs = header_f64(headers, name)?;
    Timestamp::from_second(secs as i64)
}

/// `Retry-After` as seconds or an HTTP date.
pub fn retry_after(headers: &HeaderMap, now: Timestamp) -> Option<Timestamp> {
    let raw = header(headers, "retry-after")?;
    if let Ok(secs) = raw.parse::<f64>() {
        return Some(now + SignedDuration::from_secs_f64(secs.max(0.0)));
    }
    Timestamp::from_http_date(raw)
}

pub(crate) fn parse_time(value: &Value) -> Option<Timestamp> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => Timestamp::from_second(n.as_f64()? as i64),
        _ => None,
    }
}

/// Why an upstream refused a request.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// The account's quota is spent. `until` is when it should come back,
    /// if known; `model` limits the block to one model.
    Exhausted {
        until: Option<Timestamp>,
        model: Option<String>,
    },
    /// Short-lived throttling; the account itself is fine.
    Throttled { until: Option<Timestamp> },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    #[test]
    fn elapsed_windows_start_over() {
        let mut limits = Limits {
            windows: vec![Window::new("5h", 100.0, Some(ts(500)))],
            ..Limits::default()
        };
        assert!(limits.is_exhausted(ts(400)));
        assert_eq!(limits.exhausted_until(ts(400)), Some(ts(500)));
        assert!(!limits.is_exhausted(ts(600)));
        assert_eq!(limits.score(ts(600)), 0.0);

        // A newer reading drops elapsed windows it does not mention.
        limits.merge(Limits {
            windows: vec![Window::new("7d", 10.0, None)],
            observed_at: Some(ts(600)),
            reset_credits: None,
        });
        assert_eq!(limits.windows.len(), 1);
        assert_eq!(limits.windows[0].span, "7d");
    }

    #[test]
    fn pools_read_as_one_account() {
        let now = ts(1000);
        let account = |five_hour: f64, reset: i64, week: f64| Limits {
            windows: vec![
                Window::new("5h", five_hour, Some(ts(reset))),
                Window::new("7d", week, Some(ts(90_000))),
            ],
            observed_at: Some(now),
            reset_credits: None,
        };
        let busy = account(90.0, 4000, 60.0);
        let fresh = account(10.0, 2000, 20.0);
        let idle = account(0.0, 1500, 0.0);
        let pool = pooled([(&busy, false), (&fresh, false), (&idle, false)], now);
        assert_eq!(pool.len(), 2);
        assert_eq!(pool[0].span, "5h");
        assert!(
            (pool[0].used - 100.0 / 3.0).abs() < 1e-9,
            "{}",
            pool[0].used
        );
        // The soonest reset of a window in use; the idle one frees nothing.
        assert_eq!(pool[0].resets_at, Some(ts(2000)));
        assert!((pool[1].used - 80.0 / 3.0).abs() < 1e-9);
        assert_eq!(pool[0].minutes(), 300);
        assert_eq!(pool[1].minutes(), 10_080);

        // A blocked account counts as full in its shortest window.
        let pool = pooled([(&fresh, true), (&idle, false)], now);
        assert_eq!(pool[0].used, 50.0);
        assert_eq!(pool[1].used, 10.0);
        // Accounts never measured are left out.
        let unknown = Limits::default();
        let pool = pooled([(&busy, false), (&unknown, false)], now);
        assert_eq!(pool[0].used, 90.0);
        assert!(pooled([(&unknown, false)], now).is_empty());
        // Weighted, a large plan's usage counts for more.
        let weighted = pooled_by([(&busy, false, 0.8), (&fresh, false, 0.2)], now);
        let plain = pooled([(&busy, false), (&fresh, false)], now);
        assert!(
            weighted[0].used > plain[0].used,
            "{weighted:?} vs {plain:?}"
        );
    }

    #[test]
    fn unknown_usage_scores_above_full() {
        assert_eq!(Limits::default().score(ts(0)), UNKNOWN_SCORE);
        assert!(!Limits::default().is_exhausted(ts(0)));
    }

    #[test]
    fn a_window_lapses_once_its_reset_passes_or_a_new_period_shows() {
        let ts = |s| Timestamp::from_second(s).unwrap();
        let week = 7 * 86_400;
        let old = Limits {
            windows: vec![
                Window::new("5h", 30.0, Some(ts(10_000))),
                Window::new("7d", 60.0, Some(ts(50_000))),
            ],
            observed_at: Some(ts(1_000)),
            reset_credits: None,
        };
        // Before either reset, a reading of the same period lapses nothing.
        let same =
            Limits::observed(vec![Window::new("7d", 61.0, Some(ts(50_000)))], ts(2_000)).unwrap();
        assert!(old.lapsed(&same, ts(2_000)).is_empty());
        // The 5-hour window's time passed: it lapsed at 30% used.
        let lapsed = old.lapsed(&same, ts(20_000));
        assert_eq!(lapsed.len(), 1);
        assert_eq!((lapsed[0].span.as_str(), lapsed[0].used), ("5h", 30.0));
        assert_eq!(lapsed[0].ended_at, ts(10_000));
        // A reading of next week's window shows this week's ended, even if
        // the clock says otherwise.
        let next = Limits::observed(
            vec![Window::new("7d", 2.0, Some(ts(50_000 + week)))],
            ts(3_000),
        )
        .unwrap();
        let lapsed = old.lapsed(&next, ts(3_000));
        assert_eq!(lapsed.len(), 1);
        assert_eq!((lapsed[0].span.as_str(), lapsed[0].used), ("7d", 60.0));
    }

    #[test]
    fn expiring_at_prefers_started_windows_with_headroom() {
        let three_days = 1000 + 3 * 86_400;
        let limits = Limits {
            windows: vec![
                Window::new("5h", 40.0, Some(ts(2000))),
                Window::new("7d", 60.0, Some(ts(three_days))),
            ],
            ..Limits::default()
        };
        assert_eq!(limits.expiring_at(ts(1000)), Some(ts(2000)));
        // A week with room left that ends within the day comes first.
        let ending = Limits {
            windows: vec![
                Window::new("5h", 40.0, Some(ts(2000))),
                Window::new("7d", 60.0, Some(ts(9000))),
            ],
            ..Limits::default()
        };
        assert_eq!(ending.expiring_at(ts(1000)), Some(ts(9000)));
        assert_eq!(ending.urgency(ts(1000)).short, Some(ts(2000)));
        let idle = Limits {
            windows: vec![Window::new("5h", 0.0, None)],
            ..Limits::default()
        };
        assert_eq!(idle.expiring_at(ts(1000)), None);
    }
}
