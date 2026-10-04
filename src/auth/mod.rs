//! Account connection: OAuth login, token refresh, and credential import.

pub mod callback;
pub mod claude;
pub mod codex;
pub mod import;
pub mod jwt;
pub mod pkce;

use std::time::Duration;

use anyhow::{Result, anyhow};
use reqwest::{Client, StatusCode};

use crate::account::{Account, Provider, Store, Tokens};
use crate::ids;
use crate::log;
use crate::time::Timestamp;
use pkce::Pkce;

/// Tokens returned by a code exchange or refresh.
#[derive(Debug, Clone)]
pub struct Grant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_at: Option<Timestamp>,
}

impl Grant {
    pub fn into_tokens(self, now: Timestamp) -> Tokens {
        Tokens {
            access_token: self.access_token,
            refresh_token: self.refresh_token,
            id_token: self.id_token,
            expires_at: self.expires_at,
            refreshed_at: Some(now),
        }
    }
}

/// Why a token refresh failed.
#[derive(Debug)]
pub enum RefreshError {
    /// The refresh token was rejected; only a new login can fix this.
    Revoked(String),
    /// A temporary failure; the stored token may still work later.
    Transient(anyhow::Error),
}

impl RefreshError {
    /// Classifies a non-success token endpoint response. Refresh tokens are
    /// single-use, so only explicit rejections count as revoked.
    pub fn classify(status: StatusCode, body: &str) -> Self {
        const REJECTIONS: [&str; 4] = [
            "invalid_grant",
            "refresh_token_expired",
            "refresh_token_reused",
            "refresh_token_invalidated",
        ];
        let rejected = REJECTIONS.iter().any(|code| body.contains(code));
        if status == StatusCode::UNAUTHORIZED || (status.is_client_error() && rejected) {
            Self::Revoked(format!("refresh token rejected ({status})"))
        } else {
            Self::Transient(anyhow!("token refresh failed ({status}): {body}"))
        }
    }
}

impl std::fmt::Display for RefreshError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Revoked(reason) => write!(f, "{reason}; log in again"),
            Self::Transient(err) => write!(f, "{err:#}"),
        }
    }
}

impl std::error::Error for RefreshError {}

