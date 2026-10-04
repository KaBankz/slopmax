//! Anthropic Messages.

use serde_json::{Value, json};

use super::Outcome;
use crate::time::Timestamp;

pub fn error(kind: &str, message: &str) -> Value {
    json!({ "type": "error", "error": { "type": kind, "message": message } })
}

/// Claude Code treats a rejected unified limit as the account's usage limit
/// and reads the reset time from the header.
pub fn limit_reached(message: &str, until: Timestamp) -> (Value, Vec<(&'static str, String)>) {
    let headers = vec![
        ("anthropic-ratelimit-unified-status", "rejected".to_owned()),
        (
            "anthropic-ratelimit-unified-reset",
            until.as_second().to_string(),
        ),
    ];
    (error("rate_limit_error", message), headers)
}

/// `message_start` and `message_delta` carry usage; an `error` event of
/// type `rate_limit_error` means the quota ran out mid-stream.
pub fn observe(event: &Value, outcome: &mut Outcome) {
    let usage = match event.get("type").and_then(Value::as_str) {
        Some("message_start") => event.pointer("/message/usage"),
        Some("message_delta") => event.get("usage"),
        Some("error") => {
            let kind = event.pointer("/error/type").and_then(Value::as_str);
            outcome.exhausted |= kind == Some("rate_limit_error");
            None
        }
        _ => None,
    };
    let Some(usage) = usage else { return };
    // A later event carries cumulative counts; zeros mean "unchanged".
    let total = &mut outcome.usage;
    let field = |name: &str| usage.get(name).and_then(Value::as_u64).filter(|n| *n > 0);
    if let Some(n) = field("input_tokens") {
        total.input_tokens = n;
    }
    if let Some(n) = field("output_tokens") {
        total.output_tokens = n;
    }
    if let Some(n) = field("cache_read_input_tokens") {
        total.cache_read_tokens = n;
    }
    if let Some(n) = field("cache_creation_input_tokens") {
        total.cache_write_tokens = n;
    }
}
