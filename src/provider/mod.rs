//! Providers: the services slopmax holds accounts for.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::time::SignedDuration;

/// Which provider an account belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    /// Anthropic Claude Pro/Max, used by Claude Code.
    Claude,
    /// ChatGPT Plus/Pro/Team, used by Codex.
    Codex,
}

impl ProviderId {
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    /// How long before expiry an access token is refreshed. Claude tokens
    /// live 8 hours and Codex tokens about 10 days.
    pub fn refresh_lead(self) -> SignedDuration {
        match self {
            Self::Claude => SignedDuration::from_hours(1),
            Self::Codex => SignedDuration::from_hours(24),
        }
    }
}

impl std::str::FromStr for ProviderId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|p| p.as_str() == s)
            .ok_or_else(|| format!("expected claude or codex, got {s:?}"))
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
