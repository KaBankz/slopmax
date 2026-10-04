//! Claude Code, and every app that runs it (the Agent SDK, IDE extensions,
//! GUI wrappers): they all read `~/.claude/settings.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use http::HeaderMap;
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{Agent, shell_quote};
use crate::account::{Account, Tokens};
use crate::config::Config;
use crate::import::Found;
use crate::net::Client;
use crate::provider::claude::oauth;
use crate::provider::{BoxFuture, ProviderId};
use crate::proxy::rawjson::{self, Seg};
use crate::time::Timestamp;
use crate::{fsx, paths};

pub struct ClaudeCode;

/// Settings keys `setup` manages in the `env` block.
const MANAGED: [&str; 4] = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY",
    "ANTHROPIC_API_KEY",
];

/// Environment that points Claude Code at the proxy.
/// `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` makes it win over provider
/// variables in `~/.claude/settings.json`.
fn env(config: &Config) -> Vec<(&'static str, String)> {
    vec![
        ("ANTHROPIC_BASE_URL", config.base_url()),
        ("ANTHROPIC_AUTH_TOKEN", config.api_key.clone()),
        ("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1".into()),
        ("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1".into()),
    ]
}

impl Agent for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn title(&self) -> &'static str {
        "Claude Code"
    }

    fn provider(&self) -> ProviderId {
        ProviderId::Claude
    }

    /// Every Claude Code entrypoint (CLI, Agent SDK, IDE, desktop) sends
    /// `claude-cli/<version> (external, <entrypoint>)` on API calls and
    /// `claude-code/<version>` on its others.
    fn detect(&self, headers: &HeaderMap) -> bool {
        headers
            .get(http::header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ua| ua.starts_with("claude-cli/") || ua.starts_with("claude-code/"))
    }

    fn session(&self, headers: &HeaderMap, body: &[u8]) -> Option<String> {
        if let Some(id) = headers
            .get("x-claude-code-session-id")
            .and_then(|v| v.to_str().ok())
        {
            return Some(id.to_owned());
        }
        let user_id = rawjson::find_str(body, &[Seg::Key("metadata"), Seg::Key("user_id")])?;
        let inner = user_id.as_bytes();
        rawjson::find_str(inner, &[Seg::Key("session_id")]).or_else(|| {
            // Legacy form: user_<hash>_account_<uuid>_session_<uuid>.
            user_id.rsplit_once("_session_").map(|(_, s)| s.to_owned())
        })
    }

    fn command(&self, config: &Config, args: &[String]) -> Command {
        let mut command = Command::new("claude");
        command
            .envs(env(config))
            .env_remove("ANTHROPIC_API_KEY")
            .args(args);
        command
    }

    fn env(&self, config: &Config, _exe: &Path) -> String {
        let mut out: String = env(config)
            .into_iter()
            .map(|(k, v)| format!("export {k}={}\n", shell_quote(&v)))
            .collect();
        out.push_str("unset ANTHROPIC_API_KEY\n");
        out
    }

    fn config_file(&self) -> PathBuf {
        paths::claude_dir().join("settings.json")
    }

    fn setup(&self, config: &Config, file: &Path, saved: &mut Option<Value>) -> Result<()> {
        let mut settings = read_settings(file)?;
        let env = settings
            .entry("env")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .context("settings.json `env` is not an object")?;
        if saved.is_none() {
            let previous: Map<String, Value> = MANAGED
                .iter()
                .map(|k| (k.to_string(), env.get(*k).cloned().unwrap_or(Value::Null)))
                .collect();
            *saved = Some(Value::Object(previous));
        }
        env.insert("ANTHROPIC_BASE_URL".into(), config.base_url().into());
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), config.api_key.clone().into());
        env.insert(
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".into(),
            "1".into(),
        );
        // An API key alongside the token makes Claude Code warn about conflicts.
        env.remove("ANTHROPIC_API_KEY");
        // The file now holds the slopmax key, so it stays private.
        Ok(fsx::write_json(file, &settings)?)
    }

    fn undo(&self, file: &Path, saved: Value) -> Result<()> {
        let Value::Object(previous) = saved else {
            bail!("the saved Claude Code settings are unreadable");
        };
        let mut settings = read_settings(file)?;
        if let Some(env) = settings.get_mut("env").and_then(Value::as_object_mut) {
            for (key, value) in previous {
                match value {
                    Value::Null => env.remove(&key),
                    value => env.insert(key, value),
                };
            }
        }
        Ok(fsx::write_json(file, &settings)?)
    }

    fn import<'a>(&'a self, http: &'a Client) -> BoxFuture<'a, Option<Found>> {
        Box::pin(async move {
            let oauth = credentials()?;
            Some(Found {
                origin: "claude code".into(),
                account: account_from(http, oauth).await,
            })
        })
    }
}

