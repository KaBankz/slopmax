//! Filesystem locations used by slopmax and by the agents it wires up.

use std::env;
use std::path::{Path, PathBuf};

/// The user's home directory.
pub fn user_home() -> PathBuf {
    env::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn env_dir(var: &str) -> Option<PathBuf> {
    env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// A slopmax directory and the files in it. The proxy carries its own, so
/// it never reaches into another home (tests run several side by side).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home(PathBuf);

impl Home {
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self(dir.into())
    }

    /// `$SLOPMAX_HOME`, else `~/.slopmax`.
    pub fn current() -> Self {
        Self(slopmax_common::home())
    }

    pub fn dir(&self) -> &Path {
        &self.0
    }

    /// One JSON file per connected account.
    pub fn accounts(&self) -> PathBuf {
        self.0.join("accounts")
    }

    pub fn config(&self) -> PathBuf {
        self.0.join("config.toml")
    }

    /// What the daemon keeps between runs: health, readings, sessions, pins
    /// and the nudges told ([`crate::state`]).
    pub fn state(&self) -> PathBuf {
        self.0.join("state.toml")
    }

    /// The usage ledger's monthly files.
    pub fn usage(&self) -> PathBuf {
        self.0.join("usage")
    }

    /// Log destination for a proxy started in the background.
    pub fn log(&self) -> PathBuf {
        self.0.join("slopmax.log")
    }

    /// Each subscription window that reset, and how much of it was used.
    pub fn windows(&self) -> PathBuf {
        self.0.join("windows.jsonl")
    }
}

/// Root of all slopmax state: `$SLOPMAX_HOME`, else `~/.slopmax`.
pub fn home() -> PathBuf {
    Home::current().0
}

pub fn accounts_dir() -> PathBuf {
    Home::current().accounts()
}

pub fn config_file() -> PathBuf {
    Home::current().config()
}

pub fn state_file() -> PathBuf {
    Home::current().state()
}

pub fn usage_dir() -> PathBuf {
    Home::current().usage()
}

pub fn log_file() -> PathBuf {
    Home::current().log()
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
