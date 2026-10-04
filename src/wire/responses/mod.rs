//! OpenAI Responses.

pub mod compaction;
pub mod events;
pub mod reply;
pub mod request;

pub use request::freeform_schema;

use serde_json::{Value, json};

use super::{Opening, Outcome};
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

/// Lifecycle events say nothing yet; a failure coded as a spent quota or
/// throttling is the account's, anything else (context length, policy) is
/// the request's and goes to the agent.
pub fn opening(event: &Value) -> Opening {
    match event.get("type").and_then(Value::as_str) {
        Some("response.created" | "response.in_progress" | "response.queued") => Opening::Wait,
        Some("response.failed" | "error") => match failure_code(event) {
            Some("usage_limit_reached" | "usage_limit_exceeded") => {
                Opening::Refused { exhausted: true }
            }
            Some("server_is_overloaded" | "slow_down" | "rate_limit_exceeded") => {
                Opening::Refused { exhausted: false }
            }
            _ => Opening::Content,
        },
        _ => Opening::Content,
    }
}

fn count(usage: &Value, outcome: &mut Outcome) {
    let number = |path: &str| usage.pointer(path).and_then(Value::as_u64).unwrap_or(0);
    let cached = number("/input_tokens_details/cached_tokens");
    let total = &mut outcome.usage;
    // Cached tokens are counted inside input_tokens.
    total.input_tokens = number("/input_tokens").saturating_sub(cached);
    total.cache_read_tokens = cached;
    total.output_tokens = number("/output_tokens");
}

fn failure_code(event: &Value) -> Option<&str> {
    let error = event
        .pointer("/response/error")
        .or_else(|| event.get("error"))?;
    error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
}

/// The final `response.*` event carries usage (as does a whole `response`
/// object from a non-streaming request); a failure coded
/// `usage_limit_reached` means the quota ran out mid-stream.
pub fn observe(event: &Value, outcome: &mut Outcome) {
    if event.get("object").and_then(Value::as_str) == Some("response") {
        if let Some(usage) = event.get("usage") {
            count(usage, outcome);
        }
        return;
    }
    match event.get("type").and_then(Value::as_str) {
        Some("response.completed" | "response.incomplete" | "response.done") => {
            if let Some(usage) = event.pointer("/response/usage") {
                count(usage, outcome);
            }
        }
        Some("response.failed" | "error") => {
            outcome.exhausted |= matches!(
                failure_code(event),
                Some("usage_limit_reached" | "usage_limit_exceeded")
            );
        }
        _ => {}
    }
}
