//! Where slopmax keeps its files, and where the agents it wires up keep
//! theirs: all of it in a [`Home`], which the process makes once
//! ([`Home::current`]) and hands down, so nothing reads the environment
//! behind its caller's back and tests run side by side in homes of their own
//! ([`Home::sandbox`]).

use std::env;
use std::path::{Path, PathBuf};

fn env_dir(var: &str) -> Option<PathBuf> {
    env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// A slopmax directory and the files in it, and the directories of the tools
/// slopmax reads or wires up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Home {
    dir: PathBuf,
    /// The user's home directory.
    user: PathBuf,
    /// Claude Code's config directory.
    claude: PathBuf,
    /// Codex's config directory.
    codex: PathBuf,
}

impl Home {
    /// slopmax's files in `dir`; the user's and the agents' where the
    /// environment says, as for [`Home::current`].
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        let user = env::home_dir().unwrap_or_else(|| PathBuf::from("."));
        Self {
            dir: dir.into(),
            claude: env_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| user.join(".claude")),
            codex: env_dir("CODEX_HOME").unwrap_or_else(|| user.join(".codex")),
            user,
        }
    }

    /// `$SLOPMAX_HOME`, else `~/.slopmax`; Claude Code's in
    /// `$CLAUDE_CONFIG_DIR`, else `~/.claude`; Codex's in `$CODEX_HOME`, else
    /// `~/.codex`.
    pub fn current() -> Self {
        Self::at(slopmax_common::home())
    }

    /// Everything under `root`, as though it were the user's home: slopmax's
    /// files in `.slopmax`, the agents' in `.claude` and `.codex`.
    pub fn sandbox(root: impl Into<PathBuf>) -> Self {
        let user = root.into();
        Self {
            dir: user.join(".slopmax"),
            claude: user.join(".claude"),
            codex: user.join(".codex"),
            user,
        }
    }

    /// The user's home directory.
    pub fn user(&self) -> &Path {
        &self.user
    }

    /// Claude Code's config directory.
    pub fn claude(&self) -> &Path {
        &self.claude
    }

    /// Codex's config directory.
    pub fn codex(&self) -> &Path {
        &self.codex
    }

    /// CLIProxyAPI's credential files, which `slopmax import` reads.
    pub fn cliproxyapi(&self) -> PathBuf {
        self.user.join(".cli-proxy-api")
    }

    /// What `setup` replaced in the agents' configs, for `--undo`.
    pub fn setup_backup(&self) -> PathBuf {
        self.dir.join("setup-backup.json")
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// One JSON file per connected account.
    pub fn accounts(&self) -> PathBuf {
        self.dir.join("accounts")
    }

    pub fn config(&self) -> PathBuf {
        self.dir.join("config.toml")
    }

    /// What the daemon keeps between runs: health, readings, sessions, pins
    /// and the nudges told ([`crate::state`]).
    pub fn state(&self) -> PathBuf {
        self.dir.join("state.toml")
    }

    /// The usage ledger's monthly files.
    pub fn usage(&self) -> PathBuf {
        self.dir.join("usage")
    }

    /// Log destination for a proxy started in the background.
    pub fn log(&self) -> PathBuf {
        self.dir.join("slopmax.log")
    }

    /// Each subscription window that reset, and how much of it was used.
    pub fn windows(&self) -> PathBuf {
        self.dir.join("windows.jsonl")
    }
}
