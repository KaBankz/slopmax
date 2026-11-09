//! ChatGPT Plus/Pro/Team subscriptions, as used by Codex.

mod credits;
pub mod limits;
pub mod oauth;
pub mod wire;

use anyhow::Result;
use http::{HeaderMap, StatusCode};

use super::{
    Billing, BoxFuture, Credential, Provider, Reading, ResetCredits, Spec, UsageError, Verdict,
};
use crate::account::Account;
use crate::auth::{Grant, LoginOptions, Prompt, RefreshError};
use crate::limits::{Limits, PoolWindow};
use crate::net::Client;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

/// The ChatGPT backend: the Codex API, usage, and reset credits.
pub const BACKEND: &str = "https://chatgpt.com/backend-api";

pub struct Codex;

/// The models ChatGPT plans serve through Codex.
pub const MODELS: &[&str] = &["gpt-*", "codex-*", "o1*", "o3*", "o4*"];

static SPEC: Spec = Spec {
    id: "codex",
    title: "ChatGPT",
    api: "https://chatgpt.com/backend-api/codex",
    dialects: &[Dialect::Responses],
    models: MODELS,
    billing: Billing::Subscription,
    // OpenAI allows ChatGPT plans in third-party apps.
    agent_only: None,
    // Access tokens claim ten days, but ChatGPT invalidates them about a
    // week after issue ("Encountered invalidated oauth token"), so they are
    // renewed once six days old.
    refresh_lead: SignedDuration::from_hours(96),
    credential: Credential::OAuth { device: true },
};

impl Provider for Codex {
    fn spec(&self) -> &'static Spec {
        &SPEC
    }

    fn identity(&self, account: &Account) -> Option<String> {
        account.account_id.clone()
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

    fn shape(&self, _dialect: Dialect, body: &mut serde_json::Value) {
        // The ChatGPT backend sets output limits itself and rejects them.
        if let Some(fields) = body.as_object_mut() {
            fields.remove("max_output_tokens");
        }
    }

    fn limits(&self, headers: &HeaderMap, now: Timestamp) -> Option<Limits> {
        limits::from_headers(headers, now)
    }

    fn show_pool(&self, windows: &[PoolWindow], headers: &mut HeaderMap) {
        limits::pool_headers(windows, headers);
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

    fn catalog<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        version: &'a str,
    ) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(catalog(http, account, version))
    }
}

