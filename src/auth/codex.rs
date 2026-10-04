//! OpenAI OAuth for ChatGPT accounts (the Codex CLI client).

use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use reqwest::{Client, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Grant, RefreshError, jwt, pkce::Pkce};
use crate::account::{Account, Provider};

pub const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const SCOPES: &str = "openid profile email offline_access";

/// OpenAI only accepts this exact loopback redirect for the Codex client.
pub const CALLBACK_PORT: u16 = 1455;
pub const CALLBACK_PATH: &str = "/auth/callback";

const DEVICE_VERIFY_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const DEVICE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Namespaced claim object carrying ChatGPT account details.
const AUTH_CLAIM: &str = "https://api.openai.com/auth";
const PROFILE_CLAIM: &str = "https://api.openai.com/profile";

pub fn redirect_uri() -> String {
    format!("http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}")
}

pub fn authorize_url(pkce: &Pkce, state: &str) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", &redirect_uri()),
        ("scope", SCOPES),
        ("code_challenge", &pkce.challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        // Always show the account picker so a second account can be added.
        ("prompt", "login"),
        ("state", state),
        ("originator", "codex_cli_rs"),
    ];
    url::Url::parse_with_params(&format!("{ISSUER}/oauth/authorize"), params)
        .expect("static authorize URL is valid")
        .into()
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

impl TokenResponse {
    fn grant(self) -> Grant {
        let expires_at = jwt::expiry(&self.access_token);
        Grant {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            id_token: self.id_token,
            expires_at,
        }
    }
}

/// Exchanges an authorization code for tokens and builds the account.
pub async fn exchange(
    http: &Client,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Account> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let response = http
        .post(format!("{ISSUER}/oauth/token"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("token exchange failed ({status}): {text}");
    }
    let token: TokenResponse = serde_json::from_str(&text).context("unexpected token response")?;
    let mut account = Account::new(Provider::Codex, token.grant().into_tokens(Timestamp::now()));
    apply_claims(&mut account);
    Ok(account)
}

/// Fills email, plan, and workspace from the id/access token claims.
pub fn apply_claims(account: &mut Account) {
    let tokens = &account.tokens;
    let claims: Vec<Value> = [
        tokens.id_token.as_deref(),
        Some(tokens.access_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter_map(jwt::claims)
    .collect();
    let find = |pick: &dyn Fn(&Value) -> Option<&Value>| {
        claims
            .iter()
            .find_map(|c| pick(c)?.as_str().filter(|s| !s.is_empty()))
            .map(str::to_owned)
    };
    if let Some(id) = find(&|c| c.get(AUTH_CLAIM)?.get("chatgpt_account_id")) {
        account.account_id = Some(id);
    }
    if let Some(plan) = find(&|c| c.get(AUTH_CLAIM)?.get("chatgpt_plan_type")) {
        account.plan = Some(plan);
    }
    if let Some(email) =
        find(&|c| c.get("email")).or_else(|| find(&|c| c.get(PROFILE_CLAIM)?.get("email")))
    {
        account.email = Some(email);
    }
    account.assign_id();
}

/// Redeems a refresh token. OpenAI rotates refresh tokens on use.
pub async fn refresh(http: &Client, refresh_token: &str) -> Result<Grant, RefreshError> {
    let body = json!({
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "scope": "openid profile email",
    });
    let response = http
        .post(format!("{ISSUER}/oauth/token"))
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
        return Ok(token.grant());
    }
    Err(RefreshError::classify(status, &text))
}

#[derive(Debug, Deserialize)]
struct DeviceCode {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(default)]
    interval: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct DeviceGrant {
    authorization_code: String,
    code_verifier: String,
}

/// Logs in with a short code entered at auth.openai.com, for machines
/// without a browser.
pub async fn device_login(http: &Client) -> Result<Account> {
    let code: DeviceCode = http
        .post(format!("{ISSUER}/api/accounts/deviceauth/usercode"))
        .json(&json!({ "client_id": CLIENT_ID }))
        .send()
        .await?
        .error_for_status()
        .context("device login is unavailable")?
        .json()
        .await?;
    let interval = code
        .interval
        .as_ref()
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.parse().ok()))
        .unwrap_or(5)
        .max(1);

    eprintln!(
        "\n  Open {DEVICE_VERIFY_URL}\n  and enter the code: {}\n",
        code.user_code
    );

    let deadline = tokio::time::Instant::now() + DEVICE_TIMEOUT;
    let grant = loop {
        if tokio::time::Instant::now() > deadline {
            bail!("device code expired; run login again");
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let response = http
            .post(format!("{ISSUER}/api/accounts/deviceauth/token"))
            .json(&json!({ "device_auth_id": code.device_auth_id, "user_code": code.user_code }))
            .send()
            .await?;
        match response.status() {
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND => continue,
            status if status.is_success() => break response.json::<DeviceGrant>().await?,
            status => bail!("device login failed ({status}): {}", response.text().await?),
        }
    };
    exchange(
        http,
        &grant.authorization_code,
        &grant.code_verifier,
        DEVICE_REDIRECT_URI,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;

    #[test]
    fn authorize_url_uses_registered_redirect() {
        let url = authorize_url(&Pkce::generate(), "st");
        assert!(url.starts_with("https://auth.openai.com/oauth/authorize?response_type=code"));
        assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"));
        assert!(url.contains("codex_cli_simplified_flow=true"));
        assert!(url.contains("prompt=login"));
    }

    #[test]
    fn claims_fill_identity_leniently() {
        let id_token = jwt::encode_unsigned(&json!({
            "email": "me@x.dev",
            "aud": "single-string-audience",
            AUTH_CLAIM: { "chatgpt_account_id": "ws-1", "chatgpt_plan_type": "pro" }
        }));
        let access = jwt::encode_unsigned(&json!({ "exp": 1_900_000_000 }));
        let mut account = Account::new(
            Provider::Codex,
            Tokens {
                access_token: access,
                id_token: Some(id_token),
                ..Tokens::default()
            },
        );
        apply_claims(&mut account);
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.account_id.as_deref(), Some("ws-1"));
        assert_eq!(account.plan.as_deref(), Some("pro"));
        assert!(account.id.starts_with("codex-"));
    }

    #[test]
    fn email_falls_back_to_access_token_profile_claim() {
        let access = jwt::encode_unsigned(&json!({
            PROFILE_CLAIM: { "email": "p@x.dev" },
            AUTH_CLAIM: { "chatgpt_account_id": "ws-2" }
        }));
        let mut account = Account::new(
            Provider::Codex,
            Tokens {
                access_token: access,
                ..Tokens::default()
            },
        );
        apply_claims(&mut account);
        assert_eq!(account.email.as_deref(), Some("p@x.dev"));
        assert_eq!(account.account_id.as_deref(), Some("ws-2"));
    }
}
