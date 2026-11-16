//! A client of slopmax's API (`/slopmax/api`), for the Rust code that
//! talks to a running daemon: the CLI, and slopmax-core's background proxy
//! and doctor. It speaks the [`slopmax_api`] types and nothing of the
//! engine, so what is built on it changes nothing on disk: the daemon is
//! the only writer while it runs.
//!
//! [`Client::events`] follows the event stream, which pushes the report
//! whenever it changes, each request answered, notices and sign-in
//! progress, so nothing polls.

use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::{Buf, BytesMut};
use http::Method;
use http_body_util::BodyExt;
use serde::Serialize;
use serde::de::DeserializeOwned;
use slopmax_api::events::Event;
use slopmax_api::ledger::{History, HistoryRange, Summary, SummaryBy, SummaryRange};
use slopmax_api::report::{RedeemResult, Report};
use slopmax_api::requests::{
    AccountAdded, AccountPatch, AddAccount, ImportRequest, ImportResult, LoginStarted, MakeKey,
    PasteAddress, RedeemRequest, Shutdown, StartLogin, Stopping,
};
use slopmax_api::settings::{KeyInfo, LivePatch, NewKey, SettingsView};
use slopmax_api::tailnet::{Access, TailnetPatch, TailnetView};
use slopmax_api::{ApiError, PREFIX};

pub use slopmax_api as api;

/// Why a call did not get its answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// No slopmax answered at the address: none runs, or another program
    /// holds the port.
    Unreachable(String),
    /// The daemon refused or failed it, and said why.
    Api(ApiError),
    /// It answered with something this client does not read: another
    /// version, or not slopmax at all.
    Unexpected(String),
}

