//! Command-line interface.

mod args;
mod doctor;

use std::collections::HashMap;
use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use self::args::{App, Arg, Choice, Command, Kind, Parsed};
use crate::account::Store;
use crate::agent::{self, Agent};
use crate::auth::{self, LoginOptions};
use crate::config::Config;
use crate::import::{self, Source};
use crate::net::Origins;
use crate::pool::{Pins, Pool, State};
use crate::provider::ProviderId;
use crate::provider::credits::Outcome;
use crate::report::{self, Report};
use crate::service::Manager;
use crate::time::{SignedDuration, Timestamp};
use crate::{daemon, fsx, net, paths, ui, usage};

const ACCOUNT: &str = "Number from `slopmax status`, or the account's id, email, or label";

const PROVIDERS: &[Choice] = &[
    Choice {
        value: "claude",
        help: "Claude Pro/Max, used by Claude Code",
    },
    Choice {
        value: "codex",
        help: "ChatGPT Plus/Pro/Team, used by Codex",
    },
];

const AGENTS: &[Choice] = &[
    Choice {
        value: "claude",
        help: "Claude Code",
    },
    Choice {
        value: "codex",
        help: "Codex",
    },
];

const SOURCES: &[Choice] = &[
    Choice {
        value: "all",
        help: "Every source below",
    },
    Choice {
        value: "claude-code",
        help: "Claude Code's login (~/.claude/.credentials.json or the macOS keychain)",
    },
    Choice {
        value: "codex",
        help: "The Codex CLI login (~/.codex/auth.json)",
    },
    Choice {
        value: "cliproxyapi",
        help: "CLIProxyAPI credential files (~/.cli-proxy-api/*.json)",
    },
];

const SERVICE_ACTIONS: &[Choice] = &[
    Choice {
        value: "install",
        help: "Start slopmax at login (systemd user unit or launchd agent)",
    },
    Choice {
        value: "uninstall",
        help: "Remove the service",
    },
    Choice {
        value: "status",
        help: "Show whether the service is installed and running",
    },
];

const SHELLS: &[Choice] = &[
    Choice {
        value: "bash",
        help: "Bash",
    },
    Choice {
        value: "zsh",
        help: "Zsh",
    },
    Choice {
        value: "fish",
        help: "Fish",
    },
];

const fn arg(name: &'static str, help: &'static str, kind: Kind) -> Arg {
    Arg { name, help, kind }
}

const fn command(name: &'static str, about: &'static str, args: &'static [Arg]) -> Command {
    Command {
        name,
        alias: None,
        about,
        args,
    }
}

const ACCOUNT_ARG: Arg = arg("account", ACCOUNT, Kind::Required(&[]));

