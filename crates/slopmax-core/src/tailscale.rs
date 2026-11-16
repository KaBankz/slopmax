//! Tailscale, through its own `tailscale` command: what this machine is on
//! the tailnet, which machines it sees, what `tailscale serve` publishes, and
//! publishing slopmax there or taking it down.
//!
//! slopmax runs the CLI with `--json` and reads the answer loosely, as
//! [`serde_json::Value`], so fields Tailscale adds later change nothing. It
//! never runs `sudo`, `tailscale set`, `up`, `down`, `funnel` or
//! `serve reset`. Each run has a timeout, after which the child is killed.
//! Tests give a [`Tailscale`] a scripted [`Exec`] instead of the real
//! command.

use std::ffi::OsString;
use std::fmt;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value};
use slopmax_api::tailnet::TailnetView;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use crate::config::Config;
pub use crate::provider::BoxFuture;

/// How long reads of Tailscale's state may take.
const READ: Duration = Duration::from_secs(5);
/// How long `whois` may take: it runs while a request waits.
const WHOIS: Duration = Duration::from_secs(2);
/// How long a change to what `serve` publishes may take. The first one can
/// fetch a certificate.
const CHANGE: Duration = Duration::from_secs(30);

/// The admin console's machines page, where a machine is approved.
const MACHINES: &str = "https://login.tailscale.com/admin/machines";
/// The admin console's DNS page, where HTTPS certificates are turned on.
const DNS: &str = "https://login.tailscale.com/admin/dns";

/// Where the `tailscale` command is: `$SLOPMAX_TAILSCALE` when set (empty
/// means Tailscale isn't installed), else the first `tailscale` on `PATH`,
/// else where Tailscale's installers put it on macOS and Windows.
pub fn locate() -> Option<PathBuf> {
    locate_from(
        std::env::var_os("SLOPMAX_TAILSCALE"),
        std::env::var_os("PATH"),
    )
}

/// [`locate`], with `$SLOPMAX_TAILSCALE` and `$PATH` given rather than read.
pub fn locate_from(env: Option<OsString>, path: Option<OsString>) -> Option<PathBuf> {
    if let Some(given) = env {
        return (!given.is_empty()).then(|| PathBuf::from(given));
    }
    let name = if cfg!(windows) {
        "tailscale.exe"
    } else {
        "tailscale"
    };
    path.iter()
        .flat_map(std::env::split_paths)
        .map(|dir| dir.join(name))
        .chain(installed())
        .find(|candidate| candidate.is_file())
}

/// Where Tailscale's own installers put the command, when it isn't on `PATH`.
fn installed() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/opt/homebrew/bin/tailscale",
            "/usr/local/bin/tailscale",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    }
    #[cfg(windows)]
    {
        std::env::var_os("ProgramFiles")
            .map(|dir| PathBuf::from(dir).join("Tailscale").join("tailscale.exe"))
            .into_iter()
            .collect()
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Vec::new()
    }
}

/// Where the Tailscale app on macOS keeps its command.
const APP_BUNDLE: &str = "Tailscale.app/Contents/MacOS";

/// Whether `exe` runs the command inside the Tailscale app on macOS, whose
/// tailscaled runs sandboxed and can't reach a unix socket in the user's
/// home: the command itself, a link to it, or the small script that runs
/// it, which the app's "Install CLI" puts at `/usr/local/bin/tailscale`.
pub fn in_app_bundle(exe: &Path) -> bool {
    /// Larger than any script that only runs the app's command.
    const SCRIPT_MAX: u64 = 4096;
    let in_bundle = |path: &Path| path.to_string_lossy().contains(APP_BUNDLE);
    if in_bundle(exe) || std::fs::canonicalize(exe).is_ok_and(|real| in_bundle(&real)) {
        return true;
    }
    std::fs::metadata(exe).is_ok_and(|m| m.is_file() && m.len() <= SCRIPT_MAX)
        && std::fs::read(exe).is_ok_and(|text| String::from_utf8_lossy(&text).contains(APP_BUNDLE))
}

/// What a run of the `tailscale` command printed, and how it exited.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Output {
    /// The exit code; `None` when a signal stopped it.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs the `tailscale` command: [`Process`] for real, a scripted fake in
/// tests.
pub trait Exec: Send + Sync {
    /// Runs it with `args`, stopping it after `timeout`. With `passthrough`,
    /// what it prints also reaches this terminal as it comes, so a prompt
    /// with a URL in it is seen.
    fn run<'a>(
        &'a self,
        args: Vec<String>,
        timeout: Duration,
        passthrough: bool,
    ) -> BoxFuture<'a, Result<Output, TsError>>;
}

/// The real `tailscale` command, run as a child process with no input.
#[derive(Debug, Clone)]
pub struct Process {
    exe: PathBuf,
}

impl Process {
    /// The command at `exe`.
    pub fn new(exe: PathBuf) -> Self {
        Self { exe }
    }
}

impl Exec for Process {
    fn run<'a>(
        &'a self,
        args: Vec<String>,
        timeout: Duration,
        passthrough: bool,
    ) -> BoxFuture<'a, Result<Output, TsError>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new(&self.exe);
            command
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(windows)]
            {
                /// CREATE_NO_WINDOW: a windowless slopmax never flashes a
                /// console.
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let mut child = command.spawn().map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => TsError::Missing,
                _ => TsError::Failed {
                    line: format!("couldn't run {}: {e}", self.exe.display()),
                },
            })?;
            let stdout: Option<Pipe> = child.stdout.take().map(|p| Box::new(p) as Pipe);
            let stderr: Option<Pipe> = child.stderr.take().map(|p| Box::new(p) as Pipe);
            let finished = async {
                let (stdout, stderr, status) = tokio::join!(
                    collect(stdout, passthrough),
                    collect(stderr, passthrough),
                    child.wait()
                );
                let status = status.map_err(|e| TsError::Failed {
                    line: format!("couldn't wait for {}: {e}", self.exe.display()),
                })?;
                Ok(Output {
                    code: status.code(),
                    stdout,
                    stderr,
                })
            };
            // Out of time, `finished` is dropped and then `child`, which
            // kills it.
            match tokio::time::timeout(timeout, finished).await {
                Ok(output) => output,
                Err(_) => Err(TsError::Timeout {
                    what: args.join(" "),
                }),
            }
        })
    }
}

/// One of the child's output pipes, boxed so stdout and stderr share one
/// reader.
type Pipe = Box<dyn AsyncRead + Send + Unpin>;

/// Everything `pipe` gives until it closes, each line also written to this
/// terminal's stderr as it arrives with `passthrough`.
async fn collect(pipe: Option<Pipe>, passthrough: bool) -> String {
    use std::io::Write;
    let Some(pipe) = pipe else {
        return String::new();
    };
    let mut pipe = BufReader::new(pipe);
    let (mut all, mut line) = (Vec::new(), Vec::new());
    loop {
        line.clear();
        match pipe.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if passthrough {
                    let mut terminal = std::io::stderr().lock();
                    let _ = terminal.write_all(&line);
                    let _ = terminal.flush();
                }
                all.extend_from_slice(&line);
            }
        }
    }
    String::from_utf8_lossy(&all).into_owned()
}

/// The `tailscale` command on this machine.
#[derive(Clone)]
pub struct Tailscale {
    /// Where it is.
    pub exe: PathBuf,
    exec: Arc<dyn Exec>,
}

impl fmt::Debug for Tailscale {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tailscale").field("exe", &self.exe).finish()
    }
}

impl Tailscale {
    /// The command [`locate`] finds, run for real.
    pub fn find() -> Result<Self, TsError> {
        let exe = locate().ok_or(TsError::Missing)?;
        Ok(Self::with(exe.clone(), Arc::new(Process::new(exe))))
    }

    /// The command at `exe`, run through `exec`.
    pub fn with(exe: PathBuf, exec: Arc<dyn Exec>) -> Self {
        Self { exe, exec }
    }

    /// Runs `args`, which must exit 0.
    async fn ok(
        &self,
        args: &[&str],
        timeout: Duration,
        passthrough: bool,
    ) -> Result<Output, TsError> {
        let output = self.raw(args, timeout, passthrough).await?;
        match output.code {
            Some(0) => Ok(output),
            _ => Err(classify(&output)),
        }
    }

    /// Runs `args`, however it exits.
    async fn raw(
        &self,
        args: &[&str],
        timeout: Duration,
        passthrough: bool,
    ) -> Result<Output, TsError> {
        let args = args.iter().map(|&arg| arg.to_owned()).collect();
        self.exec.run(args, timeout, passthrough).await
    }

    /// Reads `tailscale status --json`, through `args`, as `parse` reads it.
    /// An answer that reads is taken whatever the exit code; one that doesn't
    /// is an error from the exit, or else [`TsError::Unreadable`].
    async fn status<T>(
        &self,
        args: &[&str],
        parse: impl FnOnce(&str) -> Result<T, TsError>,
    ) -> Result<T, TsError> {
        let output = self.raw(args, READ, false).await?;
        match parse(&output.stdout) {
            Ok(parsed) => Ok(parsed),
            Err(_) if output.code != Some(0) => Err(classify(&output)),
            Err(e) => Err(e),
        }
    }

    /// This machine on the tailnet.
    pub async fn node(&self) -> Result<Node, TsError> {
        self.status(&["status", "--json", "--peers=false"], |json| {
            parse_status(json).map(|(node, _)| node)
        })
        .await
    }

    /// This machine and the others it sees on the tailnet, sorted by name.
    pub async fn peers(&self) -> Result<(Node, Vec<Peer>), TsError> {
        self.status(&["status", "--json"], parse_status).await
    }

    /// What `tailscale serve` publishes from this machine.
    pub async fn serve_state(&self) -> Result<ServeState, TsError> {
        let output = self.ok(&["serve", "status", "--json"], READ, false).await?;
        parse_serve(&output.stdout)
    }

