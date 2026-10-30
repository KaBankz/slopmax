//! Wire formats: the shapes agents and providers exchange requests,
//! responses, and errors in.
//!
//! slopmax forwards each agent's requests in the dialect it speaks. What it
//! needs to know about a dialect lives here: how errors look, how to say
//! "every account is spent" so the agent shows its usual limit message, and
//! where a stream reports token usage and in-stream refusals. When the
//! model a request asks for speaks another format, [`translate`] carries it
//! across through [`ir`].

pub mod chat;
pub mod ir;
pub mod messages;
pub mod responses;
pub mod translate;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use slopmax_common::time::Timestamp;

/// A request and response format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    /// Anthropic Messages (`/v1/messages`), spoken by Claude Code.
    Messages,
    /// OpenAI Responses (`/v1/responses`), spoken by Codex.
    Responses,
    /// OpenAI Chat Completions (`/v1/chat/completions`), spoken by most
    /// other tools.
    Chat,
}

/// Token counts: one answer's, or everything an account has served.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
}

impl Usage {
    pub fn add(&mut self, other: &Usage) {
        self.requests += other.requests;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_tokens += other.cache_read_tokens;
        self.cache_write_tokens += other.cache_write_tokens;
    }

    pub fn total_tokens(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens
    }
}

/// How a stream opens, judged one event at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opening {
    /// Nothing telling yet (the response was merely created).
    Wait,
    /// Content began, or a failure that belongs to the request.
    Content,
    /// A refusal another account may not give: a spent quota
    /// (`exhausted`) or throttling.
    Refused { exhausted: bool },
}

/// What a finished (or abandoned) stream said about the account.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Outcome {
    pub usage: Usage,
    /// An in-stream error that means the account's quota is spent.
    pub exhausted: bool,
}

impl Dialect {
    /// An error body of the given `kind`, e.g. `rate_limit_error`.
    pub fn error(self, kind: &str, message: &str) -> Value {
        match self {
            Self::Messages => messages::error(kind, message),
            Self::Responses | Self::Chat => responses::error(kind, message),
        }
    }