pub static APP: App = App {
    name: "slopmax",
    about: "Multi-account switcher and proxy for Claude Code and Codex",
    after_help: "Run without a command to show account status.",
    default: "status",
    commands: &[
        Command {
            name: "status",
            alias: Some("ls"),
            about: "Show accounts, usage windows, and when limits reset",
            args: &[
                arg(
                    "refresh",
                    "Fetch fresh usage from the providers first",
                    Kind::Flag(Some('r')),
                ),
                arg("watch", "Keep the display updated", Kind::Flag(Some('w'))),
                arg("json", "Print machine-readable JSON", Kind::Flag(None)),
            ],
        },
        command(
            "login",
            "Connect an account through the provider's sign-in page",
            &[
                arg(
                    "provider",
                    "Which kind of account",
                    Kind::Required(PROVIDERS),
                ),
                arg(
                    "label",
                    "Display name for the account",
                    Kind::Value(None, "LABEL"),
                ),
                arg(
                    "device",
                    "Sign in with a code instead of a browser redirect (Codex only)",
                    Kind::Flag(None),
                ),
                arg(
                    "no-browser",
                    "Print the sign-in URL instead of opening a browser",
                    Kind::Flag(None),
                ),
            ],
        ),
        command(
            "import",
            "Copy existing logins from Claude Code, Codex, or CLIProxyAPI",
            &[
                arg(
                    "source",
                    "Where to import from",
                    Kind::Optional(SOURCES, "all"),
                ),
                arg(
                    "own",
                    "Refresh imported CLIProxyAPI logins here instead of following its files",
                    Kind::Flag(None),
                ),
            ],
        ),
        command(
            "own",
            "Take over refreshing an account slopmax follows from another tool",
            &[arg(
                "account",
                "Number from `slopmax status`, the account's id, email, or label, or `all`",
                Kind::Required(&[]),
            )],
        ),
        command(
            "use",
            "Prefer an account for new sessions, or `auto` to let slopmax choose",
            &[ACCOUNT_ARG],
        ),
        command(
            "label",
            "Set an account's display name",
            &[
                ACCOUNT_ARG,
                arg("label", "The new name", Kind::Required(&[])),
            ],
        ),
        command(
            "priority",
            "Set an account's priority; higher tiers are used first",
            &[
                ACCOUNT_ARG,
                arg(
                    "priority",
                    "Tier, 0 by default; negative values hold an account in reserve",
                    Kind::Required(&[]),
                ),
            ],
        ),
        command("enable", "Route to an account again", &[ACCOUNT_ARG]),
        command(
            "disable",
            "Stop routing to an account (its tokens are still kept fresh)",
            &[ACCOUNT_ARG],
        ),
        command("remove", "Forget an account", &[ACCOUNT_ARG]),
        command(
            "redeem",
            "Redeem a banked reset credit, resetting a ChatGPT account's limits",
            &[
                ACCOUNT_ARG,
                arg("yes", "Skip the confirmation prompt", Kind::Flag(Some('y'))),
            ],
        ),
        command("serve", "Run the proxy in the foreground", &[]),
        command("start", "Start the proxy in the background", &[]),
        command("stop", "Stop the background proxy", &[]),
        command(
            "service",
            "Run the proxy as a service that starts at login",
            &[arg("action", "What to do", Kind::Required(SERVICE_ACTIONS))],
        ),
        command(
            "run",
            "Launch an agent through the proxy, starting the proxy if needed",
            &[
                arg("agent", "Which agent", Kind::Required(AGENTS)),
                arg("args", "Arguments passed to the agent", Kind::Rest),
            ],
        ),
        command(
            "env",
            "Print shell setup that points an agent at the proxy, for `eval`",
            &[arg("agent", "Which agent", Kind::Required(AGENTS))],
        ),
        command(
            "setup",
            "Point an agent's own config at the proxy (or restore it)",
            &[
                arg("agent", "Which agent", Kind::Required(AGENTS)),
                arg("undo", "Restore what setup replaced", Kind::Flag(None)),
            ],
        ),
        command("doctor", "Check the setup and say how to fix problems", &[]),
        command(
            "completions",
            "Print a shell completion script",
            &[arg("shell", "Which shell", Kind::Required(SHELLS))],
        ),
    ],
};

#[derive(Debug, Default)]
struct StatusArgs {
    refresh: bool,
    watch: bool,
    json: bool,
}

