//! Outbound HTTP/1.1 over rustls: pooled keep-alive connections, optional
//! HTTP CONNECT or SOCKS5 proxies, and timeouts.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use http::header::USER_AGENT;
use http::{HeaderMap, HeaderName, HeaderValue, Method, Request, StatusCode, Uri};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::connect::proxy::{SocksV5, Tunnel};
use hyper_util::client::legacy::{self, Client as Pool};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::net::TcpStream;
use tokio::time::Instant;
use tower_service::Service;

use super::body::{self, BoxError, IdleTimeout};
use super::form;

/// Largest response body [`Response::bytes`] reads into memory.
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Why a request failed.
#[derive(Debug)]
pub struct Error {
    kind: Kind,
    source: Option<BoxError>,
}

#[derive(Debug)]
enum Kind {
    Request,
    Connect,
    Timeout,
    Status(StatusCode),
    Body,
    Decode,
}

impl Error {
    fn new(kind: Kind, source: impl Into<BoxError>) -> Self {
        Self {
            kind,
            source: Some(source.into()),
        }
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self.kind, Kind::Timeout)
    }

    pub fn status(&self) -> Option<StatusCode> {
        match self.kind {
            Kind::Status(status) => Some(status),
            _ => None,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let what = match &self.kind {
            Kind::Request => "invalid request",
            Kind::Connect => "request failed",
            Kind::Timeout => "timed out",
            Kind::Status(status) => return write!(f, "HTTP {status}"),
            Kind::Body => "reading the response failed",
            Kind::Decode => "unexpected response",
        };
        f.write_str(what)?;
        // The root cause is the useful part: "connection refused", a TLS
        // alert, a JSON error.
        let mut cause = self.source.as_deref().map(|e| e as &dyn std::error::Error);
        let mut last = None;
        while let Some(e) = cause {
            last = Some(e);
            cause = e.source();
        }
        if let Some(root) = last {
            write!(f, ": {root}")?;
        }
        Ok(())
    }
}

// The root cause is already part of the message, so it is not also
// exposed as a source: `{:#}` would print it twice.
impl std::error::Error for Error {}

/// An upstream proxy: `http://[user:pass@]host:port` (CONNECT tunnel),
/// `socks5://…` (local DNS), or `socks5h://…` (DNS at the proxy).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proxy {
    uri: Uri,
    kind: ProxyKind,
    auth: Option<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProxyKind {
    Http,
    Socks,
    SocksRemoteDns,
}

impl Proxy {
    pub fn parse(text: &str) -> Result<Self, String> {
        let text = text.trim();
        let (scheme, rest) = text
            .split_once("://")
            .ok_or_else(|| format!("proxy {text:?} needs a scheme, like http:// or socks5://"))?;
        let kind = match scheme.to_ascii_lowercase().as_str() {
            "http" => ProxyKind::Http,
            "socks5" => ProxyKind::Socks,
            "socks5h" => ProxyKind::SocksRemoteDns,
            other => return Err(format!("unsupported proxy scheme {other:?}")),
        };
        let rest = rest.trim_end_matches('/');
        let (auth, host) = match rest.rsplit_once('@') {
            Some((userinfo, host)) => {
                let (user, pass) = userinfo.split_once(':').unwrap_or((userinfo, ""));
                (
                    Some((form::percent_decode(user), form::percent_decode(pass))),
                    host,
                )
            }
            None => (None, rest),
        };
        let default_port = if kind == ProxyKind::Http { 80 } else { 1080 };
        let authority = if host
            .rsplit_once(':')
            .is_some_and(|(_, p)| p.parse::<u16>().is_ok())
        {
            host.to_owned()
        } else {
            format!("{host}:{default_port}")
        };
        let uri: Uri = format!("http://{authority}")
            .parse()
            .map_err(|e| format!("invalid proxy {text:?}: {e}"))?;
        Ok(Self { uri, kind, auth })
    }

    /// The proxy named by `HTTPS_PROXY` or `ALL_PROXY` (either case).
    pub fn from_env() -> Option<Self> {
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .find(|value| !value.trim().is_empty())
            .and_then(|value| Self::parse(&value).ok())
    }

