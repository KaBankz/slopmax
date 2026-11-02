//! The daemon as `slopmax serve` runs it, start to stop: what it keeps
//! when it stops, what it refuses to start beside, and how it learns of
//! changes other processes make.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::StatusCode;
use slopmax_core::account::{Account, Store, Tokens};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::net::body;
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::net::{Client, Origins};
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_core::{daemon, ledger};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const KEY: &str = "sm-test-key";

const CLAUDE_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}"#,
    "\n\n",
    "event: message_stop\n",
    r#"data: {"type":"message_stop"}"#,
    "\n\n",
);

const CLAUDE_BODY: &str = r#"{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}"#;

/// The bearer tokens the mock provider was sent, in order.
type Seen = Arc<Mutex<Vec<String>>>;

/// A provider that streams an answer to any token.
async fn upstream(seen: Seen) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handler = move |request: Request| {
        let seen = seen.clone();
        async move {
            let token = request
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let messages = request.uri().path() == "/v1/messages";
            let _ = body::read(request.into_body(), usize::MAX).await;
            if !messages {
                let mut response = Response::new(body::full("{}"));
                *response.status_mut() = StatusCode::NOT_FOUND;
                return response;
            }
            seen.lock().unwrap().push(token);
            let mut response = Response::new(body::full(CLAUDE_STREAM));
            response
                .headers_mut()
                .insert("content-type", "text/event-stream".parse().unwrap());
            response
        }
    };
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    format!("http://{addr}")
}

fn claude(email: &str, token: &str, added: i64) -> Account {
    let mut account = Account::new(
        ProviderId::Claude,
        Tokens {
            access_token: token.into(),
            refresh_token: Some(format!("refresh-{token}")),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(24)),
            ..Tokens::default()
        },
    );
    account.org_id = Some(format!("org-{email}"));
    account.email = Some(email.into());
    account.added_at = Timestamp::from_second(added).unwrap();
    account.assign_id();
    account
}

fn free_port() -> SocketAddr {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
}

struct Daemon {
    home: PathBuf,
    base: String,
    run: JoinHandle<anyhow::Result<daemon::Stopped>>,
}

/// A home with `accounts`, and a daemon serving it on a port of its own.
async fn start(home: &Path, upstream: &str) -> Daemon {
    let listen = free_port();
    let run = tokio::spawn(daemon::serve(
        config(listen),
        Home::at(home),
        origins(upstream),
    ));
    let base = format!("http://{listen}");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let up = Client::builder()
            .build()
            .get(format!("{base}/healthz"))
            .send()
            .await
            .is_ok_and(|r| r.status() == StatusCode::OK);
        if up {
            break;
        }
        assert!(!run.is_finished(), "the daemon stopped while starting");
        assert!(Instant::now() < deadline, "the daemon never answered");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Daemon {
        home: home.to_owned(),
        base,
        run,
    }
}

fn config(listen: SocketAddr) -> Config {
    Config {
        listen,
        api_key: KEY.into(),
        strategy: Strategy::FillFirst,
        poll_mins: 0,
        refresh_tokens: false,
        warm_windows: false,
        redeem_expiring_credits: false,
        ..Config::default()
    }
}

fn origins(upstream: &str) -> Origins {
    Origins::new([
        ("https://api.anthropic.com", upstream),
        ("https://platform.claude.com", upstream),
        ("https://chatgpt.com", upstream),
    ])
}

fn temp_home(accounts: &[Account]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("slopmax-daemon-{}", slopmax_core::ids::token()));
    let store = Store::at(dir.join("accounts"));
    for account in accounts {
        store.upsert(account.clone()).unwrap();
    }
    dir
}

impl Daemon {
    async fn ask(&self, path: &str) -> StatusCode {
        Client::builder()
            .build()
            .post(format!("{}{path}", self.base))
            .header("authorization", format!("Bearer {KEY}"))
            .header("user-agent", "claude-cli/2.1.287 (external, cli)")
            .header("x-slopmax-affinity", "off")
            .header("content-type", "application/json")
            .body(CLAUDE_BODY)
            .send()
            .await
            .unwrap()
            .status()
    }

    /// Answers one request, reading the stream to its end.
    async fn request(&self) -> String {
        let response = Client::builder()
            .build()
            .post(format!("{}/v1/messages", self.base))
            .header("authorization", format!("Bearer {KEY}"))
            .header("user-agent", "claude-cli/2.1.287 (external, cli)")
            .header("x-slopmax-affinity", "off")
            .header("content-type", "application/json")
            .body(CLAUDE_BODY)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.text().await.unwrap()
    }

    /// Stops the daemon as `slopmax stop` does, and waits for it to finish.
    async fn stop(self) -> (PathBuf, Duration) {
        let asked = Instant::now();
        assert_eq!(self.ask("/slopmax/shutdown").await, StatusCode::OK);
        tokio::time::timeout(Duration::from_secs(20), self.run)
            .await
            .expect("the daemon stopped")
            .unwrap()
            .unwrap();
        (self.home, asked.elapsed())
    }
}

