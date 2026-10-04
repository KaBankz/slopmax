//! Usage windows and refusals, parsed from both providers' wire formats.
//!
//! Every Claude and Codex response carries rate-limit headers, and both
//! providers expose a usage endpoint. Both are folded into one [`Limits`]
//! model of percentage windows with reset times, which drives routing and the
//! status display. Refused requests are classified into a [`Refusal`].

use crate::time::{SignedDuration, Timestamp};
use http::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    fn new(span: &str, used: f64, resets_at: Option<Timestamp>) -> Self {
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
fn span_for(seconds: i64) -> &'static str {
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
    fn observed(windows: Vec<Window>, now: Timestamp) -> Option<Self> {
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

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok().map(str::trim)
}

fn header_f64(headers: &HeaderMap, name: &str) -> Option<f64> {
    header(headers, name)?
        .parse()
        .ok()
        .filter(|v: &f64| v.is_finite())
}

/// Parses a unix-seconds timestamp header.
fn header_time(headers: &HeaderMap, name: &str) -> Option<Timestamp> {
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

/// Claude: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`.
/// Utilization is a 0–1 fraction; resets are unix seconds.
pub fn from_claude_headers(headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
    let windows: Vec<Window> = [("5h", "5h"), ("7d", "7d")]
        .into_iter()
        .filter_map(|(key, span)| {
            let fraction = header_f64(
                headers,
                &format!("anthropic-ratelimit-unified-{key}-utilization"),
            )?;
            let reset = header_time(headers, &format!("anthropic-ratelimit-unified-{key}-reset"));
            Some(Window::new(span, fraction * 100.0, reset))
        })
        .collect();
    Limits::observed(windows, now)
}

/// Codex: `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`.
pub fn from_codex_headers(headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
    let windows: Vec<Window> = ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let used = header_f64(headers, &format!("x-codex-{slot}-used-percent"))?;
            let minutes = header_f64(headers, &format!("x-codex-{slot}-window-minutes"));
            let reset = header_time(headers, &format!("x-codex-{slot}-reset-at"));
            let span = minutes.map_or("7d", |m| span_for((m * 60.0) as i64));
            Some(Window::new(span, used, reset))
        })
        .collect();
    Limits::observed(windows, now)
}

fn parse_time(value: &Value) -> Option<Timestamp> {
    match value {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => Timestamp::from_second(n.as_f64()? as i64),
        _ => None,
    }
}

/// Claude `GET /api/oauth/usage`: `five_hour`, `seven_day`, and model-scoped
/// weekly limits, with utilization in percent and ISO reset times.
pub fn from_claude_usage(body: &Value, now: Timestamp) -> Limits {
    let window = |key: &str, span: &str| {
        let w = body.get(key)?;
        let used = w.get("utilization")?.as_f64()?;
        Some(Window::new(
            span,
            used,
            w.get("resets_at").and_then(parse_time),
        ))
    };
    let mut windows: Vec<Window> = [window("five_hour", "5h"), window("seven_day", "7d")]
        .into_iter()
        .flatten()
        .collect();

    let scoped = body
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|l| l.get("kind").and_then(Value::as_str) == Some("weekly_scoped"));
    for limit in scoped {
        let model = limit
            .pointer("/scope/model/display_name")
            .and_then(Value::as_str);
        let used = limit.get("percent").and_then(Value::as_f64);
        if let (Some(model), Some(used)) = (model, used) {
            let reset = limit.get("resets_at").and_then(parse_time);
            windows.push(Window {
                model: Some(model.into()),
                ..Window::new("7d", used, reset)
            });
        }
    }
    // Older payloads carry per-model weekly windows as top-level keys.
    for (key, model) in [("seven_day_opus", "Opus"), ("seven_day_sonnet", "Sonnet")] {
        if !windows.iter().any(|w| w.model.as_deref() == Some(model))
            && let Some(w) = window(key, "7d")
        {
            windows.push(Window {
                model: Some(model.into()),
                ..w
            });
        }
    }
    Limits {
        windows,
        observed_at: Some(now),
        reset_credits: None,
    }
}

