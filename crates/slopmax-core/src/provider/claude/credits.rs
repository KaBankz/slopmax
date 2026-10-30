//! Claude's banked limit resets: the full resets claude.ai lists under
//! Limit resets, such as the one Pro and Max accounts got at a model's
//! launch. Anthropic's API calls them the `cedar_ember` program. The usage
//! endpoint lists them when asked, as grants that each hold a few resets,
//! and the organization's `reset_rate_limits` spends one.
//!
//! Claude answers both to Claude Code alone: called as anything else, the
//! listing comes back ineligible and empty. So these two calls carry Claude
//! Code's user agent as slopmax last saw it in a request, and nothing else
//! slopmax sends does.

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use super::API;
use super::oauth::OAUTH_BETA;
use crate::account::Account;
use crate::ids;
use crate::limits::parse_time;
use crate::log;
use crate::net::Client;
use crate::net::client::RequestBuilder;
use crate::provider::BoxFuture;
use crate::provider::credits::{Credit, Outcome, ResetCredits};
use crate::time::Timestamp;

pub struct Credits;

/// The program the resets belong to, as Claude's API names it.
const PROGRAM: &str = "cedar_ember";

/// The usage endpoint, asked to list the resets as Claude Code asks it.
const LISTING: &str = "/api/oauth/usage?cedar_ember=1&skip_spend=1";

/// More resets than one grant could sensibly hold.
const MOST_PER_GRANT: usize = 20;

impl ResetCredits for Credits {
    /// Claude's usage reports none of them unless asked for the list.
    fn counted(&self) -> bool {
        false
    }

    fn needs_agent(&self) -> bool {
        true
    }

    fn list<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<Credit>>> {
        Box::pin(async move { list(http, account, agent.ok_or_else(unseen)?).await })
    }

    fn redeem<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        agent: Option<&'a str>,
        credit: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Outcome>> {
        Box::pin(async move { redeem(http, account, agent.ok_or_else(unseen)?, credit).await })
    }
}

fn unseen() -> anyhow::Error {
    anyhow!(
        "Claude answers limit resets to Claude Code alone, and none of its requests has come through slopmax yet"
    )
}

/// A call as Claude Code makes it, with the account's token.
fn as_claude_code(request: RequestBuilder, account: &Account, agent: &str) -> RequestBuilder {
    request
        .bearer_auth(&account.tokens.access_token)
        .header("anthropic-beta", OAUTH_BETA)
        .header("user-agent", agent)
}

async fn list(http: &Client, account: &Account, agent: &str) -> Result<Vec<Credit>> {
    let response = as_claude_code(http.get(format!("{API}{LISTING}")), account, agent)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        bail!("listing limit resets failed ({status})");
    }
    let body: Value = response.json().await.context("unexpected usage reply")?;
    let listed = available(&body, Timestamp::now())?;
    if let Some(reason) = refused_caller(&body) {
        log::info!(
            "{}: Claude would not list its limit resets ({reason})",
            account.id
        );
    }
    Ok(listed)
}

/// The resets left in the usage `body`, one credit per reset: the grant
/// Claude would spend next first, then soonest-expiring. None when the
/// account has none or may not use them.
fn available(body: &Value, now: Timestamp) -> Result<Vec<Credit>> {
    if !body.is_object() {
        bail!("unexpected usage reply");
    }
    let status = match body.get(PROGRAM) {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(status) if status.is_object() => status,
        Some(_) => bail!("unexpected limit reset status"),
    };
    let next = status.get("next_grant_id").and_then(Value::as_str);
    let mut grants: Vec<(Credit, usize)> = status
        .get("grants")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(grant)
        .filter(|(credit, left)| *left > 0 && credit.expires_at.is_none_or(|at| at > now))
        .collect();
    grants.sort_by_key(|(credit, _)| {
        let later = Some(credit.id.as_str()) != next;
        (later, credit.expires_at.unwrap_or(Timestamp::MAX))
    });
    Ok(grants
        .into_iter()
        .flat_map(|(credit, left)| std::iter::repeat_n(credit, left.min(MOST_PER_GRANT)))
        .collect())
}

