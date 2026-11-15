//! Checks of the whole setup, each saying how to fix what is wrong: what
//! `slopmax doctor` prints and the app shows. Findings never include a key
//! or token.

use std::net::{SocketAddr, TcpListener};
use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use crate::account::{Account, Store};
use crate::background::{Daemon, Probe};
use crate::config::Config;
use crate::net::{Client, Origins, server};
use crate::paths::Home;
use crate::provider::ProviderId;
use crate::service::{Manager, Status};
use crate::time::{SignedDuration, Timestamp};
use crate::{auth, human};

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

/// Runs every check. Sections without findings are left out.
pub async fn check(config: &Config, store: &Store, home: &Home) -> Result<Vec<Section>> {
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
    let sections = [
        proxy(config, probe, service),
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
        .filter(|s| !s.findings.is_empty())
        .collect())
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
    match (env("ANTHROPIC_BASE_URL"), env("ANTHROPIC_AUTH_TOKEN")) {
        (Some(base), Some(token)) if base == config.base_url() && token == config.api_key => {
            s.add(
                Level::Ok,
                "wired through settings.json, for the CLI and the apps that run it",
                None,
            );
        }
        (Some(base), _) if base == config.base_url() => s.add(
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
    let expected = format!("{}/codex", config.base_url());
    match provider.as_deref() {
        Some("slopmax")
            if field("base_url").as_deref() == Some(expected.as_str())
                && field("experimental_bearer_token").as_deref()
                    == Some(config.api_key.as_str()) =>
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
        let home = Home::at(temp_dir("doctor-install"));
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
        std::fs::remove_dir_all(dir).unwrap();
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
}