/// `GET /codex/models`: the models the account's plan offers Codex.
async fn catalog(http: &Client, account: &Account, version: &str) -> Result<Vec<String>> {
    let request = http
        .get(format!("{BACKEND}/codex/models?client_version={version}"))
        .bearer_auth(&account.tokens.access_token);
    let request = match &account.account_id {
        Some(id) => request.header("chatgpt-account-id", id),
        None => request,
    };
    let body: serde_json::Value = request.send().await?.error_for_status()?.json().await?;
    let models = body
        .get("models")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter(|m| m.get("visibility").and_then(|v| v.as_str()) != Some("hide"))
        .filter_map(|m| m.get("slug").and_then(|s| s.as_str()))
        .map(str::to_owned)
        .collect();
    Ok(models)
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

#[cfg(test)]
mod tests {
    use http::HeaderValue;
    use serde_json::json;

    use super::*;
    use crate::account::Tokens;
    use crate::auth::jwt;
    use crate::provider::ProviderId;
    use crate::testkit::{self, Mock};

    fn account(token: &str, workspace: Option<&str>) -> Account {
        let mut account = Account::new(
            ProviderId::Codex,
            Tokens {
                access_token: token.into(),
                ..Tokens::default()
            },
        );
        account.account_id = workspace.map(Into::into);
        account.assign_id();
        account
    }

    #[test]
    fn requests_carry_the_token_and_workspace() {
        let mut client = HeaderMap::new();
        client.insert("authorization", HeaderValue::from_static("Bearer sm"));
        client.insert("x-codex-turn-state", HeaderValue::from_static("turn"));
        let account = account("tok", Some("ws-1"));
        let stay = Codex.headers(&client, &account, false);
        assert_eq!(stay["authorization"], "Bearer tok");
        assert_eq!(stay["chatgpt-account-id"], "ws-1");
        assert!(stay.contains_key("x-codex-turn-state"));
        let moved = Codex.headers(&client, &account, true);
        assert!(!moved.contains_key("x-codex-turn-state"));
        assert_eq!(Codex.identity(&account).as_deref(), Some("ws-1"));
        assert!(Codex.spec().device_login());
        assert!(Codex.credits().is_some());
    }

    #[test]
    fn translated_requests_drop_output_limits_and_moved_state() {
        let mut body = json!({ "model": "gpt-6", "max_output_tokens": 100 });
        Codex.shape(Dialect::Responses, &mut body);
        assert_eq!(body, json!({ "model": "gpt-6" }));
        let mut not_object = json!([1]);
        Codex.shape(Dialect::Responses, &mut not_object);
        assert_eq!(not_object, json!([1]));

        let rebound = Codex
            .rebind(br#"{"previous_response_id":"r1","input":[]}"#)
            .unwrap();
        assert!(!String::from_utf8(rebound).unwrap().contains("r1"));
        assert_eq!(Codex.rebind(br#"{"input":[]}"#), None);
    }

    #[test]
    fn verdicts_cover_limits_stale_state_and_disguised_limits() {
        let now = Timestamp::from_second(1_000).unwrap();
        let none = HeaderMap::new();
        let verdict = |status: u16, body: &str| {
            Codex.verdict(
                StatusCode::from_u16(status).unwrap(),
                &none,
                body.as_bytes(),
                None,
                now,
            )
        };
        let limit = r#"{"error":{"type":"usage_limit_reached","resets_at":5000}}"#;
        assert!(matches!(verdict(429, limit), Verdict::Exhausted { .. }));
        assert!(matches!(verdict(402, limit), Verdict::Exhausted { .. }));
        assert_eq!(
            verdict(400, r#"{"error":{"code":"invalid_encrypted_content"}}"#),
            Verdict::StaleState
        );
        assert_eq!(verdict(400, "bad request"), Verdict::Final);
        assert_eq!(
            verdict(502, "Your usage limit has been reached"),
            Verdict::Exhausted {
                until: None,
                model: None
            }
        );
        assert_eq!(verdict(502, "gateway"), Verdict::Final);
        assert_eq!(verdict(403, ""), Verdict::Forbidden);

        // Without a reset in the body, the headers say when.
        let mut spent = HeaderMap::new();
        spent.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("100"),
        );
        spent.insert("x-codex-primary-reset-at", HeaderValue::from_static("4000"));
        let body = br#"{"error":{"type":"usage_limit_reached"}}"#;
        assert_eq!(
            Codex.verdict(StatusCode::TOO_MANY_REQUESTS, &spent, body, None, now),
            Verdict::Exhausted {
                until: Timestamp::from_second(4000),
                model: None
            }
        );
        let mut later = HeaderMap::new();
        later.insert("retry-after", HeaderValue::from_static("30"));
        assert_eq!(
            Codex.verdict(StatusCode::TOO_MANY_REQUESTS, &later, body, None, now),
            Verdict::Exhausted {
                until: Some(now + SignedDuration::from_secs(30)),
                model: None
            }
        );
    }

    #[test]
    fn windows_come_from_headers_and_the_pool_replaces_them() {
        let now = Timestamp::from_second(1_000).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-primary-used-percent",
            HeaderValue::from_static("25"),
        );
        headers.insert(
            "x-codex-primary-window-minutes",
            HeaderValue::from_static("300"),
        );
        let limits = Codex.limits(&headers, now).unwrap();
        assert_eq!(
            (limits.windows[0].span.as_str(), limits.windows[0].used),
            ("5h", 25.0)
        );
        let pool = [PoolWindow {
            span: "5h",
            used: 60.0,
            resets_at: None,
        }];
        Codex.show_pool(&pool, &mut headers);
        assert_eq!(headers["x-codex-primary-used-percent"], "60.0");
        // Socket events without limits are left alone.
        let mut event = json!({ "type": "codex.rate_limits" });
        limits::pool_event(&pool, &mut event);
        assert_eq!(event, json!({ "type": "codex.rate_limits" }));
    }

    #[test]
    fn new_tokens_are_read_for_identity() {
        let access = jwt::encode_unsigned(&json!({
            "https://api.openai.com/auth": { "chatgpt_account_id": "ws-9", "chatgpt_plan_type": "pro" }
        }));
        let mut account = account(&access, None);
        let http = crate::net::Client::builder().plain_http().build();
        let identified = Codex.identify(&http, &mut account);
        drop(identified);
        assert_eq!(account.account_id.as_deref(), Some("ws-9"));
        assert_eq!(account.plan.as_deref(), Some("pro"));
    }

    async fn chatgpt() -> Mock {
        Mock::start(|seen| match (seen.route(), seen.header("authorization")) {
            ("/wham/usage", Some("Bearer good")) => testkit::json(
                200,
                json!({ "plan_type": "pro",
                        "rate_limit": { "primary_window": { "used_percent": 20, "limit_window_seconds": 18000, "reset_after_seconds": 60 } },
                        "rate_limit_reset_credits": { "available_count": 2 } }),
            ),
            ("/codex/models", Some("Bearer good")) => testkit::json(
                200,
                json!({ "models": [
                    { "slug": "gpt-6-sol", "visibility": "list" },
                    { "slug": "gpt-hidden", "visibility": "hide" },
                    { "slug": "gpt-plain" },
                    { "visibility": "list" }
                ] }),
            ),
            (_, Some("Bearer good")) => testkit::reply(404, ""),
            _ => testkit::reply(401, ""),
        })
        .await
    }

    #[tokio::test]
    async fn usage_reads_windows_plan_and_credits() {
        let mock = chatgpt().await;
        let http = mock.client(&[BACKEND]);
        let reading = Codex
            .usage(&http, &account("good", Some("ws-1")))
            .await
            .unwrap();
        assert_eq!(reading.plan.as_deref(), Some("pro"));
        assert_eq!(reading.limits.windows[0].span, "5h");
        assert_eq!(reading.limits.windows[0].used, 20.0);
        assert_eq!(reading.limits.reset_credits, Some(2));
        let sent = &mock.seen_at("/wham/usage")[0];
        assert_eq!(sent.header("chatgpt-account-id"), Some("ws-1"));

        let no_workspace = Codex.usage(&http, &account("good", None)).await.unwrap();
        assert_eq!(no_workspace.plan.as_deref(), Some("pro"));
        assert_eq!(
            mock.seen_at("/wham/usage")[1].header("chatgpt-account-id"),
            None
        );
        let rejected = Codex.usage(&http, &account("bad", None)).await;
        assert!(matches!(rejected, Err(UsageError::Unauthorized)));
    }

    #[tokio::test]
    async fn the_catalog_lists_visible_models() {
        let mock = chatgpt().await;
        let http = mock.client(&[BACKEND]);
        let models = Codex
            .catalog(&http, &account("good", Some("ws-1")), "0.160.0")
            .await
            .unwrap();
        assert_eq!(models, ["gpt-6-sol", "gpt-plain"]);
        let sent = &mock.seen_at("/codex/models")[0];
        assert_eq!(sent.path, "/codex/models?client_version=0.160.0");
        assert_eq!(sent.header("chatgpt-account-id"), Some("ws-1"));
        assert!(
            Codex
                .catalog(&http, &account("good", None), "1")
                .await
                .is_ok()
        );
        assert!(
            Codex
                .catalog(&http, &account("bad", None), "1")
                .await
                .is_err()
        );
    }
}