impl Error {
    /// The daemon's message, or what went wrong reaching it.
    pub fn message(&self) -> &str {
        match self {
            Self::Unreachable(m) | Self::Unexpected(m) => m,
            Self::Api(error) => match error {
                ApiError::Unauthorized { message }
                | ApiError::NotFound { message, .. }
                | ApiError::BadRequest { message }
                | ApiError::Conflict { message }
                | ApiError::UpstreamFailed { message }
                | ApiError::Internal { message } => message,
            },
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(m) => write!(f, "slopmax is not reachable: {m}"),
            _ => f.write_str(self.message()),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A daemon at `base`, reached with the owner key, or a hub on another
/// machine, reached with this machine's token.
#[derive(Clone)]
pub struct Client {
    base: String,
    key: String,
    http: slopmax_net::Client,
    /// For the event stream: no deadline, but a stall longer than the
    /// pings' interval ends it.
    stream: slopmax_net::Client,
    /// For a hub on another machine: the version its `/healthz` last gave,
    /// which an answer this client can't read is put down to.
    hub: Option<Arc<Mutex<Option<String>>>>,
}

/// What `/healthz` says of the program serving.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct Health {
    pub version: String,
    /// The proxy's process (older proxies leave it out, as does a hub
    /// reached over the tailnet).
    pub pid: Option<u32>,
    /// Whether it takes this client's key (older proxies leave it out):
    /// `Some(false)` for a proxy started from another home, or before the
    /// key changed.
    pub owner: Option<bool>,
    /// What this client may do there, by its key or its tailnet identity
    /// (older proxies leave it out).
    #[serde(default)]
    pub access: Option<Access>,
    /// `tailnet` when the request came over the tailnet.
    #[serde(default)]
    pub via: Option<String>,
    /// The tailnet login it knows this machine by.
    #[serde(default)]
    pub login: Option<String>,
    /// The name it knows this machine by: a client key's, or its tailnet
    /// machine name.
    #[serde(default)]
    pub machine: Option<String>,
}

impl Client {
    /// A client of the daemon at `base` (`http://127.0.0.1:8318`).
    pub fn new(base: impl Into<String>, key: impl Into<String>) -> Self {
        let http = slopmax_net::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            // A refresh polls every account, and a sign-in or import waits
            // on providers.
            .timeout(Duration::from_secs(120))
            .plain_http()
            .build();
        let stream = slopmax_net::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .read_timeout(Duration::from_secs(45))
            .plain_http()
            .build();
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            key: key.into(),
            http,
            stream,
            hub: None,
        }
    }

    /// A client of a hub on another machine (`https://hub.example.ts.net:7567`),
    /// reached with `token`: a client key, or the placeholder a hub that
    /// knows this machine by its tailnet login takes. HTTPS is checked
    /// against the system's trusted roots.
    pub fn remote(base: impl Into<String>, token: impl Into<String>) -> Self {
        // The first TLS connection to a new tailnet name waits while the
        // hub's Tailscale makes its certificate, up to half a minute.
        let handshake = Duration::from_secs(30);
        let http = slopmax_net::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .handshake_timeout(handshake)
            .timeout(Duration::from_secs(120))
            .build();
        let stream = slopmax_net::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .handshake_timeout(handshake)
            .read_timeout(Duration::from_secs(45))
            .build();
        Self {
            base: base.into().trim_end_matches('/').to_owned(),
            key: token.into(),
            http,
            stream,
            hub: Some(Arc::default()),
        }
    }

    /// The hub's version, when this client is a hub's and has heard it.
    fn hub_version(&self) -> Option<String> {
        self.hub
            .as_ref()
            .and_then(|hub| hub.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }

    fn unexpected(&self, what: String) -> Error {
        unexpected(what, self.hub_version().as_deref())
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    /// The version of the slopmax answering, if one does.
    pub async fn health(&self) -> Option<Health> {
        self.health_within(Duration::from_secs(3)).await
    }

    /// [`Client::health`], waiting at most `timeout` for the answer. A hub
    /// reached over HTTPS for the first time can take up to 30 seconds,
    /// while its Tailscale makes its certificate.
    pub async fn health_within(&self, timeout: Duration) -> Option<Health> {
        let bytes = self
            .http
            .get(format!("{}/healthz", self.base))
            .bearer_auth(&self.key)
            .timeout(timeout)
            .send()
            .await
            .ok()?
            .bytes()
            .await
            .ok()?;
        let health = health(&bytes)?;
        if let Some(hub) = &self.hub {
            *hub.lock().unwrap_or_else(|p| p.into_inner()) = Some(health.version.clone());
        }
        Some(health)
    }

    async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&(impl Serialize + ?Sized)>,
    ) -> Result<T> {
        let bytes = self.send(method, path, body).await?;
        serde_json::from_slice(&bytes)
            .map_err(|e| self.unexpected(format!("reading {path}'s answer: {e}")))
    }

    /// A call answered with no body.
    async fn act(
        &self,
        method: Method,
        path: &str,
        body: Option<&(impl Serialize + ?Sized)>,
    ) -> Result<()> {
        self.send(method, path, body).await.map(drop)
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&(impl Serialize + ?Sized)>,
    ) -> Result<bytes::Bytes> {
        let url = format!("{}{PREFIX}/{path}", self.base);
        let mut request = self.http.request(method, url).bearer_auth(&self.key);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|e| Error::Unreachable(e.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| Error::Unreachable(e.to_string()))?;
        if status.is_success() {
            return Ok(bytes);
        }
        Err(match serde_json::from_slice::<ApiError>(&bytes) {
            Ok(error) => Error::Api(error),
            Err(_) => self.unexpected(format!("{path} answered {status}")),
        })
    }

    const NONE: Option<&'static ()> = None;

    pub async fn status(&self) -> Result<Report> {
        self.call(Method::GET, "status", Self::NONE).await
    }

    /// Polls every account's usage first.
    pub async fn refresh(&self) -> Result<Report> {
        self.call(Method::POST, "refresh", Self::NONE).await
    }

    /// Has the daemon read the account files and config.toml again.
    pub async fn sync(&self) -> Result<Report> {
        self.call(Method::POST, "sync", Self::NONE).await
    }

    /// Stops the daemon; with `restart`, so its service manager starts it
    /// again.
    pub async fn shutdown(&self, restart: bool) -> Result<Stopping> {
        self.call(
            Method::POST,
            "shutdown",
            Some(&Shutdown {
                restart,
                ..Default::default()
            }),
        )
        .await
    }

    /// Hands the proxy to the slopmax binary at `exe`; answers once that
    /// one serves, and this one finishes its requests and stops.
    pub async fn hand_off(&self, exe: &str) -> Result<Stopping> {
        self.call(
            Method::POST,
            "shutdown",
            Some(&Shutdown {
                exe: Some(exe.to_owned()),
                ..Default::default()
            }),
        )
        .await
    }

    pub async fn add_account(&self, account: &AddAccount) -> Result<AccountAdded> {
        self.call(Method::POST, "accounts", Some(account)).await
    }

    pub async fn update_account(&self, id: &str, patch: &AccountPatch) -> Result<Report> {
        self.call(
            Method::PATCH,
            &format!("accounts/{}", escape(id)),
            Some(patch),
        )
        .await
    }

    pub async fn remove_account(&self, id: &str) -> Result<Report> {
        self.call(
            Method::DELETE,
            &format!("accounts/{}", escape(id)),
            Self::NONE,
        )
        .await
    }

    /// Prefers account `id` for its provider's new sessions.
    pub async fn pin(&self, id: &str) -> Result<Report> {
        self.call(
            Method::POST,
            &format!("accounts/{}/pin", escape(id)),
            Self::NONE,
        )
        .await
    }

    pub async fn unpin_all(&self) -> Result<Report> {
        self.call(Method::DELETE, "pins", Self::NONE).await
    }

    /// Has slopmax refresh an imported login itself.
    pub async fn own(&self, id: &str) -> Result<Report> {
        self.call(
            Method::POST,
            &format!("accounts/{}/own", escape(id)),
            Self::NONE,
        )
        .await
    }

    pub async fn redeem(&self, id: &str, asked: &RedeemRequest) -> Result<RedeemResult> {
        self.call(
            Method::POST,
            &format!("accounts/{}/redeem", escape(id)),
            Some(asked),
        )
        .await
    }

    pub async fn import(&self, asked: &ImportRequest) -> Result<ImportResult> {
        self.call(Method::POST, "imports", Some(asked)).await
    }

    /// Starts a subscription sign-in, whose progress comes as
    /// [`Event::Login`] events with the id it answers with.
    pub async fn start_login(&self, asked: &StartLogin) -> Result<LoginStarted> {
        self.call(Method::POST, "logins", Some(asked)).await
    }

    /// Hands a sign-in the address the browser landed on, from another
    /// machine.
    pub async fn paste_login(&self, id: &str, address: &str) -> Result<()> {
        let pasted = PasteAddress {
            address: address.to_owned(),
        };
        self.act(
            Method::POST,
            &format!("logins/{}/paste", escape(id)),
            Some(&pasted),
        )
        .await
    }

    pub async fn cancel_login(&self, id: &str) -> Result<()> {
        self.act(
            Method::DELETE,
            &format!("logins/{}", escape(id)),
            Self::NONE,
        )
        .await
    }

    pub async fn settings(&self) -> Result<SettingsView> {
        self.call(Method::GET, "settings", Self::NONE).await
    }

    /// Changes live settings, which apply at once and are written to
    /// config.toml.
    pub async fn change_settings(&self, patch: &LivePatch) -> Result<SettingsView> {
        self.call(Method::PATCH, "settings", Some(patch)).await
    }

    pub async fn keys(&self) -> Result<Vec<KeyInfo>> {
        self.call(Method::GET, "keys", Self::NONE).await
    }

    /// Makes a client key, shown in full this once.
    pub async fn make_key(&self, asked: &MakeKey) -> Result<NewKey> {
        self.call(Method::POST, "keys", Some(asked)).await
    }

    pub async fn remove_key(&self, name: &str) -> Result<Vec<KeyInfo>> {
        self.call(
            Method::DELETE,
            &format!("keys/{}", escape(name)),
            Self::NONE,
        )
        .await
    }

    pub async fn usage(&self, range: SummaryRange, by: SummaryBy) -> Result<Summary> {
        let query = format!("usage?range={}&by={}", word(&range), word(&by));
        self.call(Method::GET, &query, Self::NONE).await
    }

    pub async fn history(&self, range: HistoryRange) -> Result<History> {
        let query = format!("history?range={}", word(&range));
        self.call(Method::GET, &query, Self::NONE).await
    }

    /// slopmax on the tailnet: whether and where it is published, and who
    /// may use it.
    pub async fn tailnet(&self) -> Result<TailnetView> {
        self.call(Method::GET, "tailnet", Self::NONE).await
    }

    /// Changes who may use slopmax over the tailnet, written to
    /// config.toml.
    pub async fn change_tailnet(&self, patch: &TailnetPatch) -> Result<TailnetView> {
        self.call(Method::PATCH, "tailnet", Some(patch)).await
    }

    /// Sends a test notification to the configured webhook or command.
    pub async fn notify_test(&self) -> Result<()> {
        self.act(Method::POST, "notify/test", Self::NONE).await
    }

    /// Follows the event stream: [`Event::Hello`] and [`Event::Status`]
    /// first, then each change as it happens.
    pub async fn events(&self) -> Result<Events> {
        let response = self
            .stream
            .get(format!("{}{PREFIX}/events", self.base))
            .bearer_auth(&self.key)
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|e| Error::Unreachable(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            let bytes = response.bytes().await.unwrap_or_default();
            return Err(match serde_json::from_slice::<ApiError>(&bytes) {
                Ok(error) => Error::Api(error),
                Err(_) => self.unexpected(format!("events answered {status}")),
            });
        }
        Ok(Events {
            body: response.into_body(),
            buffer: BytesMut::new(),
            hub_version: self.hub_version(),
        })
    }
}

/// An answer this client can't read, put down to the hub's version when
/// it is known.
fn unexpected(what: String, hub_version: Option<&str>) -> Error {
    Error::Unexpected(match hub_version {
        Some(version) => format!("{what} (the hub runs slopmax {version})"),
        None => what,
    })
}

/// What a `/healthz` answer says, when slopmax gave it.
fn health(bytes: &[u8]) -> Option<Health> {
    #[derive(serde::Deserialize)]
    struct Answer {
        service: String,
        version: String,
        #[serde(default)]
        pid: Option<u32>,
        #[serde(default)]
        owner: Option<bool>,
        #[serde(default)]
        access: Option<Access>,
        #[serde(default)]
        via: Option<String>,
        #[serde(default)]
        login: Option<String>,
        #[serde(default)]
        machine: Option<String>,
    }
    let answer: Answer = serde_json::from_slice(bytes).ok()?;
    (answer.service == "slopmax").then_some(Health {
        version: answer.version,
        pid: answer.pid,
        owner: answer.owner,
        access: answer.access,
        via: answer.via,
        login: answer.login,
        machine: answer.machine,
    })
}

/// A name as the API spells it in a path or query: its serde form.
fn word(value: &impl Serialize) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(word)) => word,
        _ => unreachable!("path words serialize as strings"),
    }
}