/// A grant as a credit, with how many resets it has left; `None` for one
/// whose id Claude Code would not accept either.
fn grant(grant: &Value) -> Option<(Credit, usize)> {
    let id = grant.get("id")?.as_str()?;
    let valid = (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if !valid {
        return None;
    }
    let left = usize::try_from(grant.get("resets_left")?.as_u64()?).ok()?;
    let title = grant
        .get("label")
        .and_then(Value::as_str)
        .map(|label| {
            let words: Vec<&str> = label.split_whitespace().collect();
            words
                .join(" ")
                .chars()
                .filter(|c| !c.is_control())
                .take(120)
                .collect::<String>()
        })
        .filter(|label| !label.is_empty());
    let credit = Credit {
        id: id.to_owned(),
        title,
        granted_at: grant.get("starts_at").and_then(parse_time),
        expires_at: grant.get("ends_at").and_then(parse_time),
    };
    Some((credit, left))
}

/// Why Claude would not list the resets to this caller, if it is the
/// caller it refused rather than the account.
fn refused_caller(body: &Value) -> Option<&str> {
    let status = body.get(PROGRAM)?;
    let reason = status.get("ineligible_reason")?.as_str()?;
    (status.get("eligible") == Some(&Value::Bool(false))
        && matches!(reason, "surface" | "cli_version"))
    .then_some(reason)
}

#[derive(Debug, Deserialize)]
struct Claimed {
    #[serde(default)]
    result: String,
    #[serde(default)]
    reason: Option<String>,
}

impl Claimed {
    fn outcome(&self) -> Outcome {
        match (self.result.as_str(), self.reason.as_deref()) {
            ("reset", _) => Outcome::Reset,
            ("not_limited", _) => Outcome::NothingToReset,
            ("already_used", _) => Outcome::AlreadyRedeemed,
            (_, Some("no_grant" | "unknown_grant" | "expired")) => Outcome::NoCredit,
            // Paused, cooling down, or not offered to the account now.
            _ => Outcome::Declined,
        }
    }
}

/// Spends one reset of `credit`, the grant it names, or of the grant Claude
/// would spend next. The request id is reused on a retry, so a lost
/// response cannot spend two.
async fn redeem(
    http: &Client,
    account: &Account,
    agent: &str,
    credit: Option<&str>,
) -> Result<Outcome> {
    let Some(org) = account.org_id.as_deref().filter(|org| is_uuid(org)) else {
        bail!("the account's organization is unknown; sign in again");
    };
    let grant = match credit {
        Some(id) => id.to_owned(),
        None => match list(http, account, agent).await?.into_iter().next() {
            Some(next) => next.id,
            None => return Ok(Outcome::NoCredit),
        },
    };
    let url = format!("{API}/api/organizations/{org}/reset_rate_limits");
    let body = json!({ "program": PROGRAM, "grant_id": grant, "request_id": ids::uuid_v4() });
    let mut last_error = None;
    for _ in 0..2 {
        match as_claude_code(http.post(&url), account, agent)
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                let claimed: Claimed = response
                    .json()
                    .await
                    .context("unexpected reply to using a limit reset")?;
                let outcome = claimed.outcome();
                if outcome == Outcome::Declined {
                    log::info!(
                        "{}: Claude kept its limit reset ({}, {})",
                        account.id,
                        claimed.result,
                        claimed.reason.as_deref().unwrap_or("no reason given")
                    );
                }
                return Ok(outcome);
            }
            Ok(response) => bail!("using a limit reset failed ({})", response.status()),
            Err(e) => last_error = Some(e),
        }
    }
    Err(last_error.expect("loop ran").into())
}

