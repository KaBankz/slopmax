//! The daemon on the user's tailnet: the owner-only socket `tailscale serve`
//! passes requests to, what the tailnet's headers are believed for, who may
//! do what, and where requests are recorded as coming from.
//!
//! A test client plays tailscaled on the socket, and whois is a fake, so no
//! test runs the real `tailscale` command or reaches the real tailnet.

#![cfg(unix)]

use std::net::{IpAddr, SocketAddr};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use http::{HeaderMap, Method, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use slopmax_core::account::{Account, Store, Tokens};
use slopmax_core::config::Config;
use slopmax_core::ledger::{self, Entry};
use slopmax_core::net::server::{self, Request, Response};
use slopmax_core::net::{Client, Origins, body, ws};
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
use slopmax_core::tailscale::{BoxFuture, Machine, TsError, Whois};
use slopmax_core::time::{SignedDuration, Timestamp};
use slopmax_daemon as daemon;
use slopmax_daemon::proxy::Tailnet;
use tokio::net::{TcpListener, UnixStream};
use tokio::task::JoinHandle;

const KEY: &str = "sm-test-key";
/// A client key, for machines Tailscale can't vouch for.
const CI_KEY: &str = "sm-ci-key";
/// The hub's name, as tailscaled forwards it.
const HUB: &str = "hub.example.ts.net";
/// The admin machine, another of the same user's, and a tagged one.
const MAC: &str = "100.64.0.1";
const PHONE: &str = "100.64.0.2";
const TAGGED: &str = "100.64.0.3";

const CLAUDE_STREAM: &str = concat!(
    "event: message_start\n",
    r#"data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}"#,
    "\n\n",
    "event: message_stop\n",
    r#"data: {"type":"message_stop"}"#,
    "\n\n",
);

const CLAUDE_BODY: &str = r#"{"model":"claude-opus-5-5","messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}"#;

/// What the mock provider was sent: each request's path and headers.
type Log = Arc<Mutex<Vec<(String, HeaderMap)>>>;

/// A provider that streams an answer to Claude's messages and relays
/// Codex's sockets.
async fn upstream(log: Log) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handler = move |mut request: Request| {
        let log = log.clone();
        async move {
            let path = request.uri().path().to_owned();
            log.lock()
                .unwrap()
                .push((path.clone(), request.headers().clone()));
            if request.headers().contains_key("sec-websocket-key") {
                return mock_socket(&mut request);
            }
            let _ = body::read(request.into_body(), usize::MAX).await;
            let mut response = Response::new(body::full(match path.as_str() {
                "/v1/messages" => CLAUDE_STREAM,
                _ => "{}",
            }));
            if path != "/v1/messages" {
                *response.status_mut() = StatusCode::NOT_FOUND;
            }
            response
                .headers_mut()
                .insert("content-type", "text/event-stream".parse().unwrap());
            response
        }
    };
    tokio::spawn(server::serve(listener, handler, std::future::pending()));
    format!("http://{addr}")
}

