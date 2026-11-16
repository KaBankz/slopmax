//! Requests from the user's tailnet: what tailscaled says about who sent
//! one, and which machine is behind a tailnet address.
//!
//! tailscaled's `serve` passes each request to the owner-only socket with
//! headers naming the login it came from (`Tailscale-User-Login`) and the
//! address it came from (`X-Forwarded-For`). Those headers are believed only
//! on the [`Channel::Tailnet`] the listener marks, and are taken off every
//! request, whichever way it came, before anything else reads it. The one
//! exception is Funnel's mark, believed on every channel: it only refuses.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use http::{HeaderMap, header};

use super::App;
use crate::log;
use crate::net::headers::strip_tailnet;
use crate::net::server::Channel;
use crate::tailscale;

/// How long a machine found behind an address is believed.
const HIT: Duration = Duration::from_secs(600);
/// How long a failed lookup stands before the address is asked about again.
const MISS: Duration = Duration::from_secs(10);
/// How long a lookup may take before it counts as failed.
const WHOIS: Duration = Duration::from_secs(2);
/// How many addresses are remembered before the stale ones are let go.
const KEEP: usize = 1024;

/// What a request said about where it came from, taken before its tailnet
/// headers were removed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Seen {
    /// The listener it came in on.
    pub channel: Channel,
    /// The tailnet login tailscaled named; `None` for a tagged machine, or
    /// off the tailnet.
    pub login: Option<String>,
    /// The tailnet address it came from.
    pub peer: Option<IpAddr>,
    /// Whether it came from the internet through Tailscale Funnel.
    pub funnel: bool,
    /// The host it was sent to, for the browser check.
    pub origin_host: Option<String>,
    /// The scheme it was sent with, for the browser check.
    pub proto: Option<String>,
}

impl Seen {
    /// A request from this machine over TCP, which says nothing more.
    #[cfg(test)]
    pub fn tcp() -> Self {
        Self {
            channel: Channel::Tcp,
            login: None,
            peer: None,
            funnel: false,
            origin_host: None,
            proto: None,
        }
    }
}

/// What `request` says about where it came from, believed only when it
/// came over the tailnet socket. Its tailnet headers are removed either
/// way, so they reach nothing else: not the providers, not the logs.
///
/// Funnel's mark is believed whichever way the request came: Tailscale
/// passes Funnel's requests to the proxy's TCP port too, when that is what
/// it publishes, and a request that forges the mark only refuses itself.
pub(crate) fn take<B>(request: &mut http::Request<B>) -> Seen {
    let channel = request
        .extensions()
        .get::<Channel>()
        .copied()
        .unwrap_or(Channel::Tcp);
    let headers = request.headers();
    let mut seen = Seen {
        channel,
        login: None,
        peer: None,
        funnel: headers.contains_key("tailscale-funnel-request"),
        origin_host: None,
        proto: None,
    };
    if channel == Channel::Tailnet {
        seen.login = text(headers, "tailscale-user-login")
            .filter(|login| is_login(login))
            .map(str::to_owned);
        seen.peer = headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|v| v.to_str().ok())
            .and_then(|list| list.rsplit(',').next())
            .and_then(|last| last.trim().parse::<IpAddr>().ok())
            .filter(on_tailnet);
        seen.origin_host = text(headers, "x-forwarded-host")
            .or_else(|| text(headers, header::HOST.as_str()))
            .map(str::to_owned);
        seen.proto = text(headers, "x-forwarded-proto").map(str::to_owned);
    }
    strip_tailnet(request.headers_mut());
    seen
}

/// The header `name`, when it is readable text that says something.
fn text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Whether tailscaled's login header holds a login slopmax takes: visible
/// ASCII, and not an encoded word (`=?utf-8?q?…?=`), which is how a login
/// outside ASCII comes.
fn is_login(login: &str) -> bool {
    !login.is_empty() && login.bytes().all(|b| b.is_ascii_graphic()) && !login.contains("=?")
}

/// Whether `ip` is a tailnet address: in 100.64.0.0/10, or in
/// fd7a:115c:a1e0::/48.
fn on_tailnet(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            a == 100 && (b & 0xc0) == 64
        }
        IpAddr::V6(v6) => v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

/// Whether a request that would use the tailnet identity came from
/// slopmax's own page, or from no page at all, rather than another site in
/// the user's browser. A site that shares `*.ts.net` (same-site) is
/// another site.
pub(crate) fn browser_ok(headers: &HeaderMap, seen: &Seen) -> bool {
    let site = match headers.get("sec-fetch-site") {
        None => true,
        Some(value) => matches!(value.to_str(), Ok("same-origin" | "none")),
    };
    let origin = match headers.get(header::ORIGIN) {
        None => true,
        Some(value) => match (value.to_str(), &seen.origin_host) {
            (Ok(origin), Some(host)) => {
                let ours = format!("{}://{host}", seen.proto.as_deref().unwrap_or("https"));
                origin.eq_ignore_ascii_case(&ours)
            }
            _ => false,
        },
    };
    site && origin
}

