//! Checks of the whole setup, each saying how to fix what is wrong: what
//! `slopmax doctor` prints and the app shows. Findings never include a key
//! or token.

use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use crate::account::{Account, Store};
use crate::agent::{self, Agent};
use crate::background::{Daemon, Probe};
use crate::config::Config;
use crate::net::{Client, Origins, server};
use crate::paths::Home;
use crate::provider::ProviderId;
use crate::service::{Manager, Status};
use crate::tailscale::{self, Inspection, Peer, Target, Transport, TsError};
use crate::time::{SignedDuration, Timestamp};
use crate::{auth, human};
use slopmax_client::Health;
use slopmax_client::api::tailnet::Access;

/// CLIProxyAPI's default port, for spotting it beside slopmax.
const CLIPROXYAPI_PORT: u16 = 8317;

/// How much a finding matters, least first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Note,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Finding {
    pub level: Level,
    pub text: String,
    /// What to run or change to fix it.
    pub fix: Option<String>,
}

/// The findings about one part of the setup.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Section {
    pub title: &'static str,
    pub findings: Vec<Finding>,
}

impl Section {
    fn new(title: &'static str) -> Self {
        Self {
            title,
            findings: Vec::new(),
        }
    }

    fn add(&mut self, level: Level, text: impl Into<String>, fix: Option<&str>) {
        self.findings.push(Finding {
            level,
            text: text.into(),
            fix: fix.map(str::to_owned),
        });
    }
}

/// Runs every check. Sections without findings are left out. Tailscale is
/// read through `ts`, the `tailscale` command (`None`: there is none).
pub async fn check(
    config: &Config,
    store: &Store,
    home: &Home,
    ts: Option<tailscale::Tailscale>,
) -> Result<Vec<Section>> {
    if config.hub.is_some() {
        return Ok(client_checks(config, home).await);
    }
    let accounts = store.list()?;
    let service = Manager::detect().map(|m| m.status(home));
    let http = auth::http_client(Origins::default());
    let daemon = Daemon::new(config);
    let probe = daemon.probe().await;
    // Each account's last error, from a proxy that serves this home.
    let report = match probe {
        Probe::Ours { .. } => daemon.report().await.ok(),
        _ => None,
    };
    let failing: Vec<(String, String)> = match report {
        Some(report) => report
            .accounts
            .into_iter()
            .filter_map(|a| {
                let text = a.notes.into_iter().find_map(|n| match n {
                    slopmax_client::api::report::Note::LastError { text } => Some(text),
                    _ => None,
                })?;
                Some((a.id, text))
            })
            .collect(),
        None => Vec::new(),
    };
    let running = matches!(probe, Probe::Ours { .. });
    let tailnet = tailnet_checks(ts, config, home, running, service).await;
    let mut proxy = proxy(config, probe, service);
    if tailnet.as_ref().is_some_and(is_published) {
        // The Tailscale section says these louder: other machines lose
        // their hub when the proxy stops.
        let louder = ["slopmax service install", "loginctl enable-linger $USER"];
        proxy.findings.retain(|f| {
            f.level != Level::Note || !louder.contains(&f.fix.as_deref().unwrap_or(""))
        });
    }
    let sections = [
        proxy,
        accounts_section(&accounts, &failing),
        claude_code(config, home.claude()),
        codex(config, home.codex()),
        grok_build(config, home.grok(), &accounts),
        cliproxyapi(&accounts, CLIPROXYAPI_PORT),
        network(&http, &accounts).await,
        files(&home.accounts()),
    ];
    let mut sections = sections;
    unserved(&mut sections, config, &accounts, home, &|agent| {
        let program = agent.command(config, home, &[]).get_program().to_owned();
        slopmax_common::which(&program.to_string_lossy()).is_some()
    });
    Ok(sections
        .into_iter()
        .chain(tailnet)
        .filter(|s| !s.findings.is_empty())
        .collect())
}

/// Whether a Tailscale section says slopmax is published.
fn is_published(section: &Section) -> bool {
    section
        .findings
        .iter()
        .any(|f| f.level == Level::Ok && f.text.starts_with("served to your tailnet"))
}

/// The checks on a machine that uses a hub: the hub in place of the proxy
/// and the accounts, then the agents' wiring to it.
async fn client_checks(config: &Config, home: &Home) -> Vec<Section> {
    let client = slopmax_client::Client::remote(config.agent_base(), config.agent_token());
    let daemon = Daemon::new(config);
    let (health, local) = tokio::join!(
        client.health_within(Duration::from_secs(10)),
        daemon.is_running()
    );
    let wired: Vec<(&dyn Agent, bool)> = agent::AGENTS
        .iter()
        .map(|a| {
            let wired = agent::wiring(*a, config, home) == agent::Wiring::Slopmax;
            (*a, wired)
        })
        .collect();
    [
        hub(config, health.as_ref(), local, &wired),
        claude_code(config, home.claude()),
        codex(config, home.codex()),
        files(&home.accounts()),
    ]
    .into_iter()
    .filter(|s| !s.findings.is_empty())
    .collect()
}

/// Reads Tailscale here through `ts` for the Tailscale section, when there
/// is a `tailscale` command and the section has something to say.
async fn tailnet_checks(
    ts: Option<tailscale::Tailscale>,
    config: &Config,
    home: &Home,
    running: bool,
    service: Option<Status>,
) -> Option<Section> {
    let ts = ts?;
    let port = config.listen.port();
    let targets = [
        Target::Socket(home.tailnet_socket()),
        Target::Loopback(port),
    ];
    let inspection = tailscale::inspect(Some(&ts), &targets, port).await;
    if inspection.published.is_empty() && config.tailscale.is_none() {
        return None;
    }
    let peers = match &inspection.node {
        Ok(_) => ts.peers().await.ok().map(|(_, peers)| peers),
        Err(_) => None,
    };
    let socket_answers = if cfg!(unix) && running {
        Some(socket_answers(&home.tailnet_socket(), Duration::from_secs(3)).await)
    } else {
        None
    };
    let user = std::env::var("USER").ok();
    let facts = TailnetFacts {
        inspection: Some(&inspection),
        peers: peers.as_deref(),
        socket_answers,
        linger: service.and_then(|s| s.lingering),
        service: service.map(|s| s.installed),
        user: user.as_deref(),
        root: tailscale::is_root(),
    };
    tailnet(config, home, &facts)
}

/// Whether the proxy answers `/healthz` with 200 on its tailnet socket at
/// `path` within `within`: the way Tailscale reaches it.
pub async fn socket_answers(path: &Path, within: Duration) -> bool {
    #[cfg(unix)]
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let ask = async {
            let mut stream = tokio::net::UnixStream::connect(path).await.ok()?;
            stream
                .write_all(b"GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .await
                .ok()?;
            let mut head = [0u8; 12];
            stream.read_exact(&mut head).await.ok()?;
            Some(head.starts_with(b"HTTP/1.1 200"))
        };
        tokio::time::timeout(within, ask).await.ok().flatten() == Some(true)
    }
    #[cfg(not(unix))]
    {
        let _ = (path, within);
        false
    }
}

/// What the Tailscale section is made from, as [`check`] gathers it.
#[derive(Debug, Clone, Copy, Default)]
pub struct TailnetFacts<'a> {
    /// What [`tailscale::inspect`] read; `None` with no `tailscale`
    /// command here.
    pub inspection: Option<&'a Inspection>,
    /// The other machines on the tailnet, when they could be read.
    pub peers: Option<&'a [Peer]>,
    /// Whether the proxy answered on its tailnet socket; `None` when it
    /// wasn't asked (the proxy isn't running, or the OS has no sockets).
    pub socket_answers: Option<bool>,
    /// Whether the login service outlives the user's session; `None` when
    /// that isn't known.
    pub linger: Option<bool>,
    /// Whether the login service is installed; `None` with no service
    /// manager here.
    pub service: Option<bool>,
    /// The user this runs as (`$USER`).
    pub user: Option<&'a str>,
    pub root: bool,
}

