//! Imports existing logins from Claude Code, Codex, and CLIProxyAPI.
//!
//! Refresh tokens are single-use, so an imported login and its source share
//! one token chain: whichever refreshes first invalidates the other's copy.
//! After importing, route the agent through slopmax rather than using the
//! source login directly.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::Value;

use crate::account::{Account, Link, Tokens};
use crate::agent::{Agent, ClaudeCode, Codex};
use crate::auth::jwt;
use crate::net::Client;
use crate::paths;
use crate::provider::ProviderId;
use crate::provider::claude::oauth as claude;
use crate::provider::codex::oauth as codex;
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
    for (agent, wanted) in [
        (&ClaudeCode as &dyn Agent, Source::ClaudeCode),
        (&Codex, Source::Codex),
    ] {
        if wants(wanted)
            && let Some(login) = agent.import(http).await
        {
            found.push(login);
        }
    }
    if wants(Source::Cliproxyapi) {
        found.extend(from_cliproxyapi(http, &paths::cliproxyapi_dir()).await);
    }
    found
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
            account: from_cliproxy_file(http, provider, file, &path).await,
        });
    }
    found
}

fn cliproxy_tokens(file: &CliProxyFile) -> Result<Tokens> {
    let parse_time = |s: &Option<String>| s.as_deref().and_then(|t| t.parse::<Timestamp>().ok());
    let access_token = file.access_token.clone().context("no access token")?;
    Ok(Tokens {
        expires_at: jwt::expiry(&access_token).or_else(|| parse_time(&file.expired)),
        refreshed_at: parse_time(&file.last_refresh),
        access_token,
        refresh_token: file.refresh_token.clone().filter(|t| !t.is_empty()),
        id_token: file.id_token.clone().filter(|t| !t.is_empty()),
    })
}

/// The tokens a linked account's source holds right now.
pub fn linked_tokens(link: &Link) -> Result<Tokens> {
    match link.tool.as_str() {
        "cliproxyapi" => {
            let text = fs::read_to_string(&link.path)
                .with_context(|| format!("reading {}", link.path.display()))?;
            let file: CliProxyFile = serde_json::from_str(&text)
                .with_context(|| format!("parsing {}", link.path.display()))?;
            cliproxy_tokens(&file)
        }
        tool => anyhow::bail!("cannot follow logins from {tool}"),
    }
}

async fn from_cliproxy_file(
    http: &Client,
    provider: ProviderId,
    file: CliProxyFile,
    path: &Path,
) -> Result<Account> {
    let tokens = cliproxy_tokens(&file)?;
    let mut account = Account::new(provider, tokens);
    // CLIProxyAPI keeps refreshing its copy; follow it until `slopmax own`.
    account.link = Some(Link {
        tool: "cliproxyapi".into(),
        path: path.to_owned(),
    });
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
        // Only subscription logins are imported.
        _ => {}
    }
    account.assign_id();
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("slopmax-import-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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
        let link = claude.link.as_ref().expect("CLIProxyAPI logins are linked");
        assert_eq!(link.tool, "cliproxyapi");
        assert_eq!(link.path, dir.join("claude-a.json"));
        assert_eq!(claude.priority, 3);
        let codex = &accounts[1];
        assert_eq!(codex.account_id.as_deref(), Some("ws-9"));
        assert_eq!(codex.plan.as_deref(), Some("pro"));
        assert!(codex.tokens.is_expired(Timestamp::now()));
        fs::remove_dir_all(dir).unwrap();
    }
}
