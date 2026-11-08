//! Agents: the programs slopmax serves.
//!
//! Each agent implements [`Agent`]: how to launch it through the proxy, the
//! shell setup that wires it, how `setup` edits its own config (and undoes
//! it), how its requests name their session, and where its own login lives.
//! [`AGENTS`] is the one place that lists them.
//!
//! Three ways to connect an agent, from least to most invasive:
//! - `slopmax run <agent>` launches the agent wired up for that session;
//! - `slopmax env <agent>` prints shell setup to `eval`;
//! - `slopmax setup <agent>` writes the wiring into the agent's own config,
//!   keeping a backup for `--undo`.

mod claude_code;
mod codex;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use http::HeaderMap;
use serde_json::Value;

use crate::config::Config;
use crate::fsx;
use crate::import::Found;
use crate::net::Client;
use crate::paths::Home;
use crate::provider::{BoxFuture, ProviderId};
use crate::wire::rawjson::{self, Seg};

pub use claude_code::ClaudeCode;
pub use codex::Codex;

/// Every agent slopmax knows.
pub static AGENTS: [&dyn Agent; 2] = [&ClaudeCode, &Codex];

/// The agent with this CLI name.
pub fn find(id: &str) -> Option<&'static dyn Agent> {
    AGENTS.iter().copied().find(|a| a.id() == id)
}

/// The agent the API names. Every one it can name is in [`AGENTS`], which a
/// test holds to.
pub fn of_api(id: slopmax_api::AgentId) -> &'static dyn Agent {
    AGENTS
        .iter()
        .copied()
        .find(|a| a.api() == id)
        .expect("every agent the API names is in AGENTS")
}

/// The agent a request comes from, judged from its headers.
pub fn detect(headers: &HeaderMap) -> Option<&'static dyn Agent> {
    AGENTS.iter().copied().find(|a| a.detect(headers))
}

/// The conversation a request belongs to: the agent's own session id, or
/// one of the ids other clients commonly send.
pub fn session(agent: Option<&dyn Agent>, headers: &HeaderMap, body: &[u8]) -> Option<String> {
    if let Some(agent) = agent {
        return agent.session(headers, body);
    }
    ["session-id", "session_id", "x-session-id"]
        .iter()
        .find_map(|name| headers.get(*name)?.to_str().ok())
        .map(str::to_owned)
        .or_else(|| rawjson::find_str(body, &[Seg::Key("prompt_cache_key")]))
}

/// A program slopmax can serve.
pub trait Agent: Send + Sync {
    /// Its name on the command line: `claude`, `codex`.
    fn id(&self) -> &'static str;

    /// As slopmax's API names it.
    fn api(&self) -> slopmax_api::AgentId;

    /// For people: "Claude Code".
    fn title(&self) -> &'static str;

    /// The provider whose subscriptions it uses.
    fn provider(&self) -> ProviderId;

    /// Whether a request comes from this agent, judged from the headers it
    /// always sends.
    fn detect(&self, headers: &HeaderMap) -> bool;

    /// The conversation id its requests carry, which keeps a session on one
    /// account (and its prompt cache warm).
    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String>;

    /// The agent launched through the proxy, with `args` passed along.
    fn command(&self, config: &Config, args: &[String]) -> Command;

    /// Shell commands that wire the current shell to the proxy. `exe` is
    /// this slopmax binary.
    fn env(&self, config: &Config, exe: &Path) -> String;

    /// The config file `setup` edits.
    fn config_file(&self, home: &Home) -> PathBuf;

    /// Points the config file at the proxy. When `saved` is empty, it first
    /// records what it replaces there, for [`Agent::undo`].
    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()>;

    /// Restores what [`Agent::setup`] replaced.
    fn undo(&self, file: &Path, saved: Value) -> Result<()>;

    /// What to tell the user after `setup`.
    fn setup_note(&self) -> &'static str;

    /// Whether the agent has a saved login to import (checked without
    /// touching it).
    fn has_login(&self, home: &Home) -> bool;

    /// Where the agent's config sends it today, when that is somewhere
    /// other than its provider: a base URL or provider name.
    fn wired_to(&self, home: &Home) -> Option<String>;

    /// The agent's own saved login, if it has one.
    fn import<'a>(&'a self, http: &'a Client, home: &'a Home) -> BoxFuture<'a, Option<Found>>;
}

