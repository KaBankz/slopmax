//! Account connection: OAuth login, token refresh, and credential import.

pub mod callback;
pub mod jwt;
pub mod pkce;

use std::fmt;
use std::time::Duration;

use anyhow::{Result, anyhow};
use http::StatusCode;
use tokio::sync::mpsc;

use crate::account::{Account, Store, Tokens};
use crate::net::{Client, Origins};
use crate::provider::ProviderId;
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

#[derive(Default, Clone)]
pub struct LoginOptions {
    /// Use the device-code flow (Codex only).
    pub device: bool,
    /// Ask for authorization without opening a browser.
    pub no_browser: bool,
    /// For a compatible endpoint: where it is and what it serves.
    pub endpoint: Option<crate::account::Endpoint>,
    /// For API keys and compatible endpoints: the key, which the CLI or app
    /// asks for before signing in.
    pub key: Option<String>,
}

impl fmt::Debug for LoginOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LoginOptions")
            .field("device", &self.device)
            .field("no_browser", &self.no_browser)
            .field("endpoint", &self.endpoint)
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// What a sign-in tells the person signing in, as it goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginEvent {
    /// Authorize the `title` account at `url`, in the browser `opened` if
    /// one could be. The browser then redirects to `localhost:port`; with a
    /// browser on another machine, that final address is pasted back.
    Authorize {
        title: &'static str,
        url: String,
        opened: bool,
        port: u16,
    },
    /// Enter `code` at `url`: the sign-in for machines without a browser.
    DeviceCode { url: String, code: String },
    /// Something to know while waiting, such as a rejected paste.
    Notice(String),
}

/// The person's side of a sign-in: where its [`LoginEvent`]s go, and the
/// redirect addresses pasted by hand. The CLI connects it to the terminal,
/// the app to its window.
pub struct Prompt {
    events: Box<dyn Fn(LoginEvent) + Send + Sync>,
    pasted: Option<mpsc::UnboundedReceiver<String>>,
}

impl Prompt {
    pub fn new(events: impl Fn(LoginEvent) + Send + Sync + 'static) -> Self {
        Self {
            events: Box::new(events),
            pasted: None,
        }
    }

    /// Also accepts each line `pasted` delivers as a redirect address.
    pub fn with_pasted(mut self, pasted: mpsc::UnboundedReceiver<String>) -> Self {
        self.pasted = Some(pasted);
        self
    }

    pub(crate) fn tell(&self, event: LoginEvent) {
        (self.events)(event);
    }

    /// The next pasted line, or `None` when nothing more can be pasted.
    pub(crate) async fn pasted(&mut self) -> Option<String> {
        match &mut self.pasted {
            Some(lines) => lines.recv().await,
            None => None,
        }
    }
}

impl fmt::Debug for Prompt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Prompt")
            .field("pasted", &self.pasted.is_some())
            .finish_non_exhaustive()
    }
}

/// Signs in to `provider` and saves the account, merging it into an earlier
/// record of the same identity. Returns the account and whether it is new.
pub async fn connect(
    store: &Store,
    provider: ProviderId,
    label: Option<String>,
    options: LoginOptions,
    prompt: Prompt,
) -> Result<(Account, bool)> {
    let http = http_client(Origins::default());
    let mut account = provider.get().login(&http, options, prompt).await?;
    if label.is_some() {
        account.label = label;
    }
    store.upsert(account)
}