fn read_settings(path: &Path) -> Result<Map<String, Value>> {
    match fsx::read_json::<Value>(path)? {
        Some(Value::Object(map)) => Ok(map),
        Some(_) => bail!("{} is not a JSON object", path.display()),
        None => Ok(Map::new()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedLogin {
    access_token: String,
    refresh_token: Option<String>,
    /// Milliseconds since the epoch.
    expires_at: Option<i64>,
}

/// Claude Code's login: `~/.claude/.credentials.json`, or the keychain on
/// macOS.
fn credentials() -> Option<SavedLogin> {
    let text = fs::read_to_string(paths::claude_dir().join(".credentials.json"))
        .ok()
        .or_else(keychain_credentials)?;
    let value: Value = serde_json::from_str(&text).ok()?;
    serde_json::from_value(value.get("claudeAiOauth")?.clone()).ok()
}

fn keychain_credentials() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn account_from(http: &Client, login: SavedLogin) -> Result<Account> {
    let mut tokens = Tokens {
        access_token: login.access_token,
        refresh_token: login.refresh_token,
        expires_at: login.expires_at.and_then(Timestamp::from_millisecond),
        ..Tokens::default()
    };
    let now = Timestamp::now();
    if tokens.is_expired(now) {
        // The profile lookup needs a live token. Refreshing rotates Claude
        // Code's own copy, which is fine once Claude Code uses slopmax.
        let refresh = tokens
            .refresh_token
            .clone()
            .context("login expired; log in again")?;
        let grant = oauth::refresh(http, &refresh).await?;
        tokens = grant.into_tokens(now);
        tokens.refresh_token = tokens.refresh_token.or(Some(refresh));
    }
    let mut account = Account::new(ProviderId::Claude, tokens);
    let profile = oauth::profile(http, &account.tokens.access_token)
        .await
        .context("could not read the Claude profile")?;
    oauth::apply_profile(&mut account, &profile);
    account.assign_id();
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn config() -> Config {
        Config {
            api_key: "sm-test".into(),
            ..Config::default()
        }
    }

    #[test]
    fn session_id_comes_from_header_then_metadata() {
        let mut headers = HeaderMap::new();
        let body = br#"{"metadata":{"user_id":"{\"session_id\":\"from-body\"}"}}"#;
        assert_eq!(
            ClaudeCode.session(&headers, body).as_deref(),
            Some("from-body")
        );
        headers.insert(
            "x-claude-code-session-id",
            HeaderValue::from_static("from-header"),
        );
        assert_eq!(
            ClaudeCode.session(&headers, body).as_deref(),
            Some("from-header")
        );
        let legacy = br#"{"metadata":{"user_id":"user_abc_account_def_session_s-1"}}"#;
        assert_eq!(
            ClaudeCode.session(&HeaderMap::new(), legacy).as_deref(),
            Some("s-1")
        );
    }

    #[test]
    fn detects_every_claude_code_entrypoint() {
        let ua = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert("user-agent", HeaderValue::from_static(value));
            headers
        };
        assert!(ClaudeCode.detect(&ua("claude-cli/2.1.287 (external, cli)")));
        assert!(ClaudeCode.detect(&ua(
            "claude-cli/2.1.287 (external, sdk-ts, agent-sdk/0.3.1)"
        )));
        assert!(ClaudeCode.detect(&ua("claude-code/2.1.287")));
        assert!(!ClaudeCode.detect(&ua("OpenAI/Python 2.4.0")));
        assert!(!ClaudeCode.detect(&HeaderMap::new()));
    }

    #[test]
    fn env_points_at_the_proxy() {
        let script = ClaudeCode.env(&config(), Path::new("slopmax"));
        assert!(script.contains("export ANTHROPIC_BASE_URL=http://127.0.0.1:7567"));
        assert!(script.contains("export ANTHROPIC_AUTH_TOKEN=sm-test"));
        assert!(script.contains("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1"));
        assert!(script.contains("unset ANTHROPIC_API_KEY"));
    }

    #[test]
    fn setup_round_trips_and_keeps_other_settings() {
        let dir = std::env::temp_dir().join(format!("slopmax-claude-code-{}", crate::ids::token()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        let original = json!({
            "theme": "auto",
            "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8317", "ANTHROPIC_API_KEY": "sk-x", "OTHER": "1" }
        });
        std::fs::write(&file, original.to_string()).unwrap();

        let mut saved = None;
        ClaudeCode.setup(&config(), &file, &mut saved).unwrap();
        let wired: Value = fsx::read_json(&file).unwrap().unwrap();
        assert_eq!(wired["env"]["ANTHROPIC_BASE_URL"], "http://127.0.0.1:7567");
        assert_eq!(wired["env"]["ANTHROPIC_AUTH_TOKEN"], "sm-test");
        assert!(wired["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(wired["env"]["OTHER"], "1");
        assert_eq!(wired["theme"], "auto");

        // A second setup keeps the original backup.
        ClaudeCode.setup(&config(), &file, &mut saved).unwrap();
        ClaudeCode.undo(&file, saved.unwrap()).unwrap();
        let restored: Value = fsx::read_json(&file).unwrap().unwrap();
        assert_eq!(restored, original);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