    /// Makes `proxy` the default for every client built from now on, ahead
    /// of the environment. Set once, from the config.
    pub fn set_default(proxy: Self) {
        let _ = DEFAULT_PROXY.set(proxy);
    }
}

static DEFAULT_PROXY: std::sync::OnceLock<Proxy> = std::sync::OnceLock::new();

impl fmt::Display for Proxy {
    /// The proxy without its credentials.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scheme = match self.kind {
            ProxyKind::Http => "http",
            ProxyKind::Socks => "socks5",
            ProxyKind::SocksRemoteDns => "socks5h",
        };
        let authority = self.uri.authority().map_or("", |a| a.as_str());
        write!(f, "{scheme}://{authority}")
    }
}

/// Hosts that skip the proxy: loopback, plus `NO_PROXY` entries
/// (`*`, `example.com`, `.example.com`).
#[derive(Debug, Default)]
struct Bypass(Vec<String>);

impl Bypass {
    fn from_env() -> Self {
        let list = std::env::var("NO_PROXY")
            .or_else(|_| std::env::var("no_proxy"))
            .unwrap_or_default();
        Self(
            list.split(',')
                .map(|entry| entry.trim().trim_start_matches('.').to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
        )
    }

    fn skips(&self, host: &str) -> bool {
        let host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        let loopback = host == "localhost"
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback());
        loopback
            || self.0.iter().any(|entry| {
                entry == "*"
                    || host == *entry
                    || host
                        .strip_suffix(entry.as_str())
                        .is_some_and(|prefix| prefix.ends_with('.'))
            })
    }
}

#[derive(Clone)]
enum Through {
    Tunnel(Tunnel<HttpConnector>),
    Socks(SocksV5<HttpConnector>),
}

/// Opens TCP connections, directly or through the configured proxy.
#[derive(Clone)]
struct Connector {
    direct: HttpConnector,
    through: Option<Through>,
    bypass: Arc<Bypass>,
}

type Connecting = Pin<Box<dyn Future<Output = Result<TokioIo<TcpStream>, BoxError>> + Send>>;

impl Service<Uri> for Connector {
    type Response = TokioIo<TcpStream>;
    type Error = BoxError;
    type Future = Connecting;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, dst: Uri) -> Connecting {
        let proxied = !dst.host().is_some_and(|host| self.bypass.skips(host));
        match &mut self.through {
            Some(Through::Tunnel(tunnel)) if proxied => {
                let connecting = tunnel.call(dst);
                Box::pin(async move { connecting.await.map_err(Into::into) })
            }
            Some(Through::Socks(socks)) if proxied => {
                let connecting = socks.call(dst);
                Box::pin(async move { connecting.await.map_err(Into::into) })
            }
            _ => {
                let connecting = self.direct.call(dst);
                Box::pin(async move { connecting.await.map_err(Into::into) })
            }
        }
    }
}

/// The system's trusted roots, loaded once.
fn system_roots() -> Result<Arc<rustls::RootCertStore>, &'static str> {
    static ROOTS: OnceLock<Option<Arc<rustls::RootCertStore>>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            let (added, _) =
                roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            (added > 0).then(|| Arc::new(roots))
        })
        .clone()
        .ok_or("no system CA certificates found; HTTPS is unavailable")
}

/// TLS with the system roots (or none, so only plain HTTP works).
fn tls_config(roots: Option<Arc<rustls::RootCertStore>>) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .with_root_certificates(roots.unwrap_or_else(|| Arc::new(rustls::RootCertStore::empty())))
        .with_no_client_auth()
}

/// URL prefixes to send elsewhere. Tests stand in for a provider this way:
/// `https://api.anthropic.com` → `http://127.0.0.1:PORT`.
#[derive(Debug, Clone, Default)]
pub struct Origins(Arc<Vec<(String, String)>>);

impl Origins {
    pub fn new<'a>(pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        Self(Arc::new(
            pairs
                .into_iter()
                .map(|(from, to)| (from.to_owned(), to.to_owned()))
                .collect(),
        ))
    }

    fn apply(&self, url: &str) -> Option<String> {
        self.0.iter().find_map(|(from, to)| {
            let rest = url.strip_prefix(from.as_str())?;
            (rest.is_empty() || rest.starts_with(['/', '?'])).then(|| format!("{to}{rest}"))
        })
    }
}

