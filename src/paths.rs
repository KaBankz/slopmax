//! Filesystem locations used by slopmax and by the agents it wires up.

use std::env;
use std::path::PathBuf;

/// The user's home directory.
pub fn user_home() -> PathBuf {
    env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn env_dir(var: &str) -> Option<PathBuf> {
    env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// Root of all slopmax state: `$SLOPMAX_HOME`, else `~/.slopmax`.
pub fn home() -> PathBuf {
    env_dir("SLOPMAX_HOME").unwrap_or_else(|| user_home().join(".slopmax"))
}

/// One JSON file per connected account.
pub fn accounts_dir() -> PathBuf {
    home().join("accounts")
}

pub fn config_file() -> PathBuf {
    home().join("config.toml")
}

/// Last known limits and token counters, written by the proxy.
pub fn state_file() -> PathBuf {
    home().join("state.json")
}

/// The usage ledger's monthly files.
pub fn usage_dir() -> PathBuf {
    home().join("usage")
}

/// Log destination for a proxy started in the background.
pub fn log_file() -> PathBuf {
    home().join("slopmax.log")
}

/// Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
pub fn claude_dir() -> PathBuf {
    env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| user_home().join(".claude"))
}

/// Codex's config dir: `$CODEX_HOME`, else `~/.codex`.
pub fn codex_dir() -> PathBuf {
    env_dir("CODEX_HOME").unwrap_or_else(|| user_home().join(".codex"))
}

/// CLIProxyAPI's default credential dir, used for imports.
pub fn cliproxyapi_dir() -> PathBuf {
    user_home().join(".cli-proxy-api")
}

/// Manual account preferences set by `slopmax use`.
pub fn pins_file() -> PathBuf {
    home().join("pins.json")
}