/// Parses `args` (without the program name), runs the command, and returns
/// the process exit code.
pub async fn run(args: impl IntoIterator<Item = String>) -> Result<i32> {
    let matches = match args::parse(&APP, args) {
        Ok(Parsed::Run(matches)) => matches,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return Ok(0);
        }
        Err(usage) => {
            eprint!("{usage}");
            return Ok(2);
        }
    };
    let m = &matches;
    let config = Config::load()?;
    let store = Store::open();
    match m.command.name {
        "status" => {
            let args = StatusArgs {
                refresh: m.flag("refresh"),
                watch: m.flag("watch"),
                json: m.flag("json"),
            };
            if args.watch && args.json {
                bail!("--json cannot be combined with --watch");
            }
            status(&config, &store, args).await?;
        }
        "login" => {
            let options = LoginOptions {
                device: m.flag("device"),
                no_browser: m.flag("no-browser"),
            };
            let label = m.value("label").map(str::to_owned);
            login(&store, m.get("provider")?, label, options).await?;
        }
        "import" => import(&store, m.get("source")?, m.flag("own")).await?,
        "own" => own(&store, &m.get::<String>("account")?)?,
        "use" => use_account(&store, &m.get::<String>("account")?)?,
        "label" => {
            let id = store.find(&m.get::<String>("account")?)?.id;
            let label: String = m.get("label")?;
            let a = store.update(&id, |a| a.label = Some(label))?;
            println!("Renamed {} to {}", a.id, ui::bold(a.name()));
        }
        "priority" => {
            let id = store.find(&m.get::<String>("account")?)?.id;
            let priority: i32 = m.get("priority")?;
            let a = store.update(&id, |a| a.priority = priority)?;
            println!("{} now has priority {priority}", ui::bold(a.name()));
        }
        "enable" => set_disabled(&store, &m.get::<String>("account")?, false)?,
        "disable" => set_disabled(&store, &m.get::<String>("account")?, true)?,
        "remove" => remove(&store, &m.get::<String>("account")?)?,
        "redeem" => redeem(&config, &store, &m.get::<String>("account")?, m.flag("yes")).await?,
        "serve" => daemon::run(config).await?,
        "start" => start(&config).await?,
        "stop" => stop(&config).await?,
        "service" => service(&config, &m.get::<String>("action")?).await?,
        "run" => {
            ensure_running(&config).await?;
            return agent::run(agent_named(m)?, &config, &m.rest);
        }
        "env" => {
            let exe = std::env::current_exe().context("locating the slopmax binary")?;
            print!("{}", agent_named(m)?.env(&config, &exe));
        }
        "setup" => setup(&config, agent_named(m)?, m.flag("undo"))?,
        "doctor" => return doctor::run(&config, &store).await,
        "completions" => print!("{}", args::completions(&APP, m.get("shell")?)),
        name => unreachable!("`{name}` is in the command table but not dispatched"),
    }
    Ok(0)
}

/// Talks to a running proxy.
struct Daemon {
    base: String,
    key: String,
    http: net::Client,
}

impl Daemon {
    fn new(config: &Config) -> Self {
        let http = net::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(1))
            .build();
        Self {
            base: config.base_url(),
            key: config.api_key.clone(),
            http,
        }
    }

    async fn is_running(&self) -> bool {
        self.version().await.is_some()
    }

    /// The running proxy's version, if one answers on the configured port.
    async fn version(&self) -> Option<String> {
        let url = format!("{}/healthz", self.base);
        let body: serde_json::Value = self.http.get(url).send().await.ok()?.json().await.ok()?;
        if body["service"] != "slopmax" {
            return None;
        }
        body["version"].as_str().map(str::to_owned)
    }

    async fn report(&self, refresh: bool) -> Option<Report> {
        let url = format!(
            "{}/slopmax/{}",
            self.base,
            if refresh { "refresh" } else { "status" }
        );
        let request = if refresh {
            self.http.post(url)
        } else {
            self.http.get(url)
        };
        let response = request.bearer_auth(&self.key).send().await.ok()?;
        response.error_for_status().ok()?.json().await.ok()
    }

    async fn shutdown(&self) -> Result<()> {
        self.http
            .post(format!("{}/slopmax/shutdown", self.base))
            .bearer_auth(&self.key)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }
}