/// The hub's own section: slopmax on the tailnet, as `tailscale serve`
/// publishes it. `None` unless there is a `tailscale` command and slopmax
/// is published there, or `[tailscale]` is set.
pub fn tailnet(config: &Config, home: &Home, facts: &TailnetFacts<'_>) -> Option<Section> {
    let inspection = facts.inspection.filter(|i| i.exe.is_some())?;
    if inspection.published.is_empty() && config.tailscale.is_none() {
        return None;
    }
    let mut s = Section::new("Tailscale");
    let failed = |s: &mut Section, e: &TsError| s.add(Level::Fail, e.message(), e.fix().as_deref());
    let node = match &inspection.node {
        Ok(node) => node,
        Err(e) => {
            failed(&mut s, e);
            return Some(s);
        }
    };
    if let Some(e) = tailscale::state_error(node) {
        failed(&mut s, &e);
        return Some(s);
    }
    if node.cert_domains.is_empty() {
        failed(&mut s, &TsError::NoHttps);
    }
    for p in &inspection.published {
        let to = match &p.target {
            Target::Socket(path) => home.show(path),
            Target::Loopback(port) => format!("http://127.0.0.1:{port}"),
        };
        s.add(
            Level::Ok,
            format!("served to your tailnet at {} (to {to})", p.url),
            None,
        );
        if p.funnel {
            failed(&mut s, &TsError::Funnel { port: p.port });
        }
    }
    for h in &inspection.stale {
        s.add(
            Level::Fail,
            format!(
                "port {} serves {} to your tailnet: likely slopmax from another home or port",
                h.port, h.target
            ),
            Some(&format!(
                "{}, then slopmax tailscale on",
                tailscale::serve_off(h.port)
            )),
        );
    }
    let published = !inspection.published.is_empty();
    if !published && inspection.stale.is_empty() {
        s.add(
            Level::Warn,
            "[tailscale] is set, but slopmax isn't published to your tailnet",
            Some("slopmax tailscale on"),
        );
    }
    let socket = home.tailnet_socket();
    let over = |transport| {
        inspection
            .published
            .iter()
            .any(|p| p.transport == transport)
    };
    if over(Transport::Socket) && facts.socket_answers == Some(false) {
        s.add(
            Level::Fail,
            format!(
                "the proxy doesn't answer on {}, where Tailscale sends your machines' requests",
                home.show(&socket)
            ),
            Some("slopmax stop && slopmax start"),
        );
    }
    if cfg!(unix) && socket.as_os_str().len() > 100 {
        s.add(
            Level::Warn,
            format!(
                "{} is too long a path for a socket (over 100 bytes), so Tailscale can't tell \
                 slopmax who is asking",
                socket.display()
            ),
            Some("move SLOPMAX_HOME to a shorter path"),
        );
    }
    if over(Transport::Loopback) {
        s.add(
            Level::Note,
            "machines need a key; Tailscale here can't tell slopmax who is asking",
            Some("slopmax key add <name>"),
        );
    }
    let users = config.tailnet_users();
    if users.is_empty() {
        s.add(
            Level::Note,
            "no tailnet login uses slopmax without a key ([tailscale] users is empty)",
            Some("slopmax tailscale users add <login>"),
        );
    }
    if let Some(peers) = facts.peers {
        let known = |login: &str| {
            node.login
                .iter()
                .chain(peers.iter().filter_map(|p| p.login.as_ref()))
                .any(|known| known.eq_ignore_ascii_case(login))
        };
        for user in users.iter().filter(|u| !known(u)) {
            s.add(
                Level::Note,
                format!("no machine on your tailnet is signed in as {user} (a typo?)"),
                Some(&format!("slopmax tailscale users remove {user}")),
            );
        }
        for admin in config.tailscale.iter().flat_map(|t| &t.admins) {
            if admin.id != node.id && !peers.iter().any(|p| p.id == admin.id) {
                s.add(
                    Level::Warn,
                    format!(
                        "the admin machine {} ({}) isn't on your tailnet any more",
                        admin.machine, admin.id
                    ),
                    Some(&format!(
                        "slopmax tailscale admins remove {}",
                        admin.machine
                    )),
                );
            }
        }
    }
    if published && !config.listen.ip().is_loopback() {
        s.add(
            Level::Note,
            format!(
                "the proxy also listens on {}, beyond this machine, where only keys work",
                config.listen
            ),
            Some(&format!(
                "set `listen` in config.toml to 127.0.0.1:{}",
                config.listen.port()
            )),
        );
    }
    if published && facts.linger == Some(false) {
        s.add(
            Level::Warn,
            "the service stops when you log out, and your machines lose their hub with it",
            Some("loginctl enable-linger $USER"),
        );
    }
    if published && facts.service == Some(false) {
        s.add(
            Level::Warn,
            "slopmax doesn't start at login, so your machines lose their hub when this one restarts",
            Some("slopmax service install"),
        );
    }
    if cfg!(target_os = "linux") && !facts.root && inspection.operator.as_deref() != facts.user {
        s.add(
            Level::Note,
            "only root may change what Tailscale serves here",
            Some("sudo tailscale set --operator=$USER"),
        );
    }
    Some(s)
}

/// What `access` lets a machine do on a hub, in words.
pub fn access_words(access: Access) -> &'static str {
    match access {
        Access::None => "nothing",
        Access::Use => "use",
        Access::View => "use and view",
        Access::Admin => "use, view and manage",
    }
}

/// A client's section: the hub its agents use, in place of the proxy and
/// the accounts. `health` is what the hub's `/healthz` said, if it
/// answered; `local` whether a proxy of this machine's own still runs;
/// `wired` each agent and whether it uses the hub.
pub fn hub(
    config: &Config,
    health: Option<&Health>,
    local: bool,
    wired: &[(&dyn Agent, bool)],
) -> Section {
    let mut s = Section::new("Hub");
    let url = config.agent_base();
    match health {
        None => s.add(
            Level::Fail,
            format!("the hub at {url} isn't answering"),
            Some(
                "check that Tailscale is connected here (`tailscale status`) and that slopmax \
                 runs on the hub (`slopmax doctor` there)",
            ),
        ),
        Some(health) => {
            s.add(
                Level::Ok,
                format!("the hub at {url} answers (slopmax {})", health.version),
                None,
            );
            let known = health
                .machine
                .as_deref()
                .map(|m| format!(" as {m}"))
                .unwrap_or_default();
            match (health.access, health.owner) {
                (Some(Access::None), _) => s.add(
                    Level::Fail,
                    "the hub doesn't take this machine: it knows neither its key nor its \
                     tailnet login",
                    Some(&format!("slopmax setup --hub {url}")),
                ),
                (Some(access), _) => s.add(
                    Level::Ok,
                    format!("it knows this machine{known}: {}", access_words(access)),
                    None,
                ),
                (None, Some(true)) => {
                    s.add(Level::Ok, "this machine has the hub's owner key", None);
                }
                (None, _) => s.add(
                    Level::Note,
                    "the hub's slopmax is older and doesn't say what this machine may do",
                    None,
                ),
            }
            let ours = env!("CARGO_PKG_VERSION");
            if health.version != ours {
                s.add(
                    Level::Note,
                    format!(
                        "the hub runs slopmax {}, and this machine {ours}",
                        health.version
                    ),
                    Some("update the older one, so both run the same version"),
                );
            }
        }
    }
    for (agent, wired) in wired {
        if !wired {
            s.add(
                Level::Warn,
                format!("{} doesn't use the hub", agent.title()),
                Some(&format!("slopmax setup {}", agent.id())),
            );
        }
    }
    if local {
        s.add(
            Level::Warn,
            "a proxy of this machine's own still runs, though its agents use the hub",
            Some("slopmax stop, then slopmax service uninstall"),
        );
    }
    s
}

/// What each agent's section says to run first: install the agent, when
/// it is not on PATH; connect an account, when none serves it, as wiring
/// it now would only break it. An agent wired to slopmax with no account to
/// serve its own models gets an error for every request it sends.
fn unserved(
    sections: &mut [Section],
    config: &Config,
    accounts: &[crate::account::Account],
    home: &Home,
    installed: &dyn Fn(&dyn crate::agent::Agent) -> bool,
) {
    for agent in crate::agent::AGENTS {
        let Some(section) = sections.iter_mut().find(|s| s.title == agent.title()) else {
            continue;
        };
        let servable = crate::agent::servable(agent, accounts);
        let provider = agent.provider();
        let mut steps = Vec::new();
        if !installed(agent) {
            steps.push(format!("install {}", agent.title()));
        }
        if !servable {
            steps.push(format!("slopmax login {provider}"));
        }
        let setup = format!("slopmax setup {}", agent.id());
        if !steps.is_empty() {
            steps.push(setup.clone());
            let first = steps.join(", then ");
            for finding in &mut section.findings {
                if finding.fix.as_deref() == Some(setup.as_str()) {
                    finding.fix = Some(first.clone());
                }
            }
        }
        let wired = crate::agent::wiring(agent, config, home) == crate::agent::Wiring::Slopmax;
        if servable || !wired {
            continue;
        }
        section.add(
            Level::Fail,
            format!(
                "points at slopmax, but no {} account is connected to serve it",
                provider.spec().title
            ),
            Some(&format!(
                "slopmax login {provider}, or `slopmax setup {} --undo`",
                agent.id()
            )),
        );
    }
}

