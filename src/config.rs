//! User configuration, stored as TOML in `~/.slopmax/config.toml`.

use std::collections::BTreeMap;
use std::fmt;
use std::net::SocketAddr;
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

use crate::pricing::Custom;
use crate::{fsx, ids, paths};

/// Default proxy port: "slop" on a phone keypad.
pub const DEFAULT_PORT: u16 = 7567;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Redeem a ChatGPT reset credit shortly before it expires, if the
    /// account has usage to reset; otherwise the credit lapses unused.
    pub redeem_expiring_credits: bool,
    /// When every Codex account is spent, redeem a banked reset credit
    /// instead of failing the request.
    pub redeem_when_exhausted: bool,
    /// Per-model API prices for `slopmax usage`, beyond the built-in ones.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub prices: BTreeMap<String, Custom>,
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
            redeem_expiring_credits: true,
            redeem_when_exhausted: false,
            prices: BTreeMap::new(),
        }
    }
}

/// Account selection strategy for sessions without an existing pin.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
        let text = match std::fs::read_to_string(path) {
            Ok(text) => Some(text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        };
        let invalid = || format!("invalid config {}", path.display());
        let mut config = match &text {
            Some(text) => toml_edit::de::from_str::<Self>(text).with_context(invalid)?,
            None => Self::default(),
        };
        if config.api_key.is_empty() {
            config.api_key = format!("sm-{}", ids::token());
            let text = match text {
                // Add the key without disturbing the user's comments.
                Some(text) => {
                    let mut doc: DocumentMut = text.parse().with_context(invalid)?;
                    doc["api_key"] = toml_edit::value(&config.api_key);
                    doc.to_string()
                }
                None => template(&config.api_key),
            };
            fsx::write_private(path, text.as_bytes())
                .with_context(|| format!("writing {}", path.display()))?;
        }
        Ok(config)
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

/// The config written on first run: the generated key, then every other
/// setting commented out at its default. (Keys are base64url, so they need
/// no escaping.)
fn template(api_key: &str) -> String {
    format!(
        r#"# slopmax settings. Everything but api_key is optional; the commented
# values are the defaults.

# Key agents present to the proxy, as a bearer token or x-api-key.
api_key = "{api_key}"

# Address the proxy listens on.
# listen = "127.0.0.1:{DEFAULT_PORT}"

# How a new session picks its account:
#   reset-first  spend the quota that resets soonest, so none is lost
#   fill-first   drain accounts in priority order
#   least-used   spread sessions over the least used accounts
# strategy = "reset-first"

# Minutes a session stays on its account after its last request.
# session_ttl_mins = 60

# Minutes between usage polls per account (0 turns polling off).
# poll_mins = 5

# Refresh OAuth tokens before they expire. Turn this off only while another
# tool uses the same accounts: every refresh rotates the refresh token.
# refresh_tokens = true

# Redeem a ChatGPT reset credit in its last hours, if the account has usage
# to reset, rather than let it expire unused.
# redeem_expiring_credits = true

# When every Codex account is spent, redeem a reset credit instead of
# failing the request.
# redeem_when_exhausted = false

# API prices for `slopmax usage`, in dollars per million tokens. Anthropic's
# list prices are built in; add models it can't price. Cache reads default
# to a tenth of input, cache writes to 1.25x input. For example:
#   [prices."my-model"]
#   input = 2.0
#   output = 8.0
#   cache_read = 0.5
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slopmax-config-{}", ids::token()));
        dir.join("config.toml")
    }

    #[test]
    fn first_load_writes_the_template_with_a_fresh_key() {
        let path = temp_config();
        let first = Config::load_from(&path).unwrap();
        assert!(first.api_key.starts_with("sm-"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, template(&first.api_key));
        let second = Config::load_from(&path).unwrap();
        assert_eq!(first, second);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_missing_key_is_added_without_rewriting_the_file() {
        let path = temp_config();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mine = "# my setup\nstrategy = \"fill-first\" # drain in order\n";
        std::fs::write(&path, mine).unwrap();
        let config = Config::load_from(&path).unwrap();
        assert_eq!(config.strategy, Strategy::FillFirst);
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, format!("{mine}api_key = \"{}\"\n", config.api_key));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn template_lists_every_setting_at_its_default() {
        let expected = Config {
            api_key: "sm-key".into(),
            ..Config::default()
        };
        let text = template("sm-key");
        assert_eq!(toml_edit::de::from_str::<Config>(&text).unwrap(), expected);

        let uncommented: String = text
            .lines()
            .map(|line| match line.strip_prefix("# ") {
                // Settings start the line; indented ones are examples.
                Some(setting) if setting.contains(" = ") && !setting.starts_with(' ') => setting,
                _ => line,
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            toml_edit::de::from_str::<Config>(&uncommented).unwrap(),
            expected
        );
        let listed: DocumentMut = uncommented.parse().unwrap();
        let fields: DocumentMut = toml_edit::ser::to_string(&expected)
            .unwrap()
            .parse()
            .unwrap();
        let keys = |doc: &DocumentMut| {
            doc.iter()
                .map(|(key, _)| key.to_owned())
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(keys(&listed), keys(&fields));
    }

    #[test]
    fn parses_partial_config() {
        let config: Config =
            toml_edit::de::from_str("strategy = \"fill-first\"\nlisten = \"0.0.0.0:9000\"")
                .unwrap();
        assert_eq!(config.strategy, Strategy::FillFirst);
        assert_eq!(config.base_url(), "http://127.0.0.1:9000");
        assert_eq!(config.session_ttl_mins, 60);
    }

    #[test]
    fn parses_custom_prices() {
        let config: Config =
            toml_edit::de::from_str("[prices.\"my-model\"]\ninput = 2.0\noutput = 8\n").unwrap();
        let price = config.prices["my-model"];
        assert_eq!(
            (price.input, price.output, price.cache_read),
            (2.0, 8.0, None)
        );
        assert!(toml_edit::de::from_str::<Config>("[prices.m]\ninput = 1\n").is_err());
    }

    #[test]
    fn rejects_unknown_keys() {
        assert!(toml_edit::de::from_str::<Config>("lisen = \"x\"").is_err());
    }
}
