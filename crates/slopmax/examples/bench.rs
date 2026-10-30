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
use std::sync::{Mutex, OnceLock};

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
/// rate-limit headers slopmax reads; and both providers' limit resets.
async fn answer(request: Request) -> Response {
    let (parts, incoming) = request.into_parts();
    let sent = body::read(incoming, usize::MAX).await.unwrap_or_default();
    let token = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim_start_matches("Bearer ");
    let agent = parts
        .headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match (&parts.method, parts.uri.path()) {
        (&Method::GET, "/wham/rate-limit-reset-credits") => return credit_list(token),
        (&Method::POST, "/wham/rate-limit-reset-credits/consume") => return consume(&sent),
        (&Method::GET, "/api/oauth/usage") => return claude_resets(token, agent),
        (&Method::POST, path) if path.ends_with("/reset_rate_limits") => {
            return claim(token, &sent);
        }
        _ => {}
    }
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

/// The reset credits redeemed so far.
static REDEEMED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Each ChatGPT account's unspent reset credits: two, granted weeks apart,
/// the first account's soon to expire. Dated from when the mock started,
/// so they stay put.
fn credit_list(token: &str) -> Response {
    static STARTED: OnceLock<Timestamp> = OnceLock::new();
    let started = *STARTED.get_or_init(Timestamp::now);
    let at = |hours: i64| (started + SignedDuration::from_hours(hours)).to_string();
    // Granted, then expiring, in hours from the start.
    let dates: &[(i64, i64)] = match token {
        "bench-codex-0" => &[(-27 * 24 - 5, 19), (-6 * 24, 24 * 24)],
        "bench-codex-1" => &[(-12 * 24, 18 * 24), (-30, 29 * 24 - 6)],
        _ => &[],
    };
    let redeemed = REDEEMED.lock().unwrap_or_else(|p| p.into_inner());
    let credits: Vec<Value> = dates
        .iter()
        .enumerate()
        .map(|(i, (granted, expires))| (format!("{token}-credit-{i}"), granted, expires))
        .filter(|(id, _, _)| !redeemed.contains(id))
        .map(|(id, granted, expires)| {
            json!({
                "id": id, "status": "available", "reset_type": "codex_rate_limits",
                "title": "Rate limit reset", "granted_at": at(*granted), "expires_at": at(*expires),
            })
        })
        .collect();
    let list = json!({ "available_count": credits.len(), "credits": credits });
    json_response(&list)
}

/// Redeems the credit asked for, once.
fn consume(sent: &[u8]) -> Response {
    let asked: Value = serde_json::from_slice(sent).unwrap_or_default();
    let id = asked["credit_id"].as_str().unwrap_or_default().to_owned();
    let mut redeemed = REDEEMED.lock().unwrap_or_else(|p| p.into_inner());
    let code = if redeemed.contains(&id) {
        "already_redeemed"
    } else {
        redeemed.push(id);
        "reset"
    };
    json_response(&json!({ "code": code, "windows_reset": 2 }))
}

/// Claude's usage, with only its limit resets, so the demo's windows stay
/// as seeded: the first account holds a model launch's reset, the second
/// none. Claude lists them to Claude Code alone.
fn claude_resets(token: &str, agent: &str) -> Response {
    static STARTED: OnceLock<Timestamp> = OnceLock::new();
    let started = *STARTED.get_or_init(Timestamp::now);
    let at = |hours: i64| (started + SignedDuration::from_hours(hours)).to_string();
    if !agent.starts_with("claude-cli/") {
        let refused = json!({ "eligible": false, "ineligible_reason": "surface", "grants": [] });
        return json_response(&json!({ "cedar_ember": refused }));
    }
    let redeemed = REDEEMED.lock().unwrap_or_else(|p| p.into_inner());
    let grants: Vec<Value> = match token {
        "bench-claude-0" if !redeemed.contains(&format!("{token}/{LAUNCH}")) => vec![json!({
            "id": LAUNCH, "label": "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
            "resets_total": 1, "resets_left": 1,
            "starts_at": at(-15 * 24 - 5), "ends_at": at(15 * 24 - 5),
            "clears": ["five_hour", "seven_day", "seven_day_overage_included"],
            "paused": false, "usable_now": true, "use_requires_limit": false,
        })],
        _ => Vec::new(),
    };
    let next = grants.first().map(|_| LAUNCH);
    let status = json!({ "eligible": true, "grants": grants, "next_grant_id": next });
    json_response(&json!({ "cedar_ember": status }))
}

/// The reset grant every Pro and Max account got at a model's launch.
const LAUNCH: &str = "opus55-launch-promax-20260921";

/// Spends the account's reset of the grant asked for, once.
fn claim(token: &str, sent: &[u8]) -> Response {
    let asked: Value = serde_json::from_slice(sent).unwrap_or_default();
    let grant = asked["grant_id"].as_str().unwrap_or_default();
    let key = format!("{token}/{grant}");
    let mut redeemed = REDEEMED.lock().unwrap_or_else(|p| p.into_inner());
    let answer = if token != "bench-claude-0" || grant != LAUNCH {
        json!({ "result": "ineligible", "reason": "unknown_grant" })
    } else if redeemed.contains(&key) {
        json!({ "result": "already_used", "reason": "already_used", "resets_left": 0 })
    } else {
        redeemed.push(key);
        json!({ "result": "reset", "resets_left": 0, "cleared": ["five_hour", "seven_day"] })
    };
    json_response(&answer)
}

fn json_response(value: &Value) -> Response {
    let mut response = Response::new(body::full(value.to_string()));
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static("application/json"));
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
            // A UUID, as Claude's organizations have: spending a limit
            // reset names it.
            let org = 100 * provider as usize + i;
            account.org_id = Some(format!("00000000-0000-4000-8000-{org:012}"));
            account.account_id = Some(format!("acct-{provider}-{i}"));
            // Plans, for what unused quota is worth.
            let plans = match provider {
                ProviderId::Claude => ["max 20x", "max 5x"],
                _ => ["pro", "plus"],
            };
            account.plan = Some(plans[i].into());
            account.assign_id();
            store.upsert(account).context("saving a bench account")?;
        }
    }
    // The home's own settings, but for what keeps the rig to itself.
    let config = Config {
        listen,
        api_key: "bench".into(),
        refresh_tokens: false,
        poll_mins: 0,
        ..Config::load_from(&home.config()).unwrap_or_default()
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
