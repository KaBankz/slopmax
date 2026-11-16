//! Anthropic Messages.

pub mod reply;
pub mod request;

use serde_json::{Value, json};

use super::Outcome;
use super::rawjson::{self, Seg};
use slopmax_common::time::Timestamp;

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

/// `body` with its advisor tools asking for `to` where they named `from`,
/// or `None` when none did. Claude Code's advisor is a server tool that
/// carries a model of its own, by default the one the request asks for, so
/// when routing renames the request's model (an alias, a selector, a
/// fallback) the advisor's must follow, or Claude refuses the request and
/// Claude Code turns the advisor off for the conversation.
pub fn rename_advisor(body: &[u8], from: &str, to: &str) -> Option<Vec<u8>> {
    let tools = rawjson::find(body, &[Seg::Key("tools")])?;
    memchr::memmem::find(&body[tools], b"\"advisor_")?;
    let renamed = serde_json::to_vec(to).expect("strings serialize");
    let mut out = None::<Vec<u8>>;
    // Last to first, so the ranges still ahead stay where they are.
    for tool in rawjson::elements(body, &[Seg::Key("tools")])
        .into_iter()
        .rev()
    {
        let tool_body = &body[tool.clone()];
        let advisor = rawjson::find_str(tool_body, &[Seg::Key("type")])
            .is_some_and(|kind| kind.starts_with("advisor_"));
        let model = rawjson::find(tool_body, &[Seg::Key("model")]).filter(|m| {
            serde_json::from_slice::<String>(&tool_body[m.clone()]).is_ok_and(|m| m == from)
        });
        let (true, Some(model)) = (advisor, model) else {
            continue;
        };
        let at = tool.start + model.start..tool.start + model.end;
        let edited = out.as_deref().unwrap_or(body);
        out = Some(rawjson::splice(edited, at, &renamed));
    }
    out
}

/// The fields of a stream event [`observe`] reads, borrowed: everything
/// else is skipped without allocating.
#[derive(serde::Deserialize)]
struct Event<'a> {
    #[serde(rename = "type", borrow)]
    kind: std::borrow::Cow<'a, str>,
    message: Option<Message>,
    usage: Option<Counts>,
    #[serde(borrow)]
    error: Option<Error<'a>>,
}

#[derive(serde::Deserialize)]
struct Message {
    usage: Option<Counts>,
}

#[derive(serde::Deserialize)]
struct Counts {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(serde::Deserialize)]
struct Error<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<std::borrow::Cow<'a, str>>,
}

/// [`observe`] on a stream event's raw JSON, without building a value.
/// `false` when the event has another shape, for [`observe`] to read.
pub fn observe_raw(data: &[u8], outcome: &mut Outcome) -> bool {
    let Ok(event) = serde_json::from_slice::<Event>(data) else {
        return false;
    };
    let usage = match &*event.kind {
        "message_start" => event.message.and_then(|m| m.usage),
        "message_delta" | "message" => event.usage,
        "error" => {
            let kind = event.error.and_then(|e| e.kind);
            outcome.exhausted |= kind.as_deref() == Some("rate_limit_error");
            None
        }
        _ => None,
    };
    if let Some(usage) = usage {
        // A later event carries cumulative counts; zeros mean "unchanged".
        let total = &mut outcome.usage;
        let set = |slot: &mut u64, n: Option<u64>| {
            if let Some(n) = n.filter(|n| *n > 0) {
                *slot = n;
            }
        };
        set(&mut total.input_tokens, usage.input_tokens);
        set(&mut total.output_tokens, usage.output_tokens);
        set(&mut total.cache_read_tokens, usage.cache_read_input_tokens);
        set(
            &mut total.cache_write_tokens,
            usage.cache_creation_input_tokens,
        );
    }
    true
}

/// `message_start` and `message_delta` carry usage (as does a whole
/// `message` from a non-streaming request); an `error` event of type
/// `rate_limit_error` means the quota ran out mid-stream.
pub fn observe(event: &Value, outcome: &mut Outcome) {
    let usage = match event.get("type").and_then(Value::as_str) {
        Some("message") => event.get("usage"),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advisor_tools_follow_a_renamed_model() {
        let body = br#"{"model":"work/claude-opus-5-5","tools":[{"name":"Read","input_schema":{"type":"object"}},{"type":"advisor_20260301","name":"advisor","model":"work/claude-opus-5-5","defer_loading":true},{"type":"custom","name":"x","model":"work/claude-opus-5-5"}],"messages":[]}"#;
        let renamed = rename_advisor(body, "work/claude-opus-5-5", "claude-opus-5-5").unwrap();
        let renamed: Value = serde_json::from_slice(&renamed).unwrap();
        assert_eq!(renamed["tools"][1]["model"], "claude-opus-5-5");
        assert_eq!(renamed["tools"][1]["defer_loading"], true);
        // Only advisors: another tool's field is the tool's own business.
        assert_eq!(renamed["tools"][2]["model"], "work/claude-opus-5-5");
        // The request's own model is the caller's to rename.
        assert_eq!(renamed["model"], "work/claude-opus-5-5");
    }

    #[test]
    fn advisors_naming_another_model_or_none_are_left_alone() {
        let other = br#"{"tools":[{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}]}"#;
        assert_eq!(rename_advisor(other, "fast", "claude-sonnet-5-5"), None);
        let none = br#"{"model":"fast","messages":[{"role":"user","content":"advisor_"}]}"#;
        assert_eq!(rename_advisor(none, "fast", "claude-sonnet-5-5"), None);
        let two = br#"{"tools":[{"type":"advisor_1","model":"fast"},{"model":"fast","type":"advisor_2"}]}"#;
        assert_eq!(
            rename_advisor(two, "fast", "claude-sonnet-5-5").unwrap(),
            br#"{"tools":[{"type":"advisor_1","model":"claude-sonnet-5-5"},{"model":"claude-sonnet-5-5","type":"advisor_2"}]}"#
        );
    }
}
