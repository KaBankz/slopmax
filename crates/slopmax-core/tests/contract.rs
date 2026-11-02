//! The API's contract: every endpoint's answers, successes and errors, as
//! the fixtures in `contract/fixtures/` hold them. The TypeScript client
//! (`ts/packages/domain/test/rust-contract.test.ts`) and the Swift app
//! decode the same fixtures strictly, so a field added, renamed or dropped
//! here fails there.
//!
//! `SLOPMAX_BLESS=1 cargo test --test contract` rewrites the fixtures;
//! otherwise each answer must match its fixture, times and secrets aside.
//!
//! Left out, as they would reach real things: importing (reads Claude
//! Code's and Codex's logins), starting a sign-in (opens a browser and a
//! callback port), adding a key (checks it with the provider), doctor (the
//! network), and wiring agents (their settings files). `contract/zero/`
//! holds those as the TypeScript daemon answers them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use http::StatusCode;
use http_body_util::BodyExt;
use serde_json::Value;
use slopmax_core::account::{Account, Endpoint, Store, Tokens};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::ledger::Entry;
use slopmax_core::limits::{Limits, Window};
use slopmax_core::net::server;
use slopmax_core::net::{Client, Origins};
use slopmax_core::paths::Home;
use slopmax_core::pool::State as PoolState;
use slopmax_core::provider::ProviderId;
use slopmax_core::provider::credits::Credit;
use slopmax_core::proxy::{self, App};
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_core::wire::Dialect;
use tokio::net::TcpListener;

const KEY: &str = "sm-contract-owner";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contract/fixtures")
}