/// The proxy, as `probe` found it answering on the configured port.
fn proxy(config: &Config, probe: Probe, service: Option<Status>) -> Section {
    let mut s = Section::new("Proxy");
    let ours = env!("CARGO_PKG_VERSION");
    match probe {
        Probe::Ours { version } if version == ours => {
            s.add(Level::Ok, format!("running on {}", config.base_url()), None);
        }
        Probe::Ours { version } => s.add(
            Level::Warn,
            format!("running version {version}, but this binary is {ours}"),
            Some("slopmax stop && slopmax start"),
        ),
        Probe::Foreign { pid, .. } => {
            let end = pid
                .map(|p| format!(" (or end pid {p})"))
                .unwrap_or_default();
            s.add(
                Level::Fail,
                format!(
                    "the slopmax on {} doesn't accept this home's key: it was started from \
                     another SLOPMAX_HOME, or before api_key changed",
                    config.listen
                ),
                Some(&format!("stop it from there{end}, then slopmax start")),
            );
        }
        Probe::Absent => match unlistenable(config.listen) {
            Some(std::io::ErrorKind::PermissionDenied) if !cfg!(windows) => s.add(
                Level::Fail,
                format!(
                    "slopmax may not listen on {}: ports below 1024 need administrator rights",
                    config.listen
                ),
                Some("set `listen` in config.toml to a port above 1023"),
            ),
            Some(std::io::ErrorKind::AddrNotAvailable) => s.add(
                Level::Fail,
                format!("this machine has no address {}", config.listen.ip()),
                Some("set `listen` in config.toml to an address of this machine, like 127.0.0.1"),
            ),
            Some(_) => {
                let port = config.listen.port();
                let holder = server::port_holder(port).unwrap_or_else(|| "another program".into());
                s.add(
                    Level::Fail,
                    format!("port {port} is taken by {holder}"),
                    Some("set `listen` in config.toml to a free port"),
                );
            }
            None => s.add(
                Level::Warn,
                "not running",
                Some("slopmax start (or `slopmax service install` to start at login)"),
            ),
        },
    }
    if !config.listen.ip().is_loopback() {
        let named = config.keys.len();
        s.add(
            Level::Note,
            format!(
                "listens beyond this machine on {}: anyone who can reach it with the key \
                 ({named} client key{} besides api_key) can use your accounts",
                config.listen,
                if named == 1 { "" } else { "s" }
            ),
            Some("give other machines their own keys with `slopmax key add <name>`"),
        );
    }
    if let Some(status) = service {
        match (status.installed, status.running) {
            (false, _) => s.add(
                Level::Note,
                "not installed as a service",
                Some("slopmax service install"),
            ),
            (true, true) => s.add(Level::Ok, "runs as a login service", None),
            (true, false) => s.add(
                Level::Warn,
                "the service is installed but not running",
                Some("slopmax start"),
            ),
        }
        if status.installed && status.lingering == Some(false) {
            s.add(
                Level::Note,
                "the service stops when you log out",
                Some("loginctl enable-linger $USER"),
            );
        }
    }
    s
}

/// Why the proxy could not listen on `listen`, if it could not: the port
/// is taken (Windows calls a port another process holds access denied), a
/// privileged one, or the address is not this machine's.
fn unlistenable(listen: SocketAddr) -> Option<std::io::ErrorKind> {
    use std::io::ErrorKind;
    let kind = TcpListener::bind(listen).err()?.kind();
    matches!(
        kind,
        ErrorKind::AddrInUse | ErrorKind::PermissionDenied | ErrorKind::AddrNotAvailable
    )
    .then_some(kind)
}

/// The accounts; `failing` holds, by id, the last error of each account a
/// running proxy saw fail and not since succeed.
fn accounts_section(accounts: &[Account], failing: &[(String, String)]) -> Section {
    let mut s = Section::new("Accounts");
    if accounts.is_empty() {
        s.add(
            Level::Fail,
            "no accounts connected",
            Some("slopmax login claude, slopmax login codex, or slopmax import"),
        );
        return s;
    }
    let counts: Vec<String> = ProviderId::ALL
        .into_iter()
        .filter_map(|provider| {
            let n = accounts.iter().filter(|a| a.provider == provider).count();
            let s = if n == 1 { "" } else { "s" };
            (n > 0).then(|| format!("{n} {} account{s}", provider.spec().title))
        })
        .collect();
    s.add(Level::Ok, counts.join(", "), None);
    let now = Timestamp::now();
    for account in accounts {
        let name = account.name();
        if let Some(error) = &account.auth_error {
            let fix = format!("slopmax login {}", account.provider);
            s.add(
                Level::Fail,
                format!("{name} needs a new login ({error})"),
                Some(&fix),
            );
        } else if let Some(link) = &account.link {
            let fix = format!("slopmax own {}", account.id);
            if !link.path.exists() {
                s.add(
                    Level::Warn,
                    format!(
                        "{name} follows {}, but {} is gone",
                        link.tool,
                        link.path.display()
                    ),
                    Some(&fix),
                );
            } else if account.tokens.is_expired(now) {
                s.add(
                    Level::Warn,
                    format!(
                        "{name}'s token expired and {} has not refreshed it",
                        link.tool
                    ),
                    Some(&format!("start {} again, or {fix}", link.tool)),
                );
            }
        }
        if account.disabled {
            s.add(Level::Note, format!("{name} is disabled"), None);
        } else if account.auth_error.is_none()
            && let Some((_, error)) = failing.iter().find(|(id, _)| *id == account.id)
        {
            s.add(
                Level::Warn,
                format!("{name}'s last request failed: {error}"),
                Some("slopmax logs"),
            );
        }
    }
    s
}

fn claude_code(config: &Config, dir: &Path) -> Section {
    let mut s = Section::new("Claude Code");
    if !on_path("claude") {
        s.add(Level::Note, "`claude` is not on PATH", None);
    }
    let settings: Value = crate::fsx::read_json(&dir.join("settings.json"))
        .ok()
        .flatten()
        .unwrap_or_default();
    let env = |key: &str| {
        settings
            .pointer(&format!("/env/{key}"))
            .and_then(Value::as_str)
    };
    let (ours, key) = (config.agent_base(), config.agent_token());
    match (env("ANTHROPIC_BASE_URL"), env("ANTHROPIC_AUTH_TOKEN")) {
        (Some(base), Some(token)) if base == ours && token == key => {
            s.add(
                Level::Ok,
                "wired through settings.json, for the CLI and the apps that run it",
                None,
            );
        }
        (Some(base), _) if base == ours => s.add(
            Level::Warn,
            "settings.json points at slopmax with a different key",
            Some("slopmax setup claude"),
        ),
        (Some(base), _) => s.add(
            Level::Warn,
            format!("settings.json sends Claude Code to {base}"),
            Some("slopmax setup claude"),
        ),
        (None, _) => s.add(
            Level::Note,
            "not wired in settings.json (`slopmax run claude` still works)",
            Some("slopmax setup claude"),
        ),
    }
    if std::env::var_os("ANTHROPIC_API_KEY").is_some() {
        s.add(
            Level::Warn,
            "ANTHROPIC_API_KEY is set in this shell and conflicts with the proxy's key",
            Some("unset ANTHROPIC_API_KEY"),
        );
    }
    s
}

fn codex(config: &Config, dir: &Path) -> Section {
    let mut s = Section::new("Codex");
    if !on_path("codex") {
        s.add(Level::Note, "`codex` is not on PATH", None);
    }
    let file = dir.join("config.toml");
    let doc: Option<toml_edit::DocumentMut> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| text.parse().ok());
    let provider = doc
        .as_ref()
        .and_then(|d| d.get("model_provider")?.as_str().map(str::to_owned));
    let table = doc.as_ref().and_then(|d| {
        d.get("model_providers")?
            .get("slopmax")?
            .as_table()
            .cloned()
    });
    let field = |key: &str| {
        table
            .as_ref()
            .and_then(|t| t.get(key)?.as_str().map(str::to_owned))
    };
    let expected = format!("{}/codex", config.agent_base());
    let token = config.agent_token();
    match provider.as_deref() {
        Some("slopmax")
            if field("base_url").as_deref() == Some(expected.as_str())
                && field("experimental_bearer_token").as_deref() == Some(token.as_str()) =>
        {
            s.add(
                Level::Ok,
                "wired through config.toml, for the CLI and the desktop app",
                None,
            );
        }
        Some("slopmax") if table.is_none() => s.add(
            Level::Warn,
            "config.toml selects slopmax, but its provider table is gone \
             (the Codex desktop app can rewrite the file)",
            Some("slopmax setup codex"),
        ),
        Some("slopmax") => s.add(
            Level::Warn,
            "config.toml's slopmax provider has an old address or key",
            Some("slopmax setup codex"),
        ),
        Some(other) => s.add(
            Level::Warn,
            format!("config.toml sends Codex to the `{other}` provider"),
            Some("slopmax setup codex"),
        ),
        None => s.add(
            Level::Note,
            "not wired in config.toml (`slopmax run codex` still works)",
            Some("slopmax setup codex"),
        ),
    }
    s
}

