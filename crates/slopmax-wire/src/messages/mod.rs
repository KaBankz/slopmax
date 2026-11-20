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

/// The name of Claude Code's advisor, a server tool.
const ADVISOR: &str = "advisor";

/// What stands in for an assistant turn left with nothing to say once its
/// advisor blocks are dropped (Claude refuses an empty one); Claude Code
/// writes the same.
const ADVISED: &[u8] = br#"{"type":"text","text":"[Advisor response]"}"#;

/// The id of the advisor call a content block holds: Claude's call itself
/// (a `server_tool_use` named `advisor`) or the result it gave.
fn advisor_block(block: &[u8]) -> Option<String> {
    let field = |key| rawjson::find_str(block, &[Seg::Key(key)]);
    match field("type")?.as_str() {
        "server_tool_use" if field("name").as_deref() == Some(ADVISOR) => field("id"),
        "advisor_tool_result" => field("tool_use_id"),
        _ => None,
    }
}

/// Whether a content block says nothing a reader would see.
fn says_nothing(block: &[u8]) -> bool {
    let field = |key| rawjson::find_str(block, &[Seg::Key(key)]);
    match field("type").as_deref() {
        Some("thinking" | "redacted_thinking") => true,
        Some("text") => field("text").is_none_or(|text| text.trim().is_empty()),
        _ => false,
    }
}

/// `body` without the advisor calls (and their results) whose ids `keep`
/// turns down, or `None` when it holds none. Claude seals an advisor's
/// result to the account that made the call and refuses it from any other
/// ("Advisor tool result content could not be processed"), so a
/// conversation that moves to another account must leave the old one's
/// behind. Claude Code drops them all itself after that refusal, at the
/// cost of a failed request and of every advisor result after it.
pub fn strip_advisor(body: &[u8], keep: impl Fn(&str) -> bool) -> Option<Vec<u8>> {
    let messages = rawjson::find(body, &[Seg::Key("messages")])?;
    memchr::memmem::find(&body[messages], b"\"advisor")?;
    let mut out = None::<Vec<u8>>;
    // Last to first, so the ranges still ahead stay where they are.
    for message in rawjson::elements(body, &[Seg::Key("messages")])
        .into_iter()
        .rev()
    {
        let turn = &body[message.clone()];
        if rawjson::find_str(turn, &[Seg::Key("role")]).as_deref() != Some("assistant") {
            continue;
        }
        let blocks = rawjson::elements(turn, &[Seg::Key("content")]);
        let kept: Vec<&[u8]> = blocks
            .iter()
            .map(|block| &turn[block.clone()])
            .filter(|block| advisor_block(block).is_none_or(|id| keep(&id)))
            .collect();
        if kept.len() == blocks.len() {
            continue;
        }
        let mut content = b"[".to_vec();
        for (i, block) in kept.iter().enumerate() {
            if i > 0 {
                content.push(b',');
            }
            content.extend_from_slice(block);
        }
        if kept.iter().all(|block| says_nothing(block)) {
            if !kept.is_empty() {
                content.push(b',');
            }
            content.extend_from_slice(ADVISED);
        }
        content.push(b']');
        let Some(at) = rawjson::find(turn, &[Seg::Key("content")]) else {
            continue;
        };
        let at = message.start + at.start..message.start + at.end;
        out = Some(rawjson::splice(
            out.as_deref().unwrap_or(body),
            at,
            &content,
        ));
    }
    out
}

/// Whether a 400 is Claude refusing advisor results, as it does those
/// another account made. Claude Code reads the same two messages.
pub fn rejects_advisor(body: &[u8]) -> bool {
    [
        &b"Advisor tool result content could not be processed"[..],
        b"found in advisor_tool_result blocks",
    ]
    .iter()
    .any(|needle| memchr::memmem::find(body, needle).is_some())
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
    #[serde(borrow)]
    content_block: Option<Block<'a>>,
    /// A whole `message`'s blocks.
    #[serde(borrow)]
    content: Option<Vec<Block<'a>>>,
}

#[derive(serde::Deserialize)]
struct Block<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<std::borrow::Cow<'a, str>>,
    #[serde(borrow)]
    name: Option<std::borrow::Cow<'a, str>>,
    #[serde(borrow)]
    id: Option<std::borrow::Cow<'a, str>>,
}