/// HTTP client for OAuth and usage endpoints, with bounded timeouts.
pub fn http_client() -> Client {
    Client::builder()
        .user_agent(concat!("slopmax/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .expect("TLS backend initializes")
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LoginOptions {
    /// Use the device-code flow (Codex only).
    pub device: bool,
    /// Print the authorize URL instead of opening a browser.
    pub no_browser: bool,
}

/// Runs an interactive OAuth login and returns the connected account.
pub async fn login(provider: Provider, options: LoginOptions) -> Result<Account> {
    let http = http_client();
    if provider == Provider::Codex && options.device {
        return codex::device_login(&http).await;
    }
    let pkce = Pkce::generate();
    let state = ids::token();
    let (url, port, path) = match provider {
        Provider::Claude => (
            claude::authorize_url(&pkce, &state),
            claude::CALLBACK_PORT,
            claude::CALLBACK_PATH,
        ),
        Provider::Codex => (
            codex::authorize_url(&pkce, &state),
            codex::CALLBACK_PORT,
            codex::CALLBACK_PATH,
        ),
    };

    let opened = !options.no_browser && callback::open_browser(&url);
    eprintln!(
        "\n  {} your {provider} account in the browser:\n\n  {url}\n",
        if opened { "Opened" } else { "Authorize" }
    );
    eprintln!(
        "  Waiting for the redirect to localhost:{port}. If the browser runs on another\n  \
         machine, paste the final localhost URL from its address bar here.\n"
    );

    let callback = callback::receive(port, path, &state).await?;
    match provider {
        Provider::Claude => {
            let state = callback.state.as_deref().unwrap_or(&state);
            claude::exchange(&http, &callback.code, state, &pkce).await
        }
        Provider::Codex => {
            codex::exchange(
                &http,
                &callback.code,
                &pkce.verifier,
                &codex::redirect_uri(),
            )
            .await
        }
    }
}

/// Returns `account` with a usable access token, refreshing it when it is
/// within the provider's refresh lead (or always, with `force`).
///
/// Refreshes are serialized across slopmax processes with the account's lock
/// file. The stored copy is re-read under the lock so a token another process
/// already rotated is reused rather than refreshed twice. The refresh runs in
/// a detached task: once a single-use refresh token is sent, the new tokens
/// must be persisted even if the caller goes away.
pub async fn ensure_fresh(
    http: &Client,
    store: &Store,
    account: &Account,
    force: bool,
) -> Result<Account, RefreshError> {
    let now = Timestamp::now();
    let due = move |a: &Account| force || a.tokens.expires_within(a.provider.refresh_lead(), now);
    if !due(account) {
        return Ok(account.clone());
    }
    let (http, store, stale) = (http.clone(), store.clone(), account.clone());
    let task = tokio::spawn(async move {
        let id = stale.id.clone();
        let lock_store = store.clone();
        let _lock = tokio::task::spawn_blocking(move || lock_store.lock(&id))
            .await
            .map_err(|e| RefreshError::Transient(e.into()))?
            .map_err(RefreshError::Transient)?;

        let current = store
            .get(&stale.id)
            .map_err(RefreshError::Transient)?
            .unwrap_or(stale.clone());
        let rotated_elsewhere = current.tokens.access_token != stale.tokens.access_token;
        if rotated_elsewhere || !due(&current) {
            return Ok(current);
        }
        refresh_and_save(&http, &store, current).await
    });
    task.await.map_err(|e| RefreshError::Transient(e.into()))?
}

async fn refresh_and_save(
    http: &Client,
    store: &Store,
    mut account: Account,
) -> Result<Account, RefreshError> {
    let Some(refresh_token) = account.tokens.refresh_token.clone() else {
        return Err(RefreshError::Revoked("no refresh token stored".into()));
    };
    let result = match account.provider {
        Provider::Claude => claude::refresh(http, &refresh_token).await,
        Provider::Codex => codex::refresh(http, &refresh_token).await,
    };
    let grant = match result {
        Ok(grant) => grant,
        Err(err) => {
            if let RefreshError::Revoked(reason) = &err {
                account.auth_error = Some(reason.clone());
                let _ = store.save(&account);
            }
            return Err(err);
        }
    };

    let now = Timestamp::now();
    let mut tokens = grant.into_tokens(now);
    // Providers may omit tokens that did not rotate.
    tokens.refresh_token = tokens.refresh_token.or(Some(refresh_token));
    tokens.id_token = tokens.id_token.or(account.tokens.id_token.take());
    account.tokens = tokens;
    account.auth_error = None;

    match account.provider {
        Provider::Codex => codex::apply_claims(&mut account),
        Provider::Claude => {
            if let Ok(profile) = claude::profile(http, &account.tokens.access_token).await {
                claude::apply_profile(&mut account, &profile);
            }
        }
    }
    // Persist before anyone uses the new token: the old refresh token is dead.
    if let Err(e) = store.save(&account) {
        log::error!("refreshed {} but could not save it: {e:#}", account.id);
    }
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_refresh_failures() {
        let revoked = |s, b| matches!(RefreshError::classify(s, b), RefreshError::Revoked(_));
        assert!(revoked(
            StatusCode::BAD_REQUEST,
            r#"{"error": "invalid_grant"}"#
        ));
        assert!(revoked(
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"code":"token_expired"}}"#
        ));
        assert!(revoked(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"code":"refresh_token_reused"}}"#
        ));
        assert!(!revoked(StatusCode::TOO_MANY_REQUESTS, "slow down"));
        assert!(!revoked(StatusCode::BAD_GATEWAY, "invalid_grant"));
        assert!(!revoked(StatusCode::BAD_REQUEST, "malformed"));
    }
}