    /// The user tailscaled lets change its settings besides root, if any.
    /// Best-effort: `None` too when it can't be read.
    pub async fn operator(&self) -> Option<String> {
        let output = self.ok(&["debug", "prefs"], READ, false).await.ok()?;
        let prefs: Value = serde_json::from_str(&output.stdout).ok()?;
        prefs
            .get("OperatorUser")
            .and_then(Value::as_str)
            .filter(|user| !user.is_empty())
            .map(str::to_owned)
    }

    /// Publishes `target` to the tailnet over HTTPS on `port`, in the
    /// background so it outlasts this command. What Tailscale prints reaches
    /// the terminal.
    pub async fn publish(&self, port: u16, target: &Target) -> Result<(), TsError> {
        let https = format!("--https={port}");
        let target = target.arg();
        self.ok(&["serve", "--bg", "--yes", &https, &target], CHANGE, true)
            .await
            .map(drop)
    }

    /// Stops publishing whatever `port` serves.
    pub async fn unpublish(&self, port: u16) -> Result<(), TsError> {
        let https = format!("--https={port}");
        self.ok(&["serve", &https, "off"], CHANGE, false)
            .await
            .map(drop)
    }

    /// Which machine, and whose, has the tailnet address `ip`.
    pub async fn whois(&self, ip: IpAddr) -> Result<Machine, TsError> {
        let ip = ip.to_string();
        let output = self.ok(&["whois", "--json", &ip], WHOIS, false).await?;
        parse_whois(&output.stdout)
    }
}

/// tailscaled's state, as `BackendState` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendState {
    Running,
    NeedsLogin,
    NeedsMachineAuth,
    Stopped,
    Starting,
    NoState,
    /// A state this slopmax doesn't know, as Tailscale named it.
    Other(String),
}

impl BackendState {
    fn parse(state: &str) -> Self {
        match state {
            "Running" => Self::Running,
            "NeedsLogin" => Self::NeedsLogin,
            "NeedsMachineAuth" => Self::NeedsMachineAuth,
            "Stopped" => Self::Stopped,
            "Starting" => Self::Starting,
            "NoState" => Self::NoState,
            other => Self::Other(other.to_owned()),
        }
    }
}

/// This machine on the tailnet, from `tailscale status --json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub backend_state: BackendState,
    /// Its full name in MagicDNS, without the trailing dot:
    /// `hub.example.ts.net`. Empty while signed out.
    pub dns_name: String,
    /// The first label of [`Node::dns_name`]: `hub`.
    pub name: String,
    /// Its tailnet addresses.
    pub ips: Vec<IpAddr>,
    /// Its ACL tags. A tagged machine belongs to no one.
    pub tags: Vec<String>,
    /// Who it is signed in as; `None` when tagged.
    pub login: Option<String>,
    /// The names Tailscale can get certificates for; empty while HTTPS is off
    /// in the tailnet.
    pub cert_domains: Vec<String>,
    /// The tailnet's MagicDNS suffix: `example.ts.net`.
    pub magic_dns_suffix: Option<String>,
    /// Tailscale's version here: `1.104.5`.
    pub version: String,
    /// Its stable node id.
    pub id: String,
}

/// Another machine on the tailnet, from `tailscale status --json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    /// Its stable node id (`ID` in the JSON), such as `nfsCwwfvgz11CNTRL`.
    pub id: String,
    /// Its full name in MagicDNS, without the trailing dot.
    pub dns_name: String,
    /// The first label of [`Peer::dns_name`]. Never the host name, which can
    /// be `Me’s MacBook Pro`.
    pub name: String,
    /// The name the machine gives itself, as its owner typed it.
    pub host_name: String,
    pub online: bool,
    pub tags: Vec<String>,
    /// Who it is signed in as; `None` when tagged.
    pub login: Option<String>,
    pub os: String,
    /// Its tailnet addresses.
    pub ips: Vec<IpAddr>,
}

/// A machine on the tailnet as `tailscale whois` names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Machine {
    /// Its stable node id.
    pub id: String,
    /// Its MagicDNS name's first label.
    pub name: String,
    /// Who it is signed in as; `None` when tagged.
    pub login: Option<String>,
    pub tags: Vec<String>,
}

/// The text at `key`, or empty.
fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// The texts in the array at `key`.
fn texts(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// The addresses in the array at `key`, any `/32`-style prefix length left
/// off.
fn addresses(value: &Value, key: &str) -> Vec<IpAddr> {
    texts(value, key)
        .iter()
        .filter_map(|ip| ip.split('/').next()?.parse().ok())
        .collect()
}

/// `name` without MagicDNS's trailing dot.
fn trim_dot(name: &str) -> String {
    name.strip_suffix('.').unwrap_or(name).to_owned()
}

/// The first label of a DNS name.
fn first_label(name: &str) -> String {
    name.split('.').next().unwrap_or_default().to_owned()
}

/// `1.104.5` from `1.104.5-t788384763-gd9218e278`.
fn short_version(version: &str) -> String {
    version.split('-').next().unwrap_or_default().to_owned()
}

/// The login of the user `status` lists under `user_id`, unless the machine
/// is tagged.
fn login_of(status: &Value, user_id: Option<&Value>, tagged: bool) -> Option<String> {
    if tagged {
        return None;
    }
    let key = match user_id? {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    let login = text(status.get("User")?.get(&key)?, "LoginName");
    (!login.is_empty()).then_some(login)
}

/// This machine and the others, from `tailscale status --json`.
pub fn parse_status(json: &str) -> Result<(Node, Vec<Peer>), TsError> {
    let unreadable = |version: String| TsError::Unreadable { version };
    let status: Value = serde_json::from_str(json).map_err(|_| unreadable(String::new()))?;
    let version = short_version(&text(&status, "Version"));
    let Some(state) = status.get("BackendState").and_then(Value::as_str) else {
        return Err(unreadable(version));
    };
    let backend_state = BackendState::parse(state);
    let null = Value::Null;
    let me = match status.get("Self").filter(|me| me.is_object()) {
        Some(me) => me,
        // Signed out, Tailscale may know nothing of this machine yet.
        None if backend_state != BackendState::Running => &null,
        None => return Err(unreadable(version)),
    };
    let dns_name = trim_dot(&text(me, "DNSName"));
    let tags = texts(me, "Tags");
    let mut ips = addresses(me, "TailscaleIPs");
    if ips.is_empty() {
        ips = addresses(&status, "TailscaleIPs");
    }
    let suffix = Some(text(&status, "MagicDNSSuffix"))
        .filter(|s| !s.is_empty())
        .or_else(|| Some(text(status.get("CurrentTailnet")?, "MagicDNSSuffix")))
        .filter(|s| !s.is_empty());
    let node = Node {
        backend_state,
        name: first_label(&dns_name),
        dns_name,
        ips,
        login: login_of(&status, me.get("UserID"), !tags.is_empty()),
        tags,
        cert_domains: texts(&status, "CertDomains"),
        magic_dns_suffix: suffix,
        version,
        id: text(me, "ID"),
    };
    let mut peers: Vec<Peer> = Vec::new();
    for peer in status
        .get("Peer")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(Map::values)
    {
        let dns_name = trim_dot(&text(peer, "DNSName"));
        let tags = texts(peer, "Tags");
        let peer = Peer {
            id: text(peer, "ID"),
            name: first_label(&dns_name),
            dns_name,
            host_name: text(peer, "HostName"),
            online: peer.get("Online").and_then(Value::as_bool) == Some(true),
            login: login_of(&status, peer.get("UserID"), !tags.is_empty()),
            tags,
            os: text(peer, "OS"),
            ips: addresses(peer, "TailscaleIPs"),
        };
        insert_sorted(&mut peers, peer, |a, b| {
            a.name
                .cmp(&b.name)
                .then_with(|| a.dns_name.cmp(&b.dns_name))
        });
    }
    Ok((node, peers))
}

/// The machine in `tailscale whois --json`'s answer.
pub fn parse_whois(json: &str) -> Result<Machine, TsError> {
    let unreadable = || TsError::Unreadable {
        version: String::new(),
    };
    let whois: Value = serde_json::from_str(json).map_err(|_| unreadable())?;
    let node = whois
        .get("Node")
        .filter(|node| node.is_object())
        .ok_or_else(unreadable)?;
    let tags = texts(node, "Tags");
    let name = Some(text(node, "ComputedName"))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| first_label(&text(node, "Name")));
    let login = whois
        .get("UserProfile")
        .map(|profile| text(profile, "LoginName"))
        .filter(|login| tags.is_empty() && !login.is_empty());
    Ok(Machine {
        id: text(node, "StableID"),
        name,
        login,
        tags,
    })
}

/// What `tailscale serve` passes requests to, as slopmax publishes it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Target {
    /// A unix socket (Linux and macOS).
    Socket(PathBuf),
    /// A port on this machine's loopback address.
    Loopback(u16),
}

impl Target {
    /// The target as `tailscale serve` takes it: `unix:<path>` or
    /// `http://127.0.0.1:<port>`.
    pub fn arg(&self) -> String {
        match self {
            Self::Socket(path) => format!("unix:{}", path.display()),
            Self::Loopback(port) => format!("http://127.0.0.1:{port}"),
        }
    }

    /// How requests reach slopmax through it.
    pub fn transport(&self) -> Transport {
        match self {
            Self::Socket(_) => Transport::Socket,
            Self::Loopback(_) => Transport::Loopback,
        }
    }

    fn local(&self) -> Local {
        match self {
            Self::Socket(path) => Local::Socket(path.clone()),
            Self::Loopback(port) => Local::Loopback(*port),
        }
    }
}

/// How requests from the tailnet reach slopmax.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Transport {
    /// Through slopmax's unix socket, which tells it who is asking.
    Socket,
    /// Through its TCP port on loopback, where it can't tell.
    Loopback,
}

