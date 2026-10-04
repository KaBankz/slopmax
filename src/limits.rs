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

    /// The soonest moment some spare capacity on this account expires: the
    /// earliest upcoming reset of a started, not-yet-full shared window.
    /// Quota left in that window is lost at reset, so it should go first.
    pub fn expiring_at(&self, now: Timestamp) -> Option<Timestamp> {
        self.shared()
            .filter(|w| w.used_at(now) > 0.0 && !w.is_full(now))
            .filter_map(|w| w.upcoming_reset(now))
            .min()
    }
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
    fn unknown_usage_scores_above_full() {
        assert_eq!(Limits::default().score(ts(0)), UNKNOWN_SCORE);
        assert!(!Limits::default().is_exhausted(ts(0)));
    }

    #[test]
    fn expiring_at_prefers_started_windows_with_headroom() {
        let limits = Limits {
            windows: vec![
                Window::new("5h", 40.0, Some(ts(2000))),
                Window::new("7d", 60.0, Some(ts(9000))),
            ],
            ..Limits::default()
        };
        assert_eq!(limits.expiring_at(ts(1000)), Some(ts(2000)));
        let idle = Limits {
            windows: vec![Window::new("5h", 0.0, None)],
            ..Limits::default()
        };
        assert_eq!(idle.expiring_at(ts(1000)), None);
    }
}
