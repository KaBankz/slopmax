//! Anthropic OAuth for Claude Pro/Max accounts (the Claude Code client).

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use super::{Grant, RefreshError, pkce::Pkce};
use crate::account::{Account, Provider};
use crate::log;
use crate::net::form;
use crate::time::{SignedDuration, Timestamp};

pub const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const SCOPES: &str =
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

/// Registered loopback redirect for this client.
pub const CALLBACK_PORT: u16 = 54545;
pub const CALLBACK_PATH: &str = "/callback";

/// Beta flag that lets OAuth access tokens call the Messages API.
pub const OAUTH_BETA: &str = "oauth-2025-04-20";

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}")
}

pub fn authorize_url(pkce: &Pkce, state: &str) -> String {
    let params = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", &redirect_uri()),
        ("scope", SCOPES),
        ("code_challenge", &pkce.challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];
    format!("{AUTHORIZE_URL}?{}", form::encode(params))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    account: Option<TokenAccount>,
    organization: Option<TokenOrganization>,
}

#[derive(Debug, Deserialize)]
struct TokenAccount {
    uuid: Option<String>,
    email_address: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TokenOrganization {
    uuid: Option<String>,
    name: Option<String>,
}

impl TokenResponse {
    fn grant(&self, now: Timestamp) -> Grant {
        Grant {
            access_token: self.access_token.clone(),
            refresh_token: self.refresh_token.clone(),
            id_token: None,
            expires_at: self
                .expires_in
                .map(|secs| now + SignedDuration::from_secs(secs)),
        }
    }
}

/// `GET /api/oauth/profile`, the source of plan and organization details.
#[derive(Debug, Default, Deserialize)]
pub struct Profile {
    #[serde(default)]
    pub account: ProfileAccount,
    #[serde(default)]
    pub organization: ProfileOrganization,
}

#[derive(Debug, Default, Deserialize)]
pub struct ProfileAccount {
    pub uuid: Option<String>,
    pub email: Option<String>,
    #[serde(default)]
    pub has_claude_max: bool,
    #[serde(default)]
    pub has_claude_pro: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct ProfileOrganization {
    pub uuid: Option<String>,
    pub name: Option<String>,
    /// e.g. `claude_max`, `claude_pro`, `claude_team`.
    pub organization_type: Option<String>,
    /// e.g. `default_claude_max_20x`.
    pub rate_limit_tier: Option<String>,
}

impl Profile {
    /// A short plan label such as `max 20x`, `pro`, or `team`.
    pub fn plan(&self) -> Option<String> {
        let tier = self.organization.rate_limit_tier.as_deref().unwrap_or("");
        let multiplier = tier.rsplit('_').next().filter(|m| m.ends_with('x'));
        let base = match self.organization.organization_type.as_deref() {
            Some(kind) => kind.trim_start_matches("claude_").to_string(),
            None if self.account.has_claude_max => "max".into(),
            None if self.account.has_claude_pro => "pro".into(),
            None => return None,
        };
        Some(match multiplier {
            Some(m) if base == "max" => format!("max {m}"),
            _ => base,
        })
    }
}

/// Exchanges an authorization code for tokens and builds the account.
pub async fn exchange(http: &Client, code: &str, state: &str, pkce: &Pkce) -> Result<Account> {
    let body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(),
        "client_id": CLIENT_ID,
        "code_verifier": pkce.verifier,
        "state": state,
    });
    let now = Timestamp::now();
    let response = http.post(TOKEN_URL).json(&body).send().await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        anyhow::bail!("token exchange failed ({status}): {text}");
    }
    let token: TokenResponse = serde_json::from_str(&text).context("unexpected token response")?;

    let mut account = Account::new(Provider::Claude, token.grant(now).into_tokens(now));
    if let Some(a) = &token.account {
        account.account_id = a.uuid.clone();
        account.email = a.email_address.clone();
    }
    if let Some(o) = &token.organization {
        account.org_id = o.uuid.clone();
        account.org_name = o.name.clone();
    }
    match profile(http, &account.tokens.access_token).await {
        Ok(profile) => apply_profile(&mut account, &profile),
        Err(e) => log::warn!("profile lookup failed: {e:#}"),
    }
    account.assign_id();
    Ok(account)
}

/// Fetches the account profile with an access token.
pub async fn profile(http: &Client, access_token: &str) -> Result<Profile> {
    let response = http
        .get(PROFILE_URL)
        .bearer_auth(access_token)
        .header("anthropic-beta", OAUTH_BETA)
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json().await?)
}

/// Fills identity and plan from a profile without erasing known values.
pub fn apply_profile(account: &mut Account, profile: &Profile) {
    fn keep(slot: &mut Option<String>, value: &Option<String>) {
        if let Some(v) = value.as_ref().filter(|v| !v.is_empty()) {
            *slot = Some(v.clone());
        }
    }
    keep(&mut account.account_id, &profile.account.uuid);
    keep(&mut account.email, &profile.account.email);
    keep(&mut account.org_id, &profile.organization.uuid);
    keep(&mut account.org_name, &profile.organization.name);
    keep(&mut account.plan, &profile.plan());
}

/// Redeems a refresh token. Anthropic rotates refresh tokens, so the old one
/// is dead once this succeeds.
pub async fn refresh(http: &Client, refresh_token: &str) -> Result<Grant, RefreshError> {
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLIENT_ID,
        "scope": SCOPES,
    });
    let now = Timestamp::now();
    let response = http
        .post(TOKEN_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| RefreshError::Transient(e.into()))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| RefreshError::Transient(e.into()))?;
    if status.is_success() {
        let token: TokenResponse =
            serde_json::from_str(&text).map_err(|e| RefreshError::Transient(e.into()))?;
        return Ok(token.grant(now));
    }
    Err(RefreshError::classify(status, &text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;

    #[test]
    fn authorize_url_carries_pkce_and_scopes() {
        let pkce = Pkce::generate();
        let url = authorize_url(&pkce, "st");
        assert!(url.starts_with("https://claude.ai/oauth/authorize?code=true&client_id="));
        assert!(url.contains(&format!("code_challenge={}", pkce.challenge)));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback"));
        assert!(url.contains("scope=user%3Aprofile+user%3Ainference"));
        assert!(url.contains("state=st"));
    }

    #[test]
    fn plan_from_profile() {
        let profile: Profile = serde_json::from_value(json!({
            "account": { "has_claude_max": true },
            "organization": {
                "organization_type": "claude_max",
                "rate_limit_tier": "default_claude_max_20x"
            }
        }))
        .unwrap();
        assert_eq!(profile.plan().as_deref(), Some("max 20x"));

        let pro: Profile = serde_json::from_value(json!({
            "account": { "has_claude_pro": true }, "organization": {}
        }))
        .unwrap();
        assert_eq!(pro.plan().as_deref(), Some("pro"));
    }

    #[test]
    fn apply_profile_never_erases_identity() {
        let mut account = Account::new(Provider::Claude, Tokens::default());
        account.email = Some("me@x.dev".into());
        apply_profile(&mut account, &Profile::default());
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
    }
}
