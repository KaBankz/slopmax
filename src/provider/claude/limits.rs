//! Claude's usage windows: response headers, the usage endpoint, and 429s.

use http::HeaderMap;
use serde_json::Value;

use crate::limits::{
    Limits, Refusal, Window, header, header_f64, header_time, parse_time, retry_after,
};
use crate::time::Timestamp;

/// Claude: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`.
/// Utilization is a 0–1 fraction; resets are unix seconds.
pub fn from_headers(headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
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

/// Claude `GET /api/oauth/usage`: `five_hour`, `seven_day`, and model-scoped
/// weekly limits, with utilization in percent and ISO reset times.
pub fn from_usage(body: &Value, now: Timestamp) -> Limits {
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

/// Classifies a Claude 429 from its unified rate-limit headers.
///
/// A rejected 5h or 7d window blocks the whole account until the latest of
/// the rejected resets. A rejection that only involves the overage-included
/// window (`7d_oi`) or extra usage caps one model, not the account.
pub fn refusal(headers: &HeaderMap, model: Option<&str>, now: Timestamp) -> Refusal {
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
        let limits = from_headers(&h, ts(1000)).unwrap();
        assert_eq!(limits.windows[0].span, "5h");
        assert!((limits.windows[0].used - 53.0).abs() < 1e-9);
        assert_eq!(limits.windows[0].resets_at, Some(ts(2000)));
        assert_eq!(limits.windows[1].resets_at, None);
        assert!(from_headers(&HeaderMap::new(), ts(0)).is_none());
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
        let limits = from_usage(&body, ts(0));
        let labels: Vec<String> = limits.windows.iter().map(Window::label).collect();
        assert_eq!(labels, ["5h", "7d", "7d Fable"]);
        assert_eq!(
            limits.score(ts(0)),
            47.0,
            "scoped windows do not drive the score"
        );
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
        let refusal = refusal(&h, Some("claude-x"), ts(1000));
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
        let refusal = refusal(&h, Some("claude-fable-5"), ts(1000));
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
            refusal(&h, None, ts(1000)),
            Refusal::Throttled {
                until: Some(ts(1005))
            }
        );
    }
}
