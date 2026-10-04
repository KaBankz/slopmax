//! User configuration, stored as TOML in `~/.slopmax/config.toml`.

use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::auth::pkce::random_token;
use crate::{fsx, paths};

/// Default proxy port: "slop" on a phone keypad.
pub const DEFAULT_PORT: u16 = 7567;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Address the proxy listens on.
    pub listen: SocketAddr,
    /// Key agents must present (as a bearer token or `x-api-key`).
    pub api_key: String,
    /// How a new session picks its account.
    pub strategy: Strategy,
    /// Minutes a session stays pinned to its account after its last request.
    pub session_ttl_mins: u64,
    /// Minutes between background usage polls per account (0 disables).
    pub poll_mins: u64,
    /// Whether the proxy refreshes OAuth tokens. Disable only while another
    /// tool owns the same refresh tokens.
    pub refresh_tokens: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)),
            api_key: String::new(),
            strategy: Strategy::default(),
            session_ttl_mins: 60,
            poll_mins: 5,
            refresh_tokens: true,
        }
    }
}

/// Account selection strategy for sessions without an existing pin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Strategy {
    /// Spend the quota that expires first: prefer the account whose usage
    /// window resets soonest, so no capacity is lost to a reset.
    #[default]
    ResetFirst,
    /// Drain accounts in priority order, moving on only when one is limited.
    FillFirst,
    /// Spread sessions across accounts, preferring the least used.
    LeastUsed,
}

impl fmt::Display for Strategy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::ResetFirst => "reset-first",
            Self::FillFirst => "fill-first",
            Self::LeastUsed => "least-used",
        })
    }
}

impl Config {
    /// Loads the config, creating it (with a fresh API key) on first use.
    pub fn load() -> Result<Self> {
        Self::load_from(&paths::config_file())
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        let mut config = match std::fs::read_to_string(path) {
            Ok(text) => toml::from_str::<Self>(&text)
                .with_context(|| format!("invalid config {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        if config.api_key.is_empty() {
            config.api_key = format!("sm-{}", random_token(24));
            config.save_to(path)?;
        }
        Ok(config)
    }

    pub fn save_to(&self, path: &Path) -> Result<()> {
        let text = toml::to_string_pretty(self)?;
        fsx::write_private(path, text.as_bytes())
            .with_context(|| format!("writing {}", path.display()))
    }

    /// Base URL agents use to reach the proxy.
    pub fn base_url(&self) -> String {
        let ip = self.listen.ip();
        let host = if ip.is_unspecified() {
            "127.0.0.1".to_string()
        } else if ip.is_ipv6() {
            format!("[{ip}]")
        } else {
            ip.to_string()
        };
        format!("http://{host}:{}", self.listen.port())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_load_generates_and_persists_key() {
        let dir = std::env::temp_dir().join(format!("slopmax-config-{}", std::process::id()));
        let path = dir.join("config.toml");
        let first = Config::load_from(&path).unwrap();
        assert!(first.api_key.starts_with("sm-"));
        let second = Config::load_from(&path).unwrap();
        assert_eq!(first.api_key, second.api_key);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parses_partial_config() {
        let config: Config =
            toml::from_str("strategy = \"fill-first\"\nlisten = \"0.0.0.0:9000\"").unwrap();
        assert_eq!(config.strategy, Strategy::FillFirst);
        assert_eq!(config.base_url(), "http://127.0.0.1:9000");
        assert_eq!(config.session_ttl_mins, 60);
    }

    #[test]
    fn rejects_unknown_keys() {
        assert!(toml::from_str::<Config>("lisen = \"x\"").is_err());
    }
}
