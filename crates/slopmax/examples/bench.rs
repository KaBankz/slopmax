//! A load-test rig: a mock provider, the real proxy in front of it with
//! throwaway accounts, and the request bodies to send, so a load generator
//! can measure what slopmax adds.
//!
//! ```sh
//! cargo run --release --example bench -- upstream 127.0.0.1:9100
//! cargo run --release --example bench -- proxy 127.0.0.1:9101 http://127.0.0.1:9100 /tmp/home
//! cargo run --release --example bench -- bodies /tmp/bodies
//! ```
//!
//! `mise run bench` runs them and drives the proxy with `oha`.

use std::net::SocketAddr;
use std::path::Path;

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use http::{HeaderValue, Method, StatusCode};
use serde_json::{Map, Value, json};
use slopmax_core::account::{Account, Store, Tokens};
use slopmax_core::config::Config;
use slopmax_core::net::Origins;
use slopmax_core::net::body;
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::{SignedDuration, Timestamp};
use tokio::net::TcpListener;

// As in the binary: `--features mimalloc` measures that allocator.
#[cfg(feature = "mimalloc")]
#[global_allocator]
static ALLOC: mimalloc::MiMalloc = mimalloc::MiMalloc;

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
        ["bodies", dir] => bodies(Path::new(dir)),
        _ => bail!(
            "usage: bench upstream <addr> | bench proxy <addr> <upstream-url> <home> | bench bodies <dir>"
        ),
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
    slopmax_core::daemon::serve(config, home, origins).await
}

/// Writes the request bodies to send: a first turn, and a long conversation
/// of about 300 KB, for each agent.
fn bodies(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let write = |name: &str, body: Value| -> Result<()> {
        std::fs::write(dir.join(format!("{name}.json")), body.to_string())?;
        Ok(())
    };
    let mut words = Words(7);

    let user_id = json!({ "device_id": "d".repeat(64), "account_uuid": "", "session_id": "bench" });
    let tools: Vec<Value> = (0..25)
        .map(|i| {
            let properties: Map<String, Value> = (0..6)
                .map(|j| {
                    (
                        format!("p{j}"),
                        json!({ "type": "string", "description": words.text(15) }),
                    )
                })
                .collect();
            json!({
                "name": format!("Tool{i}"),
                "description": words.text(120),
                "input_schema": { "type": "object", "properties": properties },
            })
        })
        .collect();
    let mut turns = Vec::new();
    for i in 0..60 {
        turns.push(json!({ "role": "user", "content": [
            { "type": "tool_result", "tool_use_id": format!("t{i}"), "content": words.text(500) },
        ] }));
        turns.push(json!({ "role": "assistant", "content": [
            { "type": "thinking", "thinking": words.text(60), "signature": "S".repeat(400) },
            { "type": "tool_use", "id": format!("t{}", i + 1), "name": "Tool3", "input": { "p0": words.text(40) } },
        ] }));
    }
    turns.push(json!({ "role": "user", "content": "continue" }));
    let system = format!("You are Claude Code. {}", words.text(2500));
    let claude = |messages: Value, tools: Value| {
        json!({
            "model": "claude-opus-5-5",
            "max_tokens": 32000,
            "stream": true,
            "thinking": { "type": "adaptive" },
            "metadata": { "user_id": user_id.to_string() },
            "system": [{ "type": "text", "text": system }],
            "tools": tools,
            "messages": messages,
        })
    };
    write(
        "claude-small",
        claude(json!([{ "role": "user", "content": "hi" }]), json!([])),
    )?;
    write(
        "claude-large",
        claude(Value::from(turns), Value::from(tools)),
    )?;

    let mut items = Vec::new();
    for i in 0..60 {
        let command = json!({ "command": ["bash", "-lc", words.text(30)] }).to_string();
        items.extend([
            json!({ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": words.text(200) }] }),
            json!({ "type": "reasoning", "summary": [], "encrypted_content": "E".repeat(600) }),
            json!({ "type": "function_call", "name": "shell", "arguments": command, "call_id": format!("c{i}") }),
            json!({ "type": "function_call_output", "call_id": format!("c{i}"), "output": words.text(500) }),
        ]);
    }
    let instructions = format!("You are Codex. {}", words.text(1500));
    let codex = |input: Value| {
        json!({
            "model": "gpt-6-sol",
            "instructions": instructions,
            "input": input,
            "tools": [],
            "store": false,
            "stream": true,
            "prompt_cache_key": "bench",
        })
    };
    let hi = json!([{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "hi" }] }]);
    write("codex-small", codex(hi))?;
    write("codex-large", codex(Value::from(items)))?;
    Ok(())
}

/// Filler text from a fixed seed, so every run sends the same bodies.
struct Words(u64);

impl Words {
    fn text(&mut self, count: usize) -> String {
        const WORDS: [&str; 16] = [
            "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "file", "path",
            "function", "return", "value", "error", "test", "build",
        ];
        let mut out = Vec::with_capacity(count);
        for _ in 0..count {
            // xorshift64
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            out.push(WORDS[(self.0 % WORDS.len() as u64) as usize]);
        }
        out.join(" ")
    }
}