/// Grok Build, for those who use it: it is on PATH, or SuperGrok accounts
/// are connected.
fn grok_build(config: &Config, dir: &Path, accounts: &[Account]) -> Section {
    let mut s = Section::new("Grok Build");
    let installed = on_path("grok");
    if !installed && !accounts.iter().any(|a| a.provider == ProviderId::Grok) {
        return s;
    }
    if !installed {
        s.add(Level::Note, "`grok` is not on PATH", None);
    }
    let doc: Option<toml_edit::DocumentMut> = std::fs::read_to_string(dir.join("config.toml"))
        .ok()
        .and_then(|text| text.parse().ok());
    let setting = |table: &str, key: &str| {
        doc.as_ref()
            .and_then(|d| d.get(table)?.get(key)?.as_str().map(str::to_owned))
    };
    let base = setting("endpoints", "cli_chat_proxy_base_url");
    let command = setting("grok_com_config", "auth_provider_command");
    let expected = format!("{}/grok/v1", config.base_url());
    let wired = base.as_deref() == Some(expected.as_str());
    match base {
        Some(base) if base == expected => {
            if command.is_some_and(|c| c.contains(&config.api_key)) {
                s.add(Level::Ok, "wired through config.toml", None);
            } else {
                s.add(
                    Level::Warn,
                    "config.toml points at slopmax with a different key",
                    Some("slopmax setup grok"),
                );
            }
        }
        Some(base) => s.add(
            Level::Warn,
            format!("config.toml sends Grok Build to {base}"),
            Some("slopmax setup grok"),
        ),
        None => s.add(
            Level::Note,
            "not wired in config.toml (`slopmax run grok` still works)",
            Some("slopmax setup grok"),
        ),
    }
    // Its own sign-in comes before the auth provider, for plain `grok`.
    if wired && crate::agent::grok::signed_in(&dir.join("config.toml")) {
        s.add(
            Level::Warn,
            "Grok Build is signed in to xAI itself, so it goes to xAI directly",
            Some("grok logout"),
        );
    }
    s
}

fn cliproxyapi(accounts: &[Account], port: u16) -> Section {
    let mut s = Section::new("CLIProxyAPI");
    let linked = accounts
        .iter()
        .filter(|a| a.link.as_ref().is_some_and(|l| l.tool == "cliproxyapi"))
        .count();
    if linked == 0 {
        return s;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let running = crate::net::reachable(addr, Duration::from_millis(300));
    if running {
        s.add(
            Level::Note,
            format!(
                "still running and refreshing {linked} account{} slopmax follows",
                if linked == 1 { "" } else { "s" }
            ),
            Some("once you stop CLIProxyAPI: slopmax own all"),
        );
    } else {
        s.add(
            Level::Warn,
            format!("not running, so nothing refreshes the {linked} accounts slopmax follows"),
            Some("slopmax own all"),
        );
    }
    s
}

async fn network(http: &Client, accounts: &[Account]) -> Section {
    let mut s = Section::new("Network");
    let mut skew_checked = false;
    let mut services = vec![
        ("Anthropic", "https://api.anthropic.com/api/hello"),
        ("ChatGPT", "https://chatgpt.com/backend-api/wham/usage"),
    ];
    // xAI only for those who pool SuperGrok.
    if accounts.iter().any(|a| a.provider == ProviderId::Grok) {
        services.push(("xAI", "https://cli-chat-proxy.grok.com/v1/models"));
    }
    for (name, url) in services {
        match http.get(url).timeout(Duration::from_secs(10)).send().await {
            Ok(response) => {
                s.add(Level::Ok, format!("{name} is reachable"), None);
                let date = response
                    .headers()
                    .get("date")
                    .and_then(|v| v.to_str().ok())
                    .and_then(Timestamp::from_http_date);
                if let Some(date) = date.filter(|_| !skew_checked) {
                    skew_checked = true;
                    let skew = Timestamp::now().duration_since(date).as_secs().abs();
                    if SignedDuration::from_secs(skew) > SignedDuration::from_mins(1) {
                        s.add(
                            Level::Warn,
                            format!(
                                "the system clock is off by {}",
                                human::duration(SignedDuration::from_secs(skew))
                            ),
                            Some("enable time sync (e.g. `timedatectl set-ntp true`)"),
                        );
                    }
                }
            }
            Err(e) => s.add(
                Level::Fail,
                format!("cannot reach {name}: {e}"),
                Some("check the network, or set HTTPS_PROXY"),
            ),
        }
    }
    s
}

#[cfg_attr(not(unix), allow(unused_variables, unused_mut))]
fn files(dir: &Path) -> Section {
    let mut s = Section::new("Files");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let open = |path: &Path| {
            std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o077 != 0)
        };
        if open(dir) {
            s.add(
                Level::Warn,
                format!("{} is readable by other users", dir.display()),
                Some(&format!("chmod 700 {}", dir.display())),
            );
        }
        let exposed = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| open(p))
            .count();
        if exposed > 0 {
            s.add(
                Level::Warn,
                format!("{exposed} account files are readable by other users"),
                Some(&format!("chmod 600 {}/*", dir.display())),
            );
        }
    }
    s
}

