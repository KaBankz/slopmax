//! Reads each account's usage windows from its provider's usage endpoint.

use anyhow::{Result, anyhow, bail};

use crate::account::{Account, Store};
use crate::auth::{self, RefreshError};
use crate::net::Client;
use crate::provider::{Reading, UsageError};

/// Polls one account, refreshing its token first when due (if `refresh` is
/// allowed) and retrying once after a forced refresh if the token is
/// rejected. Returns the possibly refreshed account alongside the reading.
pub async fn poll(
    http: &Client,
    store: &Store,
    account: &Account,
    refresh: bool,
) -> Result<(Account, Reading)> {
    let mut account = account.clone();
    if refresh {
        account = fresh(http, store, &account, false).await?;
    }
    let provider = account.provider.get();
    match provider.usage(http, &account).await {
        Ok(reading) => Ok((account, reading)),
        Err(UsageError::Other(e)) => Err(e),
        Err(UsageError::Unauthorized) if refresh => {
            account = fresh(http, store, &account, true).await?;
            match provider.usage(http, &account).await {
                Ok(reading) => Ok((account, reading)),
                Err(UsageError::Unauthorized) => bail!("token rejected after refresh"),
                Err(UsageError::Other(e)) => Err(e),
            }
        }
        Err(UsageError::Unauthorized) => bail!("token rejected (refresh disabled)"),
    }
}

async fn fresh(http: &Client, store: &Store, account: &Account, force: bool) -> Result<Account> {
    auth::ensure_fresh(http, store, account, force)
        .await
        .map_err(|e| match e {
            RefreshError::Revoked(reason) => {
                anyhow!("{reason}; run `slopmax login {}`", account.provider)
            }
            RefreshError::Transient(e) => e,
        })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::account::Tokens;
    use crate::provider::ProviderId;
    use crate::provider::claude::API;
    use crate::testkit::{self, Mock};
    use crate::time::{SignedDuration, Timestamp};

    const ORIGINS: &[&str] = &[API, "https://platform.claude.com"];

    fn account(token: &str, expires_in: i64) -> Account {
        let mut account = Account::new(
            ProviderId::Claude,
            Tokens {
                access_token: token.into(),
                refresh_token: Some("rt".into()),
                expires_at: Some(Timestamp::now() + SignedDuration::from_secs(expires_in)),
                ..Tokens::default()
            },
        );
        account.org_id = Some("org".into());
        account.assign_id();
        account
    }

    fn store() -> Store {
        Store::at(testkit::temp_dir("usage").join("accounts"))
    }

    /// Usage answers for `accepted` only (500 for `down`), and the token
    /// endpoint answers `refresh` with a new token `fresh`.
    async fn mock(accepted: &'static str, refresh: u16) -> Mock {
        Mock::start(move |seen| match seen.route() {
            "/api/oauth/usage" => match seen.header("authorization") {
                Some(auth) if auth == format!("Bearer {accepted}") => {
                    testkit::json(200, json!({ "five_hour": { "utilization": 30 } }))
                }
                Some("Bearer down") => testkit::reply(500, "broken"),
                _ => testkit::reply(401, ""),
            },
            "/v1/oauth/token" if refresh == 200 => {
                testkit::json(200, json!({ "access_token": "fresh", "expires_in": 28800 }))
            }
            "/v1/oauth/token" => testkit::json(refresh, json!({ "error": "invalid_grant" })),
            _ => testkit::reply(404, ""),
        })
        .await
    }

    fn refreshes(mock: &Mock) -> usize {
        mock.seen_at("/v1/oauth/token").len()
    }

    #[tokio::test]
    async fn reads_usage_with_a_working_token() {
        let mock = mock("live", 200).await;
        let (account, reading) = poll(
            &mock.client(ORIGINS),
            &store(),
            &account("live", 7200),
            true,
        )
        .await
        .unwrap();
        assert_eq!(account.tokens.access_token, "live");
        assert_eq!(reading.limits.windows[0].used, 30.0);
        assert_eq!(refreshes(&mock), 0);
    }

    #[tokio::test]
    async fn refreshes_a_due_token_before_reading() {
        let mock = mock("fresh", 200).await;
        let store = store();
        let (account, _) = poll(&mock.client(ORIGINS), &store, &account("old", 60), true)
            .await
            .unwrap();
        assert_eq!(account.tokens.access_token, "fresh");
        assert_eq!(refreshes(&mock), 1);
        let saved = store.get(&account.id).unwrap().unwrap();
        assert_eq!(saved.tokens.access_token, "fresh");
    }

    #[tokio::test]
    async fn a_rejected_token_is_refreshed_once_and_retried() {
        let mock = mock("fresh", 200).await;
        let (account, reading) = poll(&mock.client(ORIGINS), &store(), &account("old", 7200), true)
            .await
            .unwrap();
        assert_eq!(account.tokens.access_token, "fresh");
        assert_eq!(reading.limits.windows.len(), 1);
        assert_eq!(refreshes(&mock), 1);
        assert_eq!(mock.seen_at("/api/oauth/usage").len(), 2);
    }

    #[tokio::test]
    async fn a_token_rejected_after_refresh_is_an_error() {
        let mock = mock("nobody", 200).await;
        let err = poll(&mock.client(ORIGINS), &store(), &account("old", 7200), true)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "token rejected after refresh");
    }

    #[tokio::test]
    async fn without_refresh_a_rejected_token_is_reported() {
        let mock = mock("nobody", 200).await;
        let err = poll(&mock.client(ORIGINS), &store(), &account("old", 60), false)
            .await
            .unwrap_err();
        assert_eq!(err.to_string(), "token rejected (refresh disabled)");
        assert_eq!(refreshes(&mock), 0);
    }

    #[tokio::test]
    async fn revoked_logins_say_how_to_reconnect() {
        let mock = mock("nobody", 400).await;
        let err = poll(&mock.client(ORIGINS), &store(), &account("old", 60), true)
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(text.ends_with("; run `slopmax login claude`"), "{text}");
    }

    #[tokio::test]
    async fn passing_refresh_failures_keep_their_reason() {
        let mock = mock("nobody", 503).await;
        let err = poll(&mock.client(ORIGINS), &store(), &account("old", 7200), true)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("token refresh failed (503"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn other_failures_pass_through_before_and_after_a_refresh() {
        let mock = mock("nobody", 200).await;
        let err = poll(
            &mock.client(ORIGINS),
            &store(),
            &account("down", 7200),
            true,
        )
        .await
        .unwrap_err();
        assert!(err.to_string().starts_with("usage endpoint returned 500"));

        // The refreshed token reads a failing endpoint.
        let failing = Mock::start(|seen| match (seen.route(), seen.header("authorization")) {
            ("/api/oauth/usage", Some("Bearer fresh")) => testkit::reply(502, "bad gateway"),
            ("/api/oauth/usage", _) => testkit::reply(401, ""),
            _ => testkit::json(200, json!({ "access_token": "fresh" })),
        })
        .await;
        let err = poll(
            &failing.client(ORIGINS),
            &store(),
            &account("old", 7200),
            true,
        )
        .await
        .unwrap_err();
        assert!(
            err.to_string().starts_with("usage endpoint returned 502"),
            "{err}"
        );
    }
}
