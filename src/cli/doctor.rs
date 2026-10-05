//! `slopmax doctor`: checks the setup end to end and says how to fix what
//! is wrong. Never prints a key or token.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use super::background::Daemon;
use crate::account::{Account, Store};
use crate::config::Config;
use crate::net::{Origins, server};
use crate::provider::ProviderId;
use crate::service::Manager;
use crate::time::{SignedDuration, Timestamp};
use crate::{auth, human, paths, ui};

/// CLIProxyAPI's default port, for spotting it beside slopmax.
const CLIPROXYAPI_PORT: u16 = 8317;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Ok,
    Note,
    Warn,
    Fail,
}

struct Finding {
    level: Level,
    text: String,
    fix: Option<String>,
}

struct Section {
    title: &'static str,
    findings: Vec<Finding>,
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

/// Runs every check, prints the findings, and returns the exit code: 1 if
/// something is broken.
pub async fn run(config: &Config, store: &Store) -> Result<i32> {
    let accounts = store.list()?;
    let sections = [
        proxy(config).await,
        accounts_section(&accounts),
        claude_code(config),
        codex(config),
        cliproxyapi(&accounts),
        network().await,
        files(),
    ];
    let mut worst = Level::Ok;
    let (mut problems, mut warnings) = (0, 0);
    for section in sections.iter().filter(|s| !s.findings.is_empty()) {
        println!("\n{}", ui::bold(section.title));
        for finding in &section.findings {
            let mark = match finding.level {
                Level::Ok => ui::green("✓"),
                Level::Note => ui::dim("·"),
                Level::Warn => ui::yellow("!"),
                Level::Fail => ui::red("✗"),
            };
            println!("  {mark} {}", finding.text);
            if let Some(fix) = &finding.fix {
                println!("      {} {fix}", ui::dim("fix:"));
            }
            worst = worst.max(finding.level);
            problems += usize::from(finding.level == Level::Fail);
            warnings += usize::from(finding.level == Level::Warn);
        }
    }
    let plural = |n: usize, word: &str| format!("{n} {word}{}", if n == 1 { "" } else { "s" });
    println!();
    match (problems, warnings) {
        (0, 0) => println!("{}", ui::green("Everything looks good.")),
        _ => println!(
            "{}, {}.",
            plural(problems, "problem"),
            plural(warnings, "warning")
        ),
    }
    Ok(i32::from(worst == Level::Fail))
}

async fn proxy(config: &Config) -> Section {
    let mut s = Section::new("Proxy");
    let ours = env!("CARGO_PKG_VERSION");
    match Daemon::new(config).version().await {
        Some(version) if version == ours => {
            s.add(Level::Ok, format!("running on {}", config.base_url()), None);
        }
        Some(version) => s.add(
            Level::Warn,
            format!("running version {version}, but this binary is {ours}"),
            Some("slopmax stop && slopmax start"),
        ),
        None if port_taken(config.listen) => {
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
    if let Some(manager) = Manager::detect() {
        let status = manager.status();
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

fn port_taken(listen: SocketAddr) -> bool {
    TcpListener::bind(listen).is_err_and(|e| e.kind() == std::io::ErrorKind::AddrInUse)
}

fn accounts_section(accounts: &[Account]) -> Section {
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
        }
    }
    s
}

fn claude_code(config: &Config) -> Section {
    let mut s = Section::new("Claude Code");
    if !on_path("claude") {
        s.add(Level::Note, "`claude` is not on PATH", None);
    }
    let settings: Value = crate::fsx::read_json(&paths::claude_dir().join("settings.json"))
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

fn codex(config: &Config) -> Section {
    let mut s = Section::new("Codex");
    if !on_path("codex") {
        s.add(Level::Note, "`codex` is not on PATH", None);
    }
    let file = paths::codex_dir().join("config.toml");
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

fn cliproxyapi(accounts: &[Account]) -> Section {
    let mut s = Section::new("CLIProxyAPI");
    let linked = accounts
        .iter()
        .filter(|a| a.link.as_ref().is_some_and(|l| l.tool == "cliproxyapi"))
        .count();
    if linked == 0 {
        return s;
    }
    let addr = SocketAddr::from(([127, 0, 0, 1], CLIPROXYAPI_PORT));
    let running = TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok();
    if running {
        s.add(
            Level::Note,
            format!("still running and refreshing {linked} accounts slopmax follows"),
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

async fn network() -> Section {
    let mut s = Section::new("Network");
    let http = auth::http_client(Origins::default());
    let mut skew_checked = false;
    for (name, url) in [
        ("Anthropic", "https://api.anthropic.com/api/hello"),
        ("ChatGPT", "https://chatgpt.com/backend-api/wham/usage"),
    ] {
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

fn files() -> Section {
    let mut s = Section::new("Files");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let open = |path: &Path| {
            std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o077 != 0)
        };
        let dir = paths::accounts_dir();
        if open(&dir) {
            s.add(
                Level::Warn,
                format!("{} is readable by other users", dir.display()),
                Some(&format!("chmod 700 {}", dir.display())),
            );
        }
        let exposed = std::fs::read_dir(&dir)
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
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}
