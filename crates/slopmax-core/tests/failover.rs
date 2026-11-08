//! The failover loop's less traveled turns, end to end: a rejected token
//! refreshed and retried, a refresh that is refused, an endpoint that does
//! not answer, a throttled account, a stream that opens overloaded, and
//! requests routing turns away.
//!
//! The mock answers by bearer token, as in `proxy.rs`, and also stands in for
//! Anthropic's token endpoint.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::{Method, StatusCode};
use serde_json::{Value, json};
use slopmax_core::account::{Account, Endpoint, Store, Tokens};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::net::body;
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::net::{Client, Origins};
use slopmax_core::paths::Home;
use slopmax_core::pool::State as PoolState;
use slopmax_core::provider::ProviderId;
use slopmax_core::proxy::{self, App};
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_core::wire::Dialect;
use tokio::net::TcpListener;

const KEY: &str = "sm-test-key";

#[derive(Debug, Clone)]
struct Seen {
    path: String,
    authorization: String,
    body: Bytes,
}

type Log = Arc<Mutex<Vec<Seen>>>;

async fn serve<H, F>(handler: H) -> String
where
    H: Fn(Request) -> F + Clone + Send + Sync + 'static,
    F: Future<Output = Response> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    format!("http://{addr}")
}

fn reply(status: u16, content_type: &str, body: impl Into<Bytes>) -> Response {
    let mut response = Response::new(body::full(body));
    *response.status_mut() = StatusCode::from_u16(status).unwrap();
    response
        .headers_mut()
        .insert("content-type", content_type.parse().unwrap());
    response
}

const CLAUDE_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}"#,
    "\n\n",
);

const CODEX_STREAM: &str = concat!(
    "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
    "data: {\"type\":\"response.output_text.delta\",\"item_id\":\"m1\",\"delta\":\"hi\"}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":3,\"output_tokens\":1}}}\n\n",
);

async fn mock(log: Log, request: Request) -> Response {
    // Other programs on the machine may probe any open port.
    if request.uri().path() == "/" {
        return reply(404, "text/plain", "");
    }
    let (parts, incoming) = request.into_parts();
    let body = body::read(incoming, usize::MAX).await.unwrap();
    let authorization = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    log.lock().unwrap().push(Seen {
        path: parts.uri.path().to_owned(),
        authorization: authorization.clone(),
        body: body.clone(),
    });
    let sse = "text/event-stream";
    let json = "application/json";
    match (parts.method, parts.uri.path(), authorization.as_str()) {
        (Method::POST, "/v1/oauth/token", _) => {
            let request: Value = serde_json::from_slice(&body).unwrap();
            match request["refresh_token"].as_str() {
                Some("refresh-good") => reply(
                    200,
                    json,
                    json!({ "access_token": "tok-renewed", "refresh_token": "refresh-next",
                            "expires_in": 3600 })
                    .to_string(),
                ),
                _ => reply(
                    400,
                    json,
                    r#"{"error":"invalid_grant","error_description":"refresh token revoked"}"#,
                ),
            }
        }
        (Method::GET, "/api/oauth/profile", _) => reply(200, json, "{}"),
        (Method::POST, "/v1/messages", "Bearer tok-ok" | "Bearer tok-renewed") => {
            reply(200, sse, CLAUDE_STREAM)
        }
        // Briefly held back: a 429 that names no spent window.
        (Method::POST, "/v1/messages", "Bearer tok-busy") => reply(
            429,
            json,
            r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#,
        ),
        (Method::POST, "/v1/messages", _) => reply(
            401,
            json,
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid token"}}"#,
        ),
        (Method::POST, "/backend-api/codex/responses", "Bearer tok-ok") => {
            reply(200, sse, CODEX_STREAM)
        }
        // Opens a 200 stream, then says the server is overloaded.
        (Method::POST, "/backend-api/codex/responses", "Bearer tok-overloaded") => reply(
            200,
            sse,
            concat!(
                "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r\"}}\n\n",
                "data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"server_is_overloaded\",\"message\":\"try later\"}}}\n\n",
            ),
        ),
        (Method::POST, "/local/v1/chat/completions", _) => reply(
            200,
            json,
            json!({
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}}],
                "usage": {"prompt_tokens": 4, "completion_tokens": 1}
            })
            .to_string(),
        ),
        _ => reply(404, json, "{}"),
    }
}