/// What `tailscale serve` publishes from this machine.
#[derive(Debug, Clone, PartialEq)]
pub struct ServeState {
    /// Each path on each port, sorted by port and path.
    pub handlers: Vec<Handler>,
    /// The ports Tailscale Funnel opens to the internet.
    pub funnel_ports: Vec<u16>,
    /// The answer as Tailscale gave it.
    pub raw: Value,
}

/// One thing `tailscale serve` publishes: a path on a port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handler {
    pub port: u16,
    /// Whether the port serves HTTPS (else plain HTTP, or raw TCP).
    pub https: bool,
    /// The name it is served under; empty for a TCP forward.
    pub host: String,
    /// The path it is served at; empty for a TCP forward.
    pub path: String,
    pub target: HandlerTarget,
    /// Whether a `tailscale serve` running in some terminal publishes it,
    /// rather than tailscaled in the background.
    pub foreground: bool,
}

/// Where a [`Handler`] sends what it receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandlerTarget {
    /// An HTTP server: `http://127.0.0.1:3000`, `unix:/path`.
    Proxy(String),
    /// A raw TCP forward: `127.0.0.1:22`.
    Tcp(String),
    /// Files, fixed text, or something newer, described.
    Other(String),
}

impl fmt::Display for HandlerTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Proxy(text) | Self::Tcp(text) | Self::Other(text) => f.write_str(text),
        }
    }
}

/// What `tailscale serve status --json` says is published. `{}`, or nothing
/// at all, means nothing is.
pub fn parse_serve(json: &str) -> Result<ServeState, TsError> {
    let raw: Value = if json.trim().is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str(json).map_err(|_| TsError::Unreadable {
            version: String::new(),
        })?
    };
    if !raw.is_object() {
        return Err(TsError::Unreadable {
            version: String::new(),
        });
    }
    let mut state = ServeState {
        handlers: Vec::new(),
        funnel_ports: Vec::new(),
        raw: Value::Null,
    };
    read_config(&raw, false, &mut state);
    if let Some(sessions) = raw.get("Foreground").and_then(Value::as_object) {
        for session in sessions.values() {
            read_config(session, true, &mut state);
        }
    }
    state.raw = raw;
    Ok(state)
}

/// The port of a `host:port` key.
fn port_of(key: &str) -> Option<(&str, u16)> {
    let (host, port) = key.rsplit_once(':')?;
    Some((host, port.parse().ok()?))
}

/// Adds what one ServeConfig publishes to `state`.
fn read_config(config: &Value, foreground: bool, state: &mut ServeState) {
    let tcp = config.get("TCP").and_then(Value::as_object);
    for (port, handler) in tcp.into_iter().flatten() {
        let (Ok(port), Some(forward)) = (
            port.parse::<u16>(),
            handler.get("TCPForward").and_then(Value::as_str),
        ) else {
            continue;
        };
        if forward.is_empty() {
            continue;
        }
        add_handler(
            state,
            Handler {
                port,
                https: !text(handler, "TerminateTLS").is_empty(),
                host: String::new(),
                path: String::new(),
                target: HandlerTarget::Tcp(forward.to_owned()),
                foreground,
            },
        );
    }
    let web = config.get("Web").and_then(Value::as_object);
    for (key, site) in web.into_iter().flatten() {
        let Some((host, port)) = port_of(key) else {
            continue;
        };
        // A port serves HTTPS unless its TCP entry says plain HTTP.
        let plain = tcp
            .and_then(|tcp| tcp.get(&port.to_string()))
            .and_then(|entry| entry.get("HTTP"))
            .and_then(Value::as_bool)
            == Some(true);
        let handlers = site.get("Handlers").and_then(Value::as_object);
        for (path, handler) in handlers.into_iter().flatten() {
            add_handler(
                state,
                Handler {
                    port,
                    https: !plain,
                    host: host.to_owned(),
                    path: path.clone(),
                    target: handler_target(handler),
                    foreground,
                },
            );
        }
    }
    let funnel = config.get("AllowFunnel").and_then(Value::as_object);
    for (key, on) in funnel.into_iter().flatten() {
        if let (Some((_, port)), Some(true)) = (port_of(key), on.as_bool())
            && let Err(at) = state.funnel_ports.binary_search(&port)
        {
            state.funnel_ports.insert(at, port);
        }
    }
}

/// Adds `handler` to what `state` publishes, in order of port and path.
fn add_handler(state: &mut ServeState, handler: Handler) {
    insert_sorted(&mut state.handlers, handler, |a, b| {
        (a.port, &a.path, a.foreground).cmp(&(b.port, &b.path, b.foreground))
    });
}

/// Puts `item` in `list`, sorted by `order`, after those it equals. The
/// lists are short, and a sort is compiled anew for each type it sorts.
fn insert_sorted<T>(list: &mut Vec<T>, item: T, order: impl Fn(&T, &T) -> std::cmp::Ordering) {
    let at = list.partition_point(|x| order(x, &item).is_le());
    list.insert(at, item);
}

fn handler_target(handler: &Value) -> HandlerTarget {
    let field = |key| Some(text(handler, key)).filter(|value| !value.is_empty());
    if let Some(proxy) = field("Proxy") {
        HandlerTarget::Proxy(proxy)
    } else if let Some(path) = field("Path") {
        HandlerTarget::Other(path)
    } else if handler.get("Text").is_some() {
        HandlerTarget::Other("a fixed text".to_owned())
    } else if let Some(redirect) = field("Redirect") {
        HandlerTarget::Other(redirect)
    } else {
        HandlerTarget::Other("something".to_owned())
    }
}

/// A place on this machine a proxy target points at.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Local {
    Socket(PathBuf),
    Loopback(u16),
}

/// Where on this machine a `serve` proxy target points, whichever of its
/// forms it takes (`unix:/path`, `http://127.0.0.1:N`, `localhost:N`,
/// `[::1]:N`, a bare port); `None` for anywhere else.
fn local(proxy: &str) -> Option<Local> {
    if let Some(path) = proxy.strip_prefix("unix:") {
        let path = path.strip_prefix("//").unwrap_or(path);
        return Some(Local::Socket(PathBuf::from(path)));
    }
    let rest = proxy.strip_prefix("http://").unwrap_or(proxy);
    if rest.contains("://") {
        return None;
    }
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if let Ok(port) = rest.parse() {
        return Some(Local::Loopback(port));
    }
    let (host, port) = rest.rsplit_once(':')?;
    let loopback = host == "127.0.0.1" || host == "[::1]" || host.eq_ignore_ascii_case("localhost");
    loopback.then_some(Local::Loopback(port.parse().ok()?))
}

/// The one of `targets` `handler` passes requests to, if any.
fn target_of<'a>(handler: &Handler, targets: &'a [Target]) -> Option<&'a Target> {
    let HandlerTarget::Proxy(proxy) = &handler.target else {
        return None;
    };
    let at = local(proxy)?;
    targets.iter().find(|target| target.local() == at)
}

/// Whether `handler` passes requests to one of `targets`, whichever way its
/// target is written.
pub fn ours(handler: &Handler, targets: &[Target]) -> bool {
    target_of(handler, targets).is_some()
}

/// What a port of this machine serves to the tailnet, as far as slopmax is
/// concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Port {
    /// Nothing.
    Free,
    /// slopmax.
    Ours(Handler),
    /// Something else, which `by` names.
    Taken { by: String },
}

/// What `port` serves: nothing, slopmax at one of `targets`, or something
/// else. A TCP forward, another proxy, files, or a foreground session on the
/// port all take it.
pub fn port_use(state: &ServeState, port: u16, targets: &[Target]) -> Port {
    let mut on = state.handlers.iter().filter(|h| h.port == port).peekable();
    let Some(&first) = on.peek() else {
        return Port::Free;
    };
    match on.find(|h| h.foreground || !ours(h, targets)) {
        Some(other) if other.foreground => Port::Taken {
            by: format!("{} (from a `tailscale serve` in a terminal)", other.target),
        },
        Some(other) => Port::Taken {
            by: other.target.to_string(),
        },
        None => Port::Ours(first.clone()),
    }
}

/// Where slopmax is published on the tailnet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Published {
    /// Its address: `https://hub.example.ts.net:7567`.
    pub url: String,
    pub port: u16,
    /// Which of slopmax's targets the port passes requests to.
    pub target: Target,
    pub transport: Transport,
    /// Whether Tailscale Funnel opens the port to the internet.
    pub funnel: bool,
}

/// Each port that publishes one of `targets`, with its address on `node`.
pub fn published(state: &ServeState, node: &Node, targets: &[Target]) -> Vec<Published> {
    let mut all: Vec<Published> = Vec::new();
    for handler in &state.handlers {
        let Some(target) = target_of(handler, targets) else {
            continue;
        };
        if all.iter().any(|p| p.port == handler.port) {
            continue;
        }
        let host = if node.dns_name.is_empty() {
            &handler.host
        } else {
            &node.dns_name
        };
        let (scheme, default) = if handler.https {
            ("https", 443)
        } else {
            ("http", 80)
        };
        let url = match handler.port {
            port if port == default => format!("{scheme}://{host}"),
            port => format!("{scheme}://{host}:{port}"),
        };
        all.push(Published {
            url,
            port: handler.port,
            target: target.clone(),
            transport: target.transport(),
            funnel: state.funnel_ports.contains(&handler.port),
        });
    }
    all
}

/// The handlers on `port` that pass requests to a unix socket or a loopback
/// port of this machine other than `targets`: most likely slopmax published
/// from another home or another port before.
pub fn stale(state: &ServeState, port: u16, targets: &[Target]) -> Vec<Handler> {
    state
        .handlers
        .iter()
        .filter(|h| h.port == port && !ours(h, targets))
        .filter(|h| matches!(&h.target, HandlerTarget::Proxy(proxy) if local(proxy).is_some()))
        .cloned()
        .collect()
}

/// The command that stops publishing `port`: what turns off a [`stale`]
/// handler, which slopmax leaves alone since it doesn't serve this home.
pub fn serve_off(port: u16) -> String {
    format!("tailscale serve --https={port} off")
}