/// ChatGPT's socket: each turn is answered and completed.
fn mock_socket(request: &mut Request) -> Response {
    let key = request.headers()["sec-websocket-key"]
        .to_str()
        .unwrap()
        .to_owned();
    let upgrading = hyper::upgrade::on(request);
    tokio::spawn(async move {
        let io = TokioIo::new(upgrading.await.unwrap());
        let (read, write) = tokio::io::split(io);
        let mut reader = ws::Reader::new(tokio::io::BufReader::new(read));
        let mut writer = ws::Writer::server(write);
        while let Ok(Some(ws::Message::Text(_))) = reader.message().await {
            for event in [
                json!({"type": "response.created", "response": {"id": "r"}}),
                json!({"type": "response.completed", "response": {"id": "r", "usage":
                    {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7}}}),
            ] {
                if writer
                    .send(&ws::Message::Text(event.to_string()))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
    let mut response = Response::new(body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let out = response.headers_mut();
    out.insert("upgrade", "websocket".parse().unwrap());
    out.insert("connection", "Upgrade".parse().unwrap());
    out.insert(
        "sec-websocket-accept",
        ws::accept_key(&key).parse().unwrap(),
    );
    response
}

/// Whois from a fixed list: the admin `mac` and the `phone` signed in as
/// `me@test`, and a tagged `ci` machine.
struct FakeWhois;

impl Whois for FakeWhois {
    fn whois<'a>(&'a self, ip: IpAddr) -> BoxFuture<'a, Result<Machine, TsError>> {
        let machine = |id: &str, name: &str, login: Option<&str>| Machine {
            id: id.into(),
            name: name.into(),
            login: login.map(str::to_owned),
            tags: match login {
                Some(_) => vec![],
                None => vec!["tag:ci".into()],
            },
        };
        let found = match ip.to_string().as_str() {
            MAC => Ok(machine("nADMIN", "mac", Some("me@test"))),
            PHONE => Ok(machine("nOTHER", "phone", Some("me@test"))),
            TAGGED => Ok(machine("nTAGGED", "ci", None)),
            _ => Err(TsError::Failed {
                line: "no machine has that address".into(),
            }),
        };
        Box::pin(async move { found })
    }
}

fn account(provider: ProviderId, name: &str, token: &str, added: i64) -> Account {
    let mut account = Account::new(
        provider,
        Tokens {
            access_token: token.into(),
            refresh_token: Some(format!("refresh-{token}")),
            expires_at: Some(Timestamp::now() + SignedDuration::from_hours(24)),
            ..Tokens::default()
        },
    );
    account.org_id = Some(format!("org-{name}"));
    account.account_id = Some(format!("acct-{name}"));
    account.email = Some(format!("{name}@example.com"));
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

/// A home with a Claude and a Codex account, under a short path, so its
/// socket's path is short enough.
fn temp_home() -> PathBuf {
    let token = slopmax_core::ids::token();
    let dir = std::env::temp_dir().join(format!("smtn-{}", &token[..12]));
    let store = Store::at(dir.join("accounts"));
    store
        .upsert(account(ProviderId::Claude, "claude", "tok-claude", 1000))
        .unwrap();
    store
        .upsert(account(ProviderId::Codex, "codex", "tok-codex", 1001))
        .unwrap();
    dir
}

/// The config of a hub whose tailnet user is `me@test`, with `mac` its
/// admin machine, and a client key for `ci`.
fn config_text(listen: SocketAddr) -> String {
    format!(
        "api_key = \"{KEY}\"\nlisten = \"{listen}\"\nstrategy = \"fill-first\"\npoll_mins = 0\n\
         refresh_tokens = false\nwarm_windows = false\nredeem_expiring_credits = false\n\n\
         [[keys]]\nname = \"ci\"\nkey = \"{CI_KEY}\"\n\n\
         [tailscale]\nusers = [\"me@test\"]\nadmins = [{{ machine = \"mac\", id = \"nADMIN\" }}]\n"
    )
}

struct Hub {
    home: PathBuf,
    base: String,
    log: Log,
    run: JoinHandle<anyhow::Result<daemon::Stopped>>,
}

impl Hub {
    /// A daemon serving `home`, its config written there first.
    async fn start(home: &Path) -> Self {
        let log = Log::default();
        let upstream = upstream(log.clone()).await;
        let listen = free_port();
        std::fs::create_dir_all(home).unwrap();
        std::fs::write(home.join("config.toml"), config_text(listen)).unwrap();
        let config = Config::load_from(&home.join("config.toml")).unwrap();
        let origins = Origins::new([
            ("https://api.anthropic.com", upstream.as_str()),
            ("https://platform.claude.com", upstream.as_str()),
            ("https://chatgpt.com/backend-api", upstream.as_str()),
        ]);
        let tailnet = Tailnet {
            whois: Arc::new(FakeWhois),
            cli: Arc::new(|| None),
        };
        let run = tokio::spawn(daemon::serve_with(config, Home::at(home), origins, tailnet));
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
        Self {
            home: home.to_owned(),
            base,
            log,
            run,
        }
    }

    fn socket(&self) -> PathBuf {
        self.home.join("tailnet.sock")
    }

    /// A request over TCP, from this machine.
    fn local(&self, method: Method, path: &str) -> slopmax_core::net::client::RequestBuilder {
        Client::builder()
            .build()
            .request(method, format!("{}{path}", self.base))
    }

    /// A request over the socket, as tailscaled sends one from `ip`
    /// signed in as `login` (`None`: a tagged machine).
    async fn tailnet(&self, request: http::Request<Full<Bytes>>) -> http::Response<Incoming> {
        let stream = UnixStream::connect(self.socket()).await.unwrap();
        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(connection.with_upgrades());
        sender.send_request(request).await.unwrap()
    }

    /// [`Hub::tailnet`], read whole: its status and its body as JSON (or
    /// as a string, when it is not JSON).
    async fn ask(&self, request: http::Request<Full<Bytes>>) -> (StatusCode, Value) {
        let response = self.tailnet(request).await;
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::String(text)),
        )
    }

    fn recorded(&self) -> Vec<Entry> {
        ledger::read(&self.home.join("usage"), Timestamp::UNIX_EPOCH)
    }

    /// Stops the daemon as `slopmax proxy stop` does, and waits for it.
    async fn stop(self) -> PathBuf {
        let stopping = self
            .local(Method::POST, "/slopmax/api/shutdown")
            .header("authorization", format!("Bearer {KEY}"))
            .send()
            .await
            .unwrap();
        assert_eq!(stopping.status(), StatusCode::OK);
        tokio::time::timeout(Duration::from_secs(20), self.run)
            .await
            .expect("the daemon stopped")
            .unwrap()
            .unwrap();
        self.home
    }
}

/// A request as tailscaled forwards one from `ip`, signed in as `login`.
fn from(method: Method, path: &str, ip: &str, login: Option<&str>) -> http::request::Builder {
    let mut request = http::Request::builder()
        .method(method)
        .uri(path)
        .header("host", HUB)
        .header("x-forwarded-for", ip)
        .header("x-forwarded-host", HUB)
        .header("x-forwarded-proto", "https");
    if let Some(login) = login {
        request = request
            .header("tailscale-user-login", login)
            .header("tailscale-user-name", "Me")
            .header("tailscale-user-profile-pic", "https://example.com/me.png");
    }
    request
}

/// [`from`] `me@test` on `ip`, with the placeholder token hub clients send.
fn member(method: Method, path: &str, ip: &str) -> http::request::Builder {
    from(method, path, ip, Some("me@test")).header("authorization", "Bearer tailnet")
}

fn empty(request: http::request::Builder) -> http::Request<Full<Bytes>> {
    request.body(Full::new(Bytes::new())).unwrap()
}

fn with(request: http::request::Builder, body: &str) -> http::Request<Full<Bytes>> {
    request
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_owned())))
        .unwrap()
}

