//! CLIProxyAPI's management API, as far as tools that show a hub's quotas
//! use it. T3 Code's usage-limit sources are one: given a hub's URL and
//! management key, they list its accounts, read each account's usage and
//! reset credits, and redeem credits.
//!
//! CLIProxyAPI serves those reads through `api-call`, which sends any
//! request to any address with an account's token filled in. slopmax keeps
//! the request and reply shapes but not the relay: its `api-call` answers
//! the usage and reset-credit calls those tools make, usage from the
//! readings slopmax already keeps, and refuses everything else.

use std::sync::Arc;

use http::{HeaderMap, Method, StatusCode};
use hyper::body::Incoming;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use super::{App, authorized, constant_time_eq, json_reply};
use crate::account::Account;
use crate::config::Config;
use crate::limits::{Limits, Window};
use crate::net::body;
use crate::net::server::{Request, Response};
use crate::provider::ProviderId;
use crate::provider::credits::{Credit, Outcome};
use crate::time::{SignedDuration, Timestamp};
use crate::{daemon, log};

const CLAUDE_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_CREDITS: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_CONSUME: &str = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
/// How long a credit list is reused. Tools read it on every refresh, and it
/// changes only when a credit is granted or spent.
const CREDITS_FRESH: SignedDuration = SignedDuration::from_mins(5);

/// A provider's status and body, as `api-call` relays them.
type Answer = Result<Value, (StatusCode, String)>;

/// Answers a request under `/v0/management/`.
pub(super) async fn handle(app: Arc<App>, request: Request) -> Response {
    if !authorized(&app.config(), request.headers())
        && !has_management_key(&app.config(), request.headers())
    {
        return fail(
            StatusCode::UNAUTHORIZED,
            "missing or invalid management key; use slopmax's api_key",
        );
    }
    let (parts, incoming) = request.into_parts();
    let path = parts.uri.path().trim_start_matches("/v0/management/");
    match (parts.method, path) {
        (Method::GET, "auth-files") => auth_files(&app),
        (Method::POST, "api-call") => match read_json::<Call>(incoming).await {
            Some(call) => api_call(&app, call).await,
            None => fail(StatusCode::BAD_REQUEST, "invalid body"),
        },
        (Method::POST, "reset-quota") => match read_json::<Index>(incoming).await {
            Some(Index { auth_index }) => reset_quota(app, &auth_index),
            None => fail(StatusCode::BAD_REQUEST, "auth_index is required"),
        },
        _ => fail(
            StatusCode::NOT_FOUND,
            "slopmax serves auth-files, api-call, and reset-quota of CLIProxyAPI's management API",
        ),
    }
}

/// CLIProxyAPI also takes its key in `x-management-key`.
fn has_management_key(config: &Config, headers: &HeaderMap) -> bool {
    headers
        .get("x-management-key")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|key| constant_time_eq(key.trim().as_bytes(), config.api_key.as_bytes()))
}

