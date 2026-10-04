//! ChatGPT's banked reset credits (`/wham/rate-limit-reset-credits`).

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::json;

use super::BACKEND;
use crate::account::Account;
use crate::ids;
use crate::net::Client;
use crate::net::client::RequestBuilder;
use crate::provider::BoxFuture;
use crate::provider::credits::{Credit, Outcome, ResetCredits};
use crate::time::Timestamp;

pub struct Credits;

#[derive(Debug, Deserialize)]
struct Listed {
    id: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreditList {
    #[serde(default)]
    credits: Vec<Listed>,
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

impl ResetCredits for Credits {
    fn list<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<Vec<Credit>>> {
        Box::pin(list(http, account))
    }

    fn redeem<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        credit: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Outcome>> {
        Box::pin(redeem(http, account, credit))
    }
}

async fn list(http: &Client, account: &Account) -> Result<Vec<Credit>> {
    let url = format!("{BACKEND}/wham/rate-limit-reset-credits");
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
        .map(|c| Credit {
            expires_at: c.expires_at.as_deref().and_then(|t| t.parse().ok()),
            id: c.id,
            title: c.title,
        })
        .collect();
    credits.sort_by_key(|c| c.expires_at.unwrap_or(Timestamp::MAX));
    Ok(credits)
}

/// The request id is reused on a retry, so a lost response cannot spend
/// two credits.
async fn redeem(http: &Client, account: &Account, credit: Option<&str>) -> Result<Outcome> {
    let url = format!("{BACKEND}/wham/rate-limit-reset-credits/consume");
    let mut body = json!({ "redeem_request_id": ids::uuid_v4() });
    if let Some(id) = credit {
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