fn on_path(program: &str) -> bool {
    slopmax_common::which(program).is_some()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::account::{Link, Tokens};
    use crate::config::ClientKey;
    use crate::testkit::{self, Mock, temp_dir};

    /// The proxy section, probing the configured port first.
    async fn proxy(config: &Config, service: Option<Status>) -> Section {
        super::proxy(config, Daemon::new(config).probe().await, service)
    }

    fn texts(section: &Section) -> Vec<(Level, &str)> {
        section
            .findings
            .iter()
            .map(|f| (f.level, f.text.as_str()))
            .collect()
    }

    /// The finding that mentions `needle`.
    fn finding<'a>(section: &'a Section, needle: &str) -> &'a Finding {
        section
            .findings
            .iter()
            .find(|f| f.text.contains(needle))
            .unwrap_or_else(|| panic!("no finding with {needle:?} in {:#?}", section.findings))
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    fn config_on(port: u16) -> Config {
        Config {
            listen: SocketAddr::from(([127, 0, 0, 1], port)),
            api_key: "sm-key".into(),
            ..Config::default()
        }
    }

    fn port_of(mock: &Mock) -> u16 {
        mock.url.rsplit(':').next().unwrap().parse().unwrap()
    }

    async fn healthz(version: &'static str) -> Mock {
        Mock::start(move |seen| match seen.route() {
            "/healthz" => testkit::json(200, json!({ "service": "slopmax", "version": version })),
            _ => testkit::reply(404, ""),
        })
        .await
    }

    fn account(provider: ProviderId, email: &str) -> Account {
        let mut account = Account::new(provider, Tokens::default());
        account.email = Some(email.into());
        account.assign_id();
        account
    }

    #[tokio::test]
    async fn a_running_proxy_of_this_version_is_fine() {
        let mock = healthz(env!("CARGO_PKG_VERSION")).await;
        let config = config_on(port_of(&mock));
        let s = proxy(&config, None).await;
        assert_eq!(
            texts(&s),
            [(
                Level::Ok,
                format!("running on {}", config.base_url()).as_str()
            )]
        );
    }

    #[tokio::test]
    async fn an_older_proxy_should_be_restarted() {
        let mock = healthz("0.0.1").await;
        let s = proxy(&config_on(port_of(&mock)), None).await;
        let f = finding(&s, "running version 0.0.1");
        assert_eq!(f.level, Level::Warn);
        assert_eq!(f.fix.as_deref(), Some("slopmax stop && slopmax start"));
    }

    #[tokio::test]
    async fn another_program_on_the_port_is_named() {
        // Answers, but not as slopmax, and holds the port.
        let mock = Mock::start(|_| testkit::reply(404, "")).await;
        let port = port_of(&mock);
        let s = proxy(&config_on(port), None).await;
        let f = finding(&s, &format!("port {port} is taken by"));
        assert_eq!(f.level, Level::Fail);
        assert!(f.fix.as_deref().unwrap().contains("listen"));
    }

    #[tokio::test]
    async fn a_proxy_from_another_home_fails_with_how_to_stop_it() {
        let mock = Mock::start(|seen| match seen.route() {
            "/healthz" => testkit::json(
                200,
                json!({ "service": "slopmax", "version": env!("CARGO_PKG_VERSION"),
                        "pid": 31337, "owner": false }),
            ),
            _ => testkit::reply(401, ""),
        })
        .await;
        let s = proxy(&config_on(port_of(&mock)), None).await;
        let f = finding(&s, "doesn't accept this home's key");
        assert_eq!(f.level, Level::Fail);
        assert_eq!(
            f.fix.as_deref(),
            Some("stop it from there (or end pid 31337), then slopmax start")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_privileged_port_cannot_be_started_on() {
        // Root may listen anywhere: nothing to check then.
        if TcpListener::bind("127.0.0.1:1").is_ok() {
            return;
        }
        let s = proxy(&config_on(1), None).await;
        let f = finding(&s, "ports below 1024 need administrator rights");
        assert_eq!(f.level, Level::Fail);
        assert_eq!(
            f.fix.as_deref(),
            Some("set `listen` in config.toml to a port above 1023")
        );
    }

    #[test]
    fn an_agent_not_installed_is_installed_first() {
        let dir = temp_dir("doctor-install");
        let home = Home::at(dir.to_path_buf());
        let config = config_on(8318);
        let section = |title: &'static str, setup: &str| Section {
            title,
            findings: vec![Finding {
                level: Level::Note,
                text: "not wired".into(),
                fix: Some(setup.into()),
            }],
        };
        let fixes = |accounts: &[Account], installed: bool| {
            let mut sections = [
                section("Claude Code", "slopmax setup claude"),
                section("Codex", "slopmax setup codex"),
            ];
            unserved(&mut sections, &config, accounts, &home, &|_| installed);
            sections.map(|s| s.findings[0].fix.clone().unwrap())
        };
        let both = [
            account(ProviderId::Claude, "c@x.com"),
            account(ProviderId::Codex, "x@x.com"),
        ];
        assert_eq!(
            fixes(&both, true),
            ["slopmax setup claude", "slopmax setup codex"]
        );
        assert_eq!(
            fixes(&both, false),
            [
                "install Claude Code, then slopmax setup claude",
                "install Codex, then slopmax setup codex"
            ]
        );
        assert_eq!(
            fixes(&[], false),
            [
                "install Claude Code, then slopmax login claude, then slopmax setup claude",
                "install Codex, then slopmax login codex, then slopmax setup codex"
            ]
        );
    }

    #[tokio::test]
    async fn a_stopped_proxy_says_how_to_start_it() {
        let s = proxy(&config_on(free_port()), None).await;
        let f = finding(&s, "not running");
        assert_eq!(f.level, Level::Warn);
        assert!(f.fix.as_deref().unwrap().starts_with("slopmax start"));
    }

    #[tokio::test]
    async fn listening_beyond_this_machine_is_pointed_out() {
        let mut config = config_on(free_port());
        config.listen.set_ip([0, 0, 0, 0].into());
        let s = proxy(&config, None).await;
        assert!(finding(&s, "(0 client keys besides api_key)").level == Level::Note);
        config.keys.push(ClientKey {
            name: "laptop".into(),
            key: "k".into(),
            models: Vec::new(),
        });
        let s = proxy(&config, None).await;
        let f = finding(&s, "listens beyond this machine");
        assert!(f.text.contains("(1 client key besides api_key)"));
        assert!(f.fix.as_deref().unwrap().contains("slopmax key add"));
    }

    #[tokio::test]
    async fn the_login_service_is_reported() {
        let config = config_on(free_port());
        let status = |installed, running, lingering| {
            Some(Status {
                installed,
                running,
                lingering,
            })
        };
        let s = proxy(&config, status(false, false, None)).await;
        let f = finding(&s, "not installed as a service");
        assert_eq!(
            (f.level, f.fix.as_deref()),
            (Level::Note, Some("slopmax service install"))
        );
        let s = proxy(&config, status(true, true, Some(true))).await;
        assert_eq!(finding(&s, "runs as a login service").level, Level::Ok);
        assert!(!s.findings.iter().any(|f| f.text.contains("log out")));
        let s = proxy(&config, status(true, false, Some(false))).await;
        assert_eq!(finding(&s, "installed but not running").level, Level::Warn);
        let f = finding(&s, "stops when you log out");
        assert_eq!(f.fix.as_deref(), Some("loginctl enable-linger $USER"));
    }

    #[test]
    fn no_accounts_is_a_failure() {
        let s = accounts_section(&[], &[]);
        assert_eq!(texts(&s), [(Level::Fail, "no accounts connected")]);
    }

    #[test]
    fn accounts_are_counted_and_each_problem_has_a_fix() {
        let now = Timestamp::now();
        let dir = temp_dir("doctor-accounts");
        let kept = dir.join("kept.json");
        std::fs::write(&kept, "{}").unwrap();

        let fine = account(ProviderId::Claude, "fine@x.com");
        let mut revoked = account(ProviderId::Claude, "revoked@x.com");
        revoked.auth_error = Some("refresh token revoked".into());
        let mut orphan = account(ProviderId::Codex, "orphan@x.com");
        orphan.link = Some(Link {
            tool: "cliproxyapi".into(),
            path: dir.join("gone.json"),
        });
        let mut stale = account(ProviderId::Codex, "stale@x.com");
        stale.link = Some(Link {
            tool: "cliproxyapi".into(),
            path: kept.clone(),
        });
        stale.tokens.expires_at = Some(now - SignedDuration::from_mins(5));
        let mut current = account(ProviderId::Codex, "current@x.com");
        current.link = stale.link.clone();
        current.tokens.expires_at = Some(now + SignedDuration::from_hours(1));
        let mut off = account(ProviderId::Codex, "off@x.com");
        off.disabled = true;

        let failing = [
            (
                fine.id.clone(),
                "couldn't connect to api.anthropic.com (connection refused)".into(),
            ),
            // Said already: it needs a new login.
            (revoked.id.clone(), "refresh token revoked".into()),
        ];
        let s = accounts_section(
            &[
                fine,
                revoked.clone(),
                orphan.clone(),
                stale.clone(),
                current,
                off,
            ],
            &failing,
        );
        let counts = &s.findings[0];
        assert_eq!(counts.level, Level::Ok);
        let claude = ProviderId::Claude.spec().title;
        let codex = ProviderId::Codex.spec().title;
        assert_eq!(
            counts.text,
            format!("2 {claude} accounts, 4 {codex} accounts")
        );

        let f = finding(&s, "needs a new login (refresh token revoked)");
        assert_eq!(f.level, Level::Fail);
        assert_eq!(f.fix.as_deref(), Some("slopmax login claude"));
        let f = finding(&s, "follows cliproxyapi, but");
        assert_eq!(f.level, Level::Warn);
        assert!(f.text.contains("gone.json is gone"));
        assert_eq!(f.fix, Some(format!("slopmax own {}", orphan.id)));
        let f = finding(&s, "token expired and cliproxyapi has not refreshed it");
        assert_eq!(
            f.fix,
            Some(format!(
                "start cliproxyapi again, or slopmax own {}",
                stale.id
            ))
        );
        assert_eq!(finding(&s, "is disabled").level, Level::Note);
        let f = finding(&s, "fine@x.com's last request failed");
        assert_eq!(f.level, Level::Warn);
        assert_eq!(
            f.text,
            "fine@x.com's last request failed: couldn't connect to api.anthropic.com (connection refused)"
        );
        assert_eq!(f.fix.as_deref(), Some("slopmax logs"));
        // One count line, five problems: the fresh linked account is fine.
        assert_eq!(s.findings.len(), 6);

        let single = accounts_section(&[account(ProviderId::Codex, "one@x.com")], &[]);
        assert_eq!(single.findings[0].text, format!("1 {codex} account"));
    }

    fn claude_with(settings: Option<serde_json::Value>) -> Section {
        let dir = temp_dir("doctor-claude");
        if let Some(settings) = settings {
            std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
        }
        claude_code(&config_on(8318), &dir)
    }

    /// The finding about settings.json, apart from whether `claude` is on
    /// PATH or an API key is set in the shell running the tests.
    fn wiring(s: &Section) -> (Level, &str) {
        let f = s
            .findings
            .iter()
            .find(|f| !f.text.contains("PATH") && !f.text.contains("ANTHROPIC_API_KEY"))
            .unwrap();
        (f.level, f.text.as_str())
    }

    #[test]
    fn claude_code_wiring_is_checked_against_this_proxy() {
        let base = config_on(8318).base_url();
        let s = claude_with(Some(json!({ "env": {
            "ANTHROPIC_BASE_URL": base, "ANTHROPIC_AUTH_TOKEN": "sm-key"
        } })));
        assert_eq!(wiring(&s).0, Level::Ok);

        let s = claude_with(Some(json!({ "env": {
            "ANTHROPIC_BASE_URL": base, "ANTHROPIC_AUTH_TOKEN": "old-key"
        } })));
        assert_eq!(
            wiring(&s),
            (
                Level::Warn,
                "settings.json points at slopmax with a different key"
            )
        );

        let s = claude_with(Some(json!({ "env": {
            "ANTHROPIC_BASE_URL": "https://elsewhere.example"
        } })));
        assert_eq!(
            wiring(&s),
            (
                Level::Warn,
                "settings.json sends Claude Code to https://elsewhere.example"
            )
        );

        for missing in [None, Some(json!({ "theme": "dark" }))] {
            let s = claude_with(missing);
            let (level, text) = wiring(&s);
            assert_eq!(level, Level::Note);
            assert!(text.starts_with("not wired in settings.json"));
        }
        // A broken file reads as not wired, not as an error.
        let dir = temp_dir("doctor-claude-broken");
        std::fs::write(dir.join("settings.json"), "{ nope").unwrap();
        let s = claude_code(&config_on(8318), &dir);
        assert_eq!(wiring(&s).0, Level::Note);
        assert!(s.findings.iter().all(|f| {
            f.fix
                .as_deref()
                .is_none_or(|fix| fix.contains("claude") || fix.contains("unset"))
        }));
    }

    fn codex_with(toml: Option<&str>) -> (Level, String) {
        let dir = temp_dir("doctor-codex");
        if let Some(toml) = toml {
            std::fs::write(dir.join("config.toml"), toml).unwrap();
        }
        let s = codex(&config_on(8318), &dir);
        let f = s
            .findings
            .iter()
            .find(|f| !f.text.contains("PATH"))
            .unwrap();
        (f.level, f.text.clone())
    }

    #[test]
    fn codex_wiring_is_checked_against_this_proxy() {
        let wired = "model_provider = \"slopmax\"\n\
             [model_providers.slopmax]\n\
             base_url = \"http://127.0.0.1:8318/codex\"\n\
             experimental_bearer_token = \"sm-key\"\n";
        assert_eq!(codex_with(Some(wired)).0, Level::Ok);

        let old_key = wired.replace("sm-key", "old-key");
        assert_eq!(
            codex_with(Some(&old_key)),
            (
                Level::Warn,
                "config.toml's slopmax provider has an old address or key".into()
            )
        );
        let old_port = wired.replace("8318", "9999");
        assert_eq!(codex_with(Some(&old_port)).0, Level::Warn);

        let (level, text) = codex_with(Some("model_provider = \"slopmax\"\n"));
        assert_eq!(level, Level::Warn);
        assert!(text.contains("its provider table is gone"));

        assert_eq!(
            codex_with(Some("model_provider = \"openai\"\n")),
            (
                Level::Warn,
                "config.toml sends Codex to the `openai` provider".into()
            )
        );
        for unwired in [None, Some("model = \"gpt-5\"\n"), Some("not = [valid")] {
            let (level, text) = codex_with(unwired);
            assert_eq!(level, Level::Note, "{unwired:?}");
            assert!(text.starts_with("not wired in config.toml"));
        }
    }

    #[test]
    fn cliproxyapi_matters_only_with_linked_accounts() {
        let plain = account(ProviderId::Codex, "a@x.com");
        assert!(
            cliproxyapi(std::slice::from_ref(&plain), free_port())
                .findings
                .is_empty()
        );

        let mut linked = plain.clone();
        linked.link = Some(Link {
            tool: "cliproxyapi".into(),
            path: "/tmp/x.json".into(),
        });
        let accounts = [plain, linked];
        let s = cliproxyapi(&accounts, free_port());
        let f = finding(&s, "not running, so nothing refreshes the 1 accounts");
        assert_eq!(
            (f.level, f.fix.as_deref()),
            (Level::Warn, Some("slopmax own all"))
        );

        let running = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = running.local_addr().unwrap().port();
        let s = cliproxyapi(&accounts, port);
        let f = finding(&s, "still running and refreshing 1 account slopmax");
        assert_eq!(f.level, Level::Note);
    }

    #[tokio::test]
    async fn reachable_services_with_a_sound_clock_are_fine() {
        let mock = Mock::start(|_| testkit::reply(401, "")).await;
        let http = mock.client(&["https://api.anthropic.com", "https://chatgpt.com"]);
        let s = network(&http, &[]).await;
        assert_eq!(
            texts(&s),
            [
                (Level::Ok, "Anthropic is reachable"),
                (Level::Ok, "ChatGPT is reachable"),
            ]
        );
        let paths: Vec<String> = mock.seen().into_iter().map(|s| s.path).collect();
        assert_eq!(paths, ["/api/hello", "/backend-api/wham/usage"]);
    }

    #[tokio::test]
    async fn xai_is_checked_for_supergrok_accounts() {
        let mock = Mock::start(|_| testkit::reply(401, "")).await;
        let http = mock.client(&[
            "https://api.anthropic.com",
            "https://chatgpt.com",
            "https://cli-chat-proxy.grok.com",
        ]);
        let s = network(&http, &[account(ProviderId::Grok, "g@x.com")]).await;
        assert_eq!(texts(&s).last(), Some(&(Level::Ok, "xAI is reachable")));
        assert_eq!(mock.seen().last().unwrap().path, "/v1/models");
    }

    #[test]
    fn grok_build_is_checked_for_those_who_use_it() {
        let dir = testkit::temp_dir("doctor-grok");
        let config = Config {
            api_key: "sm-key".into(),
            ..Config::default()
        };
        let grok = [account(ProviderId::Grok, "g@x.com")];
        let with = |text: Option<&str>| {
            match text {
                Some(text) => std::fs::write(dir.join("config.toml"), text).unwrap(),
                None => {
                    let _ = std::fs::remove_file(dir.join("config.toml"));
                }
            }
            let s = grok_build(&config, &dir, &grok);
            let last = s.findings.last().unwrap();
            (last.level, last.text.clone())
        };
        let mut saved = None;
        let file = dir.join("config.toml");
        crate::agent::Agent::setup(&crate::agent::GrokBuild, &config, &file, &mut saved).unwrap();
        let wired = std::fs::read_to_string(&file).unwrap();
        assert_eq!(
            with(Some(&wired)),
            (Level::Ok, "wired through config.toml".into())
        );
        assert_eq!(with(Some(&wired.replace("sm-key", "old"))).0, Level::Warn);
        // Its own sign-in would bypass slopmax; a key it was handed would not.
        let auth = dir.join("auth.json");
        std::fs::write(&auth, r#"{"a":{"auth_mode":"external"}}"#).unwrap();
        assert_eq!(with(Some(&wired)).0, Level::Ok);
        std::fs::write(&auth, r#"{"a":{"auth_mode":"oauth"}}"#).unwrap();
        assert_eq!(
            with(Some(&wired)),
            (
                Level::Warn,
                "Grok Build is signed in to xAI itself, so it goes to xAI directly".into()
            )
        );
        std::fs::remove_file(&auth).unwrap();
        assert_eq!(
            with(Some(
                "[endpoints]\ncli_chat_proxy_base_url = \"https://p\"\n"
            )),
            (
                Level::Warn,
                "config.toml sends Grok Build to https://p".into()
            )
        );
        let (level, text) = with(None);
        assert_eq!(level, Level::Note);
        assert!(text.starts_with("not wired in config.toml"));
    }

    #[tokio::test]
    async fn a_skewed_clock_is_reported_once() {
        let mock = Mock::start(|_| {
            let mut response = testkit::reply(200, "");
            response
                .headers_mut()
                .insert("date", "Sun, 06 Nov 1994 08:49:37 GMT".parse().unwrap());
            response
        })
        .await;
        let http = mock.client(&["https://api.anthropic.com", "https://chatgpt.com"]);
        let s = network(&http, &[]).await;
        let skewed: Vec<&Finding> = s
            .findings
            .iter()
            .filter(|f| f.text.starts_with("the system clock is off by"))
            .collect();
        assert_eq!(skewed.len(), 1);
        assert_eq!(skewed[0].level, Level::Warn);
    }

    #[tokio::test]
    async fn unreachable_services_fail_with_a_fix() {
        let closed = format!("http://127.0.0.1:{}", free_port());
        let origins = Origins::new([
            ("https://api.anthropic.com", closed.as_str()),
            ("https://chatgpt.com", closed.as_str()),
        ]);
        let http = Client::builder().plain_http().origins(origins).build();
        let s = network(&http, &[]).await;
        assert_eq!(s.findings.len(), 2);
        for (f, name) in s.findings.iter().zip(["Anthropic", "ChatGPT"]) {
            assert_eq!(f.level, Level::Fail);
            assert!(f.text.starts_with(&format!("cannot reach {name}: ")));
            assert_eq!(
                f.fix.as_deref(),
                Some("check the network, or set HTTPS_PROXY")
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn account_files_others_can_read_are_flagged() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path, mode| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
        };
        let dir = temp_dir("doctor-files");
        let file = dir.join("claude-1.json");
        std::fs::write(&file, "{}").unwrap();
        mode(&dir, 0o700);
        mode(&file, 0o600);
        assert!(files(&dir).findings.is_empty());

        mode(&dir, 0o755);
        mode(&file, 0o644);
        let s = files(&dir);
        assert_eq!(s.findings.len(), 2);
        assert!(
            finding(&s, "is readable by other users")
                .fix
                .as_deref()
                .unwrap()
                .starts_with("chmod 700")
        );
        let f = finding(&s, "1 account files are readable by other users");
        assert!(f.fix.as_deref().unwrap().starts_with("chmod 600"));

        // No accounts directory yet: nothing to flag.
        assert!(files(&dir.join("missing")).findings.is_empty());
    }

    #[test]
    fn programs_are_looked_up_on_path() {
        assert!(on_path(if cfg!(windows) { "cmd" } else { "sh" }));
        assert!(!on_path("slopmax-no-such-program"));
    }

    #[test]
    fn levels_order_by_severity() {
        assert!(Level::Ok < Level::Note && Level::Note < Level::Warn && Level::Warn < Level::Fail);
    }

    mod tailnet {
        use super::*;
        use crate::config::{AdminMachine, HubLink, Tailnet};
        use crate::tailscale::{BackendState, Handler, HandlerTarget, Node, Published};

        fn home() -> Home {
            Home::sandbox("/home/me")
        }

        fn node() -> Node {
            Node {
                backend_state: BackendState::Running,
                dns_name: "hub.example.ts.net".into(),
                name: "hub".into(),
                ips: Vec::new(),
                tags: Vec::new(),
                login: Some("me@github".into()),
                cert_domains: vec!["hub.example.ts.net".into()],
                magic_dns_suffix: Some("example.ts.net".into()),
                version: "1.104.5".into(),
                id: "nSELF1CNTRL".into(),
            }
        }

        fn peer(id: &str, name: &str, login: Option<&str>) -> Peer {
            Peer {
                id: id.into(),
                dns_name: format!("{name}.example.ts.net"),
                name: name.into(),
                host_name: name.into(),
                online: true,
                tags: Vec::new(),
                login: login.map(str::to_owned),
                os: "linux".into(),
                ips: Vec::new(),
            }
        }

        fn served(target: Target) -> Published {
            Published {
                url: "https://hub.example.ts.net:7567".into(),
                port: 7567,
                transport: target.transport(),
                target,
                funnel: false,
            }
        }

        fn inspection(node: Result<Node, TsError>, published: Vec<Published>) -> Inspection {
            Inspection {
                exe: Some("/usr/bin/tailscale".into()),
                node,
                serve: None,
                published,
                stale: Vec::new(),
                operator: Some("me".into()),
            }
        }

        fn config(users: &[&str]) -> Config {
            Config {
                tailscale: Some(Tailnet {
                    users: users.iter().map(|u| u.to_string()).collect(),
                    admins: Vec::new(),
                }),
                ..config_on(7567)
            }
        }

        /// Everything fine: served over the socket, which answers, by a
        /// service that outlives the session, with the operator set.
        fn facts<'a>(inspection: &'a Inspection, peers: &'a [Peer]) -> TailnetFacts<'a> {
            TailnetFacts {
                inspection: Some(inspection),
                peers: Some(peers),
                socket_answers: Some(true),
                linger: Some(true),
                service: Some(true),
                user: Some("me"),
                root: false,
            }
        }

        fn section(config: &Config, facts: &TailnetFacts<'_>) -> Section {
            super::super::tailnet(config, &home(), facts).expect("a Tailscale section")
        }

        #[test]
        fn is_left_out_where_tailscale_has_nothing_to_do_with_slopmax() {
            let home = home();
            let none = TailnetFacts::default();
            assert!(super::super::tailnet(&config(&["me@github"]), &home, &none).is_none());
            let mut seen = inspection(Ok(node()), Vec::new());
            let peers = [];
            let plain = config_on(7567);
            assert!(super::super::tailnet(&plain, &home, &facts(&seen, &peers)).is_none());
            seen.published = vec![served(Target::Socket(home.tailnet_socket()))];
            seen.exe = None;
            assert!(super::super::tailnet(&plain, &home, &facts(&seen, &peers)).is_none());
        }

        #[test]
        fn a_hub_served_over_its_socket_is_fine() {
            let seen = inspection(
                Ok(node()),
                vec![served(Target::Socket(home().tailnet_socket()))],
            );
            let peers = [peer("nMAC1CNTRL", "mac", Some("me@github"))];
            let s = section(&config(&["me@github"]), &facts(&seen, &peers));
            assert_eq!(
                texts(&s),
                [(
                    Level::Ok,
                    "served to your tailnet at https://hub.example.ts.net:7567 (to ~/.slopmax/tailnet.sock)"
                )]
            );
        }

        #[test]
        fn tailscale_that_cannot_serve_fails_with_its_fix() {
            let peers = [];
            let cases = [
                (
                    Err(TsError::DaemonDown),
                    "Tailscale isn't running on this machine",
                ),
                (
                    Ok(Node {
                        backend_state: BackendState::NeedsLogin,
                        ..node()
                    }),
                    "signed out",
                ),
                (
                    Ok(Node {
                        backend_state: BackendState::Stopped,
                        ..node()
                    }),
                    "turned off",
                ),
                (
                    Ok(Node {
                        backend_state: BackendState::NeedsMachineAuth,
                        ..node()
                    }),
                    "waits for approval",
                ),
            ];
            for (node, says) in cases {
                let seen = inspection(node, Vec::new());
                let s = section(&config(&["me@github"]), &facts(&seen, &peers));
                assert_eq!(s.findings.len(), 1, "{s:#?}");
                let f = finding(&s, says);
                assert_eq!(f.level, Level::Fail);
                assert!(f.fix.is_some(), "{f:?}");
            }
            let seen = inspection(
                Ok(Node {
                    cert_domains: Vec::new(),
                    ..node()
                }),
                Vec::new(),
            );
            let s = section(&config(&["me@github"]), &facts(&seen, &peers));
            let f = finding(&s, "HTTPS certificates turned off");
            assert_eq!(f.level, Level::Fail);
            assert!(f.fix.as_deref().unwrap().contains("admin/dns"));
        }

        #[test]
        fn funnel_a_stale_target_and_a_silent_socket_fail() {
            let home = home();
            let mut open = served(Target::Socket(home.tailnet_socket()));
            open.funnel = true;
            let mut seen = inspection(Ok(node()), vec![open]);
            seen.stale = vec![Handler {
                port: 7567,
                https: true,
                host: "hub.example.ts.net".into(),
                path: "/".into(),
                target: HandlerTarget::Proxy("unix:/home/old/.slopmax/tailnet.sock".into()),
                foreground: false,
            }];
            let peers = [];
            let mut facts = facts(&seen, &peers);
            facts.socket_answers = Some(false);
            let s = section(&config(&["me@github"]), &facts);
            let f = finding(&s, "open to the internet through Tailscale Funnel");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Fail, Some("tailscale funnel --https=7567 off"))
            );
            // `slopmax tailscale on` leaves a target it doesn't serve alone,
            // so the fix turns the old one off first.
            let f = finding(&s, "serves unix:/home/old/.slopmax/tailnet.sock");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (
                    Level::Fail,
                    Some("tailscale serve --https=7567 off, then slopmax tailscale on")
                )
            );
            let f = finding(&s, "the proxy doesn't answer on ~/.slopmax/tailnet.sock");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Fail, Some("slopmax stop && slopmax start"))
            );
        }

        #[test]
        fn set_up_but_not_published_says_how_to_publish() {
            let seen = inspection(Ok(node()), Vec::new());
            let peers = [];
            let s = section(&config(&["me@github"]), &facts(&seen, &peers));
            let f = finding(&s, "isn't published to your tailnet");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Warn, Some("slopmax tailscale on"))
            );
        }

        #[test]
        fn loopback_and_no_users_are_notes() {
            let seen = inspection(Ok(node()), vec![served(Target::Loopback(7567))]);
            let peers = [];
            let s = section(&config(&[]), &facts(&seen, &peers));
            let f = finding(&s, "machines need a key");
            assert_eq!(f.level, Level::Note);
            let f = finding(&s, "[tailscale] users is empty");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Note, Some("slopmax tailscale users add <login>"))
            );
            assert!(
                finding(&s, "served to your tailnet")
                    .text
                    .contains("http://127.0.0.1:7567")
            );
        }

        #[test]
        fn unknown_users_and_admins_gone_from_the_tailnet_are_named() {
            let seen = inspection(
                Ok(node()),
                vec![served(Target::Socket(home().tailnet_socket()))],
            );
            let peers = [peer("nMAC1CNTRL", "mac", Some("me@github"))];
            let mut config = config(&["me@github", "Me@GitHub", "mee@github"]);
            config.tailscale.as_mut().unwrap().admins = vec![
                AdminMachine {
                    machine: "mac".into(),
                    id: "nMAC1CNTRL".into(),
                },
                AdminMachine {
                    machine: "old".into(),
                    id: "nOLD1CNTRL".into(),
                },
            ];
            let s = section(&config, &facts(&seen, &peers));
            let f = finding(&s, "signed in as mee@github (a typo?)");
            assert_eq!(f.level, Level::Note);
            assert!(!s.findings.iter().any(|f| f.text.contains("as Me@GitHub")));
            let f = finding(&s, "the admin machine old (nOLD1CNTRL)");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Warn, Some("slopmax tailscale admins remove old"))
            );
            assert!(!s.findings.iter().any(|f| f.text.contains("machine mac")));
            // Peers that couldn't be read prove nothing.
            let mut unread = facts(&seen, &peers);
            unread.peers = None;
            let s = section(&config, &unread);
            assert!(!s.findings.iter().any(|f| f.text.contains("a typo")));
        }

        #[test]
        fn a_published_hub_must_outlive_the_session_and_listen_here() {
            let seen = inspection(
                Ok(node()),
                vec![served(Target::Socket(home().tailnet_socket()))],
            );
            let peers = [];
            let mut config = config(&["me@github"]);
            config.listen.set_ip([0, 0, 0, 0].into());
            let mut facts = facts(&seen, &peers);
            facts.linger = Some(false);
            facts.service = Some(false);
            let s = section(&config, &facts);
            assert_eq!(
                finding(&s, "beyond this machine, where only keys work").level,
                Level::Note
            );
            let f = finding(&s, "stops when you log out");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Warn, Some("loginctl enable-linger $USER"))
            );
            let f = finding(&s, "doesn't start at login");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Warn, Some("slopmax service install"))
            );
        }

        #[test]
        fn without_operator_rights_linux_says_how_to_get_them() {
            let mut seen = inspection(
                Ok(node()),
                vec![served(Target::Socket(home().tailnet_socket()))],
            );
            seen.operator = None;
            let peers = [];
            let s = section(&config(&["me@github"]), &facts(&seen, &peers));
            let found = s.findings.iter().find(|f| f.text.contains("only root"));
            if cfg!(target_os = "linux") {
                let f = found.expect("the operator note");
                assert_eq!(f.level, Level::Note);
                assert_eq!(
                    f.fix.as_deref(),
                    Some("sudo tailscale set --operator=$USER")
                );
            } else {
                assert!(found.is_none());
            }
            let mut root = facts(&seen, &peers);
            root.root = true;
            let s = section(&config(&["me@github"]), &root);
            assert!(!s.findings.iter().any(|f| f.text.contains("only root")));
        }

        fn health(access: Option<Access>, version: &str) -> Health {
            Health {
                version: version.into(),
                pid: None,
                owner: Some(false),
                access,
                via: Some("tailnet".into()),
                login: Some("me@github".into()),
                machine: Some("mac".into()),
            }
        }

        fn client() -> Config {
            Config {
                hub: Some(HubLink {
                    url: "https://hub.example.ts.net:7567/".into(),
                    key: None,
                }),
                ..config_on(7567)
            }
        }

        #[test]
        fn a_client_reports_its_hub() {
            let ours = env!("CARGO_PKG_VERSION");
            let wired: Vec<(&dyn Agent, bool)> = agent::AGENTS.iter().map(|a| (*a, true)).collect();
            let s = hub(
                &client(),
                Some(&health(Some(Access::View), ours)),
                false,
                &wired,
            );
            assert_eq!(
                texts(&s),
                [
                    (
                        Level::Ok,
                        format!(
                            "the hub at https://hub.example.ts.net:7567 answers (slopmax {ours})"
                        )
                        .as_str()
                    ),
                    (Level::Ok, "it knows this machine as mac: use and view"),
                ]
            );

            let s = hub(&client(), None, false, &wired);
            let f = finding(&s, "isn't answering");
            assert_eq!(f.level, Level::Fail);
            assert!(f.fix.as_deref().unwrap().contains("tailscale status"));

            let s = hub(
                &client(),
                Some(&health(Some(Access::None), ours)),
                false,
                &wired,
            );
            assert_eq!(finding(&s, "doesn't take this machine").level, Level::Fail);

            let s = hub(&client(), Some(&health(None, "0.0.1")), false, &wired);
            assert_eq!(finding(&s, "is older").level, Level::Note);
            let f = finding(&s, "the hub runs slopmax 0.0.1");
            assert_eq!(f.level, Level::Note);

            let unwired: Vec<(&dyn Agent, bool)> =
                agent::AGENTS.iter().map(|a| (*a, false)).collect();
            let s = hub(
                &client(),
                Some(&health(Some(Access::Use), ours)),
                true,
                &unwired,
            );
            let f = finding(&s, "Claude Code doesn't use the hub");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (Level::Warn, Some("slopmax setup claude"))
            );
            let f = finding(&s, "a proxy of this machine's own still runs");
            assert_eq!(
                (f.level, f.fix.as_deref()),
                (
                    Level::Warn,
                    Some("slopmax stop, then slopmax service uninstall")
                )
            );
        }

        #[test]
        fn a_clients_agents_are_checked_against_the_hub() {
            let config = Config {
                hub: Some(HubLink {
                    url: "https://hub.example.ts.net:7567".into(),
                    key: Some("sm-client".into()),
                }),
                ..config_on(8318)
            };
            let dir = temp_dir("doctor-hub-claude");
            let settings = json!({ "env": {
                "ANTHROPIC_BASE_URL": "https://hub.example.ts.net:7567",
                "ANTHROPIC_AUTH_TOKEN": "sm-client"
            } });
            std::fs::write(dir.join("settings.json"), settings.to_string()).unwrap();
            assert_eq!(wiring(&claude_code(&config, &dir)).0, Level::Ok);
            assert_eq!(wiring(&claude_code(&config_on(8318), &dir)).0, Level::Warn);

            let dir = temp_dir("doctor-hub-codex");
            std::fs::write(
                dir.join("config.toml"),
                "model_provider = \"slopmax\"\n[model_providers.slopmax]\n\
                 base_url = \"https://hub.example.ts.net:7567/codex\"\n\
                 experimental_bearer_token = \"sm-client\"\n",
            )
            .unwrap();
            let s = codex(&config, &dir);
            assert!(s.findings.iter().any(|f| f.level == Level::Ok), "{s:#?}");
        }

        #[cfg(unix)]
        #[tokio::test]
        async fn the_socket_answers_only_with_a_200() {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let dir = temp_dir("doctor-socket");
            let path = dir.join("t.sock");
            assert!(!socket_answers(&path, Duration::from_millis(200)).await);
            let listener = tokio::net::UnixListener::bind(&path).unwrap();
            let serve = |status: &'static str| {
                let listener = &listener;
                async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut buf = [0u8; 256];
                    let _ = stream.read(&mut buf).await;
                    stream.write_all(status.as_bytes()).await.unwrap();
                }
            };
            let (answered, ()) = tokio::join!(
                socket_answers(&path, Duration::from_secs(2)),
                serve("HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
            );
            assert!(answered);
            let (answered, ()) = tokio::join!(
                socket_answers(&path, Duration::from_secs(2)),
                serve("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
            );
            assert!(!answered);
        }
    }
}