async fn read_json<T: DeserializeOwned>(incoming: Incoming) -> Option<T> {
    let bytes = body::read(incoming, 64 * 1024).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// An error in CLIProxyAPI's shape.
fn fail(status: StatusCode, message: &str) -> Response {
    json_reply(status, &json!({ "error": message }))
}

/// The subscription account an `auth_index` names: slopmax's account id.
fn find(app: &App, index: &str) -> Option<Account> {
    let index = index.trim();
    app.pool
        .accounts()
        .into_iter()
        .find(|a| a.id == index && a.provider.spec().is_subscription())
}

/// The subscription accounts, listed as CLIProxyAPI lists its auth files.
fn auth_files(app: &App) -> Response {
    let now = Timestamp::now();
    let files: Vec<Value> = app
        .pool
        .accounts()
        .iter()
        .filter(|a| a.provider.spec().is_subscription())
        .map(|account| {
            let status = match (&account.auth_error, account.disabled) {
                (Some(_), _) => "error",
                (None, true) => "disabled",
                (None, false) => "active",
            };
            let mut file = json!({
                "id": account.id,
                "auth_index": account.id,
                "name": format!("{}.json", account.id),
                "type": account.provider.as_str(),
                "provider": account.provider.as_str(),
                "label": account.name(),
                "status": status,
                "disabled": account.disabled,
                "unavailable": account.auth_error.is_some()
                    || app.pool.state(&account.id).is_blocked(now),
                "priority": account.priority,
            });
            // Clients read these as strings when present, so absent values
            // are left out rather than sent as null.
            if let Some(email) = &account.email {
                file["email"] = json!(email);
            }
            if let Some(error) = &account.auth_error {
                file["status_message"] = json!(error);
            }
            if account.provider == ProviderId::Codex {
                let mut token = json!({});
                if let Some(id) = &account.account_id {
                    token["chatgpt_account_id"] = json!(id);
                }
                if let Some(plan) = &account.plan {
                    token["chatgpt_plan_type"] = json!(plan);
                }
                file["id_token"] = token;
            }
            file
        })
        .collect();
    json_reply(StatusCode::OK, &json!({ "files": files }))
}

/// An `api-call` request. The headers it asks for are ignored: slopmax
/// answers from its own state and sends with its own credentials.
#[derive(Debug, Deserialize)]
struct Call {
    #[serde(alias = "authIndex", alias = "AuthIndex", default)]
    auth_index: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    data: String,
}

async fn api_call(app: &App, call: Call) -> Response {
    let Some(account) = find(app, &call.auth_index) else {
        return fail(StatusCode::BAD_REQUEST, "no account has this auth_index");
    };
    let now = Timestamp::now();
    let method = call.method.trim().to_ascii_uppercase();
    let answer = match (method.as_str(), call.url.trim(), account.provider) {
        ("GET", CLAUDE_USAGE, ProviderId::Claude) => {
            reading(app, &account).map(|limits| claude_usage(&limits, now))
        }
        ("GET", CODEX_USAGE, ProviderId::Codex) => {
            reading(app, &account).map(|limits| codex_usage(&account, &limits, now))
        }
        ("GET", CODEX_CREDITS, ProviderId::Codex) => credit_list(app, &account).await,
        ("POST", CODEX_CONSUME, ProviderId::Codex) => consume(app, &account, &call.data).await,
        _ => {
            return fail(
                StatusCode::FORBIDDEN,
                "slopmax answers only the usage and reset-credit calls of its accounts; \
                 it does not send their tokens elsewhere",
            );
        }
    };
    let (status, body) = match answer {
        Ok(body) => (StatusCode::OK, body),
        Err((status, message)) => (status, json!({ "error": { "message": message } })),
    };
    json_reply(
        StatusCode::OK,
        &json!({
            "status_code": status.as_u16(),
            "header": { "Content-Type": ["application/json"] },
            "body": body.to_string(),
        }),
    )
}

fn signed_out() -> (StatusCode, String) {
    (
        StatusCode::UNAUTHORIZED,
        "the account needs signing in again".into(),
    )
}

/// The account's usage windows as slopmax last read them, from its usage
/// polls and the headers of every response.
fn reading(app: &App, account: &Account) -> Result<Limits, (StatusCode, String)> {
    if account.auth_error.is_some() {
        return Err(signed_out());
    }
    let limits = app.pool.state(&account.id).limits;
    if limits.observed_at.is_none() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "slopmax has not read this account's usage yet".into(),
        ));
    }
    Ok(limits)
}

