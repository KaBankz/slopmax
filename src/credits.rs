//! Banked rate-limit resets on ChatGPT accounts.
//!
//! ChatGPT grants some accounts reset credits that instantly reset their
//! usage windows. slopmax redeems them on request (`slopmax redeem`), just
//! before one would expire unused (`redeem_expiring_credits`), and, with
//! `redeem_when_exhausted`, once every Codex account is spent, so the pool
//! keeps serving instead of waiting.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::account::Account;
use crate::auth::codex;
use crate::ids;
use crate::net::Client;
use crate::net::client::RequestBuilder;
use crate::time::Timestamp;

#[derive(Debug, Clone, Deserialize)]
pub struct Credit {
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

impl Credit {
    pub fn expires(&self) -> Option<Timestamp> {
        self.expires_at.as_deref()?.parse().ok()
    }
}

#[derive(Debug, Deserialize)]
struct CreditList {
    #[serde(default)]
    credits: Vec<Credit>,
}

/// What a redemption did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The account's windows were reset.
    Reset,
    /// Nothing was used, so the credit was kept.
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
}

#[derive(Debug, Deserialize)]
struct Consumed {
    code: Outcome,
}

fn authorized(request: RequestBuilder, account: &Account) -> RequestBuilder {
    let request = request.bearer_auth(&account.tokens.access_token);
    match &account.account_id {
        Some(id) => request.header("chatgpt-account-id", id),
        None => request,
    }
}

/// Available credits, soonest-expiring first.
pub async fn list(http: &Client, account: &Account) -> Result<Vec<Credit>> {
    let url = format!("{}/wham/rate-limit-reset-credits", codex::BACKEND);
    let response = authorized(http.get(url), account).send().await?;
    let status = response.status();
    if !status.is_success() {
        bail!("listing reset credits failed ({status})");
    }
    let list: CreditList = response
        .json()
        .await
        .context("unexpected reset credit list")?;
    let mut credits: Vec<Credit> = list
        .credits
        .into_iter()
        .filter(|c| c.status.is_empty() || c.status.eq_ignore_ascii_case("available"))
        .collect();
    credits.sort_by_key(|c| c.expires().unwrap_or(Timestamp::MAX));
    Ok(credits)
}

/// Redeems one credit (the given one, or the server's choice). The request
/// id is reused on a retry, so a lost response cannot spend two credits.
pub async fn redeem(http: &Client, account: &Account, credit_id: Option<&str>) -> Result<Outcome> {
    let url = format!("{}/wham/rate-limit-reset-credits/consume", codex::BACKEND);
    let mut body = json!({ "redeem_request_id": ids::uuid_v4() });
    if let Some(id) = credit_id {
        body["credit_id"] = id.into();
    }
    let mut last_error = None;
    for _ in 0..2 {
        match authorized(http.post(&url), account)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let consumed: Consumed = response
                    .json()
                    .await
                    .context("unexpected redeem response")?;
                return Ok(consumed.code);
            }
            Ok(response) => bail!("redeeming a reset credit failed ({})", response.status()),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.expect("loop ran").into())
}