/// Codex `GET /backend-api/wham/usage`. Returns the limits and the plan.
pub fn from_codex_usage(body: &Value, now: Timestamp) -> (Limits, Option<String>) {
    let rate_limit = body.get("rate_limit");
    let windows = ["primary_window", "secondary_window", "tertiary_window"]
        .into_iter()
        .filter_map(|key| {
            let w = rate_limit?.get(key)?;
            let used = w.get("used_percent")?.as_f64()?;
            let seconds = w.get("limit_window_seconds").and_then(Value::as_i64);
            let reset = w.get("reset_at").and_then(parse_time).or_else(|| {
                let after = w.get("reset_after_seconds")?.as_i64()?;
                Some(now + SignedDuration::from_secs(after))
            });
            Some(Window::new(seconds.map_or("7d", span_for), used, reset))
        })
        .collect();
    let reset_credits = body
        .pointer("/rate_limit_reset_credits/available_count")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let plan = body
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let limits = Limits {
        windows,
        observed_at: Some(now),
        reset_credits,
    };
    (limits, plan)
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

/// Classifies a Claude 429 from its unified rate-limit headers.
///
/// A rejected 5h or 7d window blocks the whole account until the latest of
/// the rejected resets. A rejection that only involves the overage-included
/// window (`7d_oi`) or extra usage caps one model, not the account.
pub fn claude_refusal(headers: &HeaderMap, model: Option<&str>, now: Timestamp) -> Refusal {
    let status = |key: &str| header(headers, &format!("anthropic-ratelimit-unified-{key}status"));
    let rejected = |key: &str| status(key) == Some("rejected");
    let reset =
        |key: &str| header_time(headers, &format!("anthropic-ratelimit-unified-{key}reset"));

    let shared: Vec<&str> = ["5h-", "7d-"].into_iter().filter(|k| rejected(k)).collect();
    if !shared.is_empty() {
        let until = shared
            .iter()
            .filter_map(|k| reset(k))
            .chain(retry_after(headers, now))
            .chain(reset(""))
            .filter(|at| *at > now)
            .max();
        return Refusal::Exhausted { until, model: None };
    }
    if rejected("") {
        let overage_only = rejected("7d_oi-")
            || status("overage-") == Some("rejected")
            || header(headers, "anthropic-ratelimit-unified-representative-claim")
                .is_some_and(|claim| claim.contains("overage"));
        let until = [reset("7d_oi-"), reset(""), retry_after(headers, now)]
            .into_iter()
            .flatten()
            .filter(|at| *at > now)
            .max();
        let model = overage_only.then(|| model.map(str::to_owned)).flatten();
        return Refusal::Exhausted { until, model };
    }
    Refusal::Throttled {
        until: retry_after(headers, now),
    }
}

/// Classifies a Codex 429/402. `usage_limit_reached` means the account is
/// spent; its body carries `resets_at` (unix seconds) or `resets_in_seconds`.
pub fn codex_refusal(status: u16, headers: &HeaderMap, body: &[u8], now: Timestamp) -> Refusal {
    let json: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let error = json.get("error").unwrap_or(&json);
    let kind = ["type", "code"]
        .iter()
        .find_map(|k| error.get(*k).and_then(Value::as_str))
        .unwrap_or_default();

    let exhausted = status == 402
        || matches!(
            kind,
            "usage_limit_reached"
                | "usage_limit_exceeded"
                | "usage_not_included"
                | "insufficient_quota"
        );
    if !exhausted {
        return Refusal::Throttled {
            until: retry_after(headers, now),
        };
    }
    let from_body = error.get("resets_at").and_then(parse_time).or_else(|| {
        let secs = error.get("resets_in_seconds")?.as_i64()?;
        Some(now + SignedDuration::from_secs(secs))
    });
    let from_headers = || {
        from_codex_headers(headers, now)
            .and_then(|limits| limits.exhausted_until(now))
            .or_else(|| retry_after(headers, now))
    };
    Refusal::Exhausted {
        until: from_body.filter(|at| *at > now).or_else(from_headers),
        model: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;
    use serde_json::json;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn claude_headers_convert_fractions_to_percent() {
        let h = headers(&[
            ("anthropic-ratelimit-unified-5h-utilization", "0.53"),
            ("anthropic-ratelimit-unified-5h-reset", "2000"),
            ("anthropic-ratelimit-unified-7d-utilization", "0.1"),
        ]);
        let limits = from_claude_headers(&h, ts(1000)).unwrap();
        assert_eq!(limits.windows[0].span, "5h");
        assert!((limits.windows[0].used - 53.0).abs() < 1e-9);
        assert_eq!(limits.windows[0].resets_at, Some(ts(2000)));
        assert_eq!(limits.windows[1].resets_at, None);
        assert!(from_claude_headers(&HeaderMap::new(), ts(0)).is_none());
    }

    #[test]
    fn codex_headers_classify_by_window_length() {
        let h = headers(&[
            ("x-codex-primary-used-percent", "29"),
            ("x-codex-primary-window-minutes", "10080"),
            ("x-codex-primary-reset-at", "5000"),
            ("x-codex-secondary-used-percent", "100"),
            ("x-codex-secondary-window-minutes", "300"),
        ]);
        let limits = from_codex_headers(&h, ts(1000)).unwrap();
        assert_eq!(limits.windows[0].span, "7d");
        assert_eq!(limits.windows[1].span, "5h");
        assert!(limits.is_exhausted(ts(1000)));
    }

    #[test]
    fn claude_usage_reads_shared_and_scoped_windows() {
        let body = json!({
            "five_hour": { "utilization": 33.0, "resets_at": "2026-10-04T07:20:00.250378+00:00" },
            "seven_day": { "utilization": 47.0, "resets_at": "2026-10-05T04:00:00+00:00" },
            "seven_day_opus": null,
            "limits": [
                { "kind": "session", "percent": 33 },
                { "kind": "weekly_scoped", "percent": 58, "resets_at": "2026-10-05T04:00:00+00:00",
                  "scope": { "model": { "display_name": "Fable" } } }
            ]
        });
        let limits = from_claude_usage(&body, ts(0));
        let labels: Vec<String> = limits.windows.iter().map(Window::label).collect();
        assert_eq!(labels, ["5h", "7d", "7d Fable"]);
        assert_eq!(
            limits.score(ts(0)),
            47.0,
            "scoped windows do not drive the score"
        );
    }

    #[test]
    fn codex_usage_reads_windows_plan_and_reset_credits() {
        let body = json!({
            "plan_type": "pro",
            "rate_limit": {
                "allowed": true,
                "primary_window": { "used_percent": 29, "limit_window_seconds": 604800,
                                    "reset_after_seconds": 498039, "reset_at": 1791580389 },
                "secondary_window": null
            },
            "rate_limit_reset_credits": { "available_count": 3 }
        });
        let (limits, plan) = from_codex_usage(&body, ts(0));
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(limits.windows.len(), 1);
        assert_eq!(limits.windows[0].span, "7d");
        assert_eq!(limits.windows[0].resets_at, Some(ts(1791580389)));
        assert_eq!(limits.reset_credits, Some(3));
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

    #[test]
    fn claude_refusal_blocks_until_latest_rejected_reset() {
        let h = headers(&[
            ("anthropic-ratelimit-unified-status", "rejected"),
            ("anthropic-ratelimit-unified-5h-status", "rejected"),
            ("anthropic-ratelimit-unified-5h-reset", "3000"),
            ("anthropic-ratelimit-unified-7d-status", "allowed"),
            ("anthropic-ratelimit-unified-7d-reset", "9000"),
            ("retry-after", "60"),
        ]);
        let refusal = claude_refusal(&h, Some("claude-x"), ts(1000));
        assert_eq!(
            refusal,
            Refusal::Exhausted {
                until: Some(ts(3000)),
                model: None
            }
        );
    }

    #[test]
    fn claude_overage_only_refusal_scopes_to_model() {
        let h = headers(&[
            ("anthropic-ratelimit-unified-status", "rejected"),
            ("anthropic-ratelimit-unified-5h-status", "allowed"),
            ("anthropic-ratelimit-unified-7d-status", "allowed"),
            ("anthropic-ratelimit-unified-7d_oi-status", "rejected"),
            ("anthropic-ratelimit-unified-7d_oi-reset", "7000"),
        ]);
        let refusal = claude_refusal(&h, Some("claude-fable-5"), ts(1000));
        assert_eq!(
            refusal,
            Refusal::Exhausted {
                until: Some(ts(7000)),
                model: Some("claude-fable-5".into())
            }
        );
    }

    #[test]
    fn claude_plain_429_is_throttling() {
        let h = headers(&[("retry-after", "5")]);
        assert_eq!(
            claude_refusal(&h, None, ts(1000)),
            Refusal::Throttled {
                until: Some(ts(1005))
            }
        );
    }

    #[test]
    fn codex_usage_limit_uses_body_reset() {
        let body = br#"{"error":{"type":"usage_limit_reached","message":"x","resets_at":4000,"plan_type":"pro"}}"#;
        let refusal = codex_refusal(429, &HeaderMap::new(), body, ts(1000));
        assert_eq!(
            refusal,
            Refusal::Exhausted {
                until: Some(ts(4000)),
                model: None
            }
        );
        let relative = br#"{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}"#;
        assert_eq!(
            codex_refusal(429, &HeaderMap::new(), relative, ts(1000)),
            Refusal::Exhausted {
                until: Some(ts(1060)),
                model: None
            }
        );
    }

    #[test]
    fn codex_rate_limit_is_throttling() {
        let body = br#"{"error":{"type":"rate_limit_exceeded"}}"#;
        assert!(matches!(
            codex_refusal(429, &HeaderMap::new(), body, ts(0)),
            Refusal::Throttled { .. }
        ));
    }
}
