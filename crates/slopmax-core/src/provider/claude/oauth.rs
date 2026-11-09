//! Anthropic OAuth for Claude Pro/Max accounts (the Claude Code client).

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;

use crate::account::Account;
use crate::auth::pkce::Pkce;
use crate::auth::{self, Grant, LoginOptions, Prompt, RefreshError, callback};
use crate::net::{Client, form};
use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::{ids, log};

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

/// Registered redirect to Anthropic's page that shows the code to paste, for
/// a browser on another machine (Claude Code uses it over SSH).
pub const MANUAL_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}")
}

pub fn authorize_url(pkce: &Pkce, state: &str, redirect_uri: &str) -> String {
    let params = [
        ("code", "true"),
        ("client_id", CLIENT_ID),
        ("response_type", "code"),
        ("redirect_uri", redirect_uri),
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

/// Signs in through claude.ai. With no browser on this machine, the person
/// authorizes on another one, where a redirect to this machine's localhost
/// cannot arrive: Anthropic's page shows the code to paste instead.
pub async fn login(http: &Client, options: LoginOptions, prompt: Prompt) -> Result<Account> {
    let shows_code = prompt.can_paste() && !callback::has_browser();
    login_via(http, shows_code, options, prompt).await
}

async fn login_via(
    http: &Client,
    shows_code: bool,
    options: LoginOptions,
    prompt: Prompt,
) -> Result<Account> {
    let pkce = Pkce::generate();
    let state = ids::token();
    let (callback, redirect) = if shows_code {
        let redirect = MANUAL_REDIRECT_URI.to_owned();
        let url = authorize_url(&pkce, &state, &redirect);
        (
            auth::code_login("Claude", &url, &state, prompt).await?,
            redirect,
        )
    } else {
        let redirect = redirect_uri();
        let url = authorize_url(&pkce, &state, &redirect);
        let listen = (CALLBACK_PORT, CALLBACK_PATH);
        let callback = auth::browser_login("Claude", &url, listen, &state, options, prompt).await?;
        (callback, redirect)
    };
    let state = callback.state.as_deref().unwrap_or(&state);
    exchange(http, &callback.code, state, &pkce, &redirect).await
}

/// Exchanges an authorization code, issued for `redirect_uri`, for tokens and
/// builds the account.
pub async fn exchange(
    http: &Client,
    code: &str,
    state: &str,
    pkce: &Pkce,
    redirect_uri: &str,
) -> Result<Account> {
    let body = json!({
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
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

    let mut account = Account::new(ProviderId::Claude, token.grant(now).into_tokens(now));
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
        let url = authorize_url(&pkce, "st", &redirect_uri());
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
        let mut account = Account::new(ProviderId::Claude, Tokens::default());
        account.email = Some("me@x.dev".into());
        apply_profile(&mut account, &Profile::default());
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
    }

    use crate::auth::LoginEvent;
    use crate::testkit::{self, Mock};
    use serde_json::Value;

    const ORIGINS: &[&str] = &["https://platform.claude.com", "https://api.anthropic.com"];

    fn profile_of(value: Value) -> Profile {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn plans_read_the_organization_first() {
        let plan = |org: Value| profile_of(json!({ "organization": org })).plan();
        assert_eq!(
            plan(json!({ "organization_type": "claude_team" })).as_deref(),
            Some("team")
        );
        assert_eq!(
            plan(json!({ "organization_type": "claude_max" })).as_deref(),
            Some("max")
        );
        // Multipliers only qualify Max.
        assert_eq!(
            plan(json!({ "organization_type": "claude_pro", "rate_limit_tier": "x_5x" }))
                .as_deref(),
            Some("pro")
        );
        assert_eq!(plan(json!({})), None);
        let max = profile_of(json!({ "account": { "has_claude_max": true } }));
        assert_eq!(max.plan().as_deref(), Some("max"));
    }

    #[test]
    fn profiles_fill_identity_but_skip_blanks() {
        let mut account = Account::new(ProviderId::Claude, Tokens::default());
        account.org_name = Some("Kept".into());
        let profile = profile_of(json!({
            "account": { "uuid": "acct", "email": "me@x.dev" },
            "organization": { "uuid": "org", "name": "", "organization_type": "claude_pro" }
        }));
        apply_profile(&mut account, &profile);
        assert_eq!(account.account_id.as_deref(), Some("acct"));
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.org_id.as_deref(), Some("org"));
        assert_eq!(account.org_name.as_deref(), Some("Kept"));
        assert_eq!(account.plan.as_deref(), Some("pro"));
    }

    /// Anthropic's token endpoint answering `token`, and a Max 20x profile.
    async fn anthropic(status: u16, token: Value, profile: u16) -> Mock {
        Mock::start(move |seen| match seen.route() {
            "/v1/oauth/token" => testkit::json(status, token.clone()),
            "/api/oauth/profile" if profile == 200 => testkit::json(
                200,
                json!({
                    "account": { "email": "profile@x.dev" },
                    "organization": {
                        "organization_type": "claude_max",
                        "rate_limit_tier": "default_claude_max_20x"
                    }
                }),
            ),
            "/api/oauth/profile" => testkit::reply(profile, ""),
            _ => testkit::reply(404, ""),
        })
        .await
    }

    fn token_answer() -> Value {
        json!({
            "access_token": "at", "refresh_token": "rt", "expires_in": 28800,
            "account": { "uuid": "acct-1", "email_address": "token@x.dev" },
            "organization": { "uuid": "org-1", "name": "Acme" }
        })
    }

    #[tokio::test]
    async fn exchanges_codes_for_an_identified_account() {
        let mock = anthropic(200, token_answer(), 200).await;
        let pkce = Pkce::generate();
        let account = exchange(
            &mock.client(ORIGINS),
            "the-code",
            "st",
            &pkce,
            &redirect_uri(),
        )
        .await
        .unwrap();
        assert_eq!(account.provider, ProviderId::Claude);
        assert_eq!(account.tokens.access_token, "at");
        assert_eq!(account.tokens.refresh_token.as_deref(), Some("rt"));
        assert!(account.tokens.expires_at.is_some());
        assert_eq!(account.account_id.as_deref(), Some("acct-1"));
        assert_eq!(account.org_id.as_deref(), Some("org-1"));
        assert_eq!(account.org_name.as_deref(), Some("Acme"));
        // The profile's email is the current one.
        assert_eq!(account.email.as_deref(), Some("profile@x.dev"));
        assert_eq!(account.plan.as_deref(), Some("max 20x"));
        assert!(account.id.starts_with("claude-"));

        let sent = mock.seen_at("/v1/oauth/token")[0].json();
        assert_eq!(sent["grant_type"], "authorization_code");
        assert_eq!(sent["code"], "the-code");
        assert_eq!(sent["state"], "st");
        assert_eq!(sent["code_verifier"], pkce.verifier.as_str());
        assert_eq!(sent["redirect_uri"], redirect_uri());
    }

    #[tokio::test]
    async fn a_failed_profile_lookup_keeps_the_token_identity() {
        let mock = anthropic(200, token_answer(), 500).await;
        let account = exchange(
            &mock.client(ORIGINS),
            "c",
            "s",
            &Pkce::generate(),
            &redirect_uri(),
        )
        .await
        .unwrap();
        assert_eq!(account.email.as_deref(), Some("token@x.dev"));
        assert_eq!(account.plan, None);
    }

    #[tokio::test]
    async fn failed_exchanges_say_why() {
        let rejected = anthropic(400, json!({ "error": "invalid_grant" }), 200).await;
        let err = exchange(
            &rejected.client(ORIGINS),
            "c",
            "s",
            &Pkce::generate(),
            &redirect_uri(),
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string()
                .starts_with("token exchange failed (400 Bad Request)"),
            "{err}"
        );
        let garbled = anthropic(200, json!({ "nope": true }), 200).await;
        let err = exchange(
            &garbled.client(ORIGINS),
            "c",
            "s",
            &Pkce::generate(),
            &redirect_uri(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.to_string(), "unexpected token response");
    }

    #[tokio::test]
    async fn refresh_classifies_the_token_endpoints_answer() {
        let ok = anthropic(200, json!({ "access_token": "new", "expires_in": 60 }), 200).await;
        let grant = refresh(&ok.client(ORIGINS), "rt").await.unwrap();
        assert_eq!(grant.access_token, "new");
        assert_eq!(grant.refresh_token, None);
        assert!(grant.expires_at.is_some());
        let sent = ok.seen_at("/v1/oauth/token")[0].json();
        assert_eq!(sent["grant_type"], "refresh_token");
        assert_eq!(sent["scope"], SCOPES);

        let revoked = anthropic(400, json!({ "error": "invalid_grant" }), 200).await;
        let err = refresh(&revoked.client(ORIGINS), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Revoked(_)));

        let down = anthropic(502, json!({}), 200).await;
        let err = refresh(&down.client(ORIGINS), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));

        let garbled = anthropic(200, json!([]), 200).await;
        let err = refresh(&garbled.client(ORIGINS), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
    }

    #[tokio::test]
    async fn profiles_need_a_working_token() {
        let mock = anthropic(200, json!({}), 401).await;
        assert!(profile(&mock.client(ORIGINS), "at").await.is_err());
    }

    /// Signs in with a prompt that pastes `code#state` as soon as it is shown
    /// the address, the way Anthropic's code page offers it; returns the
    /// address and port shown, and the token request sent.
    async fn sign_in_by_pasting(shows_code: bool) -> (String, u16, Value) {
        let mock = anthropic(200, token_answer(), 200).await;
        let (paste, pasted) = tokio::sync::mpsc::unbounded_channel();
        let authorized = std::sync::Arc::new(std::sync::Mutex::new(None));
        let shown = authorized.clone();
        let prompt = Prompt::new(move |event| {
            if let LoginEvent::Authorize {
                url, opened, port, ..
            } = event
            {
                assert!(!opened);
                let state = url.rsplit("state=").next().unwrap().to_owned();
                paste.send(format!("pasted-code#{state}")).unwrap();
                *shown.lock().unwrap() = Some((url, port));
            }
        })
        .with_pasted(pasted);
        let options = LoginOptions {
            no_browser: true,
            ..LoginOptions::default()
        };
        let account = login_via(&mock.client(ORIGINS), shows_code, options, prompt)
            .await
            .unwrap();
        assert_eq!(account.tokens.access_token, "at");
        let (url, port) = authorized.lock().unwrap().take().unwrap();
        let sent = mock.seen_at("/v1/oauth/token")[0].json();
        assert_eq!(sent["code"], "pasted-code");
        (url, port, sent)
    }

    #[tokio::test]
    async fn logs_in_with_a_pasted_localhost_address() {
        let (url, port, sent) = sign_in_by_pasting(false).await;
        assert_eq!(port, CALLBACK_PORT);
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback"));
        assert_eq!(sent["redirect_uri"], redirect_uri());
    }

    #[tokio::test]
    async fn without_a_browser_here_the_page_shows_a_code_to_paste() {
        let (url, port, sent) = sign_in_by_pasting(true).await;
        // Nothing listens here: the code comes only from the paste.
        assert_eq!(port, 0);
        assert!(
            url.contains(
                "redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
            )
        );
        assert_eq!(sent["redirect_uri"], MANUAL_REDIRECT_URI);
    }
}