struct TempHome {
    dir: PathBuf,
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn account(provider: ProviderId, email: &str, added: i64) -> Account {
    let mut account = Account::new(
        provider,
        Tokens {
            access_token: format!("tok-{email}"),
            refresh_token: Some(format!("refresh-{email}")),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(8)),
            ..Tokens::default()
        },
    );
    account.email = Some(email.into());
    account.org_id = Some(format!("org-{email}"));
    account.account_id = Some(format!("acct-{email}"));
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

/// A home with every kind of account in some state worth showing, and the
/// proxy serving it.
async fn start() -> (Arc<App>, String, Vec<String>, TempHome) {
    let dir = std::env::temp_dir().join(format!("slopmax-contract-{}", slopmax_core::ids::token()));
    let store = Store::at(dir.join("accounts"));
    let mut claude = account(ProviderId::Claude, "claude@example.com", 1000);
    claude.plan = Some("max 20x".into());
    let mut spare = account(ProviderId::Claude, "spare@example.com", 1001);
    spare.plan = Some("max 5x".into());
    spare.priority = 2;
    spare.label = Some("Spare".into());
    let mut codex = account(ProviderId::Codex, "codex@example.com", 1002);
    codex.plan = Some("pro".into());
    let mut key = Account::new(
        ProviderId::Anthropic,
        Tokens {
            access_token: "sk-ant-contract".into(),
            ..Tokens::default()
        },
    );
    key.assign_id();
    let mut endpoint = Account::new(
        ProviderId::Compat,
        Tokens {
            access_token: "local".into(),
            ..Tokens::default()
        },
    );
    endpoint.endpoint = Some(Endpoint {
        base_url: "http://127.0.0.1:11434/v1".into(),
        dialect: Dialect::Chat,
        models: vec!["llama-*".into()],
    });
    endpoint.label = Some("Local".into());
    endpoint.assign_id();
    let mut ids = Vec::new();
    for account in [claude, spare, codex, key, endpoint] {
        ids.push(store.upsert(account).unwrap().0.id);
    }
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("config.toml"),
        format!(
            "api_key = \"{KEY}\"\nstrategy = \"reset-first\"\nrefresh_tokens = false\npoll_mins = 0\n\n\
             [[keys]]\nname = \"laptop\"\nkey = \"sm-laptop\"\nmodels = [\"claude-*\"]\n"
        ),
    )
    .unwrap();
    let config = Config::load_from(&dir.join("config.toml")).unwrap();
    assert_eq!(config.strategy, Strategy::ResetFirst);
    let app = App::new(
        config,
        Home::at(&dir),
        PoolState::default(),
        Origins::new([]),
    );
    app.sync().unwrap();
    let now = Timestamp::now();
    let window = |span: &str, model: Option<&str>, used: f64, hours: i64| Window {
        span: span.into(),
        model: model.map(str::to_owned),
        used,
        resets_at: Some(now + SignedDuration::from_hours(hours)),
    };
    let limits = |windows| Limits {
        windows,
        observed_at: Some(now),
        ..Limits::default()
    };
    app.pool.observe(
        &ids[0],
        limits(vec![
            window("5h", None, 82.0, 2),
            window("7d", None, 47.0, 72),
            window("7d", Some("Fable"), 64.0, 72),
        ]),
        now,
    );
    app.pool.observe(
        &ids[1],
        limits(vec![
            window("5h", None, 12.0, 4),
            window("7d", None, 30.0, 120),
        ]),
        now,
    );
    app.pool.observe(
        &ids[2],
        limits(vec![
            window("5h", None, 100.0, 1),
            window("7d", None, 64.0, 48),
        ]),
        now,
    );
    app.pool.record_credits(
        &ids[2],
        vec![Credit {
            id: "credit-1".into(),
            title: Some("Rate limit reset".into()),
            granted_at: Some(now - SignedDuration::from_hours(24 * 6)),
            expires_at: Some(now + SignedDuration::from_hours(10)),
        }],
        now,
    );
    for (i, (account, model)) in [
        (&ids[0], "claude-opus-5-5"),
        (&ids[2], "gpt-6-sol"),
        (&ids[0], "claude-fable-5-1"),
    ]
    .into_iter()
    .enumerate()
    {
        app.record(&Entry {
            at: now - SignedDuration::from_mins(30 * i as i64),
            account: account.clone(),
            provider: if model.starts_with("gpt") {
                ProviderId::Codex
            } else {
                ProviderId::Claude
            },
            model: Some(model.into()),
            status: 200,
            input: 1200,
            output: 640,
            cache_read: 48_000,
            cache_write: 900,
            ms: 4200,
            first_byte_ms: Some(900),
            attempts: 1,
            agent: Some("claude".into()),
            session: Some("session-1".into()),
            end: None,
        });
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/slopmax/api", listener.local_addr().unwrap());
    let handler = {
        let app = app.clone();
        move |request| proxy::handle(app.clone(), request)
    };
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    (app, base, ids, TempHome { dir })
}

/// Every string that reads as a time becomes one time, every secret one
/// secret, and the home one path, so fixtures hold still between runs.
fn steady(value: &mut Value, home: &str) {
    match value {
        Value::String(text) => {
            if text.parse::<Timestamp>().is_ok() {
                *text = "2026-11-01T12:00:00Z".into();
            } else if text.starts_with("sm-") && text.len() > 20 {
                *text = "sm-<secret>".into();
            } else if text.contains(home) {
                *text = text.replace(home, "<home>");
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| steady(v, home)),
        Value::Object(fields) => {
            for (name, value) in fields.iter_mut() {
                match name.as_str() {
                    // The program and the release: true of any build.
                    "exe" => *value = "<exe>".into(),
                    "version" if value.is_string() => *value = "<version>".into(),
                    _ => steady(value, home),
                }
            }
        }
        _ => {}
    }
}

/// Checks (or, blessing, writes) one fixture.
fn fixture(name: &str, status: StatusCode, mut body: Value, home: &Path) {
    steady(&mut body, &home.display().to_string());
    let path = fixtures().join(format!("{name}.json"));
    let written = serde_json::to_string_pretty(
        &serde_json::json!({ "status": status.as_u16(), "body": body }),
    )
    .unwrap()
        + "\n";
    if std::env::var_os("SLOPMAX_BLESS").is_some() {
        std::fs::create_dir_all(fixtures()).unwrap();
        std::fs::write(&path, written).unwrap();
        return;
    }
    let held = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{name}: no fixture; run with SLOPMAX_BLESS=1 to write it"));
    let held: Value = serde_json::from_str(&held).unwrap();
    let now: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(
        now, held,
        "{name} changed; if on purpose, run with SLOPMAX_BLESS=1"
    );
}

struct Call<'a> {
    client: Client,
    base: &'a str,
    home: &'a Path,
}

impl Call<'_> {
    async fn send(
        &self,
        name: &str,
        method: http::Method,
        path: &str,
        body: Option<&str>,
        expect: StatusCode,
    ) -> Value {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .header("authorization", format!("Bearer {KEY}"));
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_owned());
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, expect, "{name}: {text}");
        let body: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text).unwrap()
        };
        fixture(name, status, body.clone(), self.home);
        body
    }
}