async fn status(config: &Config, store: &Store, args: StatusArgs) -> Result<()> {
    let daemon = Daemon::new(config);
    let mut refresh = args.refresh;
    loop {
        let report = match daemon.report(refresh).await {
            Some(report) => report,
            None => offline_report(config, store, refresh).await?,
        };
        if args.json {
            println!("{}", serde_json::to_string_pretty(&report)?);
            return Ok(());
        }
        let text = report::render(&report, Timestamp::now());
        if args.watch {
            print!("\x1b[2J\x1b[H{text}");
            std::io::stdout().flush()?;
        } else {
            print!("{text}");
            return Ok(());
        }
        refresh = false;
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Status from disk when no proxy is running, optionally polling the
/// providers directly.
async fn offline_report(config: &Config, store: &Store, refresh: bool) -> Result<Report> {
    let state: State = fsx::read_json(&paths::state_file())?.unwrap_or_default();
    let pins: Pins = fsx::read_json(&paths::pins_file())?.unwrap_or_default();
    let pool = Pool::new(config.strategy, SignedDuration::from_hours(1), state);
    pool.sync(store.list()?, pins.clone());
    if refresh {
        let http = auth::http_client(Origins::default());
        for account in pool.accounts().iter().filter(|a| a.auth_error.is_none()) {
            match usage::poll(&http, store, account, config.refresh_tokens).await {
                Ok((_, reading)) => pool.observe(&account.id, reading.limits, Timestamp::now()),
                Err(e) => eprintln!("{} {}: {e:#}", ui::yellow("warning:"), account.name()),
            }
        }
        let (state, _) = pool.snapshot(Timestamp::now());
        fsx::write_json(&paths::state_file(), &state)?;
    }
    Ok(report::build(
        store.list()?,
        |id| pool.state(id),
        &pins,
        &HashMap::new(),
        config.strategy,
        false,
    ))
}

async fn login(
    store: &Store,
    provider: ProviderId,
    label: Option<String>,
    options: LoginOptions,
) -> Result<()> {
    let spec = provider.spec();
    if options.device && !spec.device_login {
        bail!(
            "--device works for ChatGPT accounts; {} signs in with a browser",
            spec.title
        );
    }
    let http = auth::http_client(Origins::default());
    let mut account = provider.get().login(&http, options).await?;
    if label.is_some() {
        account.label = label;
    }
    let (account, created) = store.upsert(account)?;
    let plan = account
        .plan
        .as_deref()
        .map(|p| format!(" ({p})"))
        .unwrap_or_default();
    println!(
        "{} {provider} account {}{plan} as {}",
        if created { "Connected" } else { "Updated" },
        ui::bold(account.name()),
        ui::dim(&account.id)
    );
    if created {
        println!(
            "{}",
            ui::dim("Check limits with `slopmax status --refresh`.")
        );
    }
    Ok(())
}

async fn import(store: &Store, source: Source, own: bool) -> Result<()> {
    let http = auth::http_client(Origins::default());
    let found = import::discover(&http, source).await;
    if found.is_empty() {
        println!("No logins found to import.");
        return Ok(());
    }
    let (mut imported, mut linked) = (0, 0);
    for item in found {
        match item.account {
            Ok(mut account) => {
                if own {
                    account.link = None;
                }
                let (account, created) = store.upsert(account)?;
                imported += 1;
                linked += usize::from(account.link.is_some());
                println!(
                    "  {} {} {} {}",
                    if created {
                        ui::green("+")
                    } else {
                        ui::yellow("~")
                    },
                    account.provider,
                    ui::bold(account.name()),
                    ui::dim(format!("from {}", item.origin))
                );
            }
            Err(e) => println!("  {} {}: {e:#}", ui::dim("skipped"), item.origin),
        }
    }
    if linked > 0 {
        println!(
            "\n{} CLIProxyAPI keeps refreshing {linked} of these, and slopmax follows its files,\n        \
             so both can run while you switch over. Once CLIProxyAPI is stopped, run\n        \
             `slopmax own all` so slopmax refreshes them.",
            ui::cyan("linked:")
        );
    }
    if imported > linked {
        println!(
            "\n{} Imported logins share refresh tokens with their source, and whichever\n      \
             refreshes first invalidates the other's copy. Use the agents through slopmax\n      \
             from now on (`slopmax setup claude`, `slopmax setup codex`).",
            ui::yellow("note:")
        );
    }
    Ok(())
}

/// Stops following another tool's copy of an account's tokens.
fn own(store: &Store, query: &str) -> Result<()> {
    let accounts = if query == "all" {
        store
            .list()?
            .into_iter()
            .filter(|a| a.link.is_some())
            .collect()
    } else {
        vec![store.find(query)?]
    };
    if accounts.is_empty() {
        println!("No accounts follow another tool.");
        return Ok(());
    }
    for account in accounts {
        let Some(link) = &account.link else {
            println!("{} already refreshes here.", ui::bold(account.name()));
            continue;
        };
        store.update(&account.id, |a| a.link = None)?;
        println!(
            "slopmax now refreshes {} {}",
            ui::bold(account.name()),
            ui::dim(format!("(was following {})", link.tool))
        );
    }
    println!(
        "{}",
        ui::dim("Its first refresh signs the old copy out, so keep the other tool stopped.")
    );
    Ok(())
}

fn use_account(store: &Store, query: &str) -> Result<()> {
    let path = paths::pins_file();
    let mut pins: Pins = fsx::read_json(&path)?.unwrap_or_default();
    if query == "auto" {
        pins.clear();
        fsx::write_json(&path, &pins)?;
        println!("slopmax will choose accounts automatically.");
        return Ok(());
    }
    let account = store.find(query)?;
    pins.insert(account.provider, account.id.clone());
    fsx::write_json(&path, &pins)?;
    println!(
        "New {} sessions will use {} while it has quota.",
        account.provider,
        ui::bold(account.name())
    );
    Ok(())
}

fn set_disabled(store: &Store, query: &str, disabled: bool) -> Result<()> {
    let id = store.find(query)?.id;
    let account = store.update(&id, |a| a.disabled = disabled)?;
    let verb = if disabled { "Disabled" } else { "Enabled" };
    println!("{verb} {}", ui::bold(account.name()));
    Ok(())
}

fn remove(store: &Store, query: &str) -> Result<()> {
    let account = store.find(query)?;
    store.remove(&account.id)?;
    let path = paths::pins_file();
    let mut pins: Pins = fsx::read_json(&path)?.unwrap_or_default();
    if pins.get(&account.provider) == Some(&account.id) {
        pins.remove(&account.provider);
        fsx::write_json(&path, &pins)?;
    }
    println!("Removed {}", ui::bold(account.name()));
    Ok(())
}

async fn redeem(config: &Config, store: &Store, query: &str, yes: bool) -> Result<()> {
    let account = store.find(query)?;
    let Some(credits) = account.provider.get().credits() else {
        bail!(
            "{} is a {} account, which has no reset credits",
            account.name(),
            account.provider.spec().title
        );
    };
    let http = auth::http_client(Origins::default());
    let account = if config.refresh_tokens {
        auth::ensure_fresh(&http, store, &account, false).await?
    } else {
        account
    };
    let available = credits.list(&http, &account).await?;
    let Some(next) = available.first() else {
        println!("{} has no reset credits.", ui::bold(account.name()));
        return Ok(());
    };
    let now = Timestamp::now();
    let expiry = next
        .expires_at
        .map(|at| format!("; the next expires in {}", ui::until(at, now)))
        .unwrap_or_default();
    let s = if available.len() == 1 { "" } else { "s" };
    println!(
        "{} has {} reset credit{s}{expiry}.",
        ui::bold(account.name()),
        available.len()
    );
    if !yes && !confirm("Reset its usage windows now?")? {
        return Ok(());
    }
    match credits.redeem(&http, &account, Some(&next.id)).await? {
        Outcome::Reset => {
            println!("Reset the usage windows on {}.", ui::bold(account.name()));
            // Let a running proxy pick up the fresh windows right away.
            Daemon::new(config).report(true).await;
        }
        Outcome::NothingToReset => println!("Nothing to reset right now; the credit was kept."),
        Outcome::NoCredit => println!("No credit was available."),
        Outcome::AlreadyRedeemed => println!("That credit was already redeemed."),
    }
    Ok(())
}

fn confirm(question: &str) -> Result<bool> {
    print!("{question} [y/N] ");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

async fn start(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    if daemon.is_running().await {
        println!("slopmax is already running on {}", config.base_url());
        return Ok(());
    }
    launch(config).await?;
    println!(
        "slopmax running on {} {}",
        config.base_url(),
        ui::dim(format!("(log: {})", paths::log_file().display()))
    );
    Ok(())
}

async fn stop(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    if !daemon.is_running().await {
        println!("slopmax is not running");
        return Ok(());
    }
    daemon.shutdown().await?;
    println!("slopmax stopped");
    Ok(())
}

async fn ensure_running(config: &Config) -> Result<()> {
    if !Daemon::new(config).is_running().await {
        launch(config).await?;
    }
    Ok(())
}

/// Starts the proxy: through the service when one is installed, so it stays
/// supervised, else as a detached process.
async fn launch(config: &Config) -> Result<()> {
    match Manager::detect().filter(|m| m.status().installed) {
        Some(manager) => {
            manager.start()?;
            wait_until_running(config).await
        }
        None => spawn_background(config).await,
    }
}

async fn service(config: &Config, action: &str) -> Result<()> {
    let manager = Manager::detect().context(
        "no supported service manager here (systemd user services or launchd); \
         run `slopmax start` from a login script instead",
    )?;
    match action {
        "install" => {
            let daemon = Daemon::new(config);
            if daemon.is_running().await {
                // The service takes over the port.
                daemon.shutdown().await?;
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let exe = std::env::current_exe().context("locating the slopmax binary")?;
            let file = manager.install(&exe)?;
            wait_until_running(config).await?;
            println!(
                "slopmax now starts at login {}",
                ui::dim(format!("({})", file.display()))
            );
            if manager.status().lingering == Some(false) {
                println!(
                    "{}",
                    ui::dim(
                        "To keep it running after you log out (on a server), run \
                         `loginctl enable-linger $USER`."
                    )
                );
            }
        }
        "uninstall" => {
            let file = manager.uninstall()?;
            println!(
                "Removed the service {}",
                ui::dim(format!("({})", file.display()))
            );
        }
        _ => {
            let status = manager.status();
            let state = match (status.installed, status.running) {
                (false, _) => "not installed".to_owned(),
                (true, true) => ui::green("installed and running"),
                (true, false) => ui::yellow("installed, not running"),
            };
            println!("service: {state}");
            if status.lingering == Some(false) && status.installed {
                println!(
                    "{}",
                    ui::dim("It stops when you log out; `loginctl enable-linger $USER` keeps it.")
                );
            }
        }
    }
    Ok(())
}

/// Starts `slopmax serve` detached from the terminal, logging to a file.
async fn spawn_background(config: &Config) -> Result<()> {
    let exe = std::env::current_exe().context("locating the slopmax binary")?;
    std::fs::create_dir_all(paths::home())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::log_file())?;
    let mut command = std::process::Command::new(exe);
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    command.spawn().context("starting the proxy")?;
    wait_until_running(config).await
}

async fn wait_until_running(config: &Config) -> Result<()> {
    let daemon = Daemon::new(config);
    for _ in 0..50 {
        if daemon.is_running().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!(
        "the proxy did not start; see {}",
        paths::log_file().display()
    )
}

/// The agent named by the `agent` argument.
fn agent_named(m: &args::Matches) -> Result<&'static dyn Agent> {
    let name: String = m.get("agent")?;
    agent::find(&name).with_context(|| format!("unknown agent {name:?}"))
}

fn setup(config: &Config, agent: &dyn Agent, undo: bool) -> Result<()> {
    let app = agent.title();
    if undo {
        let path = agent::undo(agent)?;
        println!(
            "Restored {} {}",
            app,
            ui::dim(format!("({})", path.display()))
        );
        return Ok(());
    }
    let path = agent::setup(agent, config)?;
    println!(
        "{app} now uses slopmax {}",
        ui::dim(format!("({})", path.display()))
    );
    println!("{}", ui::dim(agent.setup_note()));
    println!(
        "{}",
        ui::dim(
            "Start the proxy with `slopmax start` (or `slopmax service install`). Undo with `--undo`."
        )
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_choices_match_the_registry() {
        let choices: Vec<&str> = AGENTS.iter().map(|c| c.value).collect();
        let registered: Vec<&str> = agent::AGENTS.iter().map(|a| a.id()).collect();
        assert_eq!(choices, registered);
        let providers: Vec<&str> = PROVIDERS.iter().map(|c| c.value).collect();
        let ids: Vec<&str> = ProviderId::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(providers, ids);
    }

    #[test]
    fn every_command_parses_a_typical_invocation() {
        let lines = [
            "status --refresh",
            "ls -w",
            "login claude --label work",
            "login codex --device --no-browser",
            "import cliproxyapi --own",
            "own all",
            "use auto",
            "label 1 work",
            "priority 3 -1",
            "enable 1",
            "disable work",
            "remove me@x.dev",
            "redeem 3 --yes",
            "serve",
            "start",
            "stop",
            "service status",
            "run codex exec -c model=m hi",
            "env claude",
            "setup codex --undo",
            "doctor",
            "completions fish",
        ];
        for line in lines {
            let args = line.split(' ').map(str::to_owned);
            assert!(
                matches!(args::parse(&APP, args), Ok(Parsed::Run(_))),
                "{line}"
            );
        }
        for command in APP.commands {
            assert!(
                lines.iter().any(|l| {
                    let first = l.split(' ').next();
                    first == Some(command.name) || first == command.alias
                }),
                "add a typical `{}` invocation above",
                command.name
            );
        }
    }
}
