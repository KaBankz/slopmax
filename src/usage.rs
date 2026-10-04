//! Reads each account's usage windows from its provider's usage endpoint.

use anyhow::{Result, anyhow, bail};
use http::StatusCode;
use serde_json::Value;

use crate::account::{Account, Provider, Store};
use crate::auth::{self, RefreshError, claude};
use crate::limits::{self, Limits};
use crate::net::Client;
use crate::time::Timestamp;
use crate::upstream::Upstream;

/// A usage reading, plus the plan when the endpoint reports one.
#[derive(Debug, Clone)]
pub struct Reading {
    pub limits: Limits,
    pub plan: Option<String>,
}

enum FetchError {
    Unauthorized,
    Other(anyhow::Error),
}

async fn fetch(
    http: &Client,
    upstream: &Upstream,
    account: &Account,
) -> Result<Reading, FetchError> {
    let token = &account.tokens.access_token;
    let request = match account.provider {
        Provider::Claude => http
            .get(upstream.claude_usage())
            .header("anthropic-beta", claude::OAUTH_BETA),
        Provider::Codex => {
            let request = http.get(upstream.codex_usage());
            match &account.account_id {
                Some(id) => request.header("chatgpt-account-id", id),
                None => request,
            }
        }
    };
    let response = request
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| FetchError::Other(e.into()))?;
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(FetchError::Unauthorized);
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(FetchError::Other(anyhow!(
            "usage endpoint returned {status}: {snippet}"
        )));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|e| FetchError::Other(e.into()))?;
    let now = Timestamp::now();
    Ok(match account.provider {
        Provider::Claude => Reading {
            limits: limits::from_claude_usage(&body, now),
            plan: None,
        },
        Provider::Codex => {
            let (limits, plan) = limits::from_codex_usage(&body, now);
            Reading { limits, plan }
        }
    })
}

/// Polls one account, refreshing its token first when due (if `refresh` is
/// allowed) and retrying once after a forced refresh if the token is
/// rejected. Returns the possibly refreshed account alongside the reading.
pub async fn poll(
    http: &Client,
    store: &Store,
    upstream: &Upstream,
    account: &Account,
    refresh: bool,
) -> Result<(Account, Reading)> {
    let mut account = account.clone();
    if refresh {
        account = fresh(http, store, &account, false).await?;
    }
    match fetch(http, upstream, &account).await {
        Ok(reading) => Ok((account, reading)),
        Err(FetchError::Other(e)) => Err(e),
        Err(FetchError::Unauthorized) if refresh => {
            account = fresh(http, store, &account, true).await?;
            match fetch(http, upstream, &account).await {
                Ok(reading) => Ok((account, reading)),
                Err(FetchError::Unauthorized) => bail!("token rejected after refresh"),
                Err(FetchError::Other(e)) => Err(e),
            }
        }
        Err(FetchError::Unauthorized) => bail!("token rejected (refresh disabled)"),
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
