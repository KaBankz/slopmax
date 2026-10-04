//! ChatGPT's usage windows: response headers, the usage endpoint, and
//! refusals.

use http::HeaderMap;
use serde_json::Value;

use crate::limits::{
    Limits, Refusal, Window, header_f64, header_time, parse_time, retry_after, span_for,
};
use crate::time::{SignedDuration, Timestamp};

/// Codex: `x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}`.
pub fn from_headers(headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
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

/// A `codex.rate_limits` event, which ChatGPT sends over WebSockets in
/// place of the rate-limit headers.
pub fn from_event(event: &Value, now: Timestamp) -> Option<Limits> {
    let limits = event.get("rate_limits")?;
    let windows = ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let w = limits.get(slot).filter(|w| w.is_object())?;
            let used = w.get("used_percent")?.as_f64()?;
            let minutes = w.get("window_minutes").and_then(Value::as_f64);
            let reset = w.get("reset_at").and_then(parse_time);
            let span = minutes.map_or("7d", |m| span_for((m * 60.0) as i64));
            Some(Window::new(span, used, reset))
        })
        .collect();
    Limits::observed(windows, now)
}

/// Codex `GET /backend-api/wham/usage`. Returns the limits and the plan.
pub fn from_usage(body: &Value, now: Timestamp) -> (Limits, Option<String>) {
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

/// Classifies a Codex 429/402. `usage_limit_reached` means the account is
/// spent; its body carries `resets_at` (unix seconds) or `resets_in_seconds`.
pub fn refusal(status: u16, headers: &HeaderMap, body: &[u8], now: Timestamp) -> Refusal {
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
        from_headers(headers, now)
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
    fn websocket_rate_limit_events() {
        let event = json!({"type": "codex.rate_limits", "plan_type": "pro",
            "rate_limits": {"allowed": true, "limit_reached": false,
                "primary": {"used_percent": 42, "window_minutes": 300, "reset_at": 9000},
                "secondary": {"used_percent": 7, "window_minutes": 10080, "reset_at": 99000}}});
        let limits = from_event(&event, ts(1000)).unwrap();
        let spans: Vec<(&str, f64)> = limits
            .windows
            .iter()
            .map(|w| (w.span.as_str(), w.used))
            .collect();
        assert_eq!(spans, [("5h", 42.0), ("7d", 7.0)]);
        assert_eq!(limits.windows[0].resets_at, Some(ts(9000)));
        assert!(
            from_event(
                &json!({"type": "codex.rate_limits", "rate_limits": {"primary": null}}),
                ts(0)
            )
            .is_none()
        );
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
        let limits = from_headers(&h, ts(1000)).unwrap();
        assert_eq!(limits.windows[0].span, "7d");
        assert_eq!(limits.windows[1].span, "5h");
        assert!(limits.is_exhausted(ts(1000)));
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
        let (limits, plan) = from_usage(&body, ts(0));
        assert_eq!(plan.as_deref(), Some("pro"));
        assert_eq!(limits.windows.len(), 1);
        assert_eq!(limits.windows[0].span, "7d");
        assert_eq!(limits.windows[0].resets_at, Some(ts(1791580389)));
        assert_eq!(limits.reset_credits, Some(3));
    }

    #[test]
    fn codex_usage_limit_uses_body_reset() {
        let body = br#"{"error":{"type":"usage_limit_reached","message":"x","resets_at":4000,"plan_type":"pro"}}"#;
        let absolute = refusal(429, &HeaderMap::new(), body, ts(1000));
        assert_eq!(
            absolute,
            Refusal::Exhausted {
                until: Some(ts(4000)),
                model: None
            }
        );
        let relative = br#"{"error":{"type":"usage_limit_reached","resets_in_seconds":60}}"#;
        assert_eq!(
            refusal(429, &HeaderMap::new(), relative, ts(1000)),
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
            refusal(429, &HeaderMap::new(), body, ts(0)),
            Refusal::Throttled { .. }
        ));
    }
}