/// Everything slopmax reads about Tailscale on this machine at once, for
/// status and doctor.
#[derive(Debug, Clone)]
pub struct Inspection {
    /// Where the `tailscale` command is, if anywhere.
    pub exe: Option<PathBuf>,
    /// This machine on the tailnet, or why it couldn't be read.
    pub node: Result<Node, TsError>,
    /// What `serve` publishes; `None` when it couldn't be read.
    pub serve: Option<ServeState>,
    /// Where slopmax is published.
    pub published: Vec<Published>,
    /// What [`stale`] finds on the port slopmax is meant to be on.
    pub stale: Vec<Handler>,
    /// tailscaled's operator, if any.
    pub operator: Option<String>,
}

/// Reads Tailscale's state here through `ts` (`None`: no `tailscale`
/// command), for slopmax at `targets` and meant to be on `port_hint`. It
/// never fails: what couldn't be read is kept as the error, or left out.
pub async fn inspect(ts: Option<&Tailscale>, targets: &[Target], port_hint: u16) -> Inspection {
    let mut inspection = Inspection {
        exe: ts.map(|ts| ts.exe.clone()),
        node: Err(TsError::Missing),
        serve: None,
        published: Vec::new(),
        stale: Vec::new(),
        operator: None,
    };
    let Some(ts) = ts else {
        return inspection;
    };
    inspection.node = ts.node().await;
    let Ok(node) = &inspection.node else {
        return inspection;
    };
    let (serve, operator) = tokio::join!(ts.serve_state(), ts.operator());
    inspection.operator = operator;
    if let Ok(serve) = serve {
        inspection.published = published(&serve, node, targets);
        inspection.stale = stale(&serve, port_hint, targets);
        inspection.serve = Some(serve);
    }
    inspection
}

impl Inspection {
    /// slopmax on the tailnet as the API shows it, before the config's say
    /// on who may use it ([`with_config`] adds that). The daemon's
    /// `GET /tailnet` and `slopmax tailscale status --json` both answer
    /// with this, so the two never disagree.
    pub fn view(&self) -> TailnetView {
        use slopmax_api::tailnet::{Problem, TailscaleState as State};
        let state = match &self.node {
            Ok(node) => match node.backend_state {
                BackendState::Running => State::Running,
                BackendState::NeedsLogin => State::SignedOut,
                BackendState::Stopped => State::Off,
                BackendState::NeedsMachineAuth => State::NeedsApproval,
                BackendState::NoState => State::Down,
                BackendState::Starting | BackendState::Other(_) => State::Unknown,
            },
            Err(TsError::Missing) => State::Missing,
            Err(TsError::DaemonDown) => State::Down,
            Err(TsError::LoggedOut) => State::SignedOut,
            Err(TsError::Off) => State::Off,
            Err(TsError::NeedsApproval) => State::NeedsApproval,
            Err(_) => State::Unknown,
        };
        let published = self.published.first();
        let funnel = self.published.iter().find(|p| p.funnel);
        let problem = match &self.node {
            Err(e) => Some(e.clone()),
            Ok(node) => state_error(node)
                .or_else(|| {
                    let https_off =
                        node.backend_state == BackendState::Running && node.cert_domains.is_empty();
                    https_off.then_some(TsError::NoHttps)
                })
                .or_else(|| funnel.map(|p| TsError::Funnel { port: p.port })),
        };
        TailnetView {
            tailscale: state,
            url: published.map(|p| p.url.clone()),
            transport: published.map(|p| match p.transport {
                Transport::Socket => slopmax_api::tailnet::Transport::Socket,
                Transport::Loopback => slopmax_api::tailnet::Transport::Loopback,
            }),
            identity: false,
            host: self
                .node
                .as_ref()
                .ok()
                .map(|node| node.name.clone())
                .filter(|name| !name.is_empty()),
            users: Vec::new(),
            admins: Vec::new(),
            funnel: funnel.is_some(),
            problem: problem.map(|e| Problem {
                text: e.message(),
                fix: e.fix(),
            }),
        }
    }
}

/// `view` with who may use slopmax as `config` says. Logins are taken
/// without a key when tailscaled reaches slopmax through its socket, which
/// names them, and some login is listed.
pub fn with_config(mut view: TailnetView, config: &Config) -> TailnetView {
    let tailnet = config.tailscale.clone().unwrap_or_default();
    view.identity = cfg!(unix)
        && view.transport == Some(slopmax_api::tailnet::Transport::Socket)
        && !tailnet.users.is_empty();
    view.users = tailnet.users;
    view.admins = tailnet
        .admins
        .into_iter()
        .map(|admin| slopmax_api::tailnet::AdminMachine {
            machine: admin.machine,
            id: admin.id,
        })
        .collect();
    view
}

/// Why slopmax couldn't do something with Tailscale.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TsError {
    /// There is no `tailscale` command here.
    Missing,
    /// tailscaled isn't running.
    DaemonDown,
    /// This machine is signed out of its tailnet.
    LoggedOut,
    /// Tailscale is turned off here.
    Off,
    /// The tailnet's admin hasn't approved this machine yet.
    NeedsApproval,
    /// Only root may change what this machine serves.
    AccessDenied,
    /// The tailnet has HTTPS certificates turned off.
    NoHttps,
    /// Something else is published on `port`.
    PortTaken { port: u16, by: String },
    /// Tailscale Funnel opens `port` to the internet.
    Funnel { port: u16 },
    /// `tailscale <what>` took too long and was stopped.
    Timeout { what: String },
    /// Tailscale's answer didn't read; `version` is Tailscale's, when known.
    Unreadable { version: String },
    /// Tailscale refused, saying `line`.
    Failed { line: String },
}

impl TsError {
    /// What went wrong, as a sentence.
    pub fn message(&self) -> String {
        match self {
            Self::Missing => "Tailscale isn't installed here".to_owned(),
            Self::DaemonDown => "Tailscale isn't running on this machine".to_owned(),
            Self::LoggedOut => "Tailscale on this machine is signed out".to_owned(),
            Self::Off => "Tailscale on this machine is turned off".to_owned(),
            Self::NeedsApproval => {
                "this machine waits for approval to join your tailnet".to_owned()
            }
            Self::AccessDenied => {
                "Tailscale lets only root change what this machine serves.".to_owned()
            }
            Self::NoHttps => "your tailnet has HTTPS certificates turned off".to_owned(),
            Self::PortTaken { port, by } => {
                format!("port {port} of this machine already serves {by} to your tailnet")
            }
            Self::Funnel { port } => {
                format!("port {port} is open to the internet through Tailscale Funnel")
            }
            Self::Timeout { what } => format!("`tailscale {what}` didn't answer in time"),
            Self::Unreadable { version } if version.is_empty() => {
                "couldn't read Tailscale's answer; update slopmax or Tailscale".to_owned()
            }
            Self::Unreadable { version } => format!(
                "couldn't read Tailscale's answer (tailscale {version}); update slopmax or Tailscale"
            ),
            Self::Failed { line } => format!("tailscale said: {line}"),
        }
    }

    /// What to run or do to fix it, where there is something.
    pub fn fix(&self) -> Option<String> {
        let fix = match self {
            Self::Missing => "Install Tailscale from https://tailscale.com/download".to_owned(),
            Self::DaemonDown if cfg!(target_os = "macos") => "Open the Tailscale app".to_owned(),
            Self::DaemonDown if cfg!(windows) => "Start Tailscale from the Start menu".to_owned(),
            Self::DaemonDown => "sudo systemctl enable --now tailscaled".to_owned(),
            Self::LoggedOut | Self::Off => {
                "tailscale up (or sign in from the Tailscale app)".to_owned()
            }
            Self::NeedsApproval => format!("Approve it at {MACHINES}"),
            Self::AccessDenied => "sudo tailscale set --operator=$USER".to_owned(),
            Self::NoHttps => format!("Turn on HTTPS under DNS in the admin console ({DNS})"),
            Self::PortTaken { port, .. } => {
                format!("slopmax tailscale on --port {}", port.saturating_add(1))
            }
            Self::Funnel { port } => format!("tailscale funnel --https={port} off"),
            Self::Timeout { .. } | Self::Unreadable { .. } | Self::Failed { .. } => return None,
        };
        Some(fix)
    }
}

impl fmt::Display for TsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for TsError {}

/// Why a run of the `tailscale` command that exited non-zero failed, from
/// what it printed.
pub fn classify(output: &Output) -> TsError {
    let stderr = output.stderr.as_str();
    let lower = stderr.to_ascii_lowercase();
    if stderr.contains("Access denied") || stderr.contains("--operator") {
        return TsError::AccessDenied;
    }
    let down = [
        "failed to connect to local tailscaled",
        "doesn't appear to be running",
        "is tailscale running",
    ];
    if down.iter().any(|text| lower.contains(text)) {
        return TsError::DaemonDown;
    }
    if lower.contains("tls certificate support is not enabled")
        || (lower.contains("https") && lower.contains("not enabled"))
    {
        return TsError::NoHttps;
    }
    let first = |text: &str| {
        text.lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(str::to_owned)
    };
    let line = first(stderr)
        .or_else(|| first(&output.stdout))
        .unwrap_or_else(|| match output.code {
            Some(code) => format!("it exited with code {code}"),
            None => "it was stopped by a signal".to_owned(),
        });
    TsError::Failed { line }
}

/// The error a machine in `node`'s state gives, if its state is one.
pub fn state_error(node: &Node) -> Option<TsError> {
    match node.backend_state {
        BackendState::NeedsLogin => Some(TsError::LoggedOut),
        BackendState::Stopped => Some(TsError::Off),
        BackendState::NeedsMachineAuth => Some(TsError::NeedsApproval),
        _ => None,
    }
}

