//! OpenAI OAuth for ChatGPT accounts (the Codex CLI client).

use std::time::Duration;

use anyhow::{Context, Result, bail};
use http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::account::Account;
use crate::auth::pkce::Pkce;
use crate::auth::{self, Grant, LoginEvent, LoginOptions, Prompt, RefreshError, jwt};
use crate::ids;
use crate::net::{Client, form};
use crate::provider::ProviderId;
use crate::time::Timestamp;

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
    format!("{ISSUER}/oauth/authorize?{}", form::encode(params))
}

/// Signs in through auth.openai.com, in a browser or with a device code.
pub async fn login(http: &Client, options: LoginOptions, prompt: Prompt) -> Result<Account> {
    if options.device {
        return device_login(http, &prompt).await;
    }
    let pkce = Pkce::generate();
    let state = ids::token();
    let url = authorize_url(&pkce, &state);
    let redirect = (CALLBACK_PORT, CALLBACK_PATH);
    let callback = auth::browser_login("ChatGPT", &url, redirect, &state, options, prompt).await?;
    exchange(http, &callback.code, &pkce.verifier, &redirect_uri()).await
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
    let response = http
        .post(format!("{ISSUER}/oauth/token"))
        .form(form)
        .send()
        .await?;
    let status = response.status();
    let text = response.text().await?;
    if !status.is_success() {
        bail!("token exchange failed ({status}): {text}");
    }
    let token: TokenResponse = serde_json::from_str(&text).context("unexpected token response")?;
    let mut account = Account::new(
        ProviderId::Codex,
        token.grant().into_tokens(Timestamp::now()),
    );
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
    // Same shape as the Codex CLI: JSON, no scope.
    let body = json!({
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
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
pub async fn device_login(http: &Client, prompt: &Prompt) -> Result<Account> {
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

    prompt.tell(LoginEvent::DeviceCode {
        url: DEVICE_VERIFY_URL.to_owned(),
        code: code.user_code.clone(),
    });

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
            ProviderId::Codex,
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
            ProviderId::Codex,
            Tokens {
                access_token: access,
                ..Tokens::default()
            },
        );
        apply_claims(&mut account);
        assert_eq!(account.email.as_deref(), Some("p@x.dev"));
        assert_eq!(account.account_id.as_deref(), Some("ws-2"));
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use crate::testkit::{self, Mock};

    fn tokens() -> Value {
        json!({
            "access_token": jwt::encode_unsigned(&json!({ "exp": 1_900_000_000 })),
            "refresh_token": "rt",
            "id_token": jwt::encode_unsigned(&json!({
                "email": "me@x.dev",
                AUTH_CLAIM: { "chatgpt_account_id": "ws-1", "chatgpt_plan_type": "plus" }
            })),
        })
    }

    /// auth.openai.com: the token endpoint answers `status` with `token`;
    /// device-code polls are pending until the `ready`th.
    async fn openai(status: u16, token: Value, ready: usize) -> Mock {
        let polls = AtomicUsize::new(0);
        Mock::start(move |seen| match seen.route() {
            "/oauth/token" => testkit::json(status, token.clone()),
            "/api/accounts/deviceauth/usercode" => testkit::json(
                200,
                json!({ "device_auth_id": "dev-1", "usercode": "ABCD-1234", "interval": "0" }),
            ),
            "/api/accounts/deviceauth/token" => {
                let poll = polls.fetch_add(1, Ordering::SeqCst) + 1;
                match poll {
                    n if n < ready => testkit::reply(if n % 2 == 0 { 404 } else { 403 }, ""),
                    n if n == ready => testkit::json(
                        200,
                        json!({ "authorization_code": "dev-code", "code_verifier": "dev-verifier" }),
                    ),
                    _ => testkit::reply(500, "device flow broke"),
                }
            }
            _ => testkit::reply(404, ""),
        })
        .await
    }

    #[tokio::test]
    async fn exchanges_codes_for_an_account_named_by_its_claims() {
        let mock = openai(200, tokens(), 1).await;
        let account = exchange(&mock.client(&[ISSUER]), "code-1", "verifier", "http://cb")
            .await
            .unwrap();
        assert_eq!(account.provider, ProviderId::Codex);
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.account_id.as_deref(), Some("ws-1"));
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert_eq!(
            account.tokens.expires_at,
            Timestamp::from_second(1_900_000_000)
        );
        assert_eq!(account.tokens.refresh_token.as_deref(), Some("rt"));

        let sent = &mock.seen_at("/oauth/token")[0];
        let form: Vec<(String, String)> = form::decode(sent.text());
        let field = |name: &str| {
            form.iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(field("grant_type"), Some("authorization_code"));
        assert_eq!(field("code"), Some("code-1"));
        assert_eq!(field("code_verifier"), Some("verifier"));
        assert_eq!(field("redirect_uri"), Some("http://cb"));
        assert_eq!(field("client_id"), Some(CLIENT_ID));
    }

    #[tokio::test]
    async fn failed_exchanges_say_why() {
        let rejected = openai(403, json!({ "error": "denied" }), 1).await;
        let err = exchange(&rejected.client(&[ISSUER]), "c", "v", "r")
            .await
            .unwrap_err();
        assert!(
            err.to_string().starts_with("token exchange failed (403"),
            "{err}"
        );
        let garbled = openai(200, json!({ "id_token": "x" }), 1).await;
        let err = exchange(&garbled.client(&[ISSUER]), "c", "v", "r")
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "unexpected token response");
    }

    #[tokio::test]
    async fn refresh_sends_json_and_classifies_failures() {
        let ok = openai(200, tokens(), 1).await;
        let grant = ProviderId::Codex
            .get()
            .refresh(&ok.client(&[ISSUER]), "rt-old")
            .await
            .unwrap();
        assert!(grant.id_token.is_some());
        assert_eq!(grant.expires_at, Timestamp::from_second(1_900_000_000));
        let sent = ok.seen_at("/oauth/token")[0].json();
        assert_eq!(
            sent,
            json!({ "client_id": CLIENT_ID, "grant_type": "refresh_token", "refresh_token": "rt-old" })
        );

        let reused = openai(
            400,
            json!({ "error": { "code": "refresh_token_reused" } }),
            1,
        )
        .await;
        let err = refresh(&reused.client(&[ISSUER]), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Revoked(_)));
        let down = openai(500, json!({}), 1).await;
        let err = refresh(&down.client(&[ISSUER]), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
        let garbled = openai(200, json!({}), 1).await;
        let err = refresh(&garbled.client(&[ISSUER]), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
        let nowhere = Client::builder()
            .plain_http()
            .origins(crate::net::Origins::new([(ISSUER, "http://127.0.0.1:9")]))
            .build();
        let err = refresh(&nowhere, "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
    }

    fn recording() -> (Prompt, Arc<Mutex<Vec<LoginEvent>>>) {
        let events: Arc<Mutex<Vec<LoginEvent>>> = Arc::default();
        let log = events.clone();
        (Prompt::new(move |e| log.lock().unwrap().push(e)), events)
    }

    #[tokio::test]
    async fn device_codes_sign_in_once_approved() {
        // Two pending polls (403, then 404), then approval.
        let mock = openai(200, tokens(), 3).await;
        let (prompt, events) = recording();
        let options = LoginOptions {
            device: true,
            ..LoginOptions::default()
        };
        let account = login(&mock.client(&[ISSUER]), options, prompt)
            .await
            .unwrap();
        assert_eq!(account.account_id.as_deref(), Some("ws-1"));
        assert_eq!(
            *events.lock().unwrap(),
            [LoginEvent::DeviceCode {
                url: DEVICE_VERIFY_URL.into(),
                code: "ABCD-1234".into()
            }]
        );
        let polls = mock.seen_at("/api/accounts/deviceauth/token");
        assert_eq!(polls.len(), 3);
        assert_eq!(
            polls[0].json(),
            json!({ "device_auth_id": "dev-1", "user_code": "ABCD-1234" })
        );
        let exchanged = mock.seen_at("/oauth/token");
        let form: Vec<(String, String)> = form::decode(exchanged[0].text());
        assert!(form.contains(&("code".into(), "dev-code".into())));
        assert!(form.contains(&("code_verifier".into(), "dev-verifier".into())));
        assert!(form.contains(&("redirect_uri".into(), DEVICE_REDIRECT_URI.into())));
    }

    #[tokio::test]
    async fn device_logins_report_failures() {
        // Approval never comes: the first poll fails outright.
        let mock = openai(200, tokens(), 0).await;
        let err = device_login(&mock.client(&[ISSUER]), &Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "device login failed (500 Internal Server Error): device flow broke"
        );

        let missing = Mock::start(|_| testkit::reply(404, "")).await;
        let err = device_login(&missing.client(&[ISSUER]), &Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "device login is unavailable");
    }

    #[tokio::test]
    async fn browser_logins_accept_a_pasted_redirect() {
        let mock = openai(200, tokens(), 1).await;
        let (paste, pasted) = tokio::sync::mpsc::unbounded_channel();
        let prompt = Prompt::new(move |event| {
            if let LoginEvent::Authorize { url, title, .. } = event {
                assert_eq!(title, "ChatGPT");
                let state = url
                    .split('&')
                    .find_map(|p| p.strip_prefix("state="))
                    .unwrap()
                    .to_owned();
                paste
                    .send(format!(
                        "{}?code=browser-code&state={state}",
                        redirect_uri()
                    ))
                    .unwrap();
            }
        })
        .with_pasted(pasted);
        let options = LoginOptions {
            no_browser: true,
            ..LoginOptions::default()
        };
        let account = ProviderId::Codex
            .get()
            .login(&mock.client(&[ISSUER]), options, prompt)
            .await
            .unwrap();
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        let form: Vec<(String, String)> = form::decode(mock.seen_at("/oauth/token")[0].text());
        assert!(form.contains(&("code".into(), "browser-code".into())));
        assert!(form.contains(&("redirect_uri".into(), redirect_uri())));
    }
}
