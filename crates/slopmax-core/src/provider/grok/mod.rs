//! SuperGrok subscriptions, as used by Grok Build.
//!
//! Grok Build talks to xAI's CLI chat proxy, which takes the account's
//! OAuth token and the client's own headers; slopmax changes only the
//! token. The plan's usage is a monthly allowance, read from the proxy's
//! billing endpoint.

pub mod oauth;

use anyhow::Result;
use http::{HeaderMap, HeaderValue, StatusCode};
use serde_json::Value;

use super::{Billing, BoxFuture, Credential, Provider, Reading, Spec, UsageError, Verdict};
use crate::account::Account;
use crate::auth::{Grant, LoginOptions, Prompt, RefreshError};
use crate::limits::{self, Limits, Window};
use crate::net::Client;
use crate::provider::codex::wire as responses;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

/// The CLI chat proxy: Responses, settings, and billing.
pub const API: &str = "https://cli-chat-proxy.grok.com/v1";

pub struct Grok;

static SPEC: Spec = Spec {
    id: "grok",
    title: "Grok",
    api: API,
    dialects: &[Dialect::Responses, Dialect::Chat],
    models: &["grok-*"],
    billing: Billing::Subscription,
    // The sign-in grants `grok-cli:access`: the plan is for xAI's own
    // agent, whose requests slopmax passes on as they are.
    agent_only: Some("grok"),
    // Access tokens live six hours.
    refresh_lead: SignedDuration::from_mins(30),
    credential: Credential::OAuth { device: true },
};

impl Provider for Grok {
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
        Box::pin(async move {
            let mut account = oauth::login(http, options, prompt).await?;
            account.plan = plan(http, &account).await;
            Ok(account)
        })
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
            oauth::apply_claims(account);
            if let Some(plan) = plan(http, account).await {
                account.plan = Some(plan);
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
        let mut headers = crate::net::headers::forwardable(client);
        if let Some(bearer) = account.bearer() {
            headers.insert(http::header::AUTHORIZATION, bearer);
        }
        // Uncompressed streams can be read for usage and in-stream refusals.
        headers.insert(
            http::header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        headers
    }

    fn rebind(&self, body: &[u8]) -> Option<Vec<u8>> {
        responses::strip_account_state(body)
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
                refusal(status, headers, body, now)
            }
            // A token xAI invalidated early comes back as a 403.
            StatusCode::FORBIDDEN if bad_credentials(body) => Verdict::Unauthorized,
            StatusCode::BAD_REQUEST if responses::rejects_account_state(body) => {
                Verdict::StaleState
            }
            _ => Verdict::of_status(status),
        }
    }
}

/// Classifies a 429 or 402. A spent allowance keeps the account out until
/// xAI says, else until the pool's default; anything else is throttling.
fn refusal(status: StatusCode, headers: &HeaderMap, body: &[u8], now: Timestamp) -> Verdict {
    let until = limits::retry_after(headers, now);
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    let spent = status == StatusCode::PAYMENT_REQUIRED
        || [
            "usage_limit_reached",
            "usage_pool_exhausted",
            "usage-exhausted",
            "usage limit",
            "included free usage",
            "credit limit",
            "out of credits",
        ]
        .iter()
        .any(|sign| text.contains(sign));
    if spent {
        Verdict::Exhausted { until, model: None }
    } else {
        Verdict::Throttled { until }
    }
}

/// Whether a 403 says the access token is no longer valid.
fn bad_credentials(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("bad-credentials")
        || text.contains("could not be validated")
        || text.contains("invalid or expired credentials")
}

/// `GET /billing`: the plan's monthly allowance, used and resetting with
/// the billing period.
async fn usage(http: &Client, account: &Account) -> Result<Reading, UsageError> {
    let response = http
        .get(format!("{API}/billing"))
        .bearer_auth(&account.tokens.access_token)
        .send()
        .await
        .map_err(|e| UsageError::Other(e.into()))?;
    let body = super::usage_body(response).await?;
    let limits = from_billing(&body, Timestamp::now());
    // The plan is read when tokens arrive; only an account without one asks
    // again here.
    let plan = match account.plan {
        Some(_) => None,
        None => plan(http, account).await,
    };
    Ok(Reading { limits, plan })
}