#[tokio::test]
async fn every_endpoint_answers_as_its_fixture_says() {
    use http::Method;
    let (app, base, ids, home) = start().await;
    let call = Call {
        client: Client::builder().build(),
        base: &base,
        home: &home.dir,
    };
    let (claude, spare, codex, key, endpoint) = (&ids[0], &ids[1], &ids[2], &ids[3], &ids[4]);

    // System.
    let report = call
        .send(
            "system.status.ok",
            Method::GET,
            "/status",
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(report["accounts"].as_array().unwrap().len(), 5);
    assert_eq!(report["pools"][0]["provider"], "claude");
    call.send(
        "system.sync.ok",
        Method::POST,
        "/sync",
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "system.unknown.notFound",
        Method::GET,
        "/nothing",
        None,
        StatusCode::NOT_FOUND,
    )
    .await;
    let unauthorized = Client::builder()
        .build()
        .get(format!("{base}/status"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
    fixture(
        "system.status.unauthorized",
        StatusCode::UNAUTHORIZED,
        unauthorized.json().await.unwrap(),
        &home.dir,
    );

    // Accounts.
    call.send(
        "accounts.update.ok",
        Method::PATCH,
        &format!("/accounts/{claude}"),
        Some(r#"{"label":"Main","priority":1}"#),
        StatusCode::OK,
    )
    .await;
    call.send(
        "accounts.update.notFound",
        Method::PATCH,
        "/accounts/nope",
        Some(r#"{"label":"x"}"#),
        StatusCode::NOT_FOUND,
    )
    .await;
    call.send(
        "accounts.update.badRequest",
        Method::PATCH,
        &format!("/accounts/{claude}"),
        Some(r#"{"nickname":"x"}"#),
        StatusCode::BAD_REQUEST,
    )
    .await;
    call.send(
        "accounts.pin.ok",
        Method::POST,
        &format!("/accounts/{spare}/pin"),
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "accounts.unpinAll.ok",
        Method::DELETE,
        "/pins",
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "accounts.redeem.badRequest",
        Method::POST,
        &format!("/accounts/{key}/redeem"),
        None,
        StatusCode::BAD_REQUEST,
    )
    .await;
    call.send(
        "accounts.add.badRequest",
        Method::POST,
        "/accounts",
        Some(r#"{"_tag":"Key","provider":"claude","key":"x"}"#),
        StatusCode::BAD_REQUEST,
    )
    .await;
    call.send(
        "accounts.own.ok",
        Method::POST,
        &format!("/accounts/{codex}/own"),
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "accounts.remove.ok",
        Method::DELETE,
        &format!("/accounts/{endpoint}"),
        None,
        StatusCode::OK,
    )
    .await;

    // Sign-ins.
    call.send(
        "logins.paste.notFound",
        Method::POST,
        "/logins/nope/paste",
        Some(r#"{"address":"http://localhost/x"}"#),
        StatusCode::NOT_FOUND,
    )
    .await;
    call.send(
        "logins.cancel.notFound",
        Method::DELETE,
        "/logins/nope",
        None,
        StatusCode::NOT_FOUND,
    )
    .await;

    // Config.
    call.send(
        "config.settings.ok",
        Method::GET,
        "/settings",
        None,
        StatusCode::OK,
    )
    .await;
    let changed = call
        .send(
            "config.change.ok",
            Method::PATCH,
            "/settings",
            Some(r#"{"sessionMinutes":45,"websockets":false}"#),
            StatusCode::OK,
        )
        .await;
    assert_eq!(changed["settings"]["sessionMinutes"], 45);
    assert_eq!(app.config().session_ttl_mins, 45);
    assert!(
        std::fs::read_to_string(home.dir.join("config.toml"))
            .unwrap()
            .contains("session_ttl_mins = 45")
    );
    call.send(
        "config.change.badRequest",
        Method::PATCH,
        "/settings",
        Some(r#"{"bogus":1}"#),
        StatusCode::BAD_REQUEST,
    )
    .await;
    call.send("config.keys.ok", Method::GET, "/keys", None, StatusCode::OK)
        .await;
    let made = call
        .send(
            "config.makeKey.ok",
            Method::POST,
            "/keys",
            Some(r#"{"name":"phone","models":["gpt-*"]}"#),
            StatusCode::OK,
        )
        .await;
    assert!(made["key"].as_str().unwrap().starts_with("sm-"));
    call.send(
        "config.makeKey.conflict",
        Method::POST,
        "/keys",
        Some(r#"{"name":"phone"}"#),
        StatusCode::CONFLICT,
    )
    .await;
    call.send(
        "config.removeKey.ok",
        Method::DELETE,
        "/keys/phone",
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "config.removeKey.notFound",
        Method::DELETE,
        "/keys/phone",
        None,
        StatusCode::NOT_FOUND,
    )
    .await;

    // Usage.
    call.send(
        "usage.summary.ok",
        Method::GET,
        "/usage?range=30d&by=model",
        None,
        StatusCode::OK,
    )
    .await;
    call.send(
        "usage.summary.badRequest",
        Method::GET,
        "/usage?range=1y",
        None,
        StatusCode::BAD_REQUEST,
    )
    .await;
    let history = call
        .send(
            "usage.history.ok",
            Method::GET,
            "/history?range=7d",
            None,
            StatusCode::OK,
        )
        .await;
    assert_eq!(history["total"]["requests"], 3);

    // Notifications.
    call.send(
        "notify.test.badRequest",
        Method::POST,
        "/notify/test",
        None,
        StatusCode::BAD_REQUEST,
    )
    .await;

    // Events: hello, the report, then a request as it is answered.
    let response = call
        .client
        .get(format!("{base}/events"))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut stream = response.into_body();
    let mut transcript = String::new();
    let mut seen = 0;
    while seen < 3 {
        let frame = tokio::time::timeout(Duration::from_secs(5), stream.frame())
            .await
            .expect("an event in time")
            .unwrap()
            .unwrap();
        let Ok(chunk) = frame.into_data() else {
            continue;
        };
        transcript.push_str(std::str::from_utf8(&chunk).unwrap());
        seen = transcript.matches("\n\n").count();
        if seen == 2 {
            app.record(&Entry {
                at: Timestamp::now(),
                account: claude.clone(),
                provider: ProviderId::Claude,
                model: Some("claude-opus-5-5".into()),
                status: 200,
                input: 10,
                output: 5,
                cache_read: 0,
                cache_write: 0,
                ms: 800,
                first_byte_ms: Some(300),
                attempts: 1,
                agent: Some("claude".into()),
                session: None,
                end: None,
            });
        }
    }
    let events: Vec<Value> = transcript
        .split("\n\n")
        .filter_map(|e| e.strip_prefix("data: "))
        .map(|data| {
            let mut event: Value = serde_json::from_str(data).unwrap();
            steady(&mut event, &home.dir.display().to_string());
            event
        })
        .collect();
    let tags: Vec<&str> = events.iter().map(|e| e["_tag"].as_str().unwrap()).collect();
    assert_eq!(tags, ["Hello", "Status", "Request"]);
    fixture(
        "events.watch.ok",
        StatusCode::OK,
        Value::Array(events),
        &home.dir,
    );
    app.stop.cancel();
}