/// A reading in the shape of Anthropic's `GET /api/oauth/usage`.
fn claude_usage(limits: &Limits, now: Timestamp) -> Value {
    let shared = |span: &str| {
        limits
            .windows
            .iter()
            .find(|w| w.span == span && w.model.is_none())
            .map(|w| json!({ "utilization": w.used_at(now), "resets_at": reset(w, now) }))
    };
    let scoped: Vec<Value> = limits
        .windows
        .iter()
        .filter_map(|w| {
            let model = w.model.as_ref()?;
            Some(json!({
                "kind": "weekly_scoped",
                "percent": w.used_at(now),
                "resets_at": reset(w, now),
                "scope": { "model": { "display_name": model } },
            }))
        })
        .collect();
    json!({ "five_hour": shared("5h"), "seven_day": shared("7d"), "limits": scoped })
}

fn reset(window: &Window, now: Timestamp) -> Option<String> {
    window.upcoming_reset(now).map(|at| at.to_string())
}

/// A reading in the shape of ChatGPT's `GET /wham/usage`, the shortest
/// window first.
fn codex_usage(account: &Account, limits: &Limits, now: Timestamp) -> Value {
    let mut shared: Vec<&Window> = limits
        .windows
        .iter()
        .filter(|w| w.model.is_none())
        .collect();
    shared.sort_by_key(|w| span_seconds(&w.span));
    let window = |w: &&Window| {
        json!({
            "used_percent": w.used_at(now),
            "reset_at": w.upcoming_reset(now).map(Timestamp::as_second),
            "limit_window_seconds": span_seconds(&w.span),
        })
    };
    let mut usage = json!({
        "rate_limit": {
            "primary_window": shared.first().map(window),
            "secondary_window": shared.get(1).map(window),
        },
    });
    if let Some(plan) = &account.plan {
        usage["plan_type"] = json!(plan);
    }
    if let Some(count) = limits.reset_credits {
        usage["rate_limit_reset_credits"] = json!({ "available_count": count });
    }
    usage
}

fn span_seconds(span: &str) -> i64 {
    match span {
        "5h" => 5 * 3600,
        "30d" => 30 * 86_400,
        _ => 7 * 86_400,
    }
}

/// The account's unspent reset credits, in ChatGPT's list shape.
async fn credit_list(app: &App, account: &Account) -> Answer {
    let credits: Vec<Value> = credits(app, account)
        .await?
        .iter()
        .filter_map(|c| {
            let mut credit = json!({
                "id": c.id,
                "status": "available",
                "reset_type": "codex_rate_limits",
                "expires_at": c.expires_at?.to_string(),
            });
            if let Some(at) = c.granted_at {
                credit["granted_at"] = json!(at.to_string());
            }
            Some(credit)
        })
        .collect();
    Ok(json!({ "credits": credits }))
}

async fn credits(app: &App, account: &Account) -> Result<Vec<Credit>, (StatusCode, String)> {
    let Some(lister) = account.provider.get().credits() else {
        return Ok(Vec::new());
    };
    let now = Timestamp::now();
    let state = app.pool.state(&account.id);
    // The usage reading counts them, which saves asking when there are none.
    if state.limits.reset_credits == Some(0) {
        return Ok(Vec::new());
    }
    if state
        .credits
        .as_ref()
        .is_some_and(|list| now.duration_since(list.listed_at) < CREDITS_FRESH)
    {
        return Ok(state.unexpired_credits(now).cloned().collect());
    }
    let ready = app.ready(account).await.ok_or_else(signed_out)?;
    let agent = app.pool.agent(account.provider);
    let credits = lister
        .list(&app.auth_http, &ready, agent.as_deref())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    app.pool.record_credits(&account.id, credits.clone(), now);
    Ok(credits)
}

