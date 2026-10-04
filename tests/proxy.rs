//! End-to-end tests: agent → slopmax → mock provider.
//!
//! The mock decides how to answer from the bearer token, so each account in
//! the store can be made to succeed, hit its limit, or reject its token.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use jiff::{SignedDuration, Timestamp};
use serde_json::{Value, json};
use slopmax::account::{Account, Provider, Store, Tokens};
use slopmax::config::{Config, Strategy};
use slopmax::pool::State as PoolState;
use slopmax::proxy::{App, router};
use slopmax::upstream::Upstream;
use tokio::net::TcpListener;

const KEY: &str = "sm-test-key";

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    headers: HeaderMap,
    body: Bytes,
}

type Log = Arc<Mutex<Vec<Seen>>>;

async fn serve(app: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{addr}")
}

fn reset_in(secs: i64) -> i64 {
    (Timestamp::now() + SignedDuration::from_secs(secs)).as_second()
}

async fn mock_claude(
    State(log): State<Log>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    log.lock().unwrap().push(Seen {
        path: uri.to_string(),
        headers: headers.clone(),
        body,
    });
    match headers["authorization"].to_str().unwrap() {
        "Bearer tok-limited" => (
            StatusCode::TOO_MANY_REQUESTS,
            [
                ("anthropic-ratelimit-unified-status", "rejected".to_owned()),
                (
                    "anthropic-ratelimit-unified-5h-status",
                    "rejected".to_owned(),
                ),
                (
                    "anthropic-ratelimit-unified-5h-reset",
                    reset_in(3600).to_string(),
                ),
                (
                    "anthropic-ratelimit-unified-5h-utilization",
                    "1.0".to_owned(),
                ),
            ],
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}"#,
        )
            .into_response(),
        "Bearer tok-ok" => {
            let stream = concat!(
                "event: message_start\n",
                r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}"#,
                "\n\nevent: message_delta\n",
                r#"data: {"type":"message_delta","usage":{"output_tokens":25}}"#,
                "\n\n",
            );
            (
                StatusCode::OK,
                [
                    ("content-type", "text/event-stream".to_owned()),
                    (
                        "anthropic-ratelimit-unified-5h-utilization",
                        "0.25".to_owned(),
                    ),
                    (
                        "anthropic-ratelimit-unified-5h-reset",
                        reset_in(7200).to_string(),
                    ),
                ],
                stream,
            )
                .into_response()
        }
        _ => (
            StatusCode::UNAUTHORIZED,
            r#"{"type":"error","error":{"type":"authentication_error"}}"#,
        )
            .into_response(),
    }
}

