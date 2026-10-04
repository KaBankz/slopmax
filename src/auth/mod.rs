//! Account connection: OAuth login, token refresh, and credential import.

pub mod callback;
pub mod jwt;
pub mod pkce;

use std::time::Duration;

use anyhow::{Result, anyhow};
use http::StatusCode;

use crate::account::{Account, Store, Tokens};
use crate::net::{Client, Origins};
use crate::time::Timestamp;
use crate::{import, log};

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
pub fn http_client(origins: Origins) -> Client {
    Client::builder()
        .origins(origins)
        .user_agent(concat!("slopmax/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
}

#[derive(Debug, Default, Clone)]
pub struct LoginOptions {
    /// Use the device-code flow (Codex only).
    pub device: bool,
    /// Print the authorize URL instead of opening a browser.
    pub no_browser: bool,
    /// For a compatible endpoint: where it is and what it serves.
    pub endpoint: Option<crate::account::Endpoint>,
}

/// The browser half of an authorization-code login: opens (or prints)
/// `url`, then waits for the redirect to `(port, path)` or a pasted URL.
pub async fn browser_login(
    title: &str,
    url: &str,
    (port, path): (u16, &'static str),
    state: &str,
    options: LoginOptions,
) -> Result<callback::Callback> {
    let opened = !options.no_browser && callback::open_browser(url);
    eprintln!(
        "\n  {} your {title} account in the browser:\n\n  {url}\n",
        if opened { "Opened" } else { "Authorize" }
    );
    eprintln!(
        "  Waiting for the redirect to localhost:{port}. If the browser runs on another\n  \
         machine, paste the final localhost URL from its address bar here.\n"
    );
    callback::receive(port, path, state).await
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
    let due =
        move |a: &Account| force || a.tokens.expires_within(a.provider.spec().refresh_lead, now);
    if !due(account) {
        return Ok(account.clone());
    }
    if account.link.is_some() {
        return follow(store, account, force).await;
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

/// For a linked account: adopts the tokens its source tool rotated, since
/// refreshing here would sign that tool out.
async fn follow(store: &Store, account: &Account, force: bool) -> Result<Account, RefreshError> {
    let link = account
        .link
        .clone()
        .expect("only linked accounts are followed");
    let (store, id) = (store.clone(), account.id.clone());
    let followed = tokio::task::spawn_blocking(move || -> Result<Option<Account>> {
        let tokens = import::linked_tokens(&link)?;
        let _lock = store.lock(&id)?;
        let Some(mut current) = store.get(&id)? else {
            return Ok(None);
        };
        if current.tokens.access_token == tokens.access_token {
            return Ok(Some(current));
        }
        current.tokens = tokens;
        current.auth_error = None;
        store.save(&current)?;
        Ok(Some(current))
    })
    .await
    .map_err(|e| RefreshError::Transient(e.into()))?
    .map_err(RefreshError::Transient)?;
    let current = followed.unwrap_or_else(|| account.clone());
    let rotated = current.tokens.access_token != account.tokens.access_token;
    if !rotated && (force || current.tokens.is_expired(Timestamp::now())) {
        let tool = account
            .link
            .as_ref()
            .map_or("its source", |l| l.tool.as_str());
        return Err(RefreshError::Transient(anyhow!(
            "{tool} has not refreshed this login yet (`slopmax own` lets slopmax refresh it)"
        )));
    }
    Ok(current)
}

async fn refresh_and_save(
    http: &Client,
    store: &Store,
    mut account: Account,
) -> Result<Account, RefreshError> {
    let Some(refresh_token) = account.tokens.refresh_token.clone() else {
        return Err(RefreshError::Revoked("no refresh token stored".into()));
    };
    let provider = account.provider.get();
    let grant = match provider.refresh(http, &refresh_token).await {
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

    provider.identify(http, &mut account).await;
    // Persist before anyone uses the new token: the old refresh token is dead.
    if let Err(e) = store.save(&account) {
        log::error!("refreshed {} but could not save it: {e:#}", account.id);
    }
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn linked_accounts_follow_their_source() {
        use crate::account::Link;
        use crate::provider::ProviderId;

        let dir = std::env::temp_dir().join(format!("slopmax-link-{}", crate::ids::token()));
        let store = Store::at(dir.join("accounts"));
        let source = dir.join("claude-x.json");
        let write = |token: &str, expired: &str| {
            let file = serde_json::json!({
                "type": "claude", "access_token": token, "refresh_token": "rt", "expired": expired
            });
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(&source, file.to_string()).unwrap();
        };
        write("old", "2000-01-01T00:00:00Z");
        let mut account = Account::new(
            ProviderId::Claude,
            Tokens {
                access_token: "old".into(),
                refresh_token: Some("rt".into()),
                expires_at: "2000-01-01T00:00:00Z".parse().ok(),
                ..Tokens::default()
            },
        );
        account.org_id = Some("org".into());
        account.assign_id();
        account.link = Some(Link {
            tool: "cliproxyapi".into(),
            path: source.clone(),
        });
        store.save(&account).unwrap();
        let http = http_client(Origins::default());

        // Not rotated yet: slopmax waits for the source rather than refreshing.
        let waiting = ensure_fresh(&http, &store, &account, false).await;
        assert!(matches!(waiting, Err(RefreshError::Transient(_))));

        write("new", "2099-01-01T00:00:00Z");
        let fresh = ensure_fresh(&http, &store, &account, false).await.unwrap();
        assert_eq!(fresh.tokens.access_token, "new");
        let saved = store.get(&account.id).unwrap().unwrap();
        assert_eq!(saved.tokens.access_token, "new");
        assert!(saved.link.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

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
