//! xAI OAuth for SuperGrok accounts (the Grok Build CLI client), by device
//! code: auth.x.ai approves the sign-in in any browser, on any machine.

use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;

use crate::account::Account;
use crate::auth::{self, Grant, LoginEvent, LoginOptions, Prompt, RefreshError, jwt};
use crate::net::Client;
use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};

/// Grok Build's public client.
pub const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER: &str = "https://auth.x.ai";
const SCOPES: &str = "openid profile email offline_access grok-cli:access api:access";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// The longest a device code is waited on, whatever xAI says it lives.
const DEVICE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_in: Option<i64>,
}

impl TokenResponse {
    fn grant(self, now: Timestamp) -> Grant {
        let expires_at = jwt::expiry(&self.access_token).or_else(|| {
            self.expires_in
                .map(|secs| now + SignedDuration::from_secs(secs))
        });
        Grant {
            access_token: self.access_token,
            refresh_token: self.refresh_token.filter(|t| !t.is_empty()),
            id_token: self.id_token.filter(|t| !t.is_empty()),
            expires_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct DeviceCode {
    device_code: String,
    user_code: String,
    verification_uri: Option<String>,
    verification_uri_complete: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}

/// An RFC 8628 token poll's error: still pending, slow down, or a failure.
#[derive(Debug, Deserialize)]
struct PollError {
    error: String,
    error_description: Option<String>,
}

/// Signs in with a code approved at auth.x.ai. A browser here, if there is
/// one, opens on the approval page with the code filled in.
pub async fn login(http: &Client, options: LoginOptions, prompt: Prompt) -> Result<Account> {
    let code: DeviceCode = http
        .post(format!("{ISSUER}/oauth2/device/code"))
        .form([("client_id", CLIENT_ID), ("scope", SCOPES)])
        .send()
        .await?
        .error_for_status()
        .context("device sign-in is unavailable")?
        .json()
        .await
        .context("unexpected device code response")?;
    let url = code
        .verification_uri_complete
        .clone()
        .or_else(|| code.verification_uri.clone())
        .context("the device code came without a page to approve it at")?;
    if !options.no_browser {
        auth::callback::open_browser(&url);
    }
    prompt.tell(LoginEvent::DeviceCode {
        url,
        code: code.user_code.clone(),
    });

    let lifetime = code.expires_in.map_or(DEVICE_TIMEOUT, |secs| {
        Duration::from_secs(secs).min(DEVICE_TIMEOUT)
    });
    let deadline = tokio::time::Instant::now() + lifetime;
    let mut interval = code.interval.unwrap_or(5);
    let token = loop {
        if tokio::time::Instant::now() > deadline {
            bail!("device code expired; run login again");
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
        let response = http
            .post(format!("{ISSUER}/oauth2/token"))
            .form([
                ("grant_type", DEVICE_GRANT),
                ("device_code", code.device_code.as_str()),
                ("client_id", CLIENT_ID),
            ])
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        if status.is_success() {
            break serde_json::from_str::<TokenResponse>(&text)
                .context("unexpected token response")?;
        }
        match serde_json::from_str::<PollError>(&text) {
            Ok(e) if e.error == "authorization_pending" => {}
            // RFC 8628: each slow_down adds five seconds to the interval.
            Ok(e) if e.error == "slow_down" => interval += 5,
            Ok(e) if e.error == "access_denied" => bail!("the sign-in was declined"),
            Ok(e) if e.error == "expired_token" => bail!("device code expired; run login again"),
            Ok(e) => bail!(
                "device sign-in failed ({status}): {}",
                e.error_description.unwrap_or(e.error)
            ),
            Err(_) => bail!("device sign-in failed ({status}): {text}"),
        }
    };
    let now = Timestamp::now();
    let mut account = Account::new(ProviderId::Grok, token.grant(now).into_tokens(now));
    apply_claims(&mut account);
    Ok(account)
}

/// Redeems a refresh token. xAI may hand back a new one, which replaces it.
pub async fn refresh(http: &Client, refresh_token: &str) -> Result<Grant, RefreshError> {
    let response = http
        .post(format!("{ISSUER}/oauth2/token"))
        .form([
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", refresh_token),
        ])
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
        let mut grant = token.grant(Timestamp::now());
        // A refresh that returns no new refresh token leaves the old one in
        // force.
        grant
            .refresh_token
            .get_or_insert_with(|| refresh_token.to_owned());
        return Ok(grant);
    }
    Err(RefreshError::classify(status, &text))
}

/// Fills the email and the xAI user from the token claims.
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
    let find = |key: &str| {
        claims
            .iter()
            .find_map(|c| c.get(key)?.as_str().filter(|s| !s.is_empty()))
            .map(str::to_owned)
    };
    if let Some(user) = find("principal_id").or_else(|| find("sub")) {
        account.account_id = Some(user);
    }
    if let Some(email) = find("email") {
        account.email = Some(email);
    }
    account.assign_id();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::account::Tokens;
    use crate::net::form;
    use crate::testkit::{self, Mock};

    fn tokens() -> Value {
        json!({
            "access_token": jwt::encode_unsigned(&json!({
                "exp": 1_900_000_000, "sub": "user-1", "principal_id": "user-1"
            })),
            "refresh_token": "rt",
            "id_token": jwt::encode_unsigned(&json!({ "email": "me@x.dev", "sub": "user-1" })),
            "token_type": "Bearer",
            "expires_in": 21600,
        })
    }

    /// auth.x.ai: device codes approve on the `ready`th poll after
    /// `slow`ly asking once to slow down; the token endpoint answers
    /// refreshes with `refresh`.
    async fn xai(ready: usize, refresh: (u16, Value)) -> Mock {
        let polls = AtomicUsize::new(0);
        Mock::start(move |seen| match seen.route() {
            "/oauth2/device/code" => testkit::json(
                200,
                json!({
                    "device_code": "dev-1", "user_code": "ABCD-1234",
                    "verification_uri": "https://accounts.x.ai/device",
                    "verification_uri_complete": "https://accounts.x.ai/device?user_code=ABCD-1234",
                    "expires_in": 600, "interval": 0
                }),
            ),
            "/oauth2/token" => {
                let form: Vec<(String, String)> = form::decode(seen.text());
                let grant = form.iter().find(|(k, _)| k == "grant_type");
                if grant.is_some_and(|(_, v)| v == "refresh_token") {
                    return testkit::json(refresh.0, refresh.1.clone());
                }
                let poll = polls.fetch_add(1, Ordering::SeqCst) + 1;
                match poll {
                    n if n < ready => {
                        testkit::json(400, json!({ "error": "authorization_pending" }))
                    }
                    n if n == ready => testkit::json(200, tokens()),
                    _ => testkit::json(400, json!({ "error": "access_denied" })),
                }
            }
            _ => testkit::reply(404, ""),
        })
        .await
    }

    fn recording() -> (Prompt, Arc<Mutex<Vec<LoginEvent>>>) {
        let events: Arc<Mutex<Vec<LoginEvent>>> = Arc::default();
        let log = events.clone();
        (Prompt::new(move |e| log.lock().unwrap().push(e)), events)
    }

    fn options() -> LoginOptions {
        LoginOptions {
            no_browser: true,
            ..LoginOptions::default()
        }
    }

    #[tokio::test]
    async fn device_codes_sign_in_once_approved() {
        let mock = xai(3, (200, tokens())).await;
        let (prompt, events) = recording();
        let account = login(&mock.client(&[ISSUER]), options(), prompt)
            .await
            .unwrap();
        assert_eq!(account.provider, ProviderId::Grok);
        assert_eq!(account.email.as_deref(), Some("me@x.dev"));
        assert_eq!(account.account_id.as_deref(), Some("user-1"));
        assert_eq!(account.tokens.refresh_token.as_deref(), Some("rt"));
        assert_eq!(
            account.tokens.expires_at,
            Timestamp::from_second(1_900_000_000)
        );
        assert!(account.id.starts_with("grok-"));
        assert_eq!(
            *events.lock().unwrap(),
            [LoginEvent::DeviceCode {
                url: "https://accounts.x.ai/device?user_code=ABCD-1234".into(),
                code: "ABCD-1234".into()
            }]
        );
        let asked: Vec<(String, String)> =
            form::decode(mock.seen_at("/oauth2/device/code")[0].text());
        assert!(asked.contains(&("client_id".into(), CLIENT_ID.into())));
        assert!(asked.contains(&("scope".into(), SCOPES.into())));
        let polls = mock.seen_at("/oauth2/token");
        assert_eq!(polls.len(), 3);
        let poll: Vec<(String, String)> = form::decode(polls[0].text());
        assert!(poll.contains(&("grant_type".into(), DEVICE_GRANT.into())));
        assert!(poll.contains(&("device_code".into(), "dev-1".into())));
    }

    #[tokio::test]
    async fn declined_and_broken_sign_ins_say_why() {
        // The first poll is the fourth answer: past approval, so declined.
        let declined = xai(0, (200, tokens())).await;
        let err = login(&declined.client(&[ISSUER]), options(), Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "the sign-in was declined");

        let missing = Mock::start(|_| testkit::reply(404, "")).await;
        let err = login(&missing.client(&[ISSUER]), options(), Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "device sign-in is unavailable");

        let odd = Mock::start(|seen| match seen.route() {
            "/oauth2/device/code" => testkit::json(
                200,
                json!({ "device_code": "d", "user_code": "u", "interval": 0 }),
            ),
            _ => testkit::json(
                400,
                json!({ "error": "server_error", "error_description": "boom" }),
            ),
        })
        .await;
        let err = login(&odd.client(&[ISSUER]), options(), Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "the device code came without a page to approve it at"
        );
    }

    #[tokio::test]
    async fn refresh_keeps_the_old_refresh_token_unless_replaced() {
        let rotated = xai(1, (200, tokens())).await;
        let grant = refresh(&rotated.client(&[ISSUER]), "rt-old").await.unwrap();
        assert_eq!(grant.refresh_token.as_deref(), Some("rt"));
        let sent: Vec<(String, String)> = form::decode(rotated.seen_at("/oauth2/token")[0].text());
        assert!(sent.contains(&("refresh_token".into(), "rt-old".into())));
        assert!(sent.contains(&("client_id".into(), CLIENT_ID.into())));

        let kept = xai(
            1,
            (200, json!({ "access_token": "opaque", "expires_in": 60 })),
        )
        .await;
        let before = Timestamp::now();
        let grant = refresh(&kept.client(&[ISSUER]), "rt-old").await.unwrap();
        assert_eq!(grant.refresh_token.as_deref(), Some("rt-old"));
        assert!(grant.expires_at.unwrap() >= before + SignedDuration::from_secs(60));

        let revoked = xai(1, (400, json!({ "error": "invalid_grant" }))).await;
        let err = refresh(&revoked.client(&[ISSUER]), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Revoked(_)));
        let down = xai(1, (503, json!({}))).await;
        let err = refresh(&down.client(&[ISSUER]), "rt").await.unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
    }

    #[test]
    fn claims_name_the_user() {
        let access = jwt::encode_unsigned(&json!({ "sub": "u-2" }));
        let mut account = Account::new(
            ProviderId::Grok,
            Tokens {
                access_token: access,
                ..Tokens::default()
            },
        );
        apply_claims(&mut account);
        assert_eq!(account.account_id.as_deref(), Some("u-2"));
        assert_eq!(account.email, None);
    }
}
