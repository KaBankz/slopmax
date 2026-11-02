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
