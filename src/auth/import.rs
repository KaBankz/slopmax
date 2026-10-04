//! Imports existing logins from Claude Code, Codex, and CLIProxyAPI.
//!
//! Refresh tokens are single-use, so an imported login and its source share
//! one token chain: whichever refreshes first invalidates the other's copy.
//! After importing, route the agent through slopmax rather than using the
//! source login directly.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

use super::{claude, codex};
use crate::account::{Account, Tokens};
use crate::net::Client;
use crate::paths;
use crate::provider::ProviderId;
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// Every source below.
    All,
    /// Claude Code's login (~/.claude/.credentials.json or the macOS keychain).
    ClaudeCode,
    /// The Codex CLI login (~/.codex/auth.json).
    Codex,
    /// CLIProxyAPI credential files (~/.cli-proxy-api/*.json).
    Cliproxyapi,
}

impl std::str::FromStr for Source {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "all" => Self::All,
            "claude-code" => Self::ClaudeCode,
            "codex" => Self::Codex,
            "cliproxyapi" => Self::Cliproxyapi,
            _ => return Err(format!("unknown source {s:?}")),
        })
    }
}

/// One importable login and where it came from.
pub struct Found {
    pub origin: String,
    pub account: Result<Account>,
}

/// Collects importable logins from `source`. Missing sources are skipped.
pub async fn discover(http: &Client, source: Source) -> Vec<Found> {
    let mut found = Vec::new();
    let wants = |s: Source| source == Source::All || source == s;
    if wants(Source::ClaudeCode)
        && let Some(oauth) = claude_code_credentials()
    {
        found.push(Found {
            origin: "claude code".into(),
            account: from_claude_code(http, oauth).await,
        });
    }
    let codex_auth = paths::codex_dir().join("auth.json");
    if wants(Source::Codex) && codex_auth.exists() {
        found.push(Found {
            origin: codex_auth.display().to_string(),
            account: from_codex_auth(&codex_auth),
        });
    }
    if wants(Source::Cliproxyapi) {
        found.extend(from_cliproxyapi(http, &paths::cliproxyapi_dir()).await);
    }
    found
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCodeOauth {
    access_token: String,
    refresh_token: Option<String>,
    /// Milliseconds since the epoch.
    expires_at: Option<i64>,
}

fn claude_code_credentials() -> Option<ClaudeCodeOauth> {
    let text = fs::read_to_string(paths::claude_dir().join(".credentials.json"))
        .ok()
        .or_else(keychain_credentials)?;
    let value: Value = serde_json::from_str(&text).ok()?;
    serde_json::from_value(value.get("claudeAiOauth")?.clone()).ok()
}

/// Claude Code keeps credentials in the keychain on macOS.
fn keychain_credentials() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let output = std::process::Command::new("security")
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

async fn from_claude_code(http: &Client, oauth: ClaudeCodeOauth) -> Result<Account> {
    let mut tokens = Tokens {
        access_token: oauth.access_token,
        refresh_token: oauth.refresh_token,
        expires_at: oauth.expires_at.and_then(Timestamp::from_millisecond),
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
        let grant = claude::refresh(http, &refresh).await?;
        tokens = grant.into_tokens(now);
        tokens.refresh_token = tokens.refresh_token.or(Some(refresh));
    }
    let mut account = Account::new(ProviderId::Claude, tokens);
    let profile = claude::profile(http, &account.tokens.access_token)
        .await
        .context("could not read the Claude profile")?;
    claude::apply_profile(&mut account, &profile);
    account.assign_id();
    Ok(account)
}

#[derive(Debug, Deserialize)]
struct CodexAuthFile {
    tokens: Option<CodexTokens>,
    last_refresh: Option<Timestamp>,
}

#[derive(Debug, Deserialize)]
struct CodexTokens {
    id_token: Option<String>,
    access_token: String,
    refresh_token: Option<String>,
}

fn from_codex_auth(path: &Path) -> Result<Account> {
    let file: CodexAuthFile = serde_json::from_str(&fs::read_to_string(path)?)
        .with_context(|| format!("reading {}", path.display()))?;
    let Some(tokens) = file.tokens else {
        bail!("not a ChatGPT login (API key or proxy auth)");
    };
    let mut account = Account::new(
        ProviderId::Codex,
        Tokens {
            expires_at: super::jwt::expiry(&tokens.access_token),
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            id_token: tokens.id_token,
            refreshed_at: file.last_refresh,
        },
    );
    codex::apply_claims(&mut account);
    Ok(account)
}

/// A CLIProxyAPI credential file. Only the fields slopmax uses are read.
#[derive(Debug, Deserialize)]
struct CliProxyFile {
    #[serde(rename = "type")]
    kind: String,
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expired: Option<String>,
    last_refresh: Option<String>,
    email: Option<String>,
    account_uuid: Option<String>,
    organization_uuid: Option<String>,
    organization_name: Option<String>,
    account_id: Option<String>,
    plan_type: Option<String>,
    label: Option<String>,
    #[serde(default)]
    disabled: bool,
    priority: Option<Value>,
}

async fn from_cliproxyapi(http: &Client, dir: &Path) -> Vec<Found> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    let mut found = Vec::new();
    for path in paths {
        let file = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<CliProxyFile>(&text).ok());
        let Some(file) = file else { continue };
        let provider = match file.kind.as_str() {
            "claude" => ProviderId::Claude,
            "codex" => ProviderId::Codex,
            _ => continue,
        };
        found.push(Found {
            origin: path.display().to_string(),
            account: from_cliproxy_file(http, provider, file).await,
        });
    }
    found
}