/// The browser half of an authorization-code login: opens `url` (unless
/// told not to), then waits for the redirect to `(port, path)` or a pasted
/// address.
pub async fn browser_login(
    title: &'static str,
    url: &str,
    (port, path): (u16, &'static str),
    state: &str,
    options: LoginOptions,
    mut prompt: Prompt,
) -> Result<callback::Callback> {
    let opened = !options.no_browser && callback::open_browser(url);
    prompt.tell(LoginEvent::Authorize {
        title,
        url: url.to_owned(),
        opened,
        port,
    });
    callback::receive(port, path, state, &mut prompt).await
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

    use crate::account::{Endpoint, Link};
    use crate::testkit::{self, Mock};
    use crate::time::SignedDuration;
    use crate::wire::Dialect;
    use serde_json::{Value, json};

    /// Where Claude's token and profile calls go.
    const CLAUDE: &[&str] = &["https://platform.claude.com", "https://api.anthropic.com"];

    fn claude_account(access: &str, refresh: Option<&str>, expires_in: i64) -> Account {
        let mut account = Account::new(
            ProviderId::Claude,
            Tokens {
                access_token: access.into(),
                refresh_token: refresh.map(Into::into),
                expires_at: Some(Timestamp::now() + SignedDuration::from_secs(expires_in)),
                ..Tokens::default()
            },
        );
        account.org_id = Some("org-1".into());
        account.assign_id();
        account
    }

    fn store() -> Store {
        Store::at(testkit::temp_dir("auth").join("accounts"))
    }

    /// Anthropic's token endpoint answering `status` and `token`, and its
    /// profile endpoint naming a Max 5x plan.
    async fn anthropic(status: u16, token: Value) -> Mock {
        Mock::start(move |seen| match seen.route() {
            "/v1/oauth/token" => testkit::json(status, token.clone()),
            "/api/oauth/profile" => testkit::json(
                200,
                json!({
                    "account": { "uuid": "acct-1", "email": "me@x.dev" },
                    "organization": {
                        "uuid": "org-1",
                        "organization_type": "claude_max",
                        "rate_limit_tier": "default_claude_max_5x"
                    }
                }),
            ),
            _ => testkit::reply(404, ""),
        })
        .await
    }

    #[tokio::test]
    async fn fresh_tokens_are_used_without_a_refresh() {
        let mock = anthropic(200, json!({})).await;
        let store = store();
        let account = claude_account("live", Some("rt"), 2 * 3600);
        let got = ensure_fresh(&mock.client(CLAUDE), &store, &account, false)
            .await
            .unwrap();
        assert_eq!(got.tokens.access_token, "live");
        assert!(mock.seen().is_empty());
    }

    #[tokio::test]
    async fn due_tokens_are_refreshed_identified_and_saved() {
        let mock = anthropic(
            200,
            json!({ "access_token": "new", "refresh_token": "rt2", "expires_in": 28800 }),
        )
        .await;
        let store = store();
        let mut account = claude_account("old", Some("rt1"), 600);
        account.auth_error = Some("earlier failure".into());
        store.save(&account).unwrap();

        let got = ensure_fresh(&mock.client(CLAUDE), &store, &account, false)
            .await
            .unwrap();
        assert_eq!(got.tokens.access_token, "new");
        assert_eq!(got.tokens.refresh_token.as_deref(), Some("rt2"));
        let left = got
            .tokens
            .expires_at
            .unwrap()
            .duration_since(Timestamp::now());
        assert!(left > SignedDuration::from_hours(7), "{left:?}");
        assert!(got.tokens.refreshed_at.is_some());
        assert_eq!(got.auth_error, None);
        assert_eq!(got.email.as_deref(), Some("me@x.dev"));
        assert_eq!(got.plan.as_deref(), Some("max 5x"));

        // Saved before it is handed out: the old refresh token is spent.
        let saved = store.get(&account.id).unwrap().unwrap();
        assert_eq!(saved.tokens.access_token, "new");
        assert_eq!(saved.tokens.refresh_token.as_deref(), Some("rt2"));
        assert_eq!(saved.plan.as_deref(), Some("max 5x"));

        let sent = mock.seen_at("/v1/oauth/token");
        assert_eq!(sent.len(), 1);
        let body = sent[0].json();
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["refresh_token"], "rt1");
        assert_eq!(body["client_id"], crate::provider::claude::oauth::CLIENT_ID);
        let profile = mock.seen_at("/api/oauth/profile");
        assert_eq!(profile[0].header("authorization"), Some("Bearer new"));
        assert_eq!(
            profile[0].header("anthropic-beta"),
            Some("oauth-2025-04-20")
        );
    }

    #[tokio::test]
    async fn forced_refreshes_keep_tokens_the_provider_did_not_rotate() {
        // No new refresh token, no expiry, and the profile lookup fails.
        let mock = Mock::start(|seen| match seen.route() {
            "/v1/oauth/token" => testkit::json(200, json!({ "access_token": "new" })),
            _ => testkit::reply(500, "down"),
        })
        .await;
        let store = store();
        let mut account = claude_account("old", Some("rt1"), 6 * 3600);
        account.tokens.id_token = Some("id".into());
        account.email = Some("kept@x.dev".into());
        let got = ensure_fresh(&mock.client(CLAUDE), &store, &account, true)
            .await
            .unwrap();
        assert_eq!(got.tokens.access_token, "new");
        assert_eq!(got.tokens.refresh_token.as_deref(), Some("rt1"));
        assert_eq!(got.tokens.id_token.as_deref(), Some("id"));
        assert_eq!(got.tokens.expires_at, None);
        assert_eq!(got.email.as_deref(), Some("kept@x.dev"));
        // The account was not stored yet; refreshing saves it.
        assert!(store.get(&account.id).unwrap().is_some());
    }

    #[tokio::test]
    async fn a_token_another_process_rotated_is_reused() {
        let mock = anthropic(200, json!({ "access_token": "unwanted" })).await;
        let store = store();
        let stale = claude_account("old", Some("rt1"), -60);
        let mut theirs = stale.clone();
        theirs.tokens.access_token = "theirs".into();
        theirs.tokens.expires_at = Some(Timestamp::now() + SignedDuration::from_hours(8));
        store.save(&theirs).unwrap();

        let got = ensure_fresh(&mock.client(CLAUDE), &store, &stale, false)
            .await
            .unwrap();
        assert_eq!(got.tokens.access_token, "theirs");
        assert!(mock.seen().is_empty());
    }

    #[tokio::test]
    async fn a_stored_copy_that_is_no_longer_due_is_not_refreshed() {
        // Same token, but the stored copy says it was extended.
        let mock = anthropic(200, json!({ "access_token": "unwanted" })).await;
        let store = store();
        let stale = claude_account("same", Some("rt1"), 60);
        let mut stored = stale.clone();
        stored.tokens.expires_at = Some(Timestamp::now() + SignedDuration::from_hours(8));
        store.save(&stored).unwrap();
        let got = ensure_fresh(&mock.client(CLAUDE), &store, &stale, false)
            .await
            .unwrap();
        assert_eq!(got.tokens.expires_at, stored.tokens.expires_at);
        assert!(mock.seen().is_empty());
    }

    #[tokio::test]
    async fn rejected_refresh_tokens_mark_the_account() {
        let mock = anthropic(400, json!({ "error": "invalid_grant" })).await;
        let store = store();
        let account = claude_account("old", Some("rt1"), 60);
        store.save(&account).unwrap();
        let err = ensure_fresh(&mock.client(CLAUDE), &store, &account, false)
            .await
            .unwrap_err();
        assert!(matches!(err, RefreshError::Revoked(_)), "{err}");
        assert!(err.to_string().ends_with("; log in again"));
        let saved = store.get(&account.id).unwrap().unwrap();
        assert!(saved.auth_error.unwrap().contains("400"));
        assert_eq!(saved.tokens.access_token, "old");
    }

    #[tokio::test]
    async fn passing_failures_leave_the_account_alone() {
        let mock = Mock::start(|seen| match seen.route() {
            "/v1/oauth/token" => testkit::reply(503, "overloaded"),
            _ => testkit::reply(404, ""),
        })
        .await;
        let store = store();
        let account = claude_account("old", Some("rt1"), 60);
        store.save(&account).unwrap();
        let err = ensure_fresh(&mock.client(CLAUDE), &store, &account, false)
            .await
            .unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
        assert!(err.to_string().contains("503"), "{err}");
        assert_eq!(store.get(&account.id).unwrap().unwrap().auth_error, None);

        // A success that is not a token answer is passing too.
        let garbled = Mock::start(|_| testkit::reply(200, "<html>")).await;
        let err = ensure_fresh(&garbled.client(CLAUDE), &store, &account, false)
            .await
            .unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
    }

    #[tokio::test]
    async fn unreachable_token_endpoints_are_passing_failures() {
        let http = Client::builder()
            .plain_http()
            .origins(Origins::new([(
                "https://platform.claude.com",
                "http://127.0.0.1:9",
            )]))
            .build();
        let account = claude_account("old", Some("rt1"), 60);
        let err = ensure_fresh(&http, &store(), &account, false)
            .await
            .unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
    }

    #[tokio::test]
    async fn accounts_without_a_refresh_token_must_log_in_again() {
        let mock = anthropic(200, json!({})).await;
        let account = claude_account("old", None, 60);
        let err = ensure_fresh(&mock.client(CLAUDE), &store(), &account, false)
            .await
            .unwrap_err();
        let RefreshError::Revoked(reason) = err else {
            panic!("expected revoked");
        };
        assert_eq!(reason, "no refresh token stored");
        assert!(mock.seen().is_empty());
    }

    #[tokio::test]
    async fn api_keys_cannot_be_refreshed() {
        let account = Account::new(
            ProviderId::OpenAI,
            Tokens {
                access_token: "sk".into(),
                refresh_token: Some("rt".into()),
                ..Tokens::default()
            },
        );
        let http = http_client(Origins::default());
        let err = ensure_fresh(&http, &store(), &account, true)
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            "OpenAI API keys cannot be refreshed; log in again"
        );
    }

    fn linked(dir: &std::path::Path, tool: &str, access: &str) -> Account {
        let mut account = claude_account(access, Some("rt"), 3600 * 4);
        account.link = Some(Link {
            tool: tool.into(),
            path: dir.join("claude-x.json"),
        });
        account
    }

    #[tokio::test]
    async fn linked_accounts_wait_for_their_source_when_forced() {
        let dir = testkit::temp_dir("link-force");
        let file = json!({ "type": "claude", "access_token": "same", "refresh_token": "rt",
            "expired": "2099-01-01T00:00:00Z" });
        std::fs::write(dir.join("claude-x.json"), file.to_string()).unwrap();
        let store = Store::at(dir.join("accounts"));
        let account = linked(&dir, "cliproxyapi", "same");
        store.save(&account).unwrap();
        let http = http_client(Origins::default());
        let err = ensure_fresh(&http, &store, &account, true)
            .await
            .unwrap_err();
        assert!(
            err.to_string()
                .contains("cliproxyapi has not refreshed this login yet"),
            "{err}"
        );

        // Due but not expired, for an account removed meanwhile: the copy
        // in hand serves until the source refreshes.
        let gone = Store::at(dir.join("elsewhere"));
        let mut soon = account.clone();
        soon.tokens.access_token = "older".into();
        soon.tokens.expires_at = Some(Timestamp::now() + SignedDuration::from_mins(30));
        let got = ensure_fresh(&http, &gone, &soon, false).await.unwrap();
        assert_eq!(got.tokens.access_token, "older");
    }

    #[tokio::test]
    async fn links_to_unknown_tools_fail_softly() {
        let dir = testkit::temp_dir("link-unknown");
        let account = linked(&dir, "mystery", "x");
        let err = ensure_fresh(&http_client(Origins::default()), &store(), &account, true)
            .await
            .unwrap_err();
        assert!(matches!(err, RefreshError::Transient(_)));
        assert!(
            err.to_string()
                .contains("cannot follow logins from mystery")
        );
    }

    #[tokio::test]
    async fn connect_signs_in_and_merges_repeat_logins() {
        let mock = Mock::start(|seen| match (seen.route(), seen.header("authorization")) {
            ("/v1/models", Some("Bearer key-1")) => {
                testkit::json(200, json!({ "data": [{ "id": "qwen3-coder" }] }))
            }
            _ => testkit::reply(401, ""),
        })
        .await;
        let store = store();
        let options = || LoginOptions {
            endpoint: Some(Endpoint {
                base_url: format!("{}/v1", mock.url),
                dialect: Dialect::Chat,
                models: Vec::new(),
            }),
            key: Some("key-1".into()),
            ..LoginOptions::default()
        };
        let (account, new) = connect(
            &store,
            ProviderId::Compat,
            Some("local".into()),
            options(),
            Prompt::new(|_| {}),
        )
        .await
        .unwrap();
        assert!(new);
        assert_eq!(account.label.as_deref(), Some("local"));
        assert_eq!(account.endpoint.as_ref().unwrap().models, ["qwen3-coder"]);
        assert_eq!(store.list().unwrap().len(), 1);

        let (again, new) = connect(
            &store,
            ProviderId::Compat,
            None,
            options(),
            Prompt::new(|_| {}),
        )
        .await
        .unwrap();
        assert!(!new);
        assert_eq!(again.id, account.id);
        // The label set before is kept.
        assert_eq!(again.label.as_deref(), Some("local"));

        let mut wrong = options();
        wrong.key = Some("key-2".into());
        let err = connect(&store, ProviderId::Compat, None, wrong, Prompt::new(|_| {}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("rejected the key"), "{err}");
    }

    #[tokio::test]
    async fn prompts_deliver_events_and_pasted_lines() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = events.clone();
        let mut bare = Prompt::new(move |e| seen.lock().unwrap().push(e));
        bare.tell(LoginEvent::Notice("hi".into()));
        assert_eq!(bare.pasted().await, None);
        assert_eq!(*events.lock().unwrap(), [LoginEvent::Notice("hi".into())]);
        assert_eq!(format!("{bare:?}"), "Prompt { pasted: false, .. }");

        let (tx, rx) = mpsc::unbounded_channel();
        let mut pasting = Prompt::new(|_| {}).with_pasted(rx);
        tx.send("line".into()).unwrap();
        drop(tx);
        assert_eq!(pasting.pasted().await.as_deref(), Some("line"));
        assert_eq!(pasting.pasted().await, None);
        assert!(format!("{pasting:?}").contains("pasted: true"));
    }

    #[test]
    fn login_options_never_print_the_key() {
        let options = LoginOptions {
            key: Some("sk-secret".into()),
            no_browser: true,
            ..LoginOptions::default()
        };
        let shown = format!("{options:?}");
        assert!(!shown.contains("sk-secret"));
        assert!(shown.contains("<redacted>"));
        assert!(shown.contains("no_browser: true"));
    }

    #[test]
    fn grants_become_tokens_stamped_now() {
        let now = Timestamp::from_second(1_000).unwrap();
        let tokens = Grant {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            id_token: Some("i".into()),
            expires_at: Some(now + SignedDuration::from_secs(60)),
        }
        .into_tokens(now);
        assert_eq!(tokens.access_token, "a");
        assert_eq!(tokens.refresh_token.as_deref(), Some("r"));
        assert_eq!(tokens.id_token.as_deref(), Some("i"));
        assert_eq!(tokens.refreshed_at, Some(now));
        assert!(!tokens.is_expired(now));
    }

    #[test]
    fn refresh_errors_read_as_what_to_do() {
        let revoked = RefreshError::classify(StatusCode::UNAUTHORIZED, "");
        assert_eq!(
            revoked.to_string(),
            "refresh token rejected (401 Unauthorized); log in again"
        );
        let passing = RefreshError::classify(StatusCode::BAD_GATEWAY, "upstream");
        assert_eq!(
            passing.to_string(),
            "token refresh failed (502 Bad Gateway): upstream"
        );
    }
}
