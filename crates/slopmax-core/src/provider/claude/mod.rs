//! Claude Pro/Max subscriptions, as used by Claude Code.

mod credits;
pub mod limits;
pub mod oauth;
pub mod wire;

use anyhow::Result;
use http::{HeaderMap, StatusCode};

use super::credits::ResetCredits;
use super::{Billing, BoxFuture, Credential, Provider, Reading, Spec, UsageError, Verdict};
use crate::account::Account;
use crate::auth::{Grant, LoginOptions, Prompt, RefreshError};
use crate::limits::{Limits, PoolWindow};
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

/// Anthropic's API: Messages, the OAuth profile, usage, and limit resets.
pub const API: &str = "https://api.anthropic.com";

pub struct Claude;

static SPEC: Spec = Spec {
    id: "claude",
    title: "Claude",
    api: API,
    dialects: &[Dialect::Messages],
    models: &["claude-*"],
    billing: Billing::Subscription,
    // Anthropic allows subscription logins in Claude Code alone.
    agent_only: Some("claude"),
    // Access tokens live 8 hours.
    refresh_lead: SignedDuration::from_hours(1),
    credential: Credential::OAuth { device: false },
};

impl Provider for Claude {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn identity(&self, account: &Account) -> Option<String> {
        account
            .org_id
            .clone()
            .or_else(|| account.account_id.clone())
    }