async fn mock_codex(State(log): State<Log>, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    log.lock().unwrap().push(Seen {
        path: uri.to_string(),
        headers: headers.clone(),
        body,
    });
    match headers["authorization"].to_str().unwrap() {
        "Bearer tok-limited" => (
            StatusCode::TOO_MANY_REQUESTS,
            json!({ "error": { "type": "usage_limit_reached", "message": "limit", "resets_at": reset_in(5400) } }).to_string(),
        )
            .into_response(),
        "Bearer tok-ok" => (
            StatusCode::OK,
            [
                ("content-type", "text/event-stream".to_owned()),
                ("x-codex-primary-used-percent", "40".to_owned()),
                ("x-codex-primary-window-minutes", "10080".to_owned()),
                ("x-codex-primary-reset-at", reset_in(86_400).to_string()),
            ],
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":60},\"output_tokens\":7}}}\n\n",
        )
            .into_response(),
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

struct Harness {
    proxy: String,
    app: Arc<App>,
    log: Log,
    ids: Vec<String>,
    _dir: TempDir,
}

struct TempDir(std::path::PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn account(provider: Provider, name: &str, token: &str, added: i64) -> Account {
    let mut account = Account::new(
        provider,
        Tokens {
            access_token: token.into(),
            refresh_token: Some(format!("refresh-{name}")),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(format!("{name}@example.com"));
    account.org_id = Some(format!("org-{name}"));
    account.account_id = Some(format!("acct-{name}"));
    account.device_id = Some(format!("{name:0>64}"));
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

/// Accounts are tried in the order given (fill-first by age).
async fn harness(provider: Provider, tokens: &[&str]) -> Harness {
    slopmax::init();
    let dir = std::env::temp_dir().join(format!(
        "slopmax-it-{}-{}",
        std::process::id(),
        slopmax::ids::token()
    ));
    let store = Store::at(dir.join("accounts"));
    let mut ids = Vec::new();
    for (i, token) in tokens.iter().enumerate() {
        let name = format!("{}{i}", provider.as_str());
        let (saved, _) = store
            .upsert(account(provider, &name, token, 1000 + i as i64))
            .unwrap();
        ids.push(saved.id);
    }

    let log: Log = Arc::default();
    let mock = Router::new()
        .route("/v1/messages", post(mock_claude))
        .route("/codex/responses", post(mock_codex))
        .with_state(log.clone());
    let upstream_url = serve(mock).await;

    let config = Config {
        api_key: KEY.into(),
        strategy: Strategy::FillFirst,
        refresh_tokens: false,
        ..Config::default()
    };
    let upstream = Upstream {
        anthropic: upstream_url.clone(),
        chatgpt: upstream_url,
    };
    let app = App::new(config, store, upstream, PoolState::default());
    app.pool.sync(app.store.list().unwrap(), Default::default());
    let proxy = serve(router(app.clone())).await;
    Harness {
        proxy,
        app,
        log,
        ids,
        _dir: TempDir(dir),
    }
}

const CLAUDE_BODY: &str = r#"{"model":"claude-opus-5-5","metadata":{"user_id":"{\"device_id\":\"client-device\",\"account_uuid\":\"\",\"session_id\":\"sess-1\"}"},"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.287.95e; cc_entrypoint=cli;"},{"type":"text","text":"You are Claude Code."}],"messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}"#;

fn claude_request(h: &Harness) -> reqwest::RequestBuilder {
    reqwest::Client::new()
        .post(format!("{}/v1/messages?beta=true", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header(
            "anthropic-beta",
            "claude-code-20250219,interleaved-thinking-2025-05-14",
        )
        .header("x-claude-code-session-id", "sess-1")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
}

async fn eventually(check: impl Fn() -> bool) {
    for _ in 0..50 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not met");
}

#[tokio::test]
async fn claude_fails_over_and_rewrites_for_the_serving_account() {
    let h = harness(Provider::Claude, &["tok-limited", "tok-ok"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let text = response.text().await.unwrap();
    assert!(
        text.contains("message_delta"),
        "stream passed through: {text}"
    );

    let seen = h.log.lock().unwrap().clone();
    assert_eq!(seen.len(), 2, "limited account, then the next one");
    let served = &seen[1];
    assert_eq!(served.path, "/v1/messages?beta=true");
    assert_eq!(served.headers["authorization"], "Bearer tok-ok");
    assert_eq!(
        served.headers["anthropic-beta"],
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14"
    );
    assert!(served.headers.contains_key("x-client-request-id"));
    assert_eq!(served.headers["accept-encoding"], "identity");

    let body: Value = serde_json::from_slice(&served.body).unwrap();
    let user_id: Value =
        serde_json::from_str(body["metadata"]["user_id"].as_str().unwrap()).unwrap();
    assert_eq!(user_id["device_id"], format!("{:0>64}", "claude1"));
    assert_eq!(user_id["account_uuid"], "acct-claude1");
    assert_eq!(user_id["session_id"], "sess-1");
    let billing = body["system"][0]["text"].as_str().unwrap();
    assert!(billing.contains("cc_entrypoint=cli; cch="), "{billing}");

    // The limited account is blocked until its reset; the other is in use.
    let limited = h.app.pool.state(&h.ids[0]);
    let until = limited.blocked_until.expect("blocked");
    assert!(until > Timestamp::now() + SignedDuration::from_mins(59));
    eventually(|| h.app.pool.state(&h.ids[1]).usage.requests == 1).await;
    let usage = h.app.pool.state(&h.ids[1]).usage;
    assert_eq!(
        (
            usage.input_tokens,
            usage.cache_read_tokens,
            usage.output_tokens
        ),
        (10, 90, 25)
    );
    let served_limits = h.app.pool.state(&h.ids[1]).limits;
    assert_eq!(served_limits.windows[0].used, 25.0);

    // The session is now pinned to the serving account; no retry on the
    // limited one.
    claude_request(&h)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let seen = h.log.lock().unwrap();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[2].headers["authorization"], "Bearer tok-ok");
}

#[tokio::test]
async fn every_account_spent_returns_the_agents_own_limit_error() {
    let h = harness(Provider::Claude, &["tok-limited", "tok-limited"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 429);
    let retry_after: i64 = response.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((3500..=3600).contains(&retry_after), "{retry_after}");
    assert_eq!(
        response.headers()["anthropic-ratelimit-unified-status"],
        "rejected"
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["type"], "rate_limit_error");

    // Both are known to be blocked now, so the next request is answered
    // without touching the provider.
    let before = h.log.lock().unwrap().len();
    assert_eq!(claude_request(&h).send().await.unwrap().status(), 429);
    assert_eq!(h.log.lock().unwrap().len(), before);
}

#[tokio::test]
async fn codex_fails_over_with_workspace_and_version_headers() {
    let h = harness(Provider::Codex, &["tok-limited", "tok-ok"]).await;
    let response = reqwest::Client::new()
        .post(format!("{}/codex/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("session-id", "codex-session")
        .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64) unknown (codex_exec; 0.159.3)")
        .header("content-type", "application/json")
        .body(r#"{"model":"gpt-6-sol","input":[],"stream":true,"store":false,"prompt_cache_key":"codex-session"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    response.text().await.unwrap();

    let seen = h.log.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].path, "/codex/responses");
    assert_eq!(seen[1].headers["authorization"], "Bearer tok-ok");
    assert_eq!(seen[1].headers["chatgpt-account-id"], "acct-codex1");
    assert_eq!(seen[1].headers["version"], "0.159.3");
    assert_eq!(seen[1].headers["session-id"], "codex-session");

    let blocked = h.app.pool.state(&h.ids[0]).blocked_until.expect("blocked");
    assert!(blocked > Timestamp::now() + SignedDuration::from_mins(89));
    eventually(|| h.app.pool.state(&h.ids[1]).usage.requests == 1).await;
    let usage = h.app.pool.state(&h.ids[1]).usage;
    assert_eq!(
        (
            usage.input_tokens,
            usage.cache_read_tokens,
            usage.output_tokens
        ),
        (40, 60, 7)
    );
    assert_eq!(h.app.pool.state(&h.ids[1]).limits.windows[0].span, "7d");
}

#[tokio::test]
async fn codex_exhaustion_uses_usage_limit_shape() {
    let h = harness(Provider::Codex, &["tok-limited"]).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/responses", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .body(r#"{"model":"gpt-6-sol","input":[]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 429);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["type"], "usage_limit_reached");
    assert!(body["error"]["resets_at"].as_i64().unwrap() > Timestamp::now().as_second());
}

#[tokio::test]
async fn rejects_requests_without_the_slopmax_key() {
    let h = harness(Provider::Claude, &["tok-ok"]).await;
    let response = reqwest::Client::new()
        .post(format!("{}/v1/messages", h.proxy))
        .header("x-api-key", "wrong")
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 401);
    assert!(h.log.lock().unwrap().is_empty());

    // Health and Claude Code's connectivity check need no key.
    let client = reqwest::Client::new();
    assert_eq!(
        client
            .get(format!("{}/healthz", h.proxy))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        client
            .head(format!("{}/api/hello", h.proxy))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn revoked_tokens_move_to_the_next_account() {
    let h = harness(Provider::Claude, &["tok-revoked", "tok-ok"]).await;
    let response = claude_request(&h).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let seen = h.log.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].headers["authorization"], "Bearer tok-ok");
    assert!(h.app.pool.state(&h.ids[0]).blocked_until.is_some());
}
