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
    /// What the credit resets; only `codex_rate_limits` resets Codex's
    /// windows.
    #[serde(default)]
    reset_type: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    granted_at: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
}

/// The kind of credit that resets Codex's usage windows.
const CODEX_RESETS: &str = "codex_rate_limits";

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
        _agent: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<Credit>>> {
        Box::pin(list(http, account))
    }

    fn redeem<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        _agent: Option<&'a str>,
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
    Ok(available(list))
}

/// Unspent credits that reset Codex's windows, soonest-expiring first.
fn available(list: CreditList) -> Vec<Credit> {
    let mut credits: Vec<Credit> = list
        .credits
        .into_iter()
        .filter(|c| c.status.is_empty() || c.status.eq_ignore_ascii_case("available"))
        .filter(|c| c.reset_type.as_deref().is_none_or(|t| t == CODEX_RESETS))
        .map(|c| Credit {
            granted_at: c.granted_at.as_deref().and_then(|t| t.parse().ok()),
            expires_at: c.expires_at.as_deref().and_then(|t| t.parse().ok()),
            id: c.id,
            title: c.title,
        })
        .collect();
    credits.sort_by_key(|c| c.expires_at.unwrap_or(Timestamp::MAX));
    credits
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_codex_window_credits_count() {
        let list: CreditList = serde_json::from_str(
            r#"{"credits": [
                {"id": "late", "status": "available", "reset_type": "codex_rate_limits", "granted_at": "2026-11-01T09:30:00Z", "expires_at": "2026-12-01T00:00:00Z"},
                {"id": "review", "status": "available", "reset_type": "code_review_rate_limits", "expires_at": "2026-10-05T00:00:00Z"},
                {"id": "spent", "status": "redeemed", "reset_type": "codex_rate_limits", "expires_at": "2026-10-06T00:00:00Z"},
                {"id": "soon", "status": "available", "reset_type": "codex_rate_limits", "expires_at": "2026-10-07T00:00:00Z"},
                {"id": "untyped", "expires_at": "2026-11-01T00:00:00Z"}
            ]}"#,
        )
        .unwrap();
        let credits = available(list);
        let ids: Vec<&str> = credits.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["soon", "untyped", "late"]);
        assert_eq!(
            credits[2].granted_at,
            Some("2026-11-01T09:30:00Z".parse().unwrap())
        );
    }
}