async fn from_cliproxy_file(
    http: &Client,
    provider: ProviderId,
    file: CliProxyFile,
) -> Result<Account> {
    let parse_time = |s: &Option<String>| s.as_deref().and_then(|t| t.parse::<Timestamp>().ok());
    let access_token = file.access_token.context("no access token")?;
    let tokens = Tokens {
        expires_at: super::jwt::expiry(&access_token).or_else(|| parse_time(&file.expired)),
        refreshed_at: parse_time(&file.last_refresh),
        access_token,
        refresh_token: file.refresh_token.filter(|t| !t.is_empty()),
        id_token: file.id_token.filter(|t| !t.is_empty()),
    };
    let mut account = Account::new(provider, tokens);
    account.email = file.email;
    account.label = file.label;
    account.disabled = file.disabled;
    account.priority = file
        .priority
        .and_then(|p| p.as_i64().or_else(|| p.as_str()?.parse().ok()))
        .unwrap_or(0) as i32;
    match provider {
        ProviderId::Claude => {
            account.account_id = file.account_uuid;
            account.org_id = file.organization_uuid;
            account.org_name = file.organization_name;
            if !account.tokens.is_expired(Timestamp::now())
                && let Ok(profile) = claude::profile(http, &account.tokens.access_token).await
            {
                claude::apply_profile(&mut account, &profile);
            }
        }
        ProviderId::Codex => {
            account.account_id = file.account_id;
            account.plan = file.plan_type;
            codex::apply_claims(&mut account);
        }
    }
    account.assign_id();
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::jwt;
    use serde_json::json;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slopmax-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_codex_auth_json() {
        let dir = temp_dir("codex");
        let id_token = jwt::encode_unsigned(&json!({
            "email": "me@x.dev",
            "https://api.openai.com/auth": { "chatgpt_account_id": "ws-1", "chatgpt_plan_type": "plus" }
        }));
        let access = jwt::encode_unsigned(&json!({ "exp": 1_900_000_000 }));
        let path = dir.join("auth.json");
        let body = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "id_token": id_token, "access_token": access, "refresh_token": "rt", "account_id": "ws-1" },
            "last_refresh": "2026-10-01T00:00:00Z"
        });
        fs::write(&path, body.to_string()).unwrap();

        let account = from_codex_auth(&path).unwrap();
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert_eq!(
            account.tokens.expires_at.unwrap().as_second(),
            1_900_000_000
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn api_key_codex_auth_is_rejected() {
        let dir = temp_dir("codex-key");
        let path = dir.join("auth.json");
        fs::write(&path, r#"{"OPENAI_API_KEY":"sk-local"}"#).unwrap();
        assert!(from_codex_auth(&path).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn reads_cliproxyapi_files() {
        let dir = temp_dir("cpa");
        let claude = json!({
            "type": "claude", "access_token": "sk-ant-oat01-x", "refresh_token": "sk-ant-ort01-y",
            "expired": "2000-01-01T00:00:00Z", "email": "me@x.dev",
            "account_uuid": "acct", "organization_uuid": "org-1", "organization_name": "Org",
            "claude_device_ids": ["abc"], "priority": "3", "disabled": false
        });
        let codex = json!({
            "type": "codex", "access_token": "not-a-jwt", "account_id": "ws-9",
            "email": "c@x.dev", "plan_type": "pro", "expired": "2000-01-01T00:00:00+08:00"
        });
        fs::write(dir.join("claude-a.json"), claude.to_string()).unwrap();
        fs::write(dir.join("codex-b.json"), codex.to_string()).unwrap();
        fs::write(dir.join("xai-c.json"), r#"{"type":"xai"}"#).unwrap();
        fs::write(dir.join("config.yaml"), "port: 1").unwrap();

        let found = from_cliproxyapi(
            &crate::auth::http_client(crate::net::Origins::default()),
            &dir,
        )
        .await;
        let accounts: Vec<Account> = found.into_iter().map(|f| f.account.unwrap()).collect();
        assert_eq!(accounts.len(), 2);
        let claude = &accounts[0];
        assert_eq!(claude.org_id.as_deref(), Some("org-1"));
        assert_eq!(claude.priority, 3);
        let codex = &accounts[1];
        assert_eq!(codex.account_id.as_deref(), Some("ws-9"));
        assert_eq!(codex.plan.as_deref(), Some("pro"));
        assert!(codex.tokens.is_expired(Timestamp::now()));
        fs::remove_dir_all(dir).unwrap();
    }
}