/// An HTTP client. Cloning is cheap and shares the connection pool.
#[derive(Clone)]
pub struct Client {
    pool: Pool<HttpsConnector<Connector>, Full<Bytes>>,
    /// Why HTTPS cannot work, when the system has no trusted roots.
    no_tls: Option<&'static str>,
    user_agent: Option<HeaderValue>,
    timeout: Option<Duration>,
    read_timeout: Option<Duration>,
    origins: Origins,
}

/// Configures a [`Client`].
#[derive(Debug, Default)]
pub struct Builder {
    user_agent: Option<String>,
    connect_timeout: Option<Duration>,
    timeout: Option<Duration>,
    read_timeout: Option<Duration>,
    proxy: Option<Proxy>,
    origins: Origins,
}

impl Builder {
    pub fn user_agent(mut self, agent: &str) -> Self {
        self.user_agent = Some(agent.to_owned());
        self
    }

    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = Some(timeout);
        self
    }

    /// Total time for a request, including reading its body.
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Longest wait for the response headers and between body chunks.
    pub fn read_timeout(mut self, timeout: Duration) -> Self {
        self.read_timeout = Some(timeout);
        self
    }

    /// Sends requests through `proxy` (otherwise `HTTPS_PROXY`/`ALL_PROXY`).
    pub fn proxy(mut self, proxy: Option<Proxy>) -> Self {
        self.proxy = proxy;
        self
    }

    /// Sends requests for some URL prefixes elsewhere.
    pub fn origins(mut self, origins: Origins) -> Self {
        self.origins = origins;
        self
    }

    pub fn build(self) -> Client {
        let mut direct = HttpConnector::new();
        direct.enforce_http(false);
        direct.set_nodelay(true);
        direct.set_keepalive(Some(Duration::from_secs(60)));
        direct.set_connect_timeout(Some(
            self.connect_timeout.unwrap_or(Duration::from_secs(10)),
        ));

        let through = self
            .proxy
            .or_else(|| DEFAULT_PROXY.get().cloned())
            .or_else(Proxy::from_env)
            .map(|proxy| match proxy.kind {
                ProxyKind::Http => {
                    let mut tunnel = Tunnel::new(proxy.uri, direct.clone());
                    if let Some((user, pass)) = &proxy.auth {
                        let token = STANDARD.encode(format!("{user}:{pass}"));
                        if let Ok(value) = HeaderValue::from_str(&format!("Basic {token}")) {
                            tunnel = tunnel.with_auth(value);
                        }
                    }
                    Through::Tunnel(tunnel)
                }
                ProxyKind::Socks | ProxyKind::SocksRemoteDns => {
                    let mut socks = SocksV5::new(proxy.uri, direct.clone())
                        .local_dns(proxy.kind == ProxyKind::Socks);
                    if let Some((user, pass)) = proxy.auth {
                        socks = socks.with_auth(user, pass);
                    }
                    Through::Socks(socks)
                }
            });
        let connector = Connector {
            direct,
            through,
            bypass: Arc::new(Bypass::from_env()),
        };
        let roots = system_roots();
        let https = HttpsConnectorBuilder::new()
            .with_tls_config(tls_config(roots.clone().ok()))
            .https_or_http()
            .enable_http1()
            .wrap_connector(connector);
        let pool = legacy::Client::builder(TokioExecutor::new())
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_timer(TokioTimer::new())
            .build(https);
        Client {
            pool,
            no_tls: roots.err(),
            user_agent: self
                .user_agent
                .and_then(|agent| HeaderValue::from_str(&agent).ok()),
            timeout: self.timeout,
            read_timeout: self.read_timeout,
            origins: self.origins,
        }
    }
}

impl Client {
    pub fn builder() -> Builder {
        Builder::default()
    }

    pub fn get(&self, url: impl AsRef<str>) -> RequestBuilder {
        self.request(Method::GET, url)
    }