/// A machine on the tailnet, as whois named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Machine {
    /// Its name on the tailnet: the first label of its DNS name.
    pub name: String,
    /// Its stable node id.
    pub id: String,
    /// Who it is signed in as; `None` when tagged.
    pub login: Option<String>,
    /// Whether it belongs to tags rather than a person.
    pub tagged: bool,
}

impl From<tailscale::Machine> for Machine {
    fn from(machine: tailscale::Machine) -> Self {
        Self {
            tagged: !machine.tags.is_empty() || machine.login.is_none(),
            name: machine.name,
            id: machine.id,
            login: machine.login,
        }
    }
}

impl Machine {
    /// Whether it is signed in as `login`.
    pub fn is(&self, login: &str) -> bool {
        self.login
            .as_deref()
            .is_some_and(|own| own.eq_ignore_ascii_case(login))
    }
}

/// The machines behind tailnet addresses, as whois found them: kept ten
/// minutes, a failure ten seconds, with one lookup in flight per address.
#[derive(Default)]
pub(crate) struct Peers {
    cache: Mutex<HashMap<IpAddr, (Instant, Option<Machine>)>>,
    /// The addresses being looked up, each with the turn a lookup of it
    /// waits for, so requests that ask at once share one lookup.
    inflight: Mutex<HashMap<IpAddr, Arc<tokio::sync::Mutex<()>>>>,
}

impl Peers {
    /// The machine at `ip` signed in as `login`, if it was found lately.
    pub fn cached(&self, ip: IpAddr, login: &str) -> Option<Machine> {
        self.known(ip, login).flatten()
    }

    /// What is known of `ip` lately: a machine signed in as `login`, or a
    /// lookup that failed. `None` asks again; so does a machine signed in
    /// as someone else, since the address may have changed hands.
    fn known(&self, ip: IpAddr, login: &str) -> Option<Option<Machine>> {
        match self.lately(ip)? {
            Some(machine) if !machine.is(login) => None,
            found => Some(found),
        }
    }

    /// What whois said of `ip` lately, whoever it named: the machine, or
    /// `Some(None)` for a lookup that failed; `None` when nothing recent is
    /// known.
    pub fn lately(&self, ip: IpAddr) -> Option<Option<Machine>> {
        let cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        let (at, found) = cache.get(&ip)?;
        let fresh = match found {
            Some(_) => at.elapsed() < HIT,
            None => at.elapsed() < MISS,
        };
        fresh.then(|| found.clone())
    }

    /// The machine at `ip`, from what is known, else asked of whois, at
    /// most [`WHOIS`]. It need not be signed in as `login`: the caller
    /// checks. A lookup of `ip` already under way is waited for rather
    /// than asked again.
    pub async fn resolve(&self, app: &App, ip: IpAddr, login: &str) -> Option<Machine> {
        if let Some(known) = self.known(ip, login) {
            return known;
        }
        let turn = Arc::clone(
            self.inflight
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .entry(ip)
                .or_default(),
        );
        let held = turn.lock().await;
        // The lookup waited for may have answered this one.
        let found = match self.known(ip, login) {
            Some(known) => known,
            None => self.ask(app, ip).await,
        };
        drop(held);
        // The last to finish lets the address go. Turns are handed out only
        // under the map's lock, so while it is held, a turn that only the
        // map and this lookup hold has no one else waiting for it.
        let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
        if Arc::strong_count(&turn) == 2 {
            inflight.remove(&ip);
        }
        found
    }

    /// Asks whois which machine is at `ip`, and keeps the answer.
    async fn ask(&self, app: &App, ip: IpAddr) -> Option<Machine> {
        let whois = app.whois();
        let found = match tokio::time::timeout(WHOIS, whois.whois(ip)).await {
            Ok(Ok(machine)) => Some(Machine::from(machine)),
            Ok(Err(e)) => {
                log::warn!("couldn't tell which machine {ip} is: {e}");
                None
            }
            Err(_) => {
                log::warn!(
                    "couldn't tell which machine {ip} is: tailscale whois didn't answer in time"
                );
                None
            }
        };
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if cache.len() >= KEEP {
            cache.retain(|_, (at, _)| at.elapsed() < HIT);
        }
        cache.insert(ip, (Instant::now(), found.clone()));
        found
    }

