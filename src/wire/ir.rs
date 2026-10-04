//! The common form translation goes through. A client's request is decoded
//! from its format into a [`Request`] and encoded into the upstream's; the
//! answer comes back as [`Event`]s that the client's format encodes again.
//! Each format needs one codec instead of one translator per pair.
//!
//! Only what agents use crosses: text, images and documents, tool calls
//! and results, reasoning, and the settings that shape an answer. Anything
//! else stays behind rather than being guessed at.

use serde_json::Value;

use crate::pool::Usage;

/// A request, as far as translation carries it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Request {
    pub model: String,
    /// System instructions, in order.
    pub system: Vec<String>,
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub tool_choice: ToolChoice,
    pub parallel_tool_calls: Option<bool>,
    pub max_tokens: Option<u64>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub stop: Vec<String>,
    pub effort: Option<Effort>,
    /// A JSON schema the answer must follow.
    pub format: Option<Format>,
    pub stream: bool,
    /// Keys the provider's prompt cache: the conversation's id.
    pub cache_key: Option<String>,
    /// The client asks for its history to be compacted into a summary
    /// (Codex's remote compaction) rather than for an answer.
    pub compact: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Part {
    Text(String),
    Image(Media),
    /// A document such as a PDF.
    File(Media),
    Call(Call),
    Result(ToolResult),
    /// Reasoning from an earlier turn.
    Reasoning(Reasoning),
}

/// An image or document, inline or by URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Media {
    pub media_type: String,
    pub source: Source,
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Base64(String),
    Url(String),
}

impl Media {
    /// A `data:` URL for inline media, else the URL itself.
    pub fn url(&self) -> String {
        match &self.source {
            Source::Base64(data) => format!("data:{};base64,{data}", self.media_type),
            Source::Url(url) => url.clone(),
        }
    }

    /// Reads a URL that may be a `data:` URL.
    pub fn from_url(url: &str) -> Self {
        let inline = url
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"));
        match inline {
            Some((media_type, data)) => Self {
                media_type: media_type.to_owned(),
                source: Source::Base64(data.to_owned()),
                name: None,
            },
            None => Self {
                media_type: String::new(),
                source: Source::Url(url.to_owned()),
                name: None,
            },
        }
    }
}

/// A tool call the model made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub id: String,
    pub name: String,
    /// JSON text for a function; the raw input for a freeform tool.
    pub input: String,
    pub kind: ToolKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub id: String,
    /// Text and images.
    pub content: Vec<Part>,
    pub is_error: bool,
}

impl ToolResult {
    /// The result's text, joined.
    pub fn text(&self) -> String {
        let texts: Vec<&str> = self
            .content
            .iter()
            .filter_map(|p| match p {
                Part::Text(text) => Some(text.as_str()),
                _ => None,
            })
            .collect();
        texts.join("\n")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reasoning {
    /// The readable summary.
    pub text: String,
    /// State only the provider that produced it can read.
    pub opaque: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// JSON schema of a function's arguments.
    pub schema: Value,
    pub kind: ToolKind,
}

/// How a tool takes its input.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ToolKind {
    /// JSON arguments matching a schema.
    #[default]
    Function,
    /// Free text, such as Codex's `apply_patch`. Formats without freeform
    /// tools see a function taking `{"input": string}`.
    Freeform,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ToolChoice {
    #[default]
    Auto,
    None,
    Required,
    Named(String),
}

/// How hard the model should think.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Effort {
    Minimal,
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "minimal" | "none" => Self::Minimal,
            "low" => Self::Low,
            "medium" => Self::Medium,
            "high" => Self::High,
            "xhigh" | "max" => Self::Max,
            _ => return None,
        })
    }

    /// The effort a thinking budget in tokens amounts to.
    pub fn from_budget(tokens: u64) -> Self {
        match tokens {
            0..4_096 => Self::Low,
            4_096..16_384 => Self::Medium,
            _ => Self::High,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Format {
    pub name: String,
    pub schema: Value,
    pub strict: bool,
}

/// One step of an answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// More of the answer's text.
    Text(String),
    /// More of the model's readable reasoning.
    Reasoning(String),
    /// Reasoning state for the next turn, readable only by its provider.
    /// It belongs to the calls that follow.
    State(String),
    /// A complete tool call.
    Call(Call),
    /// The answer ended.
    Done { stop: Stop, usage: Usage },
    /// The answer failed partway.
    Error(Failure),
}

/// Why an answer ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// It was finished.
    End,
    /// It called tools and waits for their results.
    ToolUse,
    /// It reached the token limit.
    Length,
    /// It hit a stop sequence.
    Sequence,
    /// A content filter stopped it.
    Filtered,
}

