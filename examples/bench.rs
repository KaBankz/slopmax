//! A load-test rig: a mock provider, and the real proxy in front of it with
//! throwaway accounts, so a load generator can measure what slopmax adds.
//!
//! ```sh
//! cargo run --release --example bench -- upstream 127.0.0.1:9100
//! cargo run --release --example bench -- proxy 127.0.0.1:9101 http://127.0.0.1:9100 /tmp/home
//! ```
//!
//! `scripts/bench.sh` runs both and drives them with `oha`.

use std::net::SocketAddr;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode};
use slopmax::account::{Account, Store, Tokens};
use slopmax::config::Config;
use slopmax::net::Origins;
use slopmax::net::body;
use slopmax::net::server::{self, Request, Response};
use slopmax::paths::Home;
use slopmax::provider::ProviderId;
use slopmax::time::{SignedDuration, Timestamp};
use tokio::net::TcpListener;

/// Text deltas per streamed answer.
const DELTAS: usize = 60;
const DELTA: &str = "The quick brown fox jumps over the lazy dog, then naps for a while. ";

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["upstream", listen] => runtime.block_on(upstream(listen.parse()?)),
        ["proxy", listen, upstream, home] => {
            runtime.block_on(proxy(listen.parse()?, upstream, home))
        }
        _ => bail!("usage: bench upstream <addr> | bench proxy <addr> <upstream-url> <home>"),
    }
}

async fn upstream(listen: SocketAddr) -> Result<()> {
    let listener = TcpListener::bind(listen).await?;
    eprintln!("mock provider on http://{listen}");
    server::serve(listener, answer, std::future::pending()).await;
    Ok(())
}

/// Answers like the providers do: a streamed reply with usage, and the
/// rate-limit headers slopmax reads.
async fn answer(request: Request) -> Response {
    let (parts, incoming) = request.into_parts();
    let _ = body::read(incoming, usize::MAX).await;
    let reset = (Timestamp::now() + SignedDuration::from_hours(3)).as_second();
    let (events, headers): (Vec<String>, Vec<(&str, String)>) =
        match (parts.method, parts.uri.path()) {
            (Method::POST, "/v1/messages") => (
                messages_events(),
                vec![
                    ("anthropic-ratelimit-unified-status", "allowed".into()),
                    ("anthropic-ratelimit-unified-5h-utilization", "0.21".into()),
                    ("anthropic-ratelimit-unified-5h-reset", reset.to_string()),
                    ("anthropic-ratelimit-unified-7d-utilization", "0.43".into()),
                    (
                        "anthropic-ratelimit-unified-7d-reset",
                        (reset + 86_400).to_string(),
                    ),
                    ("request-id", "req_bench".into()),
                ],
            ),
            (Method::POST, "/codex/responses") => (
                responses_events(),
                vec![
                    ("x-codex-primary-used-percent", "21.0".into()),
                    ("x-codex-primary-window-minutes", "300".into()),
                    ("x-codex-primary-reset-at", reset.to_string()),
                    ("x-codex-secondary-used-percent", "43.0".into()),
                    ("x-codex-secondary-window-minutes", "10080".into()),
                    ("x-codex-secondary-reset-at", (reset + 86_400).to_string()),
                ],
            ),
            _ => {
                let mut response = Response::new(body::empty());
                *response.status_mut() = StatusCode::NOT_FOUND;
                return response;
            }
        };
    let frames: Vec<Bytes> = events.into_iter().map(Bytes::from).collect();
    let mut response = Response::new(body::boxed(body::Prefixed::new(frames, body::empty())));
    let map = response.headers_mut();
    map.insert(
        "content-type",
        HeaderValue::from_static("text/event-stream"),
    );
    for (name, value) in headers {
        map.insert(name, HeaderValue::from_str(&value).expect("ascii"));
    }
    response
}

fn event(kind: &str, data: &str) -> String {
    format!("event: {kind}\ndata: {data}\n\n")
}

fn messages_events() -> Vec<String> {
    let mut events = vec![
        event(
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_bench","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],"stop_reason":null,"usage":{"input_tokens":1200,"cache_read_input_tokens":48000,"cache_creation_input_tokens":900,"output_tokens":1}}}"#,
        ),
        event(
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
    ];
    let delta = format!(
        r#"{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{DELTA}"}}}}"#
    );
    events.extend((0..DELTAS).map(|_| event("content_block_delta", &delta)));
    events.push(event(
        "content_block_stop",
        r#"{"type":"content_block_stop","index":0}"#,
    ));
    events.push(event(
        "message_delta",
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":620}}"#,
    ));
    events.push(event("message_stop", r#"{"type":"message_stop"}"#));
    events
}

fn responses_events() -> Vec<String> {
    let mut events = vec![event(
        "response.created",
        r#"{"type":"response.created","response":{"id":"resp_bench","status":"in_progress","model":"gpt-6-sol"}}"#,
    )];
    let delta = format!(
        r#"{{"type":"response.output_text.delta","item_id":"msg_bench","output_index":0,"content_index":0,"delta":"{DELTA}"}}"#
    );
    events.extend((0..DELTAS).map(|_| event("response.output_text.delta", &delta)));
    events.push(event(
        "response.completed",
        r#"{"type":"response.completed","response":{"id":"resp_bench","status":"completed","model":"gpt-6-sol","usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":1000},"output_tokens":620,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":1820}}}"#,
    ));
    events
}

/// The production server, with two Claude and two ChatGPT accounts whose
/// traffic goes to `upstream`.
async fn proxy(listen: SocketAddr, upstream: &str, home: &str) -> Result<()> {
    let home = Home::at(home);
    let store = Store::at(home.accounts());
    for provider in [ProviderId::Claude, ProviderId::Codex] {
        for i in 0..2 {
            let mut account = Account::new(
                provider,
                Tokens {
                    access_token: format!("bench-{provider}-{i}"),
                    refresh_token: Some(format!("bench-refresh-{provider}-{i}")),
                    expires_at: Some(Timestamp::now() + SignedDuration::from_hours(24 * 30)),
                    ..Tokens::default()
                },
            );
            account.email = Some(format!("{provider}{i}@bench.invalid"));
            account.org_id = Some(format!("org-{provider}-{i}"));
            account.account_id = Some(format!("acct-{provider}-{i}"));
            account.assign_id();
            store.upsert(account).context("saving a bench account")?;
        }
    }
    let config = Config {
        listen,
        api_key: "bench".into(),
        refresh_tokens: false,
        poll_mins: 0,
        redeem_expiring_credits: false,
        ..Config::default()
    };
    let origins = Origins::new([
        ("https://api.anthropic.com", upstream),
        ("https://chatgpt.com/backend-api", upstream),
    ]);
    slopmax::daemon::serve(config, home, origins).await
}
