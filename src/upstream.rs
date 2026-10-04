//! Where upstream services live. Overridable so tests can use a mock.

/// Base URLs for the provider APIs slopmax talks to.
#[derive(Debug, Clone)]
pub struct Upstream {
    /// Anthropic API: Messages, OAuth profile, and usage.
    pub anthropic: String,
    /// ChatGPT backend: the Codex API and usage.
    pub chatgpt: String,
}

impl Default for Upstream {
    fn default() -> Self {
        Self {
            anthropic: "https://api.anthropic.com".into(),
            chatgpt: "https://chatgpt.com/backend-api".into(),
        }
    }
}

impl Upstream {
    /// Messages and other API paths, e.g. `/v1/messages?beta=true`.
    pub fn claude(&self, path_and_query: &str) -> String {
        format!("{}{path_and_query}", self.anthropic)
    }

    /// Codex API paths relative to `/codex`, e.g. `/responses`.
    pub fn codex(&self, path_and_query: &str) -> String {
        format!("{}/codex{path_and_query}", self.chatgpt)
    }

    pub fn claude_usage(&self) -> String {
        format!("{}/api/oauth/usage", self.anthropic)
    }

    pub fn codex_usage(&self) -> String {
        format!("{}/wham/usage", self.chatgpt)
    }
}
