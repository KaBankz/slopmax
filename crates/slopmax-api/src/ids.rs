//! The names the API uses for providers, agents, strategies and the like.

use serde::{Deserialize, Serialize};

/// A provider slopmax pools accounts of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Anthropic,
    #[serde(rename = "openai")]
    OpenAi,
    Xai,
    Compat,
}

impl Provider {
    /// In the order requests try them.
    pub const ALL: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Anthropic,
        Self::OpenAi,
        Self::Xai,
        Self::Compat,
    ];

    /// As the wire and the CLI name it: `claude`, `openai`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Xai => "xai",
            Self::Compat => "compat",
        }
    }

    /// As people know it.
    pub fn title(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "ChatGPT",
            Self::Anthropic => "Anthropic API",
            Self::OpenAi => "OpenAI API",
            Self::Xai => "xAI API",
            Self::Compat => "Compatible API",
        }
    }

    /// A subscription with usage windows, rather than a key billed per
    /// token.
    pub fn is_subscription(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    /// Whether it grants limit resets, which clear its windows at once.
    pub fn grants_resets(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A coding agent slopmax serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentId {
    ClaudeCode,
    Codex,
}

/// How a new session picks its account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Strategy {
    ResetFirst,
    FillFirst,
    LeastUsed,
    RoundRobin,
}

impl Strategy {
    pub const ALL: [Self; 4] = [
        Self::ResetFirst,
        Self::FillFirst,
        Self::LeastUsed,
        Self::RoundRobin,
    ];
}

/// A request and response format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Messages,
    Responses,
    Chat,
}

/// The length of a usage window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Span {
    #[serde(rename = "5h")]
    FiveHours,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

impl Span {
    /// `5h`, `7d` or `30d`, as the wire has it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FiveHours => "5h",
            Self::Week => "7d",
            Self::Month => "30d",
        }
    }
}

/// What a notice is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeKind {
    Limited,
    Available,
    Exhausted,
    Recovered,
    SignedOut,
    ResetExpiring,
    QuotaUnused,
    Test,
}

/// How a front end colors a condition, a note or a window's use, so every
/// one colors them alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    Good,
    Muted,
    Accent,
    Warn,
    Bad,
}