/// Whether `id` is a UUID, as an organization's is: it goes in the path.
fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    #[test]
    fn grants_list_one_credit_per_reset_the_next_first() {
        let body = json!({
            "five_hour": { "utilization": 4.0 },
            "cedar_ember": {
                "eligible": true,
                "grants": [
                    { "id": "late", "label": "Later", "resets_total": 1, "resets_left": 1,
                      "ends_at": "2026-12-01T00:00:00+00:00" },
                    { "id": "opus55-launch-promax-20260921",
                      "label": "Claude Opus 5.5 launch:\none usage-limit reset  for Pro and Max",
                      "resets_total": 2, "resets_left": 2,
                      "starts_at": "2026-09-22T16:00:00+00:00", "ends_at": "2026-10-22T16:00:00+00:00",
                      "clears": ["five_hour", "seven_day"], "usable_now": true },
                    { "id": "soon", "resets_total": 1, "resets_left": 1,
                      "ends_at": "2026-10-09T00:00:00+00:00" },
                    { "id": "spent", "resets_total": 1, "resets_left": 0 },
                    { "id": "lapsed", "resets_total": 1, "resets_left": 1,
                      "ends_at": "2026-10-01T00:00:00+00:00" },
                    { "id": "Not Valid!", "resets_total": 1, "resets_left": 1 },
                    { "id": "no-count" }
                ],
                "next_grant_id": "opus55-launch-promax-20260921"
            }
        });
        let credits = available(&body, ts("2026-10-07T21:00:00Z")).unwrap();
        let ids: Vec<&str> = credits.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "opus55-launch-promax-20260921",
                "opus55-launch-promax-20260921",
                "soon",
                "late"
            ]
        );
        let launch = &credits[0];
        assert_eq!(
            launch.title.as_deref(),
            Some("Claude Opus 5.5 launch: one usage-limit reset for Pro and Max")
        );
        assert_eq!(launch.granted_at, Some(ts("2026-09-22T16:00:00Z")));
        assert_eq!(launch.expires_at, Some(ts("2026-10-22T16:00:00Z")));
    }

    #[test]
    fn a_refused_caller_or_an_account_without_any_lists_none() {
        let now = ts("2026-10-07T21:00:00Z");
        let refused = json!({
            "five_hour": { "utilization": 4.0 },
            "cedar_ember": { "eligible": false, "ineligible_reason": "surface", "grants": [] }
        });
        assert!(available(&refused, now).unwrap().is_empty());
        assert_eq!(refused_caller(&refused), Some("surface"));
        let none = json!({ "cedar_ember": { "eligible": false, "ineligible_reason": "no_grant" } });
        assert!(available(&none, now).unwrap().is_empty());
        assert_eq!(refused_caller(&none), None);
        assert!(
            available(&json!({ "cedar_ember": null }), now)
                .unwrap()
                .is_empty()
        );
        assert!(
            available(&json!({ "five_hour": {} }), now)
                .unwrap()
                .is_empty()
        );
        assert!(available(&json!(["not", "usage"]), now).is_err());
        assert!(available(&json!({ "cedar_ember": "odd" }), now).is_err());
    }

    #[test]
    fn claims_answer_as_outcomes() {
        let outcome = |result: &str, reason: Option<&str>| {
            Claimed {
                result: result.into(),
                reason: reason.map(Into::into),
            }
            .outcome()
        };
        assert_eq!(outcome("reset", None), Outcome::Reset);
        assert_eq!(
            outcome("not_limited", Some("not_limited")),
            Outcome::NothingToReset
        );
        assert_eq!(
            outcome("already_used", Some("already_used")),
            Outcome::AlreadyRedeemed
        );
        assert_eq!(outcome("ineligible", Some("expired")), Outcome::NoCredit);
        assert_eq!(outcome("cooldown", Some("cooldown")), Outcome::Declined);
        assert_eq!(outcome("unavailable", Some("paused")), Outcome::Declined);
        assert_eq!(outcome("something_new", None), Outcome::Declined);
    }

    #[test]
    fn only_a_uuid_names_the_organization() {
        assert!(is_uuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4"));
        assert!(!is_uuid("org-claude0"));
        assert!(!is_uuid("../../v1/messages?x=0b4e1f5a-9c2d-4e8f-a1"));
        assert!(!is_uuid("0b4e1f5a-9c2d-4e8f-a1b3-c5d7e9f0a2b4/x"));
    }
}