    pub fn post(&self, url: impl AsRef<str>) -> RequestBuilder {
        self.request(Method::POST, url)
    }

    pub fn request(&self, method: Method, url: impl AsRef<str>) -> RequestBuilder {
        let rewritten = self.origins.apply(url.as_ref());
        let url = rewritten.as_deref().unwrap_or(url.as_ref());
        RequestBuilder {
            client: self.clone(),
            method,
            uri: url
                .parse::<Uri>()
                .map_err(|e| Error::new(Kind::Request, format!("invalid URL {url:?}: {e}"))),
            headers: HeaderMap::new(),
            body: Bytes::new(),
            timeout: self.timeout,
            invalid: None,
        }
    }
}

/// A request being built; nothing is sent until [`RequestBuilder::send`].
pub struct RequestBuilder {
    client: Client,
    method: Method,
    uri: Result<Uri, Error>,
    headers: HeaderMap,
    body: Bytes,
    timeout: Option<Duration>,
    invalid: Option<Error>,
}

impl RequestBuilder {
    pub fn header(mut self, name: &str, value: impl AsRef<str>) -> Self {
        let name = HeaderName::from_bytes(name.as_bytes());
        match (name, HeaderValue::from_str(value.as_ref())) {
            (Ok(name), Ok(value)) => {
                self.headers.insert(name, value);
            }
            (Err(e), _) => self.invalid = Some(Error::new(Kind::Request, e)),
            (_, Err(e)) => self.invalid = Some(Error::new(Kind::Request, e)),
        }
        self
    }

    /// Adds every header in `headers`, replacing same-named ones.
    pub fn headers(mut self, headers: HeaderMap) -> Self {
        let mut last = None;
        for (name, value) in headers {
            let name = match name {
                Some(name) => {
                    self.headers.remove(&name);
                    last = Some(name.clone());
                    name
                }
                None => match &last {
                    Some(name) => name.clone(),
                    None => continue,
                },
            };
            self.headers.append(name, value);
        }
        self
    }

    pub fn bearer_auth(self, token: &str) -> Self {
        self.header("authorization", format!("Bearer {token}"))
    }

    pub fn json<T: Serialize + ?Sized>(mut self, value: &T) -> Self {
        match serde_json::to_vec(value) {
            Ok(body) => {
                self.body = body.into();
                self.header("content-type", "application/json")
            }
            Err(e) => {
                self.invalid = Some(Error::new(Kind::Request, e));
                self
            }
        }
    }

    pub fn form<'a>(mut self, pairs: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        self.body = form::encode(pairs).into();
        self.header("content-type", "application/x-www-form-urlencoded")
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = body.into();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub async fn send(self) -> Result<Response, Error> {
        if let Some(error) = self.invalid {
            return Err(error);
        }
        let uri = self.uri?;
        if let Some(reason) = self.client.no_tls
            && uri.scheme_str() == Some("https")
        {
            return Err(Error::new(Kind::Connect, reason));
        }
        let mut request = Request::new(Full::new(self.body));
        *request.method_mut() = self.method;
        *request.uri_mut() = uri;
        *request.headers_mut() = self.headers;
        if let Some(agent) = &self.client.user_agent {
            request
                .headers_mut()
                .entry(USER_AGENT)
                .or_insert_with(|| agent.clone());
        }

        let deadline = self.timeout.map(|t| Instant::now() + t);
        let wait = match (deadline, self.client.read_timeout) {
            (Some(deadline), Some(read)) => Some(deadline.min(Instant::now() + read)),
            (deadline, read) => deadline.or_else(|| read.map(|r| Instant::now() + r)),
        };
        let responding = self.client.pool.request(request);
        let response = match wait {
            Some(at) => tokio::time::timeout_at(at, responding)
                .await
                .map_err(|_| Error::new(Kind::Timeout, "no response"))?,
            None => responding.await,
        }
        .map_err(|e| Error::new(Kind::Connect, e))?;
        Ok(Response {
            inner: response,
            deadline,
            read_timeout: self.client.read_timeout,
        })
    }
}

/// A response whose headers have arrived; the body has not been read yet.
pub struct Response {
    inner: http::Response<Incoming>,
    deadline: Option<Instant>,
    read_timeout: Option<Duration>,
}