    /// Looks up `ip` in the background, unless it is known or being looked
    /// up, so a later request finds it without waiting.
    pub fn warm(&self, app: &Arc<App>, ip: IpAddr, login: &str) {
        if self.known(ip, login).is_some() {
            return;
        }
        if self
            .inflight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key(&ip)
        {
            return;
        }
        let (worker, login) = (Arc::clone(app), login.to_owned());
        app.spawn(async move {
            worker.peers.resolve(&worker, ip, &login).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(channel: Option<Channel>, headers: &[(&str, &str)]) -> http::Request<()> {
        let mut request = http::Request::new(());
        for (name, value) in headers {
            request.headers_mut().append(
                http::HeaderName::try_from(*name).unwrap(),
                value.parse().unwrap(),
            );
        }
        if let Some(channel) = channel {
            request.extensions_mut().insert(channel);
        }
        request
    }

    const TAILSCALED: [(&str, &str); 8] = [
        ("tailscale-user-login", "me@github"),
        ("tailscale-user-name", "Me"),
        ("tailscale-user-profile-pic", "https://example.com/me.png"),
        ("x-forwarded-for", "100.101.102.103"),
        ("x-forwarded-host", "hub.example.ts.net:7567"),
        ("x-forwarded-proto", "https"),
        ("forwarded", "for=100.101.102.103"),
        ("host", "hub.example.ts.net:7567"),
    ];

    #[test]
    fn tailnet_requests_say_who_sent_them_and_lose_the_headers() {
        let mut request = request(Some(Channel::Tailnet), &TAILSCALED);
        let seen = take(&mut request);
        assert_eq!(
            seen,
            Seen {
                channel: Channel::Tailnet,
                login: Some("me@github".into()),
                peer: Some("100.101.102.103".parse().unwrap()),
                funnel: false,
                origin_host: Some("hub.example.ts.net:7567".into()),
                proto: Some("https".into()),
            }
        );
        let left: Vec<&str> = request.headers().keys().map(|k| k.as_str()).collect();
        assert_eq!(left, ["host"]);
    }

    #[test]
    fn tcp_requests_are_believed_about_nothing_but_lose_the_headers_too() {
        for channel in [None, Some(Channel::Tcp)] {
            let mut request = request(channel, &TAILSCALED);
            let seen = take(&mut request);
            assert_eq!(seen, Seen::tcp());
            let left: Vec<&str> = request.headers().keys().map(|k| k.as_str()).collect();
            assert_eq!(left, ["host"]);
        }
    }

    #[test]
    fn funnel_is_believed_whichever_way_a_request_came() {
        // Published to the TCP port, Tailscale passes Funnel's requests on
        // over TCP: the mark still refuses them, and is still taken off.
        for channel in [None, Some(Channel::Tcp), Some(Channel::Tailnet)] {
            let mut request = request(channel, &[("tailscale-funnel-request", "?1")]);
            assert!(take(&mut request).funnel, "{channel:?}");
            assert!(request.headers().is_empty());
        }
    }

    #[test]
    fn logins_and_addresses_are_taken_only_when_they_read_right() {
        let seen = |headers: &[(&str, &str)]| take(&mut request(Some(Channel::Tailnet), headers));
        for bad in ["=?utf-8?q?J=C3=B6rg?=@github", "me @github", ""] {
            assert_eq!(seen(&[("tailscale-user-login", bad)]).login, None, "{bad}");
        }
        assert_eq!(
            seen(&[("tailscale-user-login", "Me@GitHub")])
                .login
                .as_deref(),
            Some("Me@GitHub")
        );
        // The last hop is tailscaled's own; anything before it, the client's.
        let peer = |list: &str| seen(&[("x-forwarded-for", list)]).peer;
        assert_eq!(
            peer("1.2.3.4, 100.64.0.1"),
            Some("100.64.0.1".parse().unwrap())
        );
        assert_eq!(peer("100.64.0.1, 1.2.3.4"), None);
        assert_eq!(peer("100.128.0.1"), None);
        assert_eq!(
            peer("100.127.255.254"),
            Some("100.127.255.254".parse().unwrap())
        );
        assert_eq!(
            peer("fd7a:115c:a1e0::1"),
            Some("fd7a:115c:a1e0::1".parse().unwrap())
        );
        assert_eq!(peer("fd7a:115c:a1e1::1"), None);
        assert_eq!(peer("not an address"), None);
        let funnel = seen(&[("tailscale-funnel-request", "?1")]);
        assert!(funnel.funnel);
        // Without tailscaled's forwarded host, the request's own.
        assert_eq!(
            seen(&[("host", "hub.example.ts.net")])
                .origin_host
                .as_deref(),
            Some("hub.example.ts.net")
        );
    }

    #[test]
    fn only_slopmax_s_own_page_or_no_page_passes_the_browser_check() {
        let seen = take(&mut request(Some(Channel::Tailnet), &TAILSCALED));
        let ok = |headers: &[(&str, &str)]| browser_ok(request(None, headers).headers(), &seen);
        assert!(ok(&[]));
        assert!(ok(&[("sec-fetch-site", "same-origin")]));
        assert!(ok(&[("sec-fetch-site", "none")]));
        assert!(!ok(&[("sec-fetch-site", "same-site")]));
        assert!(!ok(&[("sec-fetch-site", "cross-site")]));
        assert!(ok(&[("origin", "https://hub.example.ts.net:7567")]));
        assert!(!ok(&[("origin", "https://hub.example.ts.net")]));
        assert!(!ok(&[("origin", "https://dev.example.ts.net:7567")]));
        assert!(!ok(&[("origin", "null")]));
        let plain = Seen {
            proto: Some("http".into()),
            ..seen.clone()
        };
        let headers = request(None, &[("origin", "http://hub.example.ts.net:7567")]);
        assert!(browser_ok(headers.headers(), &plain));
        // No host to compare with: no origin passes.
        let hostless = Seen {
            origin_host: None,
            ..seen
        };
        assert!(!browser_ok(headers.headers(), &hostless));
    }

    #[test]
    fn machines_without_a_login_or_with_tags_are_tagged() {
        let machine = |login: Option<&str>, tags: &[&str]| {
            Machine::from(tailscale::Machine {
                id: "nX".into(),
                name: "x".into(),
                login: login.map(str::to_owned),
                tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            })
        };
        assert!(!machine(Some("me@github"), &[]).tagged);
        assert!(machine(None, &[]).tagged);
        assert!(machine(Some("me@github"), &["tag:ci"]).tagged);
        assert!(machine(Some("Me@GitHub"), &[]).is("me@github"));
        assert!(!machine(None, &[]).is("me@github"));
    }

    /// Whois that takes a while to answer, and counts how often it is
    /// asked.
    struct Slow(std::sync::atomic::AtomicUsize);

    impl tailscale::Whois for Slow {
        fn whois<'a>(
            &'a self,
            _ip: IpAddr,
        ) -> tailscale::BoxFuture<'a, Result<tailscale::Machine, tailscale::TsError>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(tailscale::Machine {
                    id: "nMAC".into(),
                    name: "mac".into(),
                    login: Some("me@github".into()),
                    tags: vec![],
                })
            })
        }
    }

    #[tokio::test]
    async fn requests_that_ask_at_once_share_one_lookup() {
        let dir = std::env::temp_dir().join(format!("slopmax-peers-{}", crate::ids::token()));
        let app = App::new(
            crate::config::Config::default(),
            crate::paths::Home::at(&dir),
            crate::pool::State::default(),
            crate::net::Origins::new([]),
        );
        let whois = Arc::new(Slow(std::sync::atomic::AtomicUsize::new(0)));
        app.set_whois(whois.clone());
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        app.peers.warm(&app, ip, "me@github");
        let asked = at_once(&app, ip).await;
        assert!(
            asked
                .iter()
                .all(|m| m.as_ref().is_some_and(|m| m.name == "mac"))
        );
        assert_eq!(whois.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(app.peers.inflight.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Five lookups of `ip` at once, as a page's first requests make them.
    async fn at_once(app: &Arc<App>, ip: IpAddr) -> Vec<Option<Machine>> {
        let mut all = tokio::task::JoinSet::new();
        for _ in 0..5 {
            let app = Arc::clone(app);
            all.spawn(async move { app.peers.resolve(&app, ip, "me@github").await });
        }
        all.join_all().await
    }

    #[test]
    fn known_machines_last_ten_minutes_and_failures_ten_seconds() {
        let peers = Peers::default();
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        let other: IpAddr = "100.64.0.2".parse().unwrap();
        let mac = Machine {
            name: "mac".into(),
            id: "nMAC".into(),
            login: Some("me@github".into()),
            tagged: false,
        };
        let now = Instant::now();
        {
            let mut cache = peers.cache.lock().unwrap();
            cache.insert(ip, (now, Some(mac.clone())));
            cache.insert(other, (now, None));
        }
        assert_eq!(peers.cached(ip, "ME@github"), Some(mac.clone()));
        assert_eq!(
            peers.known(ip, "you@github"),
            None,
            "another login asks again"
        );
        assert_eq!(peers.known(other, "me@github"), Some(None));
        let Some(stale) = now.checked_sub(MISS + Duration::from_secs(1)) else {
            return;
        };
        peers.cache.lock().unwrap().insert(other, (stale, None));
        assert_eq!(peers.known(other, "me@github"), None);
        if let Some(old) = now.checked_sub(HIT + Duration::from_secs(1)) {
            peers.cache.lock().unwrap().insert(ip, (old, Some(mac)));
            assert_eq!(peers.cached(ip, "me@github"), None);
        }
    }
}