#[tokio::test]
async fn stops_with_every_answer_in_the_ledger_and_state_saved() {
    let seen = Seen::default();
    let upstream = upstream(seen.clone()).await;
    let home = temp_home(&[claude("a@x", "tok-a", 1000)]);
    let daemon = Arc::new(start(&home, &upstream).await);
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..20 {
        let daemon = daemon.clone();
        requests.spawn(async move { daemon.request().await });
    }
    while let Some(answer) = requests.join_next().await {
        assert!(answer.unwrap().contains("message_stop"));
    }
    let daemon = Arc::into_inner(daemon).unwrap();
    let (home, _) = daemon.stop().await;
    let entries = ledger::read(&home.join("usage"), Timestamp::UNIX_EPOCH);
    assert_eq!(entries.len(), 20);
    assert!(entries.iter().all(|e| e.status == 200 && e.input == 10));
    assert!(home.join("state.toml").exists());
    // The serve lock is let go: the home can be served again.
    let again = start(&home, &upstream).await;
    again.stop().await;
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn refuses_to_start_beside_another_daemon_on_the_same_home() {
    let upstream = upstream(Seen::default()).await;
    let home = temp_home(&[claude("a@x", "tok-a", 1000)]);
    let first = start(&home, &upstream).await;
    let second = daemon::serve(config(free_port()), Home::at(&home), origins(&upstream)).await;
    let error = format!("{:#}", second.unwrap_err());
    assert!(error.contains("already serving"), "{error}");
    assert!(
        error.contains(&format!("pid {}", std::process::id())),
        "{error}"
    );
    // The first is unharmed.
    first.request().await;
    first.stop().await;
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn moves_an_unreadable_state_file_aside_and_starts() {
    let upstream = upstream(Seen::default()).await;
    let home = temp_home(&[claude("a@x", "tok-a", 1000)]);
    std::fs::write(home.join("state.toml"), "[not toml").unwrap();
    let daemon = start(&home, &upstream).await;
    daemon.request().await;
    let (home, _) = daemon.stop().await;
    let aside: Vec<String> = std::fs::read_dir(&home)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.starts_with("state.toml.bad-"))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(
        std::fs::read_to_string(home.join(&aside[0])).unwrap(),
        "[not toml"
    );
    // The fresh state was saved in its place, and reads.
    let saved = std::fs::read_to_string(home.join("state.toml")).unwrap();
    saved.parse::<toml_edit::DocumentMut>().unwrap();
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn stops_at_once_while_a_dashboard_follows_the_events() {
    let upstream = upstream(Seen::default()).await;
    let home = temp_home(&[claude("a@x", "tok-a", 1000)]);
    let daemon = start(&home, &upstream).await;
    let events = Client::builder()
        .build()
        .get(format!("{}/slopmax/events", daemon.base))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), StatusCode::OK);
    let (home, took) = daemon.stop().await;
    assert!(took < Duration::from_secs(3), "stopping took {took:?}");
    drop(events);
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn a_change_the_daemon_is_told_of_applies_to_the_next_request() {
    let seen = Seen::default();
    let upstream = upstream(seen.clone()).await;
    let first = claude("a@x", "tok-a", 1000);
    let home = temp_home(&[first.clone(), claude("b@x", "tok-b", 2000)]);
    let daemon = start(&home, &upstream).await;
    daemon.request().await;
    // Another process (the CLI, after a refresh that was refused) marks the
    // first account signed out, then tells the daemon, as the CLI does.
    Store::at(home.join("accounts"))
        .update(&first.id, |a| a.auth_error = Some("signed out".into()))
        .unwrap();
    assert_eq!(daemon.ask("/slopmax/sync").await, StatusCode::OK);
    daemon.request().await;
    assert_eq!(*seen.lock().unwrap(), ["Bearer tok-a", "Bearer tok-b"]);
    let (home, _) = daemon.stop().await;
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn serves_requests_from_the_accounts_it_holds_without_reading_their_files() {
    let seen = Seen::default();
    let upstream = upstream(seen.clone()).await;
    let first = claude("a@x", "tok-a", 1000);
    let home = temp_home(std::slice::from_ref(&first));
    let daemon = start(&home, &upstream).await;
    // The file changes under the daemon, which is not told: requests keep
    // the copy it holds until it next looks at the files.
    Store::at(home.join("accounts"))
        .update(&first.id, |a| a.tokens.access_token = "tok-on-disk".into())
        .unwrap();
    for _ in 0..3 {
        daemon.request().await;
    }
    assert_eq!(*seen.lock().unwrap(), ["Bearer tok-a"; 3]);
    // Told, it reads them.
    assert_eq!(daemon.ask("/slopmax/sync").await, StatusCode::OK);
    daemon.request().await;
    assert_eq!(seen.lock().unwrap().last().unwrap(), "Bearer tok-on-disk");
    let (home, _) = daemon.stop().await;
    std::fs::remove_dir_all(home).unwrap();
}