    /// The answer when every account is spent until `until`: the body and
    /// extra headers of the provider's own usage-limit error, so the agent
    /// shows its usual message and waits as it normally would.
    pub fn limit_reached(
        self,
        message: &str,
        until: Timestamp,
        now: Timestamp,
    ) -> (Value, Vec<(&'static str, String)>) {
        match self {
            Self::Messages => messages::limit_reached(message, until),
            Self::Responses => responses::limit_reached(message, until, now),
            Self::Chat => (chat::limit_reached(message), Vec::new()),
        }
    }

    /// Whether the proxy holds back the start of streams until they open,
    /// so a refusal inside a 200 stream can still move to another account.
    /// Claude refuses with a status code before streaming, so only Codex
    /// needs it.
    pub fn holds_start(self) -> bool {
        self == Self::Responses
    }

    /// How a stream opening with `event` should be treated.
    pub fn opening(self, event: &Value) -> Opening {
        match self {
            Self::Messages | Self::Chat => Opening::Content,
            Self::Responses => responses::opening(event),
        }
    }

    /// Folds one stream event into `outcome`.
    pub fn observe(self, event: &Value, outcome: &mut Outcome) {
        match self {
            Self::Messages => messages::observe(event, outcome),
            Self::Responses => responses::observe(event, outcome),
            Self::Chat => chat::observe(event, outcome),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Messages => "messages",
            Self::Responses => "responses",
            Self::Chat => "chat",
        }
    }
}

/// Writes one server-sent event: an optional `event:` line, then the data.
pub(crate) fn frame(out: &mut Vec<u8>, event: Option<&str>, data: &Value) {
    if let Some(event) = event {
        out.extend_from_slice(b"event: ");
        out.extend_from_slice(event.as_bytes());
        out.push(b'\n');
    }
    out.extend_from_slice(b"data: ");
    serde_json::to_writer(&mut *out, data).expect("values serialize");
    out.extend_from_slice(b"\n\n");
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn at(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    #[test]
    fn each_format_names_its_errors_its_own_way() {
        let messages = Dialect::Messages.error("rate_limit_error", "slow");
        assert_eq!(messages["type"], "error");
        assert_eq!(messages["error"]["type"], "rate_limit_error");
        assert_eq!(messages["error"]["message"], "slow");
        for dialect in [Dialect::Responses, Dialect::Chat] {
            let body = dialect.error("rate_limit_error", "slow");
            assert_eq!(body["error"]["message"], "slow", "{dialect:?}");
            assert_eq!(body["error"]["type"], "rate_limit_error", "{dialect:?}");
        }
    }

    #[test]
    fn spent_pools_answer_with_each_clients_own_limit_error() {
        let (now, until) = (at(1_000), at(4_600));
        let (body, headers) = Dialect::Chat.limit_reached("all spent", until, now);
        assert_eq!(body["error"]["code"], "rate_limit_exceeded");
        assert_eq!(body["error"]["message"], "all spent");
        assert!(headers.is_empty());

        let (body, _) = Dialect::Messages.limit_reached("all spent", until, now);
        assert_eq!(body["error"]["type"], "rate_limit_error");
        let (body, _) = Dialect::Responses.limit_reached("all spent", until, now);
        assert!(body.to_string().contains("usage_limit_reached"), "{body}");
    }

    #[test]
    fn only_codex_streams_are_held_until_they_open() {
        assert!(Dialect::Responses.holds_start());
        assert!(!Dialect::Messages.holds_start());
        assert!(!Dialect::Chat.holds_start());
        let failed = json!({"type": "error", "error": {"code": "usage_limit_reached"}});
        assert_eq!(
            Dialect::Responses.opening(&failed),
            Opening::Refused { exhausted: true }
        );
        // Claude and chat refuse before streaming: anything is content.
        assert_eq!(Dialect::Messages.opening(&failed), Opening::Content);
        assert_eq!(Dialect::Chat.opening(&failed), Opening::Content);
    }

    #[test]
    fn usage_is_read_from_each_formats_events() {
        let mut outcome = Outcome::default();
        Dialect::Chat.observe(
            &json!({"usage": {"prompt_tokens": 7, "completion_tokens": 2}}),
            &mut outcome,
        );
        assert_eq!(
            (outcome.usage.input_tokens, outcome.usage.output_tokens),
            (7, 2)
        );
        let mut outcome = Outcome::default();
        Dialect::Responses.observe(
            &json!({"type": "response.completed", "response": {"usage": {
                "input_tokens": 9, "output_tokens": 3}}}),
            &mut outcome,
        );
        assert_eq!(
            (outcome.usage.input_tokens, outcome.usage.output_tokens),
            (9, 3)
        );
        let mut outcome = Outcome::default();
        Dialect::Messages.observe(
            &json!({"type": "message_delta", "usage": {"output_tokens": 4}}),
            &mut outcome,
        );
        assert_eq!(outcome.usage.output_tokens, 4);
    }

    #[test]
    fn formats_have_stable_names() {
        assert_eq!(Dialect::Messages.as_str(), "messages");
        assert_eq!(Dialect::Responses.as_str(), "responses");
        assert_eq!(Dialect::Chat.as_str(), "chat");
    }

    #[test]
    fn usage_adds_up_and_totals_every_kind_of_token() {
        let mut total = Usage::default();
        let one = Usage {
            requests: 1,
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 100,
            cache_write_tokens: 20,
        };
        total.add(&one);
        total.add(&one);
        assert_eq!(total.requests, 2);
        assert_eq!(total.total_tokens(), 270);
    }

    #[test]
    fn frames_are_server_sent_events() {
        let mut out = Vec::new();
        frame(&mut out, Some("ping"), &json!({"a": 1}));
        frame(&mut out, None, &json!(2));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "event: ping\ndata: {\"a\":1}\n\ndata: 2\n\n"
        );
    }
}
