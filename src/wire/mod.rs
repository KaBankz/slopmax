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

use crate::time::Timestamp;

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
