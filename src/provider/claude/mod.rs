//! Claude Pro/Max subscriptions, as used by Claude Code.

pub mod limits;
pub mod oauth;
pub mod wire;

use anyhow::Result;
use http::{HeaderMap, StatusCode};

use super::{BoxFuture, Provider, Reading, Spec, UsageError, Verdict};
use crate::account::Account;
use crate::auth::{Grant, LoginOptions, RefreshError};
use crate::limits::Limits;
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};

/// Anthropic's API: Messages, the OAuth profile, and usage.
pub const API: &str = "https://api.anthropic.com";

pub struct Claude;

static SPEC: Spec = Spec {
    id: "claude",
    title: "Claude",
    api: API,
    // Access tokens live 8 hours.
    refresh_lead: SignedDuration::from_hours(1),
    device_login: false,
};

impl Provider for Claude {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn identity<'a>(&self, account: &'a Account) -> Option<&'a str> {
        account.org_id.as_deref().or(account.account_id.as_deref())
    }

    fn login<'a>(
        &'a self,
        http: &'a Client,
        options: LoginOptions,
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(oauth::login(http, options))
    }

    fn refresh<'a>(
        &'a self,
        http: &'a Client,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<Grant, RefreshError>> {
        Box::pin(oauth::refresh(http, refresh_token))
    }

    fn identify<'a>(&'a self, http: &'a Client, account: &'a mut Account) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(profile) = oauth::profile(http, &account.tokens.access_token).await {
                oauth::apply_profile(account, &profile);
            }
        })
    }

    fn usage<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<Reading, UsageError>> {
        Box::pin(usage(http, account))
    }

    fn headers(&self, client: &HeaderMap, account: &Account, _moved: bool) -> HeaderMap {
        wire::upstream_headers(client, &account.tokens.access_token)
    }

    fn limits(&self, headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
        limits::from_headers(headers, now)
    }

    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        _body: &[u8],
        model: Option<&str>,
        now: Timestamp,
    ) -> Verdict {
        match status {
            StatusCode::TOO_MANY_REQUESTS => limits::refusal(headers, model, now).into(),
            _ => Verdict::of_status(status),
        }
    }
}

/// `GET /api/oauth/usage`.
async fn usage(http: &Client, account: &Account) -> Result<Reading, UsageError> {
    let response = http
        .get(format!("{API}/api/oauth/usage"))
        .bearer_auth(&account.tokens.access_token)
        .header("anthropic-beta", oauth::OAUTH_BETA)
        .send()
        .await
        .map_err(|e| UsageError::Other(e.into()))?;
    let body = super::usage_body(response).await?;
    Ok(Reading {
        limits: limits::from_usage(&body, Timestamp::now()),
        plan: None,
    })
}