/// Redeems the credit `data` names (`{"credit_id": …}`), answering in
/// ChatGPT's shape.
async fn consume(app: &App, account: &Account, data: &str) -> Answer {
    #[derive(Deserialize)]
    struct Consume {
        credit_id: String,
    }
    let Ok(Consume { credit_id }) = serde_json::from_str(data) else {
        return Err((StatusCode::BAD_REQUEST, "no credit_id to redeem".into()));
    };
    let Some(credits) = account.provider.get().credits() else {
        return Err((
            StatusCode::BAD_REQUEST,
            "this account has no limit resets".into(),
        ));
    };
    let _redeeming = app.redeeming.lock().await;
    let ready = app.ready(account).await.ok_or_else(signed_out)?;
    let agent = app.pool.agent(account.provider);
    let outcome = credits
        .redeem(&app.auth_http, &ready, agent.as_deref(), Some(&credit_id))
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    if outcome == Outcome::Reset {
        log::info!("{}: redeemed a limit reset for a hub client", account.id);
        app.pool
            .record_reset(&account.id, Timestamp::now(), Some(&credit_id));
    }
    Ok(json!({ "code": outcome }))
}

#[derive(Debug, Deserialize)]
struct Index {
    #[serde(alias = "authIndex", alias = "AuthIndex")]
    auth_index: String,
}

/// Lifts slopmax's blocks on the account, as CLIProxyAPI clears its
/// cooldown, and reads its usage again to learn what the windows hold now.
fn reset_quota(app: Arc<App>, index: &str) -> Response {
    let Some(account) = find(&app, index) else {
        return fail(StatusCode::NOT_FOUND, "no account has this auth_index");
    };
    let models = app.pool.clear_blocks(&account.id);
    let id = account.id.clone();
    if app.config().poll_mins > 0 && account.auth_error.is_none() {
        let polling = Arc::clone(&app);
        app.spawn(async move { daemon::poll_one(&polling, &account).await });
    }
    json_reply(
        StatusCode::OK,
        &json!({ "status": "ok", "auth_index": id, "models": models }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;
    use crate::time::SignedDuration;

    #[test]
    fn readings_take_the_providers_shapes() {
        let now = Timestamp::from_second(1_000_000).unwrap();
        let at = |hours| now + SignedDuration::from_hours(hours);
        let limits = Limits {
            windows: vec![
                Window::new("7d", 49.0, Some(at(70))),
                Window::new("5h", 43.0, Some(at(2))),
                Window {
                    model: Some("Fable".into()),
                    ..Window::new("7d", 58.0, Some(at(70)))
                },
            ],
            observed_at: Some(now),
            reset_credits: Some(2),
        };

        let claude = claude_usage(&limits, now);
        assert_eq!(claude["five_hour"]["utilization"], 43.0);
        assert_eq!(claude["five_hour"]["resets_at"], at(2).to_string());
        assert_eq!(claude["seven_day"]["utilization"], 49.0);
        assert_eq!(claude["limits"][0]["kind"], "weekly_scoped");
        assert_eq!(claude["limits"][0]["percent"], 58.0);
        assert_eq!(
            claude["limits"][0]["scope"]["model"]["display_name"],
            "Fable"
        );

        let mut account = Account::new(ProviderId::Codex, Tokens::default());
        let codex = codex_usage(&account, &limits, now);
        // A missing plan is left out: clients reject a null one.
        assert!(codex.get("plan_type").is_none());
        let primary = &codex["rate_limit"]["primary_window"];
        assert_eq!(primary["used_percent"], 43.0);
        assert_eq!(primary["reset_at"], at(2).as_second());
        assert_eq!(primary["limit_window_seconds"], 18_000);
        let secondary = &codex["rate_limit"]["secondary_window"];
        assert_eq!(secondary["limit_window_seconds"], 604_800);
        assert_eq!(codex["rate_limit_reset_credits"]["available_count"], 2);
        account.plan = Some("pro".into());
        assert_eq!(codex_usage(&account, &limits, now)["plan_type"], "pro");

        // Once a window resets, it reads as unused with no reset ahead.
        let later = at(3);
        let claude = claude_usage(&limits, later);
        assert_eq!(claude["five_hour"]["utilization"], 0.0);
        assert_eq!(claude["five_hour"]["resets_at"], Value::Null);
        let codex = codex_usage(&account, &limits, later);
        assert_eq!(
            codex["rate_limit"]["primary_window"]["reset_at"],
            Value::Null
        );
    }
}