/// A Claude Code request, as `request` sends it.
fn claude_code(request: http::request::Builder) -> http::Request<Full<Bytes>> {
    with(
        request.header("user-agent", "claude-cli/2.1.287 (external, cli)"),
        CLAUDE_BODY,
    )
}

fn message(answer: &Value) -> &str {
    answer["error"]["message"]
        .as_str()
        .or_else(|| answer["message"].as_str())
        .unwrap_or_default()
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(Instant::now() < deadline, "{what} never happened");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn the_socket_is_the_owner_s_alone_and_goes_with_the_daemon() {
    let home = temp_home();
    std::fs::create_dir_all(&home).unwrap();
    // An old socket, left by a daemon that crashed: replaced.
    drop(std::os::unix::net::UnixListener::bind(home.join("tailnet.sock")).unwrap());
    let hub = Hub::start(&home).await;
    let mode = std::fs::metadata(hub.socket())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
    let (status, health) = hub.ask(empty(member(Method::GET, "/healthz", PHONE))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["via"], "tailnet");
    let home = hub.stop().await;
    assert!(!home.join("tailnet.sock").exists(), "the socket was left");

    // Something else at the path is left alone, and the proxy runs on TCP.
    std::fs::write(home.join("tailnet.sock"), "not a socket").unwrap();
    let hub = Hub::start(&home).await;
    let health = hub.local(Method::GET, "/healthz").send().await.unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let home = hub.stop().await;
    assert_eq!(
        std::fs::read_to_string(home.join("tailnet.sock")).unwrap(),
        "not a socket"
    );
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn a_home_too_deep_for_a_socket_serves_tcp_alone() {
    let home = temp_home().join("d".repeat(100));
    let hub = Hub::start(&home).await;
    assert!(!hub.socket().exists());
    let home = hub.stop().await;
    std::fs::remove_dir_all(home.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn tailnet_headers_over_tcp_are_believed_for_nothing() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let forged = |method: Method, path: &str| {
        hub.local(method, path)
            .header("authorization", "Bearer tailnet")
            .header("tailscale-user-login", "me@test")
            .header("x-forwarded-for", MAC)
            .header("x-forwarded-host", HUB)
    };
    let refused = forged(Method::POST, "/v1/messages")
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
    let status = forged(Method::GET, "/slopmax/api/status")
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::UNAUTHORIZED);
    let health: Value = forged(Method::GET, "/healthz")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (&health["via"], &health["access"]),
        (&json!("local"), &json!("none"))
    );
    assert!(health["pid"].is_number());
    assert!(hub.log.lock().unwrap().is_empty());
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

/// tailscaled publishing the proxy's port under the owner key's private
/// path: what comes under it from tailscaled (here, this user, whose
/// connection Linux names as such) is the tailnet's.
#[tokio::test]
async fn the_private_path_on_the_port_is_the_tailnet_too() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let private = slopmax_core::tailscale::private_path(KEY);
    let via = |path: &str| {
        hub.local(Method::GET, path)
            .header("authorization", "Bearer tailnet")
            .header("tailscale-user-login", "me@test")
            .header("x-forwarded-for", PHONE)
            .header("x-forwarded-host", HUB)
            .header("x-forwarded-proto", "https")
    };
    let health: Value = via(&format!("{private}/healthz"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (&health["via"], &health["access"], &health["machine"]),
        (&json!("tailnet"), &json!("view"), &json!("phone")),
        "{health}"
    );
    let status = via(&format!("{private}/slopmax/api/status"))
        .send()
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let answer = via(&format!("{private}/v1/messages"))
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    assert_eq!(answer.status(), StatusCode::OK);
    // The path went no further than slopmax.
    let sent = hub.log.lock().unwrap()[0].0.clone();
    assert!(!sent.contains(".slopmax-tailnet-"), "{sent}");

    // Another key's path is no secret of this hub's: nothing is believed.
    let other = slopmax_core::tailscale::private_path("sm-other");
    let answer = via(&format!("{other}/slopmax/api/status"))
        .send()
        .await
        .unwrap();
    assert_ne!(answer.status(), StatusCode::OK);
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn the_user_s_machines_use_the_proxy_without_a_key() {
    let home = temp_home();
    let hub = Hub::start(&home).await;

    let answer = hub
        .tailnet(claude_code(member(Method::POST, "/v1/messages", PHONE)))
        .await;
    assert_eq!(answer.status(), StatusCode::OK);
    let streamed = answer.into_body().collect().await.unwrap().to_bytes();
    assert!(String::from_utf8_lossy(&streamed).contains("message_stop"));
    // Nothing of the tailnet reached the provider.
    let sent = hub.log.lock().unwrap()[0].1.clone();
    for name in sent.keys() {
        let name = name.as_str();
        assert!(
            !name.starts_with("tailscale-")
                && !name.starts_with("x-forwarded-")
                && name != "forwarded",
            "{name} went upstream"
        );
    }
    assert_eq!(sent["authorization"], "Bearer tok-claude");

    // A token of some kind is needed, so another site's page can't send one.
    let (status, answer) = hub
        .ask(claude_code(from(
            Method::POST,
            "/v1/messages",
            PHONE,
            Some("me@test"),
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        message(&answer).starts_with("send a token with the request"),
        "{answer}"
    );

    // Other sites, even ones under the same ts.net name, are refused.
    let (status, answer) = hub
        .ask(empty(
            member(Method::GET, "/slopmax/api/status", PHONE).header("sec-fetch-site", "same-site"),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        message(&answer),
        "requests from other sites can't use your tailnet identity"
    );
    let (status, _) = hub
        .ask(empty(
            member(Method::GET, "/slopmax/api/status", PHONE)
                .header("origin", "https://dev.example.ts.net"),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = hub
        .ask(empty(
            member(Method::GET, "/slopmax/api/status", PHONE)
                .header("origin", "https://hub.example.ts.net")
                .header("sec-fetch-site", "same-origin"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);

    // Other logins, and tagged machines, need keys.
    let (status, answer) = hub
        .ask(claude_code(
            from(Method::POST, "/v1/messages", PHONE, Some("you@test"))
                .header("authorization", "Bearer tailnet"),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        message(&answer).starts_with("you@test isn't allowed"),
        "{answer}"
    );
    let (status, answer) = hub
        .ask(claude_code(
            from(Method::POST, "/v1/messages", TAGGED, None)
                .header("authorization", "Bearer tailnet"),
        ))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(
        message(&answer).starts_with("tagged machines need a key"),
        "{answer}"
    );
    let (status, _) = hub
        .ask(claude_code(
            from(Method::POST, "/v1/messages", TAGGED, None)
                .header("authorization", format!("Bearer {CI_KEY}")),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);

    // Funnel is refused, even with the owner key.
    let (status, answer) = hub
        .ask(empty(
            from(Method::GET, "/slopmax/api/status", PHONE, None)
                .header("tailscale-funnel-request", "?1")
                .header("authorization", format!("Bearer {KEY}")),
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        message(&answer).contains("tailscale funnel --https=443 off"),
        "{answer}"
    );
    // So it is when Tailscale passes it to the proxy's TCP port, as it does
    // when it publishes that port rather than the socket: not even the page
    // or /healthz answers.
    for path in ["/slopmax/api/status", "/healthz", "/slopmax/"] {
        let refused = hub
            .local(Method::GET, path)
            .header("tailscale-funnel-request", "?1")
            .header("authorization", format!("Bearer {KEY}"))
            .send()
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN, "{path}");
    }
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn the_user_s_machines_look_and_admin_machines_manage() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let (status, report) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/status", PHONE)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["accounts"].as_array().unwrap().len(), 2);
    let (status, view) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/tailnet", PHONE)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["tailscale"], "missing");
    assert_eq!(view["users"], json!(["me@test"]));
    let change = r#"{"sessionMinutes":45}"#;
    let (status, refused) = hub
        .ask(with(
            member(Method::PATCH, "/slopmax/api/settings", PHONE),
            change,
        ))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        refused["message"],
        "this machine may not change slopmax; on the hub: slopmax tailscale admin add phone"
    );
    let (status, _) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/keys", PHONE)))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Unknown endpoints are told only to callers slopmax knows.
    let (status, _) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/nothing", PHONE)))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = hub
        .ask(empty(from(
            Method::GET,
            "/slopmax/api/nothing",
            PHONE,
            None,
        )))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, settings) = hub
        .ask(with(
            member(Method::PATCH, "/slopmax/api/settings", MAC),
            change,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{settings}");
    assert_eq!(settings["settings"]["sessionMinutes"], 45);
    let patch = r#"{"users":["me@test","you@test"]}"#;
    let (status, view) = hub
        .ask(with(
            member(Method::PATCH, "/slopmax/api/tailnet", MAC),
            patch,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    assert_eq!(view["users"], json!(["me@test", "you@test"]));
    let written = std::fs::read_to_string(hub.home.join("config.toml")).unwrap();
    assert!(
        written.contains(r#"users = ["me@test", "you@test"]"#),
        "{written}"
    );
    assert!(written.contains("nADMIN"), "{written}");
    // The new login is taken at once.
    let (status, _) = hub
        .ask(empty(
            from(Method::GET, "/slopmax/api/status", PHONE, Some("you@test"))
                .header("authorization", "Bearer tailnet"),
        ))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = hub
        .ask(with(
            member(Method::PATCH, "/slopmax/api/tailnet", MAC),
            r#"{"users":["not a login"]}"#,
        ))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn only_the_hub_itself_moves_its_proxy_to_another_binary() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    for body in [r#"{"exe":"/bin/sh"}"#, r#"{"makeWay":true}"#] {
        let (status, refused) = hub
            .ask(with(
                member(Method::POST, "/slopmax/api/shutdown", MAC),
                body,
            ))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}: {refused}");
        assert_eq!(
            refused["message"],
            "only slopmax on the hub itself may move its proxy to another process"
        );
    }
    // Still serving.
    let (status, _) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/status", MAC)))
        .await;
    assert_eq!(status, StatusCode::OK);
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn health_says_who_the_tailnet_asker_is() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let (_, mac) = hub.ask(empty(member(Method::GET, "/healthz", MAC))).await;
    assert_eq!(mac["service"], "slopmax");
    assert_eq!(mac["via"], "tailnet");
    assert!(mac.get("pid").is_none(), "{mac}");
    assert_eq!(
        (
            &mac["access"],
            &mac["login"],
            &mac["machine"],
            &mac["owner"]
        ),
        (
            &json!("admin"),
            &json!("me@test"),
            &json!("mac"),
            &json!(false)
        )
    );
    let (_, phone) = hub.ask(empty(member(Method::GET, "/healthz", PHONE))).await;
    assert_eq!(
        (&phone["access"], &phone["machine"]),
        (&json!("view"), &json!("phone"))
    );
    let (_, ci) = hub
        .ask(empty(
            from(Method::GET, "/healthz", TAGGED, None)
                .header("authorization", format!("Bearer {CI_KEY}")),
        ))
        .await;
    assert_eq!(
        (&ci["access"], &ci["machine"]),
        (&json!("use"), &json!("ci"))
    );
    let (_, stranger) = hub
        .ask(empty(
            from(Method::GET, "/healthz", TAGGED, None).header("authorization", "Bearer tailnet"),
        ))
        .await;
    assert_eq!(stranger["access"], "none");
    // No credential, no say on access.
    let (_, bare) = hub
        .ask(empty(from(Method::GET, "/healthz", PHONE, Some("me@test"))))
        .await;
    assert!(bare.get("access").is_none(), "{bare}");
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

/// A machine set up with `slopmax setup --hub` sends its client key; what
/// its login may do beyond the proxy, it still may.
#[tokio::test]
async fn a_client_key_s_machine_may_do_what_its_login_may() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let keyed = |method: Method, path: &str, ip: &str, login: Option<&str>| {
        from(method, path, ip, login).header("authorization", format!("Bearer {CI_KEY}"))
    };
    let (_, phone) = hub
        .ask(empty(keyed(
            Method::GET,
            "/healthz",
            PHONE,
            Some("me@test"),
        )))
        .await;
    assert_eq!(
        (&phone["access"], &phone["login"], &phone["machine"]),
        (&json!("view"), &json!("me@test"), &json!("phone"))
    );
    let (status, _) = hub
        .ask(empty(keyed(
            Method::GET,
            "/slopmax/api/status",
            PHONE,
            Some("me@test"),
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, refused) = hub
        .ask(empty(keyed(
            Method::POST,
            "/slopmax/api/sync",
            PHONE,
            Some("me@test"),
        )))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        refused["message"],
        "this machine may not change slopmax; on the hub: slopmax tailscale admin add phone"
    );
    let (status, _) = hub
        .ask(empty(keyed(
            Method::POST,
            "/slopmax/api/sync",
            MAC,
            Some("me@test"),
        )))
        .await;
    assert_eq!(status, StatusCode::OK);
    // A login slopmax doesn't take, or none, leaves the key what it is.
    for login in [Some("stranger@test"), None] {
        let (status, refused) = hub
            .ask(empty(keyed(
                Method::GET,
                "/slopmax/api/status",
                TAGGED,
                login,
            )))
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{login:?}");
        assert_eq!(
            refused["message"],
            "the key \"ci\" reaches the proxy only, not slopmax's own API"
        );
    }
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn the_ledger_records_which_machine_asked() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    // The owner key: this machine's own agents.
    let own = hub
        .local(Method::POST, "/v1/messages")
        .header("authorization", format!("Bearer {KEY}"))
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    assert_eq!(own.status(), StatusCode::OK);
    own.text().await.unwrap();
    eventually("the owner's request recorded", || hub.recorded().len() == 1).await;
    // A client key, by its name.
    let keyed = hub
        .local(Method::POST, "/v1/messages")
        .header("authorization", format!("Bearer {CI_KEY}"))
        .header("user-agent", "claude-cli/2.1.287 (external, cli)")
        .header("content-type", "application/json")
        .body(CLAUDE_BODY)
        .send()
        .await
        .unwrap();
    keyed.text().await.unwrap();
    eventually("the key's request recorded", || hub.recorded().len() == 2).await;
    // A tailnet machine, by its name once whois has told it.
    let (status, _) = hub.ask(empty(member(Method::GET, "/healthz", MAC))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = hub
        .ask(claude_code(member(Method::POST, "/v1/messages", MAC)))
        .await;
    assert_eq!(status, StatusCode::OK);
    eventually("the mac's request recorded", || hub.recorded().len() == 3).await;
    let machines: Vec<Option<String>> = hub.recorded().into_iter().map(|e| e.machine).collect();
    assert_eq!(machines, [None, Some("ci".into()), Some("mac".into())]);

    // Read here, the owner's are this machine's; elsewhere, the hub's.
    let usage = |request: http::request::Builder| hub.ask(empty(request));
    let (_, local) = {
        let response = hub
            .local(Method::GET, "/slopmax/api/usage?by=machine")
            .header("authorization", format!("Bearer {KEY}"))
            .send()
            .await
            .unwrap();
        (response.status(), response.json::<Value>().await.unwrap())
    };
    let (_, remote) = usage(member(Method::GET, "/slopmax/api/usage?by=machine", PHONE)).await;
    let (local, remote) = (local.to_string(), remote.to_string());
    assert!(
        local.contains("\"this machine\"") && !local.contains("\"hub\""),
        "{local}"
    );
    assert!(
        remote.contains("\"hub\"") && !remote.contains("\"this machine\""),
        "{remote}"
    );
    assert!(
        remote.contains("\"mac\"") && remote.contains("\"ci\""),
        "{remote}"
    );
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

/// Reads `body` until `done` says what it read is enough, or it ends.
async fn read_until(body: &mut Incoming, read: &mut String, done: impl Fn(&str) -> bool) -> bool {
    while !done(read) {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("an event in time");
        match frame {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    read.push_str(&String::from_utf8_lossy(&data));
                }
            }
            _ => return false,
        }
    }
    true
}

#[tokio::test]
async fn sign_ins_are_shown_only_to_those_who_may_manage() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let mut phone = hub
        .tailnet(empty(member(Method::GET, "/slopmax/api/events", PHONE)))
        .await
        .into_body();
    let mut seen_by_phone = String::new();
    assert!(
        read_until(&mut phone, &mut seen_by_phone, |r| r
            .contains(r#""_tag":"Status""#))
        .await
    );
    let mut owner = hub
        .tailnet(empty(
            from(Method::GET, "/slopmax/api/events", MAC, None)
                .header("authorization", format!("Bearer {KEY}")),
        ))
        .await
        .into_body();
    let mut seen_by_owner = String::new();
    assert!(
        read_until(&mut owner, &mut seen_by_owner, |r| r
            .contains(r#""_tag":"Status""#))
        .await
    );

    // A sign-in, started and cancelled through the owner key.
    let started: Value = hub
        .local(Method::POST, "/slopmax/api/logins")
        .header("authorization", format!("Bearer {KEY}"))
        .header("content-type", "application/json")
        .body(r#"{"provider":"claude","noBrowser":true}"#)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = started["id"].as_str().unwrap();
    assert!(
        read_until(&mut owner, &mut seen_by_owner, |r| r
            .contains(r#""_tag":"Login""#))
        .await
    );
    let cancelled = hub
        .local(Method::DELETE, &format!("/slopmax/api/logins/{id}"))
        .header("authorization", format!("Bearer {KEY}"))
        .send()
        .await
        .unwrap();
    assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
    // Then a request, which every watcher is told of after the sign-in.
    let (status, _) = hub
        .ask(claude_code(member(Method::POST, "/v1/messages", PHONE)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        read_until(&mut phone, &mut seen_by_phone, |r| r
            .contains(r#""_tag":"Request""#))
        .await
    );
    assert!(
        !seen_by_phone.contains(r#""_tag":"Login""#),
        "{seen_by_phone}"
    );
    assert!(
        seen_by_phone.contains(r#""machine":"phone""#)
            || seen_by_phone.contains(r#""machine":"me@test""#)
    );
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

impl Hub {
    /// Rewrites config.toml with `change`, and has the daemon read it.
    async fn change_config(&self, change: impl Fn(&str) -> String) {
        let path = self.home.join("config.toml");
        let config = std::fs::read_to_string(&path).unwrap();
        let changed = change(&config);
        assert_ne!(config, changed);
        std::fs::write(&path, changed).unwrap();
        let synced = self
            .local(Method::POST, "/slopmax/api/sync")
            .header("authorization", format!("Bearer {KEY}"))
            .send()
            .await
            .unwrap();
        assert_eq!(synced.status(), StatusCode::OK);
    }

    /// Starts a sign-in through the owner key, and cancels it.
    async fn sign_in_and_cancel(&self) {
        let started: Value = self
            .local(Method::POST, "/slopmax/api/logins")
            .header("authorization", format!("Bearer {KEY}"))
            .header("content-type", "application/json")
            .body(r#"{"provider":"claude","noBrowser":true}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = started["id"].as_str().unwrap();
        let cancelled = self
            .local(Method::DELETE, &format!("/slopmax/api/logins/{id}"))
            .header("authorization", format!("Bearer {KEY}"))
            .send()
            .await
            .unwrap();
        assert_eq!(cancelled.status(), StatusCode::NO_CONTENT);
    }
}

/// Whether `body` ends within a few seconds.
async fn ends(body: &mut Incoming) -> bool {
    tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(Ok(_)) = body.frame().await {}
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn an_admin_machine_s_stream_shows_sign_ins_until_it_is_no_admin() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    // Opened before slopmax asked whois about the machine: it may only look
    // at first, and learns it may manage once whois answers.
    let mut mac = hub
        .tailnet(empty(member(Method::GET, "/slopmax/api/events", MAC)))
        .await
        .into_body();
    let mut read = String::new();
    assert!(read_until(&mut mac, &mut read, |r| r.contains(r#""_tag":"Status""#)).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    hub.sign_in_and_cancel().await;
    assert!(read_until(&mut mac, &mut read, |r| r.contains(r#""_tag":"Login""#)).await);

    // Taken off the admins, it may still look, but its stream ends: one
    // opened again shows no sign-ins.
    hub.change_config(|config| {
        config.replace(
            r#"admins = [{ machine = "mac", id = "nADMIN" }]"#,
            "admins = []",
        )
    })
    .await;
    assert!(ends(&mut mac).await, "the event stream stayed open");
    let mut mac = hub
        .tailnet(empty(member(Method::GET, "/slopmax/api/events", MAC)))
        .await
        .into_body();
    let mut read = String::new();
    assert!(read_until(&mut mac, &mut read, |r| r.contains(r#""_tag":"Status""#)).await);
    hub.sign_in_and_cancel().await;
    let (status, _) = hub
        .ask(claude_code(member(Method::POST, "/v1/messages", PHONE)))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(read_until(&mut mac, &mut read, |r| r.contains(r#""_tag":"Request""#)).await);
    assert!(!read.contains(r#""_tag":"Login""#), "{read}");
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn a_login_taken_off_the_list_loses_the_proxy_and_its_streams() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let mut events = hub
        .tailnet(empty(member(Method::GET, "/slopmax/api/events", PHONE)))
        .await
        .into_body();
    let mut read = String::new();
    assert!(read_until(&mut events, &mut read, |r| r.contains(r#""_tag":"Status""#)).await);

    hub.change_config(|config| config.replace(r#"users = ["me@test"]"#, "users = []"))
        .await;

    let (status, _) = hub
        .ask(empty(member(Method::GET, "/slopmax/api/status", PHONE)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = hub
        .ask(claude_code(member(Method::POST, "/v1/messages", PHONE)))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The open stream ends within a few seconds.
    assert!(ends(&mut events).await, "the event stream stayed open");
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn codex_sockets_are_relayed_over_the_tailnet_too() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let request = empty(
        member(Method::GET, "/codex/responses", MAC)
            .header("upgrade", "websocket")
            .header("connection", "Upgrade")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64)")
            .header("session-id", "ws-session")
            .header("x-codex-routing-hint", "model=gpt-6-sol"),
    );
    let mut response = hub.tailnet(request).await;
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let upgraded = hyper::upgrade::on(&mut response).await.unwrap();
    let (read, write) = tokio::io::split(TokioIo::new(upgraded));
    let mut reader = ws::Reader::new(tokio::io::BufReader::new(read));
    let mut writer = ws::Writer::client(write);
    let create =
        json!({"type": "response.create", "model": "gpt-6-sol", "input": [], "stream": true});
    writer
        .send(&ws::Message::Text(create.to_string()))
        .await
        .unwrap();
    let mut types = Vec::new();
    while let Some(ws::Message::Text(text)) = reader.message().await.unwrap() {
        let event: Value = serde_json::from_str(&text).unwrap();
        types.push(event["type"].as_str().unwrap().to_owned());
        if event["type"] == "response.completed" {
            break;
        }
    }
    assert_eq!(types, ["response.created", "response.completed"]);
    let upstream = hub.log.lock().unwrap()[0].clone();
    assert_eq!(upstream.0, "/codex/responses");
    assert_eq!(upstream.1["authorization"], "Bearer tok-codex");
    assert!(!upstream.1.contains_key("tailscale-user-login"));
    drop((reader, writer));
    eventually("the turn recorded", || {
        hub.recorded()
            .iter()
            .any(|e| e.provider == ProviderId::Codex && e.machine.is_some())
    })
    .await;
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}

#[tokio::test]
async fn an_open_codex_socket_stops_serving_a_login_taken_off_the_list() {
    let home = temp_home();
    let hub = Hub::start(&home).await;
    let request = empty(
        member(Method::GET, "/codex/responses", PHONE)
            .header("upgrade", "websocket")
            .header("connection", "Upgrade")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("user-agent", "codex_exec/0.159.3 (Linux; x86_64)")
            .header("session-id", "ws-revoked")
            .header("x-codex-routing-hint", "model=gpt-6-sol"),
    );
    let mut response = hub.tailnet(request).await;
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    let upgraded = hyper::upgrade::on(&mut response).await.unwrap();
    let (read, write) = tokio::io::split(TokioIo::new(upgraded));
    let mut reader = ws::Reader::new(tokio::io::BufReader::new(read));
    let mut writer = ws::Writer::client(write);
    let create =
        json!({"type": "response.create", "model": "gpt-6-sol", "input": [], "stream": true})
            .to_string();
    writer
        .send(&ws::Message::Text(create.clone()))
        .await
        .unwrap();
    loop {
        let Some(ws::Message::Text(text)) = reader.message().await.unwrap() else {
            panic!("the first turn was not answered");
        };
        if text.contains("response.completed") {
            break;
        }
    }

    hub.change_config(|config| config.replace(r#"users = ["me@test"]"#, "users = []"))
        .await;
    // The next turn is refused: the socket closes, saying why.
    writer.send(&ws::Message::Text(create)).await.unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(5), reader.message())
        .await
        .expect("an answer in time")
        .unwrap();
    assert!(
        matches!(&closed, Some(ws::Message::Close(Some((1008, _))))),
        "{closed:?}"
    );
    let sockets = hub
        .log
        .lock()
        .unwrap()
        .iter()
        .filter(|(path, _)| path == "/codex/responses")
        .count();
    assert_eq!(sockets, 1, "no other socket reached the provider");
    drop((reader, writer));
    std::fs::remove_dir_all(hub.stop().await).unwrap();
}