/// Where an agent's own config sends it.
/// Whether any of `accounts` can serve `agent`'s own models: an account of
/// its provider, or an API key that backs it.
pub fn servable(agent: &dyn Agent, accounts: &[crate::account::Account]) -> bool {
    accounts.iter().any(|a| {
        a.provider == agent.provider()
            || matches!(
                a.provider.spec().billing,
                crate::provider::Billing::Metered { backs: Some(p) } if p == agent.provider()
            )
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wiring {
    /// Through this slopmax.
    Slopmax,
    /// Somewhere else: a base URL or a provider's name.
    Elsewhere(String),
    /// Straight to its provider, as installed.
    Direct,
}

/// Where `agent`'s own config sends it, judged against this `config`.
pub fn wiring(agent: &dyn Agent, config: &Config, home: &Home) -> Wiring {
    match agent.wired_to(home) {
        Some(target) if target.contains(&config.base_url()) || target.starts_with("slopmax") => {
            Wiring::Slopmax
        }
        Some(target) => Wiring::Elsewhere(target),
        None => Wiring::Direct,
    }
}

/// Launches the agent through the proxy and returns its exit status.
pub fn run(agent: &dyn Agent, config: &Config, args: &[String]) -> Result<i32> {
    let mut command = agent.command(config, args);
    let program = command.get_program().to_string_lossy().into_owned();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = command.exec();
        anyhow::bail!("could not start {program}: {err}");
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .with_context(|| format!("could not start {program}"))?;
        Ok(status.code().unwrap_or(1))
    }
}

/// The agent's config file. A symlink (say, into a dotfiles repository) is
/// followed, so the file it points to is edited in place rather than the
/// link being replaced.
fn config_file(agent: &dyn Agent, home: &Home) -> PathBuf {
    resolve(agent.config_file(home))
}

fn resolve(path: PathBuf) -> PathBuf {
    std::fs::canonicalize(&path).unwrap_or(path)
}

/// Writes the wiring into the agent's config. Returns the file changed.
pub fn setup(agent: &dyn Agent, config: &Config, home: &Home) -> Result<PathBuf> {
    let file = config_file(agent, home);
    let backup = home.setup_backup();
    let mut saved: BTreeMap<String, Value> = fsx::read_json(&backup)?.unwrap_or_default();
    let mut slot = saved.remove(agent.id());
    let fresh = slot.is_none();
    agent.setup(config, &file, &mut slot)?;
    if fresh && let Some(previous) = slot {
        saved.insert(agent.id().to_owned(), previous);
        fsx::write_json(&backup, &saved)?;
    }
    Ok(file)
}

/// Reverts `setup`. Returns the file changed.
/// Whether `agent`'s settings from before slopmax wired it are kept, for
/// [`undo`] to put back.
pub fn backed_up(agent: &dyn Agent, home: &Home) -> bool {
    fsx::read_json::<BTreeMap<String, Value>>(&home.setup_backup())
        .ok()
        .flatten()
        .is_some_and(|saved| saved.contains_key(agent.id()))
}

pub fn undo(agent: &dyn Agent, home: &Home) -> Result<PathBuf> {
    let file = config_file(agent, home);
    let backup = home.setup_backup();
    let mut saved: BTreeMap<String, Value> = fsx::read_json(&backup)?.unwrap_or_default();
    let previous = saved
        .remove(agent.id())
        .with_context(|| format!("no {} setup to undo", agent.title()))?;
    agent.undo(&file, previous)?;
    fsx::write_json(&backup, &saved)?;
    Ok(file)
}

/// Quotes `s` for a POSIX shell when it needs quoting.
fn shell_quote(s: &str) -> String {
    if !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@".contains(c))
    {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_cover_every_subscription() {
        let mut ids: Vec<&str> = AGENTS.iter().map(|a| a.id()).collect();
        ids.dedup();
        assert_eq!(ids.len(), AGENTS.len());
        for provider in ProviderId::ALL {
            let native = AGENTS.iter().any(|a| a.provider() == provider);
            assert_eq!(native, provider.spec().is_subscription(), "{provider}");
            if let Some(only) = provider.spec().agent_only {
                assert!(find(only).is_some(), "{provider} names agent {only}");
            }
        }
        assert_eq!(find("codex").map(|a| a.title()), Some("Codex"));
        for id in [
            slopmax_api::AgentId::ClaudeCode,
            slopmax_api::AgentId::Codex,
        ] {
            assert_eq!(of_api(id).api(), id);
        }
        assert!(find("gemini").is_none());
    }

    #[test]
    fn sessions_come_from_the_agent_or_common_ids() {
        let mut headers = HeaderMap::new();
        headers.insert("x-session-id", http::HeaderValue::from_static("s-1"));
        assert_eq!(session(None, &headers, b"{}").as_deref(), Some("s-1"));
        let body = br#"{"prompt_cache_key":"pck"}"#;
        assert_eq!(
            session(None, &HeaderMap::new(), body).as_deref(),
            Some("pck")
        );
        assert_eq!(session(None, &HeaderMap::new(), b"{}"), None);
    }

    #[cfg(unix)]
    #[test]
    fn setup_edits_a_symlinked_config_in_place() {
        let dir = std::env::temp_dir().join(format!("slopmax-symlink-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let (real, link) = (dir.join("dotfiles.json"), dir.join("settings.json"));
        std::fs::write(&real, "{}").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let config = Config {
            api_key: "sm-test".into(),
            ..Config::default()
        };
        ClaudeCode
            .setup(&config, &resolve(link.clone()), &mut None)
            .unwrap();
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(
            std::fs::read_to_string(&real)
                .unwrap()
                .contains("ANTHROPIC_BASE_URL")
        );
        let missing = dir.join("absent.json");
        assert_eq!(resolve(missing.clone()), missing);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn shell_quoting() {
        assert_eq!(shell_quote("plain-value"), "plain-value");
        assert_eq!(shell_quote("it's"), r#"'it'\''s'"#);
        assert_eq!(shell_quote(""), "''");
    }
}