    fn login<'a>(
        &'a self,
        http: &'a Client,
        options: LoginOptions,
        prompt: Prompt,
    ) -> BoxFuture<'a, Result<Account>> {
        Box::pin(oauth::login(http, options, prompt))
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

    fn show_pool(&self, windows: &[PoolWindow], headers: &mut HeaderMap) {
        limits::pool_headers(windows, headers);
    }

    fn credits(&self) -> Option<&dyn ResetCredits> {
        Some(&credits::Credits)
    }

    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        model: Option<&str>,
        now: Timestamp,
    ) -> Verdict {
        match status {
            StatusCode::TOO_MANY_REQUESTS if limits::fast_mode_refused(headers, body) => {
                Verdict::Final
            }
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

#[cfg(test)]
mod tests {
    use http::HeaderValue;
    use serde_json::json;

    use super::*;
    use crate::account::Tokens;
    use crate::provider::ProviderId;
    use crate::testkit::{self, Mock};

    fn account(token: &str) -> Account {
        let mut account = Account::new(
            ProviderId::Claude,
            Tokens {
                access_token: token.into(),
                ..Tokens::default()
            },
        );
        account.assign_id();
        account
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn accounts_are_keyed_by_organization_then_account() {
        let mut account = account("t");
        assert_eq!(Claude.identity(&account), None);
        account.account_id = Some("acct".into());
        assert_eq!(Claude.identity(&account).as_deref(), Some("acct"));
        account.org_id = Some("org".into());
        assert_eq!(Claude.identity(&account).as_deref(), Some("org"));
    }

    #[test]
    fn requests_carry_the_token_and_the_oauth_beta() {
        let client = headers(&[("x-api-key", "sm-key"), ("anthropic-beta", "a-1")]);
        let sent = Claude.headers(&client, &account("tok"), false);
        assert_eq!(sent["authorization"], "Bearer tok");
        let beta = sent["anthropic-beta"].to_str().unwrap();
        assert!(
            beta.contains("a-1") && beta.contains(oauth::OAUTH_BETA),
            "{beta}"
        );
        assert!(Claude.credits().is_some());
        assert!(Claude.spec().agent_only == Some("claude"));
        assert!(!Claude.spec().device_login());
    }

    #[test]
    fn windows_come_from_headers_and_the_pool_replaces_them() {
        let now = Timestamp::from_second(1_000).unwrap();
        let read = headers(&[
            ("anthropic-ratelimit-unified-5h-utilization", "0.5"),
            ("anthropic-ratelimit-unified-5h-reset", "2000"),
        ]);
        let limits = Claude.limits(&read, now).unwrap();
        assert_eq!(limits.windows[0].span, "5h");
        assert_eq!(limits.windows[0].used, 50.0);

        let mut shown = read.clone();
        let pool = [PoolWindow {
            span: "5h",
            used: 80.0,
            resets_at: None,
        }];
        Claude.show_pool(&pool, &mut shown);
        assert_eq!(shown["anthropic-ratelimit-unified-5h-utilization"], "0.80");
        assert!(!shown.contains_key("anthropic-ratelimit-unified-5h-reset"));

        // Windows Claude Code has no header for are left out.
        let mut monthly = read.clone();
        let pool = [PoolWindow {
            span: "30d",
            used: 10.0,
            resets_at: None,
        }];
        Claude.show_pool(&pool, &mut monthly);
        assert!(monthly.is_empty());
    }

    #[test]
    fn verdicts_tell_spent_windows_from_fast_mode_and_auth() {
        let now = Timestamp::from_second(1_000).unwrap();
        let none = HeaderMap::new();
        let fast = br#"{"error":{"message":"Fast request rejected"}}"#;
        assert_eq!(
            Claude.verdict(StatusCode::TOO_MANY_REQUESTS, &none, fast, None, now),
            Verdict::Final
        );
        let spent = headers(&[
            ("anthropic-ratelimit-unified-5h-status", "rejected"),
            ("anthropic-ratelimit-unified-5h-reset", "5000"),
        ]);
        assert_eq!(
            Claude.verdict(StatusCode::TOO_MANY_REQUESTS, &spent, b"{}", None, now),
            Verdict::Exhausted {
                until: Timestamp::from_second(5000),
                model: None
            }
        );
        assert_eq!(
            Claude.verdict(StatusCode::TOO_MANY_REQUESTS, &none, b"{}", None, now),
            Verdict::Throttled { until: None }
        );
        assert_eq!(
            Claude.verdict(StatusCode::UNAUTHORIZED, &none, b"", None, now),
            Verdict::Unauthorized
        );
        assert_eq!(
            Claude.verdict(StatusCode::BAD_REQUEST, &none, b"", None, now),
            Verdict::Final
        );
    }

    async fn anthropic() -> Mock {
        Mock::start(|seen| match (seen.route(), seen.header("authorization")) {
            ("/api/oauth/usage", Some("Bearer good")) => testkit::json(
                200,
                json!({ "five_hour": { "utilization": 12.5, "resets_at": "2099-01-01T00:00:00Z" },
                        "seven_day": { "utilization": 40 },
                        "seven_day_opus": { "utilization": 70 } }),
            ),
            ("/api/oauth/usage", Some("Bearer down")) => testkit::reply(500, "x".repeat(500)),
            ("/api/oauth/profile", Some("Bearer good")) => testkit::json(
                200,
                json!({ "account": { "email": "me@x.dev" },
                        "organization": { "organization_type": "claude_pro" } }),
            ),
            _ => testkit::reply(401, ""),
        })
        .await
    }

    #[tokio::test]
    async fn usage_reads_both_windows() {
        let mock = anthropic().await;
        let http = mock.client(&[API]);
        let reading = Claude.usage(&http, &account("good")).await.unwrap();
        let spans: Vec<(&str, f64)> = reading
            .limits
            .windows
            .iter()
            .map(|w| (w.span.as_str(), w.used))
            .collect();
        assert_eq!(spans, [("5h", 12.5), ("7d", 40.0), ("7d", 70.0)]);
        // Older replies name per-model weekly windows at the top level.
        assert_eq!(reading.limits.windows[2].model.as_deref(), Some("Opus"));
        assert_eq!(reading.plan, None);
        let sent = &mock.seen_at("/api/oauth/usage")[0];
        assert_eq!(sent.header("anthropic-beta"), Some(oauth::OAUTH_BETA));

        let rejected = Claude.usage(&http, &account("bad")).await;
        assert!(matches!(rejected, Err(UsageError::Unauthorized)));
        let Err(UsageError::Other(e)) = Claude.usage(&http, &account("down")).await else {
            panic!("a 500 is another failure");
        };
        let text = e.to_string();
        assert!(text.starts_with("usage endpoint returned 500"), "{text}");
        // Only the start of the body is kept.
        assert!(text.len() < 300);
    }

    #[tokio::test]
    async fn new_tokens_bring_the_profile() {
        let mock = anthropic().await;
        let http = mock.client(&[API]);
        let mut good = account("good");
        Claude.identify(&http, &mut good).await;
        assert_eq!(good.email.as_deref(), Some("me@x.dev"));
        assert_eq!(good.plan.as_deref(), Some("pro"));
        // A failed lookup changes nothing.
        let mut bad = account("bad");
        Claude.identify(&http, &mut bad).await;
        assert_eq!(bad.email, None);
    }

    #[tokio::test]
    async fn unreachable_usage_endpoints_are_other_failures() {
        let http = crate::net::Client::builder()
            .plain_http()
            .origins(crate::net::Origins::new([(API, "http://127.0.0.1:9")]))
            .build();
        let result = Claude.usage(&http, &account("good")).await;
        assert!(matches!(result, Err(UsageError::Other(_))));
    }
}