/// The monthly window in a `/billing` answer, where amounts are `{"val": n}`.
fn from_billing(body: &Value, now: Timestamp) -> Limits {
    let config = body.get("config").unwrap_or(body);
    let amount = |key: &str| config.get(key)?.get("val")?.as_f64();
    let window = match (amount("monthlyLimit"), amount("used")) {
        (Some(limit), Some(used)) if limit > 0.0 => {
            let resets_at = config.get("billingPeriodEnd").and_then(limits::parse_time);
            Some(Window::new("30d", used / limit * 100.0, resets_at))
        }
        _ => None,
    };
    Limits {
        windows: window.into_iter().collect(),
        observed_at: Some(now),
        reset_credits: None,
    }
}

/// `GET /settings`: the plan, named short as the other providers' are:
/// "SuperGrok Heavy" is `heavy`, and SuperGrok alone `supergrok`.
async fn plan(http: &Client, account: &Account) -> Option<String> {
    let settings: Value = http
        .get(format!("{API}/settings"))
        .bearer_auth(&account.tokens.access_token)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    settings
        .get("subscription_tier_display")
        .and_then(Value::as_str)
        .and_then(plan_name)
}

fn plan_name(display: &str) -> Option<String> {
    let name = display.trim().to_lowercase();
    let short = name.strip_prefix("supergrok ").map(str::trim);
    Some(short.unwrap_or(&name).to_owned()).filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::account::Tokens;
    use crate::provider::ProviderId;
    use crate::testkit::{self, Mock};

    fn account(token: &str) -> Account {
        let mut account = Account::new(
            ProviderId::Grok,
            Tokens {
                access_token: token.into(),
                ..Tokens::default()
            },
        );
        account.account_id = Some("user-1".into());
        account.assign_id();
        account
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(*k, HeaderValue::from_static(v));
        }
        map
    }

    #[test]
    fn requests_keep_grok_builds_headers_and_carry_the_token() {
        let client = headers(&[
            ("authorization", "Bearer sm-local"),
            ("user-agent", "grok-shell/1.0.77 (linux; x86_64)"),
            ("x-xai-token-auth", "xai-grok-cli"),
            ("x-grok-conv-group-id", "g-1"),
            ("x-slopmax-affinity", "off"),
            ("host", "127.0.0.1:7567"),
        ]);
        let sent = Grok.headers(&client, &account("tok"), true);
        assert_eq!(sent["authorization"], "Bearer tok");
        assert_eq!(sent["x-xai-token-auth"], "xai-grok-cli");
        assert_eq!(sent["x-grok-conv-group-id"], "g-1");
        assert_eq!(sent["user-agent"], "grok-shell/1.0.77 (linux; x86_64)");
        assert_eq!(sent["accept-encoding"], "identity");
        assert!(!sent.contains_key("host"));
        assert!(!sent.contains_key("x-slopmax-affinity"));
        assert_eq!(Grok.identity(&account("t")).as_deref(), Some("user-1"));
        assert_eq!(Grok.spec().agent_only, Some("grok"));
        assert!(Grok.spec().is_subscription() && Grok.spec().device_login());
        assert!(Grok.serves(&account("t"), "grok-4.7"));
        assert!(!Grok.serves(&account("t"), "gpt-6"));
    }

    #[test]
    fn verdicts_tell_spent_allowances_from_throttling() {
        let now = Timestamp::from_second(1_000).unwrap();
        let none = HeaderMap::new();
        let verdict = |status: u16, headers: &HeaderMap, body: &str| {
            Grok.verdict(
                StatusCode::from_u16(status).unwrap(),
                headers,
                body.as_bytes(),
                Some("grok-4.7"),
                now,
            )
        };
        assert_eq!(
            verdict(429, &none, r#"{"code":"usage_limit_reached"}"#),
            Verdict::Exhausted {
                until: None,
                model: None
            }
        );
        let later = headers(&[("retry-after", "30")]);
        assert_eq!(
            verdict(
                429,
                &later,
                r#"{"error":"You have used up your included free usage"}"#
            ),
            Verdict::Exhausted {
                until: Some(now + SignedDuration::from_secs(30)),
                model: None
            }
        );
        assert_eq!(
            verdict(402, &none, "{}"),
            Verdict::Exhausted {
                until: None,
                model: None
            }
        );
        assert_eq!(
            verdict(429, &later, r#"{"error":"concurrency limit"}"#),
            Verdict::Throttled {
                until: Some(now + SignedDuration::from_secs(30))
            }
        );
        assert_eq!(
            verdict(403, &none, r#"{"code":"bad-credentials"}"#),
            Verdict::Unauthorized
        );
        assert_eq!(verdict(403, &none, "team blocked"), Verdict::Forbidden);
        assert_eq!(
            verdict(
                400,
                &none,
                r#"{"error":{"code":"invalid_encrypted_content"}}"#
            ),
            Verdict::StaleState
        );
        assert_eq!(verdict(400, &none, "bad"), Verdict::Final);
        assert_eq!(verdict(401, &none, ""), Verdict::Unauthorized);
        assert!(
            Grok.rebind(br#"{"input":[{"type":"reasoning","encrypted_content":"x"}]}"#)
                .is_some()
        );
    }

    #[test]
    fn billing_is_a_monthly_window() {
        let now = Timestamp::from_second(1_000).unwrap();
        let body = json!({ "config": {
            "monthlyLimit": { "val": 10000 }, "used": { "val": 2500 },
            "onDemandCap": { "val": 0 },
            "billingPeriodStart": "2026-11-01T00:00:00+00:00",
            "billingPeriodEnd": "2026-12-01T00:00:00+00:00",
        } });
        let limits = from_billing(&body, now);
        assert_eq!(limits.windows.len(), 1);
        let window = &limits.windows[0];
        assert_eq!((window.span.as_str(), window.used), ("30d", 25.0));
        assert_eq!(
            window.resets_at,
            "2026-12-01T00:00:00Z".parse::<Timestamp>().ok()
        );
        assert_eq!(limits.observed_at, Some(now));
        // No allowance, no window.
        let unlimited = json!({ "config": { "monthlyLimit": { "val": 0 }, "used": { "val": 5 } } });
        assert!(from_billing(&unlimited, now).windows.is_empty());
        assert!(from_billing(&json!({}), now).windows.is_empty());
    }

    async fn proxy() -> Mock {
        Mock::start(|seen| match (seen.route(), seen.header("authorization")) {
            ("/v1/billing", Some("Bearer good")) => testkit::json(
                200,
                json!({ "config": { "monthlyLimit": { "val": 100 }, "used": { "val": 40 },
                                    "billingPeriodEnd": "2026-12-01T00:00:00+00:00" } }),
            ),
            ("/v1/settings", Some("Bearer good")) => testkit::json(
                200,
                json!({ "subscription_tier_display": "SuperGrok Heavy" }),
            ),
            (_, Some("Bearer good")) => testkit::reply(404, ""),
            _ => testkit::json(401, json!({ "error": "Invalid or expired credentials" })),
        })
        .await
    }

    #[test]
    fn plans_are_named_short() {
        assert_eq!(plan_name("SuperGrok Heavy").as_deref(), Some("heavy"));
        assert_eq!(plan_name("SuperGrok Lite").as_deref(), Some("lite"));
        assert_eq!(plan_name(" SuperGrok ").as_deref(), Some("supergrok"));
        assert_eq!(plan_name("X Premium+").as_deref(), Some("x premium+"));
        assert_eq!(plan_name("  "), None);
    }

    #[tokio::test]
    async fn usage_reads_the_allowance_and_a_missing_plan() {
        let mock = proxy().await;
        let http = mock.client(&["https://cli-chat-proxy.grok.com"]);
        let fresh = Grok.usage(&http, &account("good")).await.unwrap();
        assert_eq!(fresh.limits.windows[0].used, 40.0);
        assert_eq!(fresh.plan.as_deref(), Some("heavy"));
        let sent = &mock.seen_at("/v1/billing")[0];
        assert_eq!(sent.header("authorization"), Some("Bearer good"));

        let mut known = account("good");
        known.plan = Some("supergrok".into());
        let again = Grok.usage(&http, &known).await.unwrap();
        assert_eq!(again.plan, None);
        assert_eq!(mock.seen_at("/v1/settings").len(), 1);

        let rejected = Grok.usage(&http, &account("bad")).await;
        assert!(matches!(rejected, Err(UsageError::Unauthorized)));
    }

    #[tokio::test]
    async fn identify_reads_claims_and_the_plan() {
        let mock = proxy().await;
        let http = mock.client(&["https://cli-chat-proxy.grok.com"]);
        let mut fresh = account("good");
        fresh.account_id = None;
        fresh.tokens.access_token = "good".into();
        Grok.identify(&http, &mut fresh).await;
        assert_eq!(fresh.plan.as_deref(), Some("heavy"));
    }
}