/// Answers which machine has a tailnet address: [`Tailscale`] for real, a
/// fake in tests.
pub trait Whois: Send + Sync {
    /// The machine at `ip`, and whose it is.
    fn whois<'a>(&'a self, ip: IpAddr) -> BoxFuture<'a, Result<Machine, TsError>>;
}

impl Whois for Tailscale {
    fn whois<'a>(&'a self, ip: IpAddr) -> BoxFuture<'a, Result<Machine, TsError>> {
        Box::pin(Tailscale::whois(self, ip))
    }
}

/// A [`Whois`] that finds the `tailscale` command the first time it is
/// asked, and answers [`TsError::Missing`] when there is none.
#[derive(Debug, Default)]
pub struct LazyWhois(OnceLock<Option<Tailscale>>);

impl Whois for LazyWhois {
    fn whois<'a>(&'a self, ip: IpAddr) -> BoxFuture<'a, Result<Machine, TsError>> {
        Box::pin(async move {
            match self.0.get_or_init(|| Tailscale::find().ok()) {
                Some(ts) => ts.whois(ip).await,
                None => Err(TsError::Missing),
            }
        })
    }
}

/// Where slopmax would answer on each online machine of `peers` serving on
/// `port`, as (name, URL), in the order of `peers` ([`parse_status`] sorts
/// them by name): the machines to look for a hub on.
pub fn discovery_candidates(peers: &[Peer], port: u16) -> Vec<(String, String)> {
    peers
        .iter()
        .filter(|peer| peer.online && !peer.dns_name.is_empty())
        .map(|peer| {
            let url = match port {
                443 => format!("https://{}", peer.dns_name),
                port => format!("https://{}:{port}", peer.dns_name),
            };
            (peer.name.clone(), url)
        })
        .collect()
}

/// The machine of `peers` that `query` names: by its full DNS name, by that
/// name's first label, or by its host name in any case, in that order. When
/// none or several match, the error says which machines there are.
/// Whether `query` names `node`, this machine, as [`resolve_machine`]
/// matches a peer: by its MagicDNS name or that name's first label. This
/// machine is never among the peers.
pub fn names_node(node: &Node, query: &str) -> bool {
    let query = query.trim();
    let query = query.strip_suffix('.').unwrap_or(query);
    let dns = node.dns_name.strip_suffix('.').unwrap_or(&node.dns_name);
    [dns, node.name.as_str()]
        .iter()
        .any(|name| !name.is_empty() && name.eq_ignore_ascii_case(query))
}

pub fn resolve_machine<'a>(peers: &'a [Peer], query: &str) -> Result<&'a Peer, String> {
    let query = query.trim();
    let query = query.strip_suffix('.').unwrap_or(query);
    let tiers: [&dyn Fn(&Peer) -> bool; 3] = [
        &|peer| !peer.dns_name.is_empty() && peer.dns_name.eq_ignore_ascii_case(query),
        &|peer| !peer.name.is_empty() && peer.name.eq_ignore_ascii_case(query),
        &|peer| !peer.host_name.is_empty() && peer.host_name.to_lowercase() == query.to_lowercase(),
    ];
    for matches in tiers {
        let found: Vec<&Peer> = peers.iter().filter(|peer| matches(peer)).collect();
        match found.as_slice() {
            [] => continue,
            [one] => return Ok(one),
            several => {
                let names: Vec<&str> = several.iter().map(|p| p.dns_name.as_str()).collect();
                return Err(format!(
                    "{query} could be any of {}; name one in full",
                    names.join(", ")
                ));
            }
        }
    }
    let names: Vec<&str> = peers
        .iter()
        .filter(|peer| !peer.name.is_empty())
        .map(|peer| peer.name.as_str())
        .collect();
    Err(if names.is_empty() {
        format!("no machine on your tailnet is called {query}, and Tailscale here sees no others")
    } else {
        format!(
            "no machine on your tailnet is called {query}; it has {}",
            names.join(", ")
        )
    })
}