/// An upstream failure, in terms every format can state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub status: u16,
    pub message: String,
}

impl Failure {
    /// A kind of error every format names the same way.
    pub fn kind(&self) -> &'static str {
        match self.status {
            400 => "invalid_request_error",
            401 => "authentication_error",
            403 => "permission_error",
            404 => "not_found_error",
            413 => "request_too_large",
            429 => "rate_limit_error",
            529 | 503 => "overloaded_error",
            _ => "api_error",
        }
    }
}

/// A whole answer, collected from its events.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Answer {
    pub text: String,
    pub reasoning: String,
    pub calls: Vec<Call>,
    pub stop: Option<Stop>,
    pub usage: Usage,
    pub error: Option<Failure>,
}

impl Answer {
    pub fn collect(events: impl IntoIterator<Item = Event>) -> Self {
        let mut answer = Self::default();
        for event in events {
            match event {
                Event::Text(text) => answer.text.push_str(&text),
                Event::Reasoning(text) => answer.reasoning.push_str(&text),
                Event::State(_) => {}
                Event::Call(call) => answer.calls.push(call),
                Event::Done { stop, usage } => {
                    answer.stop = Some(stop);
                    answer.usage = usage;
                }
                Event::Error(failure) => answer.error = Some(failure),
            }
        }
        answer
    }

    /// Why it ended, inferring tool use from the calls.
    pub fn stop(&self) -> Stop {
        match self.stop {
            Some(Stop::End) | None if !self.calls.is_empty() => Stop::ToolUse,
            Some(stop) => stop,
            None => Stop::End,
        }
    }
}

/// The text inside JSON `content` that is a plain string or an array of
/// typed parts (`{"type": "text", "text": …}` and the like).
pub fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            texts.join("\n")
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls_round_trip() {
        let media = Media::from_url("data:image/png;base64,iVBOR");
        assert_eq!(media.media_type, "image/png");
        assert_eq!(media.source, Source::Base64("iVBOR".into()));
        assert_eq!(media.url(), "data:image/png;base64,iVBOR");
        let remote = Media::from_url("https://x.dev/a.png");
        assert_eq!(remote.source, Source::Url("https://x.dev/a.png".into()));
    }

    #[test]
    fn answers_collect_and_infer_tool_use() {
        let call = Call {
            id: "c1".into(),
            name: "Bash".into(),
            input: "{}".into(),
            kind: ToolKind::Function,
        };
        let answer = Answer::collect([
            Event::Text("Let me ".into()),
            Event::Text("look.".into()),
            Event::Call(call.clone()),
            Event::Done {
                stop: Stop::End,
                usage: Usage::default(),
            },
        ]);
        assert_eq!(answer.text, "Let me look.");
        assert_eq!(answer.calls, [call]);
        assert_eq!(answer.stop(), Stop::ToolUse);
    }

    #[test]
    fn budgets_map_to_efforts() {
        assert_eq!(Effort::from_budget(1_024), Effort::Low);
        assert_eq!(Effort::from_budget(10_000), Effort::Medium);
        assert_eq!(Effort::from_budget(31_999), Effort::High);
        assert_eq!(Effort::parse("xhigh"), Some(Effort::Max));
        assert_eq!(Effort::parse("turbo"), None);
    }
}
