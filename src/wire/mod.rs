//! Wire formats: the shapes agents and providers exchange requests,
//! responses, and errors in.
//!
//! slopmax forwards each agent's requests in the dialect it speaks. What it
//! needs to know about a dialect lives here: how errors look, how to say
//! "every account is spent" so the agent shows its usual limit message, and
//! where a stream reports token usage and in-stream refusals.

mod messages;
mod responses;

use serde_json::Value;

use crate::pool::Usage;
use crate::time::Timestamp;

/// A request and response format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// Anthropic Messages (`/v1/messages`), spoken by Claude Code.
    Messages,
    /// OpenAI Responses (`/v1/responses`), spoken by Codex.
    Responses,
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
            Self::Responses => responses::error(kind, message),
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
            Self::Messages => Opening::Content,
            Self::Responses => responses::opening(event),
        }
    }

    /// Folds one stream event into `outcome`.
    pub fn observe(self, event: &Value, outcome: &mut Outcome) {
        match self {
            Self::Messages => messages::observe(event, outcome),
            Self::Responses => responses::observe(event, outcome),
        }
    }
}
