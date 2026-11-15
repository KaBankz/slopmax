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

use crate::account::{Account, Link, Store, Tokens};
use crate::agent::{Agent, ClaudeCode, Codex};
use crate::auth::jwt;
use crate::net::Client;
use crate::paths::Home;
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
            _ => {
                return Err(format!(
                    "unknown source {s:?}; use all, claude-code, codex, or cliproxyapi"
                ));
            }
        })
    }
}

/// One importable login and where it came from.
pub struct Found {
    pub origin: String,
    pub account: Result<Account>,
}

/// What became of one found login once saved.
pub struct Saved {
    pub origin: String,
    /// The account and whether it is new, or why the login was skipped.
    pub account: Result<(Account, bool)>,
}

/// Saves found logins, merging each into an earlier record of the same
/// identity. With `own`, slopmax refreshes them itself instead of following
/// their source's files.
pub fn save(store: &Store, found: Vec<Found>, own: bool) -> Vec<Saved> {
    found
        .into_iter()
        .map(|item| Saved {
            origin: item.origin,
            account: item.account.and_then(|mut account| {
                if own {
                    account.link = None;
                }
                Ok(store.upsert(account)?)
            }),
        })
        .collect()
}

/// Collects importable logins from `source`. Missing sources are skipped.
pub async fn discover(http: &Client, source: Source, home: &Home) -> Vec<Found> {
    let mut found = Vec::new();
    let wants = |s: Source| source == Source::All || source == s;
    for (agent, wanted) in [
        (&ClaudeCode as &dyn Agent, Source::ClaudeCode),
        (&Codex, Source::Codex),
    ] {
        if wants(wanted)
            && let Some(login) = agent.import(http, home).await
        {
            found.push(login);
        }
    }
    if wants(Source::Cliproxyapi) {
        found.extend(from_cliproxyapi(http, home).await);
    }
    found
}

/// Where [`discover`] looks for `source`'s logins, as a person reads it.
pub fn places(source: Source, home: &Home) -> Vec<String> {
    let wants = |s: Source| source == Source::All || source == s;
    let mut places = Vec::new();
    if wants(Source::ClaudeCode) {
        places.push(home.show(&home.claude().join(".credentials.json")));
        if cfg!(target_os = "macos") {
            places.push("the macOS keychain".into());
        }
    }
    if wants(Source::Codex) {
        places.push(home.show(&home.codex().join("auth.json")));
    }
    if wants(Source::Cliproxyapi) {
        let dir = home.cliproxyapi();
        places.push(format!(
            "{}{}*.json",
            home.show(&dir),
            std::path::MAIN_SEPARATOR
        ));
    }
    places
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

async fn from_cliproxyapi(http: &Client, home: &Home) -> Vec<Found> {
    let dir = home.cliproxyapi();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();

    let mut found = Vec::new();
    for path in paths {
        let origin = home.show(&path);
        let file = match cliproxy_file(&path) {
            Ok(Some(file)) => file,
            // Another provider's login, which slopmax does not take.
            Ok(None) => continue,
            Err(e) => {
                found.push(Found {
                    origin,
                    account: Err(e),
                });
                continue;
            }
        };
        let provider = match file.kind.as_str() {
            "claude" => ProviderId::Claude,
            _ => ProviderId::Codex,
        };
        found.push(Found {
            origin,
            account: from_cliproxy_file(http, provider, file, &path).await,
        });
    }
    found
}

/// A CLIProxyAPI file of a kind slopmax imports, None for another kind, or
/// why it can't be read, in a person's words.
fn cliproxy_file(path: &Path) -> Result<Option<CliProxyFile>> {
    let text = fs::read_to_string(path).map_err(|e| anyhow::anyhow!("can't be read ({e})"))?;
    let value: Value = serde_json::from_str(&text)
        .ok()
        .filter(|v: &Value| v.get("type").is_some_and(Value::is_string))
        .context("not a CLIProxyAPI login file")?;
    if !matches!(value["type"].as_str(), Some("claude" | "codex")) {
        return Ok(None);
    }
    serde_json::from_value(value)
        .map(Some)
        .context("a CLIProxyAPI login with fields slopmax can't read; sign in again in CLIProxyAPI, then import again")
}

fn cliproxy_tokens(file: &CliProxyFile) -> Result<Tokens> {
    let parse_time = |s: &Option<String>| s.as_deref().and_then(|t| t.parse::<Timestamp>().ok());
    let access_token = file
        .access_token
        .clone()
        .filter(|t| !t.is_empty())
        .context("it holds no access token; sign in again in CLIProxyAPI, then import again")?;
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
    account.email = file.email.filter(|e| !e.is_empty());
    account.label = file.label.filter(|l| !l.is_empty());
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
        let root = temp_dir("cpa");
        let home = Home::sandbox(&root);
        let dir = home.cliproxyapi();
        fs::create_dir_all(&dir).unwrap();
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
        fs::write(dir.join("zz-garbage.json"), "not json").unwrap();

        let mut found = from_cliproxyapi(
            &crate::auth::http_client(crate::net::Origins::default()),
            &home,
        )
        .await;
        // A file that is not a login is reported, once and plainly; another
        // provider's is passed over.
        let garbage = found.pop().unwrap();
        assert_eq!(
            garbage.origin,
            format!(
                "~{0}.cli-proxy-api{0}zz-garbage.json",
                std::path::MAIN_SEPARATOR
            )
        );
        assert_eq!(
            format!("{:#}", garbage.account.err().unwrap()),
            "not a CLIProxyAPI login file"
        );
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
        fs::remove_dir_all(root).unwrap();
    }
}
