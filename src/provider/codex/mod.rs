//! ChatGPT Plus/Pro/Team subscriptions, as used by Codex.

mod credits;
pub mod limits;
pub mod oauth;
pub mod wire;

use anyhow::Result;
use http::{HeaderMap, StatusCode};

use super::{BoxFuture, Provider, Reading, ResetCredits, Spec, UsageError, Verdict};
use crate::account::Account;
use crate::auth::{Grant, LoginOptions, RefreshError};
use crate::limits::Limits;
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

/// The ChatGPT backend: the Codex API, usage, and reset credits.
pub const BACKEND: &str = "https://chatgpt.com/backend-api";

pub struct Codex;

static SPEC: Spec = Spec {
    id: "codex",
    title: "ChatGPT",
    api: "https://chatgpt.com/backend-api/codex",
    dialect: Dialect::Responses,
    // Access tokens live about ten days.
    refresh_lead: SignedDuration::from_hours(24),
    device_login: true,
    // OpenAI allows ChatGPT plans in third-party apps.
    native_only: false,
};

impl Provider for Codex {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn identity<'a>(&self, account: &'a Account) -> Option<&'a str> {
        account.account_id.as_deref()
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

    fn identify<'a>(&'a self, _http: &'a Client, account: &'a mut Account) -> BoxFuture<'a, ()> {
        oauth::apply_claims(account);
        Box::pin(std::future::ready(()))
    }

    fn usage<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<Reading, UsageError>> {
        Box::pin(usage(http, account))
    }

    fn headers(&self, client: &HeaderMap, account: &Account, moved: bool) -> HeaderMap {
        wire::upstream_headers(
            client,
            &account.tokens.access_token,
            account.account_id.as_deref(),
            moved,
        )
    }

    fn rebind(&self, body: &[u8]) -> Option<Vec<u8>> {
        wire::strip_account_state(body)
    }

    fn limits(&self, headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
        limits::from_headers(headers, now)
    }

    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        _model: Option<&str>,
        now: Timestamp,
    ) -> Verdict {
        match status {
            StatusCode::TOO_MANY_REQUESTS | StatusCode::PAYMENT_REQUIRED => {
                limits::refusal(status.as_u16(), headers, body, now).into()
            }
            StatusCode::BAD_REQUEST if wire::rejects_account_state(body) => Verdict::StaleState,
            // The backend sometimes reports an exhausted window as a 5xx.
            s if s.is_server_error() && wire::reports_usage_limit(body) => Verdict::Exhausted {
                until: None,
                model: None,
            },
            _ => Verdict::of_status(status),
        }
    }

    fn credits(&self) -> Option<&dyn ResetCredits> {
        Some(&credits::Credits)
    }
}

/// `GET /wham/usage`, which also reports the plan and banked reset credits.
async fn usage(http: &Client, account: &Account) -> Result<Reading, UsageError> {
    let request = http
        .get(format!("{BACKEND}/wham/usage"))
        .bearer_auth(&account.tokens.access_token);
    let request = match &account.account_id {
        Some(id) => request.header("chatgpt-account-id", id),
        None => request,
    };
    let response = request
        .send()
        .await
        .map_err(|e| UsageError::Other(e.into()))?;
    let body = super::usage_body(response).await?;
    let (limits, plan) = limits::from_usage(&body, Timestamp::now());
    Ok(Reading { limits, plan })
}