/// This process's effective user id, where it can be read without unsafe
/// code: from `/proc/self` on Linux; `None` elsewhere.
pub fn effective_uid() -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata("/proc/self").ok().map(|meta| meta.uid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Whether this process runs as root, as far as [`effective_uid`] knows.
pub fn is_root() -> bool {
    effective_uid() == Some(0)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    macro_rules! fixture {
        ($name:literal) => {
            include_str!(concat!("../tests-data/tailscale/", $name))
        };
    }

    /// One canned answer: the args it answers, and what it says after how
    /// long.
    #[derive(Clone)]
    struct Rule {
        prefix: Vec<String>,
        code: i32,
        stdout: String,
        stderr: String,
        delay: Duration,
    }

    /// A fake `tailscale` that answers from rules, first match by args
    /// prefix, and keeps each call.
    #[derive(Default)]
    struct Scripted {
        rules: Vec<Rule>,
        calls: Mutex<Vec<(Vec<String>, Duration, bool)>>,
    }

    impl Scripted {
        fn on(self, prefix: &str, code: i32, stdout: &str, stderr: &str) -> Self {
            self.slow(prefix, code, stdout, stderr, Duration::ZERO)
        }

        fn slow(
            mut self,
            prefix: &str,
            code: i32,
            stdout: &str,
            stderr: &str,
            delay: Duration,
        ) -> Self {
            self.rules.push(Rule {
                prefix: prefix.split(' ').map(str::to_owned).collect(),
                code,
                stdout: stdout.to_owned(),
                stderr: stderr.to_owned(),
                delay,
            });
            self
        }

        fn calls(&self) -> Vec<(Vec<String>, Duration, bool)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Exec for Scripted {
        fn run<'a>(
            &'a self,
            args: Vec<String>,
            timeout: Duration,
            passthrough: bool,
        ) -> BoxFuture<'a, Result<Output, TsError>> {
            Box::pin(async move {
                self.calls
                    .lock()
                    .unwrap()
                    .push((args.clone(), timeout, passthrough));
                let Some(rule) = self.rules.iter().find(|r| args.starts_with(&r.prefix)) else {
                    return Ok(Output {
                        code: Some(1),
                        stdout: String::new(),
                        stderr: format!("unknown command {args:?}"),
                    });
                };
                match tokio::time::timeout(timeout, tokio::time::sleep(rule.delay)).await {
                    Err(_) => Err(TsError::Timeout {
                        what: args.join(" "),
                    }),
                    Ok(()) => Ok(Output {
                        code: Some(rule.code),
                        stdout: rule.stdout.clone(),
                        stderr: rule.stderr.clone(),
                    }),
                }
            })
        }
    }

    fn tailscale(scripted: Scripted) -> (Tailscale, Arc<Scripted>) {
        let scripted = Arc::new(scripted);
        let ts = Tailscale::with(PathBuf::from("/usr/bin/tailscale"), scripted.clone());
        (ts, scripted)
    }

    fn node(json: &str) -> Node {
        parse_status(json).unwrap().0
    }

    fn serve(json: &str) -> ServeState {
        parse_serve(json).unwrap()
    }

    fn socket() -> Target {
        Target::Socket(PathBuf::from("/home/me/.slopmax/tailnet.sock"))
    }

    /// slopmax as it runs here: its socket, and its TCP port 7567.
    fn targets() -> Vec<Target> {
        vec![socket(), Target::Loopback(7567)]
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn a_running_machine_reads() {
        let (me, peers) = parse_status(fixture!("status-running.json")).unwrap();
        assert_eq!(
            me,
            Node {
                backend_state: BackendState::Running,
                dns_name: "hub.example.ts.net".into(),
                name: "hub".into(),
                ips: vec![ip("100.64.0.1"), ip("fd7a:115c:a1e0::1")],
                tags: vec![],
                login: Some("me@github".into()),
                cert_domains: vec!["hub.example.ts.net".into()],
                magic_dns_suffix: Some("example.ts.net".into()),
                version: "1.104.5".into(),
                id: "nSELF1CNTRL".into(),
            }
        );
        assert_eq!(state_error(&me), None);
        let names: Vec<&str> = peers.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "ci-runner",
                "dev-box",
                "dev-box-1",
                "me-macbook-pro",
                "old-laptop"
            ]
        );
        let mac = &peers[3];
        assert_eq!(
            *mac,
            Peer {
                id: "nMAC1CNTRL".into(),
                dns_name: "me-macbook-pro.example.ts.net".into(),
                name: "me-macbook-pro".into(),
                host_name: "Me’s MacBook Pro".into(),
                online: true,
                tags: vec![],
                login: Some("me@github".into()),
                os: "macOS".into(),
                ips: vec![ip("100.64.0.2"), ip("fd7a:115c:a1e0::2")],
            }
        );
        let ci = &peers[0];
        assert_eq!(ci.tags, ["tag:ci"]);
        assert_eq!(ci.login, None, "a tagged machine belongs to no one");
        assert!(!peers[4].online);
    }

    #[test]
    fn each_state_reads_and_names_its_error() {
        let signed_out = node(fixture!("status-needslogin.json"));
        assert_eq!(signed_out.backend_state, BackendState::NeedsLogin);
        assert_eq!(signed_out.dns_name, "");
        assert_eq!(signed_out.login, None);
        assert_eq!(state_error(&signed_out), Some(TsError::LoggedOut));

        let stopped = node(fixture!("status-stopped.json"));
        assert_eq!(stopped.backend_state, BackendState::Stopped);
        assert_eq!(state_error(&stopped), Some(TsError::Off));

        let waiting = node(fixture!("status-needsapproval.json"));
        assert_eq!(waiting.backend_state, BackendState::NeedsMachineAuth);
        assert_eq!(state_error(&waiting), Some(TsError::NeedsApproval));

        let tagged = node(fixture!("status-tagged.json"));
        assert_eq!(tagged.tags, ["tag:server"]);
        assert_eq!(tagged.login, None);
        assert_eq!(state_error(&tagged), None);

        let no_certs = node(fixture!("status-nocerts.json"));
        assert!(no_certs.cert_domains.is_empty());
        assert_eq!(no_certs.backend_state, BackendState::Running);
    }

    #[test]
    fn an_answer_that_does_not_read_is_unreadable() {
        assert_eq!(
            parse_status("not json"),
            Err(TsError::Unreadable {
                version: String::new()
            })
        );
        assert_eq!(
            parse_status(r#"{"Version":"1.200.0-tabc","Self":{}}"#),
            Err(TsError::Unreadable {
                version: "1.200.0".into()
            })
        );
        assert_eq!(
            parse_status(r#"{"Version":"1.200.0","BackendState":"Running","Self":null}"#),
            Err(TsError::Unreadable {
                version: "1.200.0".into()
            })
        );
        assert!(
            parse_status(r#"{"BackendState":"Weird"}"#)
                .is_ok_and(|(node, _)| node.backend_state == BackendState::Other("Weird".into()))
        );
        assert!(parse_serve("[]").is_err());
        assert!(parse_serve("{").is_err());
        assert!(parse_whois("{}").is_err());
        assert!(parse_whois("<html>").is_err());
        let message = TsError::Unreadable {
            version: "1.200.0".into(),
        }
        .message();
        assert_eq!(
            message,
            "couldn't read Tailscale's answer (tailscale 1.200.0); update slopmax or Tailscale"
        );
    }

    #[test]
    fn whois_names_the_machine_by_its_dns_label() {
        let machine = parse_whois(fixture!("whois.json")).unwrap();
        assert_eq!(
            machine,
            Machine {
                id: "nMAC1CNTRL".into(),
                name: "me-macbook-pro".into(),
                login: Some("me@github".into()),
                tags: vec![],
            }
        );
        let bare = r#"{"Node":{"StableID":"nX","Name":"box.example.ts.net.","Tags":["tag:ci"]},
            "UserProfile":{"LoginName":"tagged-devices"}}"#;
        let machine = parse_whois(bare).unwrap();
        assert_eq!(machine.name, "box");
        assert_eq!(machine.login, None);
        assert_eq!(machine.tags, ["tag:ci"]);
    }

    #[test]
    fn serve_configs_read() {
        let empty = serve(fixture!("serve-empty.json"));
        assert!(empty.handlers.is_empty() && empty.funnel_ports.is_empty());
        assert!(serve("").handlers.is_empty());

        let ours = serve(fixture!("serve-ours-socket.json"));
        assert_eq!(
            ours.handlers,
            [Handler {
                port: 7567,
                https: true,
                host: "hub.example.ts.net".into(),
                path: "/".into(),
                target: HandlerTarget::Proxy("unix:/home/me/.slopmax/tailnet.sock".into()),
                foreground: false,
            }]
        );

        let foreign = serve(fixture!("serve-foreign.json"));
        let seen: Vec<(u16, &str, String)> = foreign
            .handlers
            .iter()
            .map(|h| (h.port, h.path.as_str(), h.target.to_string()))
            .collect();
        assert_eq!(
            seen,
            [
                (443, "/", "/srv/www".to_owned()),
                (443, "/hello", "a fixed text".to_owned()),
                (7567, "/", "http://127.0.0.1:3000".to_owned()),
            ]
        );

        let forward = serve(fixture!("serve-tcpforward.json"));
        assert_eq!(
            forward.handlers[0].target,
            HandlerTarget::Tcp("127.0.0.1:22".into())
        );

        let funnel = serve(fixture!("serve-funnel.json"));
        assert_eq!(funnel.funnel_ports, [443]);

        let foreground = serve(fixture!("serve-foreground.json"));
        assert_eq!(foreground.handlers.len(), 1);
        assert!(foreground.handlers[0].foreground);
        assert_eq!(
            foreground.raw["Foreground"]["6f3c2a1b"]["TCP"]["7567"]["HTTPS"],
            true
        );

        let plain = serve(
            r#"{"TCP":{"80":{"HTTP":true}},"Web":{"hub.example.ts.net:80":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7567"}}}}}"#,
        );
        assert!(!plain.handlers[0].https);
    }

    #[test]
    fn ours_reads_every_way_of_writing_a_local_target() {
        let at = |proxy: &str| Handler {
            port: 7567,
            https: true,
            host: "hub.example.ts.net".into(),
            path: "/".into(),
            target: HandlerTarget::Proxy(proxy.into()),
            foreground: false,
        };
        for proxy in [
            "http://127.0.0.1:7567",
            "http://localhost:7567",
            "http://LOCALHOST:7567/",
            "http://[::1]:7567",
            "127.0.0.1:7567",
            "localhost:7567",
            "7567",
            "unix:/home/me/.slopmax/tailnet.sock",
            "unix:///home/me/.slopmax/tailnet.sock",
        ] {
            assert!(ours(&at(proxy), &targets()), "{proxy}");
        }
        for proxy in [
            "http://127.0.0.1:7568",
            "https://127.0.0.1:7567",
            "https+insecure://localhost:7567",
            "http://10.0.0.5:7567",
            "http://127.0.0.1:7567/api",
            "unix:/home/other/.slopmax/tailnet.sock",
        ] {
            assert!(!ours(&at(proxy), &targets()), "{proxy}");
        }
        let forward = Handler {
            target: HandlerTarget::Tcp("127.0.0.1:7567".into()),
            ..at("")
        };
        assert!(!ours(&forward, &targets()), "a TCP forward is never ours");
    }

    #[test]
    fn port_use_tells_free_ours_and_taken_apart() {
        let empty = serve(fixture!("serve-empty.json"));
        assert_eq!(port_use(&empty, 7567, &targets()), Port::Free);

        let ours = serve(fixture!("serve-ours-socket.json"));
        assert!(matches!(port_use(&ours, 7567, &targets()), Port::Ours(h) if h.port == 7567));
        assert_eq!(port_use(&ours, 8443, &targets()), Port::Free);

        let other_port = serve(fixture!("serve-ours-loopback-7000.json"));
        assert!(matches!(
            port_use(&other_port, 7567, &[Target::Loopback(7000)]),
            Port::Ours(_)
        ));
        assert_eq!(
            port_use(&other_port, 7567, &targets()),
            Port::Taken {
                by: "http://127.0.0.1:7000".into()
            }
        );

        let foreign = serve(fixture!("serve-foreign.json"));
        assert_eq!(
            port_use(&foreign, 7567, &targets()),
            Port::Taken {
                by: "http://127.0.0.1:3000".into()
            }
        );
        assert_eq!(
            port_use(&foreign, 443, &targets()),
            Port::Taken {
                by: "/srv/www".into()
            }
        );

        let forward = serve(fixture!("serve-tcpforward.json"));
        assert_eq!(
            port_use(&forward, 7567, &targets()),
            Port::Taken {
                by: "127.0.0.1:22".into()
            }
        );

        let funnel = serve(fixture!("serve-funnel.json"));
        assert!(matches!(port_use(&funnel, 443, &targets()), Port::Ours(_)));

        let foreground = serve(fixture!("serve-foreground.json"));
        assert_eq!(
            port_use(&foreground, 7567, &targets()),
            Port::Taken {
                by: "http://127.0.0.1:3000 (from a `tailscale serve` in a terminal)".into()
            }
        );
    }

    #[test]
    fn published_gives_each_port_its_address() {
        let me = node(fixture!("status-running.json"));
        let ours = serve(fixture!("serve-ours-socket.json"));
        assert_eq!(
            published(&ours, &me, &targets()),
            [Published {
                url: "https://hub.example.ts.net:7567".into(),
                port: 7567,
                target: socket(),
                transport: Transport::Socket,
                funnel: false,
            }]
        );

        let funnel = serve(fixture!("serve-funnel.json"));
        assert_eq!(
            published(&funnel, &me, &targets()),
            [Published {
                url: "https://hub.example.ts.net".into(),
                port: 443,
                target: Target::Loopback(7567),
                transport: Transport::Loopback,
                funnel: true,
            }]
        );

        for state in [
            serve(fixture!("serve-empty.json")),
            serve(fixture!("serve-foreign.json")),
            serve(fixture!("serve-tcpforward.json")),
        ] {
            assert!(published(&state, &me, &targets()).is_empty(), "{state:?}");
        }
    }

    #[test]
    fn stale_finds_slopmax_published_from_elsewhere() {
        let old = serve(fixture!("serve-ours-loopback-7000.json"));
        let found = stale(&old, 7567, &targets());
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].target.to_string(), "http://127.0.0.1:7000");
        assert!(stale(&old, 7567, &[Target::Loopback(7000)]).is_empty());

        let ours = serve(fixture!("serve-ours-socket.json"));
        assert!(stale(&ours, 7567, &targets()).is_empty());
        let moved = [Target::Socket(PathBuf::from("/srv/slopmax/tailnet.sock"))];
        assert_eq!(stale(&ours, 7567, &moved).len(), 1);

        let forward = serve(fixture!("serve-tcpforward.json"));
        assert!(stale(&forward, 7567, &targets()).is_empty(), "not a proxy");
        let foreign = serve(fixture!("serve-foreign.json"));
        assert!(stale(&foreign, 443, &targets()).is_empty(), "files");
    }

    #[test]
    fn classify_maps_what_tailscale_prints() {
        let failed = |stderr: &str| Output {
            code: Some(1),
            stdout: String::new(),
            stderr: stderr.to_owned(),
        };
        let table = [
            (
                "Access denied: serve config denied\nUse 'sudo tailscale serve ...'",
                TsError::AccessDenied,
            ),
            (
                "To not require root, use 'sudo tailscale set --operator=$USER' once.",
                TsError::AccessDenied,
            ),
            (
                "failed to connect to local tailscaled; it doesn't appear to be running",
                TsError::DaemonDown,
            ),
            (
                "Tailscale doesn't appear to be running.",
                TsError::DaemonDown,
            ),
            (
                "Failed to connect to local Tailscale daemon; is Tailscale running?",
                TsError::DaemonDown,
            ),
            (
                "error: TLS certificate support is not enabled for this tailnet",
                TsError::NoHttps,
            ),
            (
                "HTTPS must be enabled to serve: HTTPS is not enabled in your tailnet",
                TsError::NoHttps,
            ),
            (
                "\n  error: port 7567 is already in use\nmore",
                TsError::Failed {
                    line: "error: port 7567 is already in use".into(),
                },
            ),
        ];
        for (stderr, want) in table {
            assert_eq!(classify(&failed(stderr)), want, "{stderr}");
        }
        assert_eq!(
            classify(&Output {
                code: Some(2),
                stdout: "usage: tailscale serve\n".into(),
                stderr: String::new(),
            }),
            TsError::Failed {
                line: "usage: tailscale serve".into()
            }
        );
        assert_eq!(
            classify(&Output {
                code: Some(3),
                ..Output::default()
            }),
            TsError::Failed {
                line: "it exited with code 3".into()
            }
        );
    }

    #[test]
    fn each_error_says_what_is_wrong_and_most_say_what_to_do() {
        assert_eq!(
            TsError::AccessDenied.message(),
            "Tailscale lets only root change what this machine serves."
        );
        assert_eq!(
            TsError::AccessDenied.fix().as_deref(),
            Some("sudo tailscale set --operator=$USER")
        );
        let taken = TsError::PortTaken {
            port: 7567,
            by: "http://127.0.0.1:3000".into(),
        };
        assert_eq!(
            taken.to_string(),
            "port 7567 of this machine already serves http://127.0.0.1:3000 to your tailnet"
        );
        assert_eq!(
            taken.fix().as_deref(),
            Some("slopmax tailscale on --port 7568")
        );
        let funnel = TsError::Funnel { port: 443 };
        assert_eq!(
            funnel.message(),
            "port 443 is open to the internet through Tailscale Funnel"
        );
        assert_eq!(
            funnel.fix().as_deref(),
            Some("tailscale funnel --https=443 off")
        );
        assert!(
            TsError::NoHttps
                .fix()
                .unwrap()
                .contains("https://login.tailscale.com/admin/dns")
        );
        assert!(
            TsError::NeedsApproval
                .fix()
                .unwrap()
                .contains("https://login.tailscale.com/admin/machines")
        );
        assert!(
            TsError::LoggedOut
                .fix()
                .unwrap()
                .starts_with("tailscale up")
        );
        assert_eq!(TsError::Off.fix(), TsError::LoggedOut.fix());
        let down = TsError::DaemonDown.fix().unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(down, "Open the Tailscale app");
        } else if cfg!(windows) {
            assert_eq!(down, "Start Tailscale from the Start menu");
        } else {
            assert_eq!(down, "sudo systemctl enable --now tailscaled");
        }
        assert_eq!(
            TsError::Failed {
                line: "no such thing".into()
            }
            .message(),
            "tailscale said: no such thing"
        );
    }

    #[test]
    fn targets_are_written_as_serve_takes_them() {
        assert_eq!(socket().arg(), "unix:/home/me/.slopmax/tailnet.sock");
        assert_eq!(Target::Loopback(7567).arg(), "http://127.0.0.1:7567");
        assert_eq!(socket().transport(), Transport::Socket);
    }

    #[test]
    fn hubs_are_looked_for_on_online_machines() {
        let (_, peers) = parse_status(fixture!("status-running.json")).unwrap();
        let pair = |name: &str| {
            (
                name.to_owned(),
                format!("https://{name}.example.ts.net:7567"),
            )
        };
        assert_eq!(
            discovery_candidates(&peers, 7567),
            [
                pair("ci-runner"),
                pair("dev-box"),
                pair("dev-box-1"),
                pair("me-macbook-pro"),
            ]
        );
        assert_eq!(
            discovery_candidates(&peers[3..4], 443)[0].1,
            "https://me-macbook-pro.example.ts.net"
        );
    }

    #[test]
    fn machines_resolve_by_name() {
        let (_, peers) = parse_status(fixture!("status-running.json")).unwrap();
        let id = |query: &str| resolve_machine(&peers, query).map(|p| p.id.as_str());
        assert_eq!(id("me-macbook-pro"), Ok("nMAC1CNTRL"));
        assert_eq!(id("ME-MACBOOK-PRO"), Ok("nMAC1CNTRL"));
        assert_eq!(id("me-macbook-pro.example.ts.net."), Ok("nMAC1CNTRL"));
        assert_eq!(id("me’s macbook pro"), Ok("nMAC1CNTRL"));
        assert_eq!(
            id("dev-box"),
            Ok("nDEV1CNTRL"),
            "the label beats host names"
        );
        let several = id("Dev Box").unwrap_err();
        assert!(
            several.contains("dev-box.example.ts.net")
                && several.contains("dev-box-1.example.ts.net"),
            "{several}"
        );
        let none = id("nowhere").unwrap_err();
        assert!(
            none.contains("nowhere") && none.contains("me-macbook-pro"),
            "{none}"
        );
        assert!(
            resolve_machine(&[], "x")
                .unwrap_err()
                .contains("sees no others")
        );
    }

    #[test]
    fn this_machine_answers_to_its_names() {
        let (node, _) = parse_status(fixture!("status-running.json")).unwrap();
        assert!(names_node(&node, &node.name));
        assert!(names_node(&node, &node.name.to_uppercase()));
        assert!(names_node(&node, &format!("{}.", node.dns_name)));
        assert!(!names_node(&node, "me-macbook-pro"));
        assert!(!names_node(&node, ""));
    }

    #[test]
    fn locate_takes_the_variable_then_path() {
        let dir = crate::testkit::temp_dir("tailscale-locate");
        let name = if cfg!(windows) {
            "tailscale.exe"
        } else {
            "tailscale"
        };
        std::fs::write(dir.join(name), "").unwrap();
        let path = std::env::join_paths([dir.join("nothing-here"), dir.to_path_buf()]).unwrap();
        assert_eq!(
            locate_from(Some("/opt/ts/tailscale".into()), Some(path.clone())),
            Some(PathBuf::from("/opt/ts/tailscale"))
        );
        assert_eq!(locate_from(Some(OsString::new()), Some(path.clone())), None);
        assert_eq!(locate_from(None, Some(path)), Some(dir.join(name)));
        if cfg!(not(any(target_os = "macos", windows))) {
            let empty = std::env::join_paths([dir.join("nothing-here")]).unwrap();
            assert_eq!(locate_from(None, Some(empty)), None);
            assert_eq!(locate_from(None, None), None);
        }
    }

    #[test]
    fn the_app_bundle_is_recognized() {
        assert!(in_app_bundle(Path::new(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        )));
        assert!(!in_app_bundle(Path::new("/opt/homebrew/bin/tailscale")));

        // The app's "Install CLI" puts a link, or a script, on PATH.
        let dir = crate::testkit::temp_dir("tailscale-app");
        let bundle = dir.join("Tailscale.app/Contents/MacOS");
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("Tailscale"), "the app's own command").unwrap();
        let script = dir.join("tailscale");
        std::fs::write(
            &script,
            "#!/bin/sh\nexec /Applications/Tailscale.app/Contents/MacOS/Tailscale \"$@\"\n",
        )
        .unwrap();
        assert!(in_app_bundle(&script));
        #[cfg(unix)]
        {
            let link = dir.join("linked");
            std::os::unix::fs::symlink(bundle.join("Tailscale"), &link).unwrap();
            assert!(in_app_bundle(&link));
        }
        // Homebrew's command, which runs its own tailscaled.
        let brew = dir.join("brew-tailscale");
        std::fs::write(
            &brew,
            "#!/bin/sh\nexec /opt/homebrew/Cellar/tailscale/bin/tailscale\n",
        )
        .unwrap();
        assert!(!in_app_bundle(&brew));
    }

    /// Run in a child by `locate_honours_the_variable`, with
    /// `SLOPMAX_TAILSCALE` set there; with nothing to check elsewhere.
    #[test]
    fn locate_in_child() {
        if let Some(want) = std::env::var_os("SLOPMAX_TAILSCALE_WANT") {
            let want = (want != "none").then(|| PathBuf::from(want));
            assert_eq!(locate(), want);
        }
    }

    #[cfg(unix)]
    #[test]
    fn locate_honours_the_variable() {
        let exe = std::env::current_exe().unwrap();
        for (given, want) in [("/opt/ts/tailscale", "/opt/ts/tailscale"), ("", "none")] {
            let output = std::process::Command::new(&exe)
                .args(["--exact", "tailscale::tests::locate_in_child"])
                .env("SLOPMAX_TAILSCALE", given)
                .env("SLOPMAX_TAILSCALE_WANT", want)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(output.status.success(), "{given:?}: {stdout}");
            assert!(stdout.contains("1 passed"), "{given:?}: {stdout}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_commands_run_with_their_timeouts() {
        let (ts, scripted) = tailscale(
            Scripted::default()
                .on(
                    "status --json --peers=false",
                    0,
                    fixture!("status-running.json"),
                    "",
                )
                .on("status --json", 0, fixture!("status-running.json"), "")
                .on(
                    "serve status --json",
                    0,
                    fixture!("serve-ours-socket.json"),
                    "",
                )
                .on(
                    "debug prefs",
                    0,
                    r#"{"OperatorUser":"me","WantRunning":true}"#,
                    "",
                )
                .on("serve --bg", 0, "Available within your tailnet", "")
                .on("serve --https=7567 off", 0, "", "")
                .on("whois --json", 0, fixture!("whois.json"), ""),
        );
        assert_eq!(ts.node().await.unwrap().name, "hub");
        assert_eq!(ts.peers().await.unwrap().1.len(), 5);
        assert_eq!(ts.serve_state().await.unwrap().handlers.len(), 1);
        assert_eq!(ts.operator().await.as_deref(), Some("me"));
        ts.publish(7567, &socket()).await.unwrap();
        ts.unpublish(7567).await.unwrap();
        let machine = Whois::whois(&ts, ip("100.64.0.2")).await.unwrap();
        assert_eq!(machine.id, "nMAC1CNTRL");

        let s = |args: &[&str]| args.iter().map(|&a| a.to_owned()).collect::<Vec<_>>();
        let read = Duration::from_secs(5);
        let change = Duration::from_secs(30);
        let who = Duration::from_secs(2);
        assert_eq!(
            scripted.calls(),
            [
                (s(&["status", "--json", "--peers=false"]), read, false),
                (s(&["status", "--json"]), read, false),
                (s(&["serve", "status", "--json"]), read, false),
                (s(&["debug", "prefs"]), read, false),
                (
                    s(&[
                        "serve",
                        "--bg",
                        "--yes",
                        "--https=7567",
                        "unix:/home/me/.slopmax/tailnet.sock"
                    ]),
                    change,
                    true
                ),
                (s(&["serve", "--https=7567", "off"]), change, false),
                (s(&["whois", "--json", "100.64.0.2"]), who, false),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn failures_come_back_classified() {
        let (ts, _) = tailscale(
            Scripted::default()
                .on(
                    "status",
                    1,
                    "",
                    "failed to connect to local tailscaled (which should be running)",
                )
                .on("serve --bg", 1, "", "Access denied: serve config denied")
                .on(
                    "serve --https=7567 off",
                    1,
                    "",
                    "error: TLS certificate support is not enabled",
                )
                .on("debug prefs", 0, r#"{"WantRunning":true}"#, "")
                .slow("whois", 0, "{}", "", Duration::from_secs(3)),
        );
        assert_eq!(ts.node().await, Err(TsError::DaemonDown));
        assert_eq!(
            ts.publish(7567, &socket()).await,
            Err(TsError::AccessDenied)
        );
        assert_eq!(ts.unpublish(7567).await, Err(TsError::NoHttps));
        assert_eq!(ts.operator().await, None, "no OperatorUser means none");
        assert_eq!(
            ts.whois(ip("100.64.0.9")).await,
            Err(TsError::Timeout {
                what: "whois --json 100.64.0.9".into()
            })
        );
    }

    #[tokio::test]
    async fn a_signed_out_status_reads_even_when_it_exits_non_zero() {
        let (ts, _) = tailscale(Scripted::default().on(
            "status",
            1,
            fixture!("status-needslogin.json"),
            "Logged out.",
        ));
        let node = ts.node().await.unwrap();
        assert_eq!(state_error(&node), Some(TsError::LoggedOut));
        let (garbage, _) = tailscale(Scripted::default().on("status", 0, "{{", ""));
        assert!(matches!(
            garbage.node().await,
            Err(TsError::Unreadable { .. })
        ));
    }

    #[tokio::test]
    async fn inspect_gathers_everything_and_never_fails() {
        let none = inspect(None, &targets(), 7567).await;
        assert_eq!(none.exe, None);
        assert_eq!(none.node, Err(TsError::Missing));
        assert!(none.serve.is_none() && none.published.is_empty());

        let (ts, _) = tailscale(
            Scripted::default()
                .on("status", 0, fixture!("status-running.json"), "")
                .on(
                    "serve status",
                    0,
                    fixture!("serve-ours-loopback-7000.json"),
                    "",
                )
                .on("debug prefs", 0, r#"{"OperatorUser":"me"}"#, ""),
        );
        let seen = inspect(Some(&ts), &targets(), 7567).await;
        assert_eq!(seen.exe.as_deref(), Some(Path::new("/usr/bin/tailscale")));
        assert!(seen.node.is_ok());
        assert!(seen.published.is_empty());
        assert_eq!(seen.stale.len(), 1);
        assert_eq!(seen.operator.as_deref(), Some("me"));

        let (down, _) = tailscale(Scripted::default().on("status", 1, "", "is Tailscale running?"));
        let seen = inspect(Some(&down), &targets(), 7567).await;
        assert_eq!(seen.node, Err(TsError::DaemonDown));
        assert!(seen.serve.is_none());
    }

    #[tokio::test]
    async fn lazy_whois_says_missing_without_tailscale() {
        let lazy = LazyWhois(OnceLock::from(None));
        assert_eq!(lazy.whois(ip("100.64.0.2")).await, Err(TsError::Missing));
    }

    #[test]
    fn the_effective_uid_is_read_on_linux() {
        if cfg!(target_os = "linux") {
            assert!(effective_uid().is_some());
        } else {
            assert_eq!(effective_uid(), None);
            assert!(!is_root());
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_process_reports_what_it_printed() {
        let sh = Process::new(PathBuf::from("/bin/sh"));
        let args = ["-c", "echo out; echo err >&2; exit 3"]
            .map(str::to_owned)
            .to_vec();
        let output = sh.run(args, Duration::from_secs(10), true).await.unwrap();
        assert_eq!(
            output,
            Output {
                code: Some(3),
                stdout: "out\n".into(),
                stderr: "err\n".into(),
            }
        );
        let missing = Process::new(PathBuf::from("/nonexistent/tailscale"));
        assert_eq!(
            missing.run(vec![], Duration::from_secs(1), false).await,
            Err(TsError::Missing)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_kills_the_child() {
        let dir = crate::testkit::temp_dir("tailscale-timeout");
        let pid_file = dir.join("pid");
        let script = format!("echo $$ > '{}'; exec sleep 30", pid_file.display());
        let sh = Process::new(PathBuf::from("/bin/sh"));
        let started = std::time::Instant::now();
        let result = sh
            .run(
                vec!["-c".to_owned(), script],
                Duration::from_millis(50),
                false,
            )
            .await;
        assert!(
            matches!(&result, Err(TsError::Timeout { what }) if what.starts_with("-c echo")),
            "{result:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        // On a busy machine the shell may be killed before it writes its
        // pid; then there is nothing left to look for.
        let Ok(pid) = std::fs::read_to_string(&pid_file) else {
            return;
        };
        let pid = pid.trim().to_owned();
        // Killed, it is gone, or a zombie until tokio reaps it.
        let alive = || {
            let out = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid])
                .output()
                .unwrap();
            let stat = String::from_utf8_lossy(&out.stdout).trim().to_owned();
            !stat.is_empty() && !stat.starts_with('Z')
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!alive(), "pid {pid} still runs");
    }

    /// What `inspect` would find with these answers from Tailscale, for
    /// slopmax at the socket of `/home/me/.slopmax` or port 7567.
    fn inspected(status: &str, serve: &str) -> Inspection {
        let targets = [
            Target::Socket("/home/me/.slopmax/tailnet.sock".into()),
            Target::Loopback(7567),
        ];
        let node = parse_status(status).map(|(node, _)| node);
        let serve = parse_serve(serve).unwrap();
        Inspection {
            exe: Some("/usr/bin/tailscale".into()),
            published: match &node {
                Ok(node) => published(&serve, node, &targets),
                Err(_) => Vec::new(),
            },
            stale: stale(&serve, 7567, &targets),
            serve: Some(serve),
            node,
            operator: None,
        }
    }

    #[test]
    fn the_tailnet_view_reads_tailscale_and_the_config() {
        use slopmax_api::tailnet::{TailscaleState, Transport};
        let missing = Inspection {
            exe: None,
            node: Err(TsError::Missing),
            serve: None,
            published: Vec::new(),
            stale: Vec::new(),
            operator: None,
        }
        .view();
        assert_eq!(missing.tailscale, TailscaleState::Missing);
        assert_eq!(
            (missing.url, missing.transport, missing.host),
            (None, None, None)
        );
        let problem = missing.problem.unwrap();
        assert_eq!(problem.text, "Tailscale isn't installed here");
        assert!(problem.fix.unwrap().contains("tailscale.com/download"));

        let ours = inspected(
            fixture!("status-running.json"),
            fixture!("serve-ours-socket.json"),
        )
        .view();
        assert_eq!(ours.tailscale, TailscaleState::Running);
        assert_eq!(ours.url.as_deref(), Some("https://hub.example.ts.net:7567"));
        assert_eq!(ours.transport, Some(Transport::Socket));
        assert_eq!(ours.host.as_deref(), Some("hub"));
        assert!(!ours.funnel && ours.problem.is_none());
        // Identity needs a login to take, as well as the socket.
        assert!(!with_config(ours.clone(), &crate::config::Config::default()).identity);
        let config = crate::config::Config {
            tailscale: Some(crate::config::Tailnet {
                users: vec!["me@github".into()],
                admins: vec![crate::config::AdminMachine {
                    machine: "mac".into(),
                    id: "nMAC".into(),
                }],
            }),
            ..Config::default()
        };
        let told = with_config(ours, &config);
        assert_eq!(told.identity, cfg!(unix));
        assert_eq!(told.users, ["me@github"]);
        assert_eq!(told.admins[0].id, "nMAC");

        let funnel = inspected(
            fixture!("status-running.json"),
            fixture!("serve-funnel.json"),
        )
        .view();
        assert!(funnel.funnel);
        assert_eq!(funnel.transport, Some(Transport::Loopback));
        assert_eq!(funnel.url.as_deref(), Some("https://hub.example.ts.net"));
        assert!(!with_config(funnel.clone(), &config).identity);
        let problem = funnel.problem.unwrap();
        assert!(problem.text.contains("Funnel"), "{}", problem.text);
        assert_eq!(
            problem.fix.as_deref(),
            Some("tailscale funnel --https=443 off")
        );

        let signed_out = inspected(
            fixture!("status-needslogin.json"),
            fixture!("serve-empty.json"),
        )
        .view();
        assert_eq!(signed_out.tailscale, TailscaleState::SignedOut);
        assert!(signed_out.problem.is_some() && signed_out.url.is_none());

        let no_certs = inspected(
            fixture!("status-nocerts.json"),
            fixture!("serve-empty.json"),
        )
        .view();
        assert_eq!(no_certs.problem.unwrap().text, TsError::NoHttps.message());
    }
}
