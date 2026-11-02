//! Claude's usage windows: response headers, the usage endpoint, and 429s.

use http::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

use crate::limits::{
    Limits, PoolWindow, Refusal, Window, header, header_f64, header_time, parse_time, retry_after,
};
use crate::time::Timestamp;

const UNIFIED: &str = "anthropic-ratelimit-unified-";

/// One of Claude's two unified windows, with its header names written out,
/// so reading and writing them on every response formats nothing.
struct Unified {
    key: &'static str,
    claim: &'static str,
    utilization: &'static str,
    reset: &'static str,
    status: &'static str,
    surpassed: &'static str,
}

const WINDOWS: [Unified; 2] = [
    Unified {
        key: "5h",
        claim: "five_hour",
        utilization: "anthropic-ratelimit-unified-5h-utilization",
        reset: "anthropic-ratelimit-unified-5h-reset",
        status: "anthropic-ratelimit-unified-5h-status",
        surpassed: "anthropic-ratelimit-unified-5h-surpassed-threshold",
    },
    Unified {
        key: "7d",
        claim: "seven_day",
        utilization: "anthropic-ratelimit-unified-7d-utilization",
        reset: "anthropic-ratelimit-unified-7d-reset",
        status: "anthropic-ratelimit-unified-7d-status",
        surpassed: "anthropic-ratelimit-unified-7d-surpassed-threshold",
    },
];

/// Claude: `anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`.
/// Utilization is a 0–1 fraction; resets are unix seconds.
pub fn from_headers(headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
    let windows: Vec<Window> = WINDOWS
        .iter()
        .filter_map(|w| {
            let fraction = header_f64(headers, w.utilization)?;
            Some(Window::new(
                w.key,
                fraction * 100.0,
                header_time(headers, w.reset),
            ))
        })
        .collect();
    Limits::observed(windows, now)
}

/// Puts the pool's standing in place of the serving account's, so the agent
/// sees one account. This follows Claude Code's contract for gateways:
/// strip the upstream's `anthropic-ratelimit-unified-*` headers and report
/// the caller's own standing, warning past 75% and again past 95%.
pub fn pool_headers(windows: &[PoolWindow], headers: &mut HeaderMap) {
    let upstream: Vec<HeaderName> = headers
        .keys()
        .filter(|name| name.as_str().starts_with(UNIFIED))
        .cloned()
        .collect();
    for name in upstream {
        headers.remove(name);
    }
    let mut set = |name: &'static str, value: String| {
        if let Ok(value) = HeaderValue::try_from(value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    };
    let mut fullest: Option<(&PoolWindow, &str)> = None;
    for window in windows {
        let Some(names) = WINDOWS.iter().find(|w| w.key == window.span) else {
            continue;
        };
        let claim = names.claim;
        // Below 1 while requests are still served.
        let fraction = (window.used / 100.0).clamp(0.0, 0.99);
        let passed = [0.95, 0.75].into_iter().find(|t| fraction >= *t);
        set(names.utilization, format!("{fraction:.2}"));
        let status = if passed.is_some() {
            "allowed_warning"
        } else {
            "allowed"
        };
        set(names.status, status.into());
        if let Some(at) = window.resets_at {
            set(names.reset, at.as_second().to_string());
        }
        if let Some(threshold) = passed {
            set(names.surpassed, threshold.to_string());
        }
        if fullest.is_none_or(|(f, _)| window.used > f.used) {
            fullest = Some((window, claim));
        }
    }
    let Some((window, claim)) = fullest else {
        return;
    };
    let warning = window.used >= 75.0;
    let status = if warning {
        "allowed_warning"
    } else {
        "allowed"
    };
    set("anthropic-ratelimit-unified-status", status.into());
    if warning {
        set(
            "anthropic-ratelimit-unified-representative-claim",
            claim.into(),
        );
    }
    if let Some(at) = window.resets_at {
        set(
            "anthropic-ratelimit-unified-reset",
            at.as_second().to_string(),
        );
    }
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

/// Whether a 429 refuses fast mode for want of usage credits rather than
/// for a spent window. That belongs to the request: every account would
/// answer the same, and all of them stay healthy for ordinary requests.
pub fn fast_mode_refused(headers: &HeaderMap, body: &[u8]) -> bool {
    let window_rejected = ["5h-", "7d-"].iter().any(|key| {
        header(headers, &format!("anthropic-ratelimit-unified-{key}status")) == Some("rejected")
    });
    if window_rejected {
        return false;
    }
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/message")?.as_str().map(str::to_lowercase))
        .unwrap_or_else(|| String::from_utf8_lossy(body).to_lowercase());
    message.contains("fast request rejected")
        || (message.contains("fast")
            && (message.contains("usage credits") || message.contains("credits are required")))
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

    #[test]
    fn pool_headers_replace_the_accounts() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("anthropic-ratelimit-unified-status", "allowed_warning"),
            ("anthropic-ratelimit-unified-5h-utilization", "0.97"),
            ("anthropic-ratelimit-unified-overage-status", "allowed"),
            (
                "anthropic-ratelimit-unified-representative-claim",
                "five_hour",
            ),
            ("request-id", "req_1"),
        ] {
            headers.insert(name, HeaderValue::from_static(value));
        }
        let reset = Timestamp::from_second(5_000).unwrap();
        let pool = [
            PoolWindow {
                span: "5h",
                used: 48.5,
                resets_at: Some(reset),
            },
            PoolWindow {
                span: "7d",
                used: 30.0,
                resets_at: None,
            },
        ];
        pool_headers(&pool, &mut headers);
        let get = |name: &str| headers.get(name).map(|v| v.to_str().unwrap());
        assert_eq!(get("anthropic-ratelimit-unified-status"), Some("allowed"));
        assert_eq!(
            get("anthropic-ratelimit-unified-5h-utilization"),
            Some("0.48")
        );
        assert_eq!(get("anthropic-ratelimit-unified-5h-reset"), Some("5000"));
        assert_eq!(
            get("anthropic-ratelimit-unified-7d-utilization"),
            Some("0.30")
        );
        assert_eq!(get("anthropic-ratelimit-unified-reset"), Some("5000"));
        assert_eq!(
            get("anthropic-ratelimit-unified-representative-claim"),
            None
        );
        assert_eq!(get("anthropic-ratelimit-unified-overage-status"), None);
        assert_eq!(get("request-id"), Some("req_1"));

        // A pool running low warns as one account would.
        let low = [PoolWindow {
            span: "7d",
            used: 96.0,
            resets_at: Some(reset),
        }];
        pool_headers(&low, &mut headers);
        let get = |name: &str| headers.get(name).map(|v| v.to_str().unwrap());
        assert_eq!(
            get("anthropic-ratelimit-unified-status"),
            Some("allowed_warning")
        );
        assert_eq!(
            get("anthropic-ratelimit-unified-representative-claim"),
            Some("seven_day")
        );
        assert_eq!(
            get("anthropic-ratelimit-unified-7d-surpassed-threshold"),
            Some("0.95")
        );
        assert_eq!(get("anthropic-ratelimit-unified-5h-utilization"), None);
    }
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
    fn fast_mode_credit_refusals_are_told_apart() {
        let body = br#"{"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for fast mode."}}"#;
        assert!(fast_mode_refused(&HeaderMap::new(), body));
        let spent = headers(&[("anthropic-ratelimit-unified-5h-status", "rejected")]);
        assert!(
            !fast_mode_refused(&spent, body),
            "a spent window comes first"
        );
        let limit = br#"{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}"#;
        assert!(!fast_mode_refused(&HeaderMap::new(), limit));
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