impl Response {
    pub fn status(&self) -> StatusCode {
        self.inner.status()
    }

    pub fn headers(&self) -> &HeaderMap {
        self.inner.headers()
    }

    /// Fails with the status when it is not a success.
    pub fn error_for_status(self) -> Result<Self, Error> {
        let status = self.status();
        if status.is_success() {
            Ok(self)
        } else {
            Err(Error {
                kind: Kind::Status(status),
                source: None,
            })
        }
    }

    /// Reads the whole body (up to 64 MiB).
    pub async fn bytes(self) -> Result<Bytes, Error> {
        let deadline = self.deadline;
        // The concrete body, not the boxed one: a `BoxError` body would make
        // callers' futures fail rustc's higher-ranked `Send` check.
        let reading = body::read(self.inner.into_body(), MAX_BODY);
        let read = match deadline {
            Some(at) => tokio::time::timeout_at(at, reading)
                .await
                .map_err(|_| Error::new(Kind::Timeout, "reading the body"))?,
            None => reading.await,
        };
        read.map_err(|e| Error::new(Kind::Body, e))
    }

    /// The body as text; invalid UTF-8 is replaced.
    pub async fn text(self) -> Result<String, Error> {
        let bytes = self.bytes().await?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn json<T: DeserializeOwned>(self) -> Result<T, Error> {
        let bytes = self.bytes().await?;
        serde_json::from_slice(&bytes).map_err(|e| Error::new(Kind::Decode, e))
    }

    /// The connection, once a `101 Switching Protocols` hands it over (a
    /// WebSocket handshake).
    pub async fn upgrade(self) -> Result<TokioIo<hyper::upgrade::Upgraded>, Error> {
        hyper::upgrade::on(self.inner)
            .await
            .map(TokioIo::new)
            .map_err(|e| Error::new(Kind::Connect, e))
    }

    /// The body as a stream of chunks, failing if it stalls for longer than
    /// the client's read timeout.
    pub fn into_body(self) -> body::Body {
        match self.read_timeout {
            Some(idle) => body::boxed(IdleTimeout::new(self.inner.into_body(), idle)),
            None => body::boxed(self.inner.into_body()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proxy_urls() {
        let proxy = Proxy::parse("http://user:p%40ss@proxy.local:3128").unwrap();
        assert_eq!(proxy.kind, ProxyKind::Http);
        assert_eq!(proxy.auth, Some(("user".into(), "p@ss".into())));
        assert_eq!(proxy.to_string(), "http://proxy.local:3128");
        let socks = Proxy::parse("socks5h://10.0.0.2").unwrap();
        assert_eq!(socks.kind, ProxyKind::SocksRemoteDns);
        assert_eq!(socks.to_string(), "socks5h://10.0.0.2:1080");
        assert!(Proxy::parse("proxy.local:3128").is_err());
        assert!(Proxy::parse("ftp://proxy.local").is_err());
    }

    #[test]
    fn origins_rewrite_matching_prefixes() {
        let origins = Origins::new([("https://chatgpt.com/backend-api", "http://127.0.0.1:9")]);
        assert_eq!(
            origins
                .apply("https://chatgpt.com/backend-api/wham/usage")
                .as_deref(),
            Some("http://127.0.0.1:9/wham/usage")
        );
        assert_eq!(origins.apply("https://chatgpt.com/backend-apix"), None);
        assert_eq!(origins.apply("https://api.anthropic.com/v1/messages"), None);
    }

    #[test]
    fn loopback_and_listed_hosts_bypass_the_proxy() {
        let bypass = Bypass(vec!["example.com".into(), "internal".into()]);
        assert!(bypass.skips("127.0.0.1"));
        assert!(bypass.skips("[::1]"));
        assert!(bypass.skips("localhost"));
        assert!(bypass.skips("api.example.com"));
        assert!(bypass.skips("example.com"));
        assert!(!bypass.skips("notexample.com"));
        assert!(!bypass.skips("chatgpt.com"));
        assert!(Bypass(vec!["*".into()]).skips("chatgpt.com"));
    }
}