struct Harness {
    proxy: String,
    app: Arc<App>,
    log: Log,
    ids: Vec<String>,
    dir: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Harness {
    fn seen(&self, path: &str) -> Vec<Seen> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.path == path)
            .cloned()
            .collect()
    }

    fn stored(&self, id: &str) -> Account {
        self.app.store.get(id).unwrap().unwrap()
    }
}

/// An OAuth account: tried in order of `added`.
fn oauth(provider: ProviderId, name: &str, token: &str, refresh: &str, added: i64) -> Account {
    let mut account = Account::new(
        provider,
        Tokens {
            access_token: token.into(),
            refresh_token: Some(refresh.into()),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(format!("{name}@example.com"));
    account.account_id = Some(format!("acct-{name}"));
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

fn endpoint(base: &str, added: i64) -> Account {
    let mut account = Account::new(
        ProviderId::Compat,
        Tokens {
            access_token: "key-local".into(),
            ..Tokens::default()
        },
    );
    account.endpoint = Some(Endpoint {
        base_url: base.into(),
        dialect: Dialect::Chat,
        models: vec!["local-model".into()],
    });
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

async fn harness(build: impl FnOnce(&str) -> Vec<Account>, refresh_tokens: bool) -> Harness {
    let dir = std::env::temp_dir().join(format!("slopmax-failover-{}", slopmax_core::ids::token()));
    let log: Log = Arc::default();
    let upstream = serve({
        let log = log.clone();
        move |request| mock(log.clone(), request)
    })
    .await;
    let store = Store::at(dir.join("accounts"));
    let mut ids = Vec::new();
    for account in build(&upstream) {
        let (saved, _) = store.upsert(account).unwrap();
        ids.push(saved.id);
    }
    let config = Config {
        api_key: KEY.into(),
        strategy: Strategy::FillFirst,
        refresh_tokens,
        ..Config::default()
    };
    let origins = Origins::new([
        ("https://api.anthropic.com", upstream.as_str()),
        ("https://platform.claude.com", upstream.as_str()),
        ("https://chatgpt.com", upstream.as_str()),
    ]);
    let app = App::new(config, Home::at(&dir), PoolState::default(), origins);
    app.pool.sync(app.store.list().unwrap());
    let proxy = serve({
        let app = app.clone();
        move |request| proxy::handle(app.clone(), request)
    })
    .await;
    Harness {
        proxy,
        app,
        log,
        ids,
        dir,
    }
}

const CLAUDE_BODY: &str = r#"{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}"#;

async fn claude(h: &Harness, path: &str, user_agent: &str) -> (StatusCode, String) {
    let response = Client::builder()
        .build()
        .post(format!("{}{path}", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", user_agent)
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.text().await.unwrap())
}

async fn claude_code(h: &Harness) -> (StatusCode, String) {
    claude(h, "/v1/messages", "claude-cli/2.1.287 (external, cli)").await
}

async fn post(h: &Harness, path: &str, body: &str) -> (StatusCode, String) {
    let response = Client::builder()
        .build()
        .post(format!("{}{path}", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("content-type", "application/json")
        .body(body.to_owned())
        .send()
        .await
        .unwrap();
    let status = response.status();
    (status, response.text().await.unwrap())
}

#[tokio::test]
async fn a_rejected_token_is_refreshed_and_the_request_retried() {
    let h = harness(
        |_| {
            vec![oauth(
                ProviderId::Claude,
                "a",
                "tok-stale",
                "refresh-good",
                1000,
            )]
        },
        true,
    )
    .await;
    let (status, body) = claude_code(&h).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("message_start"));

    let tried: Vec<String> = h
        .seen("/v1/messages")
        .into_iter()
        .map(|s| s.authorization)
        .collect();
    assert_eq!(tried, ["Bearer tok-stale", "Bearer tok-renewed"]);
    let refresh = h.seen("/v1/oauth/token");
    assert_eq!(refresh.len(), 1);
    let sent: Value = serde_json::from_slice(&refresh[0].body).unwrap();
    assert_eq!(sent["grant_type"], "refresh_token");

    // The rotated tokens are saved for next time.
    let saved = h.stored(&h.ids[0]);
    assert_eq!(saved.tokens.access_token, "tok-renewed");
    assert_eq!(saved.tokens.refresh_token.as_deref(), Some("refresh-next"));
    assert!(saved.auth_error.is_none());
}

#[tokio::test]
async fn a_refused_refresh_moves_on_to_the_next_account() {
    let h = harness(
        |_| {
            vec![
                oauth(
                    ProviderId::Claude,
                    "a",
                    "tok-stale",
                    "refresh-revoked",
                    1000,
                ),
                oauth(ProviderId::Claude, "b", "tok-ok", "refresh-b", 1001),
            ]
        },
        true,
    )
    .await;
    let (status, body) = claude_code(&h).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tried: Vec<String> = h
        .seen("/v1/messages")
        .into_iter()
        .map(|s| s.authorization)
        .collect();
    assert_eq!(tried, ["Bearer tok-stale", "Bearer tok-ok"]);
    // The first account is marked as needing a new login, and benched.
    let first = h.stored(&h.ids[0]);
    assert!(first.auth_error.is_some(), "{first:?}");
    let state = h.app.pool.state(&h.ids[0]);
    assert!(state.last_error.is_some());

    // A request placed afresh (its session would keep it on the second
    // anyway) skips the first without trying it or refreshing it again,
    // even before the pool reloads the accounts from disk.
    h.log.lock().unwrap().clear();
    let response = Client::builder()
        .build()
        .post(format!("{}/v1/messages", h.proxy))
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("x-slopmax-affinity", "off")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    let status = response.status();
    assert!(h.seen("/v1/oauth/token").is_empty(), "no second refresh");
    assert_eq!(status, StatusCode::OK);
    let tried: Vec<String> = h
        .seen("/v1/messages")
        .into_iter()
        .map(|s| s.authorization)
        .collect();
    assert_eq!(tried, ["Bearer tok-ok"]);
}

#[tokio::test]
async fn without_refreshing_a_rejected_token_benches_the_account() {
    let h = harness(
        |_| {
            vec![
                oauth(ProviderId::Claude, "a", "tok-stale", "refresh-good", 1000),
                oauth(ProviderId::Claude, "b", "tok-ok", "refresh-b", 1001),
            ]
        },
        false,
    )
    .await;
    let (status, _) = claude_code(&h).await;
    assert_eq!(status, StatusCode::OK);
    assert!(h.seen("/v1/oauth/token").is_empty());
    assert!(h.app.pool.state(&h.ids[0]).is_blocked(Timestamp::now()));
}

#[tokio::test]
async fn a_throttled_account_is_set_aside_briefly_not_blocked() {
    let h = harness(
        |_| {
            vec![
                oauth(ProviderId::Claude, "a", "tok-busy", "refresh-a", 1000),
                oauth(ProviderId::Claude, "b", "tok-ok", "refresh-b", 1001),
            ]
        },
        false,
    )
    .await;
    let (status, _) = claude_code(&h).await;
    assert_eq!(status, StatusCode::OK);
    let now = Timestamp::now();
    let busy = h.app.pool.state(&h.ids[0]);
    assert!(busy.throttled_until.is_some_and(|until| until > now));
    assert!(!busy.is_blocked(now));
}

#[tokio::test]
async fn only_throttled_accounts_pass_the_refusal_back() {
    let h = harness(
        |_| {
            vec![oauth(
                ProviderId::Claude,
                "a",
                "tok-busy",
                "refresh-a",
                1000,
            )]
        },
        false,
    )
    .await;
    let (status, body) = claude_code(&h).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(
        body.contains("rate_limit_error") || body.contains("slow down"),
        "{body}"
    );
}

#[tokio::test]
async fn an_unreachable_endpoint_fails_over_and_records_why() {
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}/v1", listener.local_addr().unwrap())
    };
    let h = harness(
        |upstream| {
            vec![
                endpoint(&closed, 1000),
                endpoint(&format!("{upstream}/local/v1"), 1001),
            ]
        },
        false,
    )
    .await;
    let (status, body) = post(
        &h,
        "/v1/chat/completions",
        r#"{"model":"local-model","messages":[{"role":"user","content":"hi"}]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("chat.completion"));
    let down = h.app.pool.state(&h.ids[0]);
    assert!(
        down.last_error
            .as_deref()
            .is_some_and(|e| e.starts_with("network error")),
        "{down:?}"
    );
}

#[tokio::test]
async fn codex_streams_that_open_overloaded_move_on_without_benching() {
    let h = harness(
        |_| {
            vec![
                oauth(ProviderId::Codex, "a", "tok-overloaded", "refresh-a", 1000),
                oauth(ProviderId::Codex, "b", "tok-ok", "refresh-b", 1001),
            ]
        },
        false,
    )
    .await;
    let (status, body) = post(
        &h,
        "/codex/responses",
        r#"{"model":"gpt-6-sol","input":[],"stream":true}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("response.completed"), "{body}");
    assert!(!body.contains("server_is_overloaded"));
    let now = Timestamp::now();
    let first = h.app.pool.state(&h.ids[0]);
    assert!(first.throttled_until.is_some_and(|until| until > now));
    assert!(!first.is_blocked(now));
}

#[tokio::test]
async fn requests_without_a_model_are_turned_away() {
    let h = harness(
        |upstream| vec![endpoint(&format!("{upstream}/local/v1"), 1000)],
        false,
    )
    .await;
    let (status, body) = post(&h, "/v1/chat/completions", r#"{"messages":[]}"#).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body.contains("the request names no model"), "{body}");
    assert!(h.seen("/local/v1/chat/completions").is_empty());
}

#[tokio::test]
async fn claude_paths_refuse_other_clients_before_routing() {
    let h = harness(
        |_| vec![oauth(ProviderId::Claude, "a", "tok-ok", "refresh-a", 1000)],
        false,
    )
    .await;
    // A path routed by where it goes rather than by model.
    let (status, body) = claude(&h, "/claude/v1/messages/count_tokens", "curl/8.7.1").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.contains("to Claude Code only"), "{body}");
    assert!(body.contains("this request came from curl/8.7.1"), "{body}");
    assert!(h.seen("/v1/messages/count_tokens").is_empty());
}

#[tokio::test]
async fn a_sign_in_another_process_found_revoked_is_neither_refreshed_nor_tried() {
    let h = harness(
        |_| {
            let mut due = oauth(ProviderId::Claude, "a", "tok-due", "refresh-good", 1000);
            due.tokens.expires_at = Some(Timestamp::now() + SignedDuration::from_secs(30));
            vec![
                due,
                oauth(ProviderId::Claude, "b", "tok-ok", "refresh-b", 1001),
            ]
        },
        true,
    )
    .await;
    // Another process's refresh was refused, and it marked the stored copy;
    // this proxy was not told and holds the account as it was.
    h.app
        .store
        .update(&h.ids[0], |a| {
            a.auth_error = Some("refresh token revoked".into())
        })
        .unwrap();
    let (status, body) = claude_code(&h).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(h.seen("/v1/oauth/token").is_empty(), "no refresh was sent");
    let tried: Vec<String> = h
        .seen("/v1/messages")
        .into_iter()
        .map(|s| s.authorization)
        .collect();
    assert_eq!(tried, ["Bearer tok-ok"]);
    assert!(h.app.pool.account(&h.ids[0]).unwrap().auth_error.is_some());
}