/// A path segment with what would end it escaped.
fn escape(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The event stream, one event at a time.
pub struct Events {
    body: slopmax_net::body::Body,
    buffer: BytesMut,
    /// The hub's version, for events this client can't read.
    hub_version: Option<String>,
}

impl Events {
    /// The next event; `None` once the stream ends (the daemon stopped),
    /// or an error when it stalls or breaks.
    pub async fn next(&mut self) -> Option<Result<Event>> {
        loop {
            if let Some(event) = self.take() {
                return Some(event);
            }
            match self.body.frame().await? {
                Ok(frame) => {
                    if let Ok(data) = frame.into_data() {
                        self.buffer.extend_from_slice(&data);
                    }
                }
                Err(e) => return Some(Err(Error::Unreachable(e.to_string()))),
            }
        }
    }

    /// The first whole event in the buffer, if one has arrived: its `data`
    /// lines, joined. Comments and other fields are skipped.
    fn take(&mut self) -> Option<Result<Event>> {
        loop {
            let end = find_blank_line(&self.buffer)?;
            let block = self.buffer.split_to(end.0);
            self.buffer.advance(end.1);
            let mut data = Vec::new();
            for line in block[..].split(|&b| b == b'\n') {
                let line = line.strip_suffix(b"\r").unwrap_or(line);
                if let Some(rest) = line.strip_prefix(b"data:") {
                    if !data.is_empty() {
                        data.push(b'\n');
                    }
                    data.extend_from_slice(rest.strip_prefix(b" ").unwrap_or(rest));
                }
            }
            if data.is_empty() {
                continue;
            }
            return Some(serde_json::from_slice(&data).map_err(|e| {
                unexpected(
                    format!("reading an event: {e}"),
                    self.hub_version.as_deref(),
                )
            }));
        }
    }
}

/// Where the first blank line starts, and how long it is with the line
/// break before it.
fn find_blank_line(buffer: &[u8]) -> Option<(usize, usize)> {
    let lf = buffer.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let crlf = buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| (i, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_words_are_their_serde_names() {
        assert_eq!(word(&HistoryRange::Week), "7d");
        assert_eq!(word(&SummaryBy::Model), "model");
        assert_eq!(escape("work laptop/1"), "work%20laptop%2F1");
    }

    #[test]
    fn events_are_read_from_their_data_lines() {
        let mut events = Events {
            body: slopmax_net::body::empty(),
            buffer: BytesMut::new(),
            hub_version: None,
        };
        events.buffer.extend_from_slice(
            b": a comment\n\ndata: {\"_tag\":\"Ping\"}\r\n\r\ndata: {\"_tag\":\"Hello\",\n",
        );
        assert_eq!(events.take().unwrap().unwrap(), Event::Ping {});
        // The rest has not arrived.
        assert!(events.take().is_none());
        events
            .buffer
            .extend_from_slice(b"data: \"version\":\"1.0\"}\n\n");
        assert_eq!(
            events.take().unwrap().unwrap(),
            Event::Hello {
                version: "1.0".into(),
            }
        );
    }

    #[test]
    fn health_reads_with_and_without_what_hubs_add() {
        let old =
            health(br#"{"service":"slopmax","version":"0.9.0","pid":42,"owner":true}"#).unwrap();
        assert_eq!(
            old,
            Health {
                version: "0.9.0".into(),
                pid: Some(42),
                owner: Some(true),
                access: None,
                via: None,
                login: None,
                machine: None,
            }
        );
        let hub = health(
            br#"{"service":"slopmax","version":"0.10.0","owner":false,"via":"tailnet",
                "access":"view","login":"you@github","machine":"laptop","later":1}"#,
        )
        .unwrap();
        assert_eq!(hub.pid, None);
        assert_eq!(hub.access, Some(Access::View));
        assert_eq!(hub.via.as_deref(), Some("tailnet"));
        assert_eq!(hub.login.as_deref(), Some("you@github"));
        assert_eq!(hub.machine.as_deref(), Some("laptop"));
        assert_eq!(health(br#"{"service":"other","version":"1"}"#), None);
        assert_eq!(health(b"not json"), None);
    }

    #[test]
    fn answers_it_cannot_read_name_the_hubs_version() {
        assert_eq!(
            unexpected("reading tailnet's answer: oops".into(), Some("0.10.0")),
            Error::Unexpected(
                "reading tailnet's answer: oops (the hub runs slopmax 0.10.0)".into()
            )
        );
        assert_eq!(
            unexpected("status answered 502".into(), None).message(),
            "status answered 502"
        );
        let local = Client::new("http://127.0.0.1:1", "sm-key");
        assert_eq!(local.hub_version(), None);
        let remote = Client::remote("https://hub.example.ts.net:7567/", "tailnet");
        assert_eq!(remote.base(), "https://hub.example.ts.net:7567");
        assert_eq!(remote.hub_version(), None);
    }

    /// A stand-in hub on 127.0.0.1 that answers `/healthz` and nothing
    /// this client reads.
    async fn hub() -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(slopmax_net::server::serve(
            listener,
            |request: slopmax_net::server::Request| async move {
                let (status, body) = match request.uri().path() {
                    "/healthz" => (
                        200,
                        r#"{"service":"slopmax","version":"9.9.9","owner":false,"access":"admin"}"#,
                    ),
                    "/slopmax/api/tailnet" => (200, r#"{"tailscale":"sideways"}"#),
                    _ => (502, "bad gateway"),
                };
                http::Response::builder()
                    .status(status)
                    .header("content-type", "application/json")
                    .body(slopmax_net::body::full(body))
                    .unwrap()
            },
            std::future::pending(),
        ));
        base
    }

    #[tokio::test]
    async fn a_remote_client_reads_the_hub_and_puts_what_it_cannot_read_down_to_its_version() {
        let base = hub().await;
        let client = Client::remote(&base, "tailnet");
        // Before it has heard the version, an error says only what failed.
        let error = client.tailnet().await.unwrap_err();
        assert!(!error.message().contains("the hub runs"), "{error}");

        let health = client.health_within(Duration::from_secs(5)).await.unwrap();
        assert_eq!(health.access, Some(Access::Admin));
        let error = client.tailnet().await.unwrap_err();
        assert!(
            error.message().starts_with("reading tailnet's answer: ")
                && error.message().ends_with(" (the hub runs slopmax 9.9.9)"),
            "{error}"
        );
        let error = client.status().await.unwrap_err();
        assert_eq!(
            error,
            Error::Unexpected(
                "status answered 502 Bad Gateway (the hub runs slopmax 9.9.9)".into()
            )
        );
        // A client of this machine's own daemon says no more than before.
        let local = Client::new(&base, "sm-key");
        assert!(local.health().await.is_some());
        assert_eq!(
            local.status().await.unwrap_err(),
            Error::Unexpected("status answered 502 Bad Gateway".into())
        );
    }
}