impl Block<'_> {
    /// The id of Claude's call to the advisor this block starts, if it does.
    fn advisor(&self) -> Option<&str> {
        let call = self.kind.as_deref() == Some("server_tool_use")
            && self.name.as_deref() == Some(ADVISOR);
        self.id.as_deref().filter(|_| call)
    }
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
        "message_delta" => event.usage,
        "message" => {
            let blocks = event.content.iter().flatten();
            let calls = blocks.filter_map(Block::advisor).map(str::to_owned);
            outcome.advisors.extend(calls);
            event.usage
        }
        "content_block_start" => {
            let call = event.content_block.as_ref().and_then(Block::advisor);
            outcome.advisors.extend(call.map(str::to_owned));
            None
        }
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
/// `rate_limit_error` means the quota ran out mid-stream; a block that
/// starts a call to the advisor (alone, or in a whole `message`) names it.
pub fn observe(event: &Value, outcome: &mut Outcome) {
    let advisor = |block: &Value| {
        let call = block.get("type").and_then(Value::as_str) == Some("server_tool_use")
            && block.get("name").and_then(Value::as_str) == Some(ADVISOR);
        let id = block.get("id").and_then(Value::as_str).filter(|_| call);
        id.map(str::to_owned)
    };
    let usage = match event.get("type").and_then(Value::as_str) {
        Some("message") => {
            let blocks = event.get("content").and_then(Value::as_array);
            outcome
                .advisors
                .extend(blocks.into_iter().flatten().filter_map(advisor));
            event.get("usage")
        }
        Some("content_block_start") => {
            outcome
                .advisors
                .extend(event.get("content_block").and_then(advisor));
            None
        }
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

    /// A conversation as Claude Code sends it after two advisor calls:
    /// `mine` beside text, then `theirs` alone in a turn with thinking.
    const ADVISED_TWICE: &[u8] = br#"{"model":"claude-opus-5-5","messages":[{"role":"user","content":"plan it"},{"role":"assistant","content":[{"type":"server_tool_use","id":"srvtoolu_mine","name":"advisor","input":{}},{"type":"advisor_tool_result","tool_use_id":"srvtoolu_mine","content":{"type":"advisor_redacted_result","encrypted_content":"AAA"}},{"type":"text","text":"Plan: one."}]},{"role":"user","content":[{"type":"text","text":"go on"}]},{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"sig"},{"type":"server_tool_use","id":"srvtoolu_theirs","name":"advisor","input":{}},{"type":"advisor_tool_result","tool_use_id":"srvtoolu_theirs","content":{"type":"advisor_redacted_result","encrypted_content":"BBB"}}]},{"role":"user","content":"and?"}],"tools":[{"type":"advisor_20260301","name":"advisor","model":"claude-opus-5-5"}]}"#;

    #[test]
    fn advisor_blocks_another_account_made_are_dropped() {
        let stripped = strip_advisor(ADVISED_TWICE, |id| id == "srvtoolu_mine").unwrap();
        let stripped: Value = serde_json::from_slice(&stripped).unwrap();
        let mut sent: Value = serde_json::from_slice(ADVISED_TWICE).unwrap();
        // Only the second assistant turn changes: its thinking stays, and
        // with nothing else left it gets Claude Code's placeholder.
        sent["messages"][3]["content"] = json!([
            {"type": "thinking", "thinking": "", "signature": "sig"},
            {"type": "text", "text": "[Advisor response]"},
        ]);
        assert_eq!(stripped, sent);
    }

    #[test]
    fn every_advisor_block_can_be_dropped() {
        let stripped = strip_advisor(ADVISED_TWICE, |_| false).unwrap();
        let stripped: Value = serde_json::from_slice(&stripped).unwrap();
        assert_eq!(
            stripped["messages"][1]["content"],
            json!([{"type": "text", "text": "Plan: one."}])
        );
        assert_eq!(
            stripped["messages"][3]["content"][1]["text"],
            "[Advisor response]"
        );
        // The advisor tool itself stays offered.
        assert_eq!(stripped["tools"][0]["name"], "advisor");
        let only = br#"{"messages":[{"role":"assistant","content":[{"type":"server_tool_use","id":"a","name":"advisor","input":{}}]}]}"#;
        assert_eq!(
            strip_advisor(only, |_| false).unwrap(),
            br#"{"messages":[{"role":"assistant","content":[{"type":"text","text":"[Advisor response]"}]}]}"#
        );
    }

    #[test]
    fn bodies_without_foreign_advisor_blocks_are_left_alone() {
        assert_eq!(strip_advisor(ADVISED_TWICE, |_| true), None);
        let plain = br#"{"messages":[{"role":"user","content":"the advisor said"},{"role":"assistant","content":[{"type":"server_tool_use","id":"w","name":"web_search","input":{}}]}],"tools":[{"type":"advisor_20260301","name":"advisor"}]}"#;
        assert_eq!(strip_advisor(plain, |_| false), None);
        assert_eq!(strip_advisor(b"{}", |_| false), None);
    }

    #[test]
    fn claude_refusing_advisor_results_is_recognised() {
        let refused = br#"{"type":"error","error":{"type":"invalid_request_error","message":"Advisor tool result content could not be processed."}}"#;
        assert!(rejects_advisor(refused));
        assert!(!rejects_advisor(
            br#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}"#
        ));
    }

    #[test]
    fn advisor_calls_are_read_from_answers() {
        let start = br#"{"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"advisor","input":{}}}"#;
        let search = br#"{"type":"content_block_start","index":2,"content_block":{"type":"server_tool_use","id":"srvtoolu_2","name":"web_search","input":{}}}"#;
        let text = br#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#;
        let whole = br#"{"type":"message","content":[{"type":"text","text":"x"},{"type":"server_tool_use","id":"srvtoolu_3","name":"advisor","input":{}}],"usage":{"input_tokens":5}}"#;
        let mut typed = Outcome::default();
        let mut by_value = Outcome::default();
        for event in [&start[..], search, text, whole] {
            assert!(observe_raw(event, &mut typed));
            observe(&serde_json::from_slice(event).unwrap(), &mut by_value);
        }
        assert_eq!(typed.advisors, ["srvtoolu_1", "srvtoolu_3"]);
        assert_eq!(typed, by_value);
        assert_eq!(typed.usage.input_tokens, 5);
    }

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
