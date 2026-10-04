//! OpenAI Responses.

use serde_json::{Value, json};

use super::Outcome;
use crate::time::Timestamp;

pub fn error(kind: &str, message: &str) -> Value {
    json!({ "error": { "type": kind, "message": message } })
}

/// Codex shows `usage_limit_reached` as its usage-limit message and waits
/// until `resets_at`.
pub fn limit_reached(
    message: &str,
    until: Timestamp,
    now: Timestamp,
) -> (Value, Vec<(&'static str, String)>) {
    let body = json!({ "error": {
        "type": "usage_limit_reached",
        "message": message,
        "resets_at": until.as_second(),
        "resets_in_seconds": until.duration_since(now).as_secs().max(1),
    } });
    (body, Vec::new())
}

/// The final `response.*` event carries usage; a failure coded
/// `usage_limit_reached` means the quota ran out mid-stream.
pub fn observe(event: &Value, outcome: &mut Outcome) {
    match event.get("type").and_then(Value::as_str) {
        Some("response.completed" | "response.incomplete" | "response.done") => {
            let Some(usage) = event.pointer("/response/usage") else {
                return;
            };
            let number = |path: &str| usage.pointer(path).and_then(Value::as_u64).unwrap_or(0);
            let cached = number("/input_tokens_details/cached_tokens");
            let total = &mut outcome.usage;
            // Cached tokens are counted inside input_tokens.
            total.input_tokens = number("/input_tokens").saturating_sub(cached);
            total.cache_read_tokens = cached;
            total.output_tokens = number("/output_tokens");
        }
        Some("response.failed" | "error") => {
            let error = event
                .pointer("/response/error")
                .or_else(|| event.get("error"));
            let code = error
                .and_then(|e| e.get("code").or_else(|| e.get("type")))
                .and_then(Value::as_str);
            outcome.exhausted |=
                matches!(code, Some("usage_limit_reached" | "usage_limit_exceeded"));
        }
        _ => {}
    }
}
