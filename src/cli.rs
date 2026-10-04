//! Command-line interface.

use std::collections::HashMap;
use std::io::Write as _;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use jiff::{SignedDuration, Timestamp};

use crate::account::{Provider, Store};
use crate::auth::import::{self, Source};
use crate::auth::{self, LoginOptions};
use crate::config::Config;
use crate::credits::{self, Outcome};
use crate::pool::{Pins, Pool, State};
use crate::report::{self, Report};
use crate::upstream::Upstream;
use crate::{agents, daemon, fsx, paths, ui, usage};

#[derive(Debug, Parser)]
#[command(
    name = "slopmax",
    version,
    about = "Multi-account switcher and proxy for Claude Code and Codex",
    after_help = "Run without a command to show account status."
)]
pub struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

const ACCOUNT: &str = "Number from `slopmax status`, or the account's id, email, or label";

#[derive(Debug, Subcommand)]
enum Command {
    /// Show accounts, usage windows, and when limits reset
    #[command(visible_alias = "ls")]
    Status(StatusArgs),
    /// Connect an account through the provider's sign-in page
    Login {
        provider: Provider,
        /// Display name for the account
        #[arg(long)]
        label: Option<String>,
        /// Sign in with a code instead of a browser redirect (Codex only)
        #[arg(long)]
        device: bool,
        /// Print the sign-in URL instead of opening a browser
        #[arg(long)]
        no_browser: bool,
    },
    /// Copy existing logins from Claude Code, Codex, or CLIProxyAPI
    Import {
        #[arg(value_enum, default_value_t = Source::All)]
        source: Source,
    },
    /// Prefer an account for new sessions, or `auto` to let slopmax choose
    Use {
        #[arg(help = ACCOUNT)]
        account: String,
    },
    /// Set an account's display name
    Label {
        #[arg(help = ACCOUNT)]
        account: String,
        label: String,
    },
    /// Set an account's priority; higher tiers are used first
    Priority {
        #[arg(help = ACCOUNT)]
        account: String,
        /// Tier, 0 by default; negative values hold an account in reserve
        #[arg(allow_hyphen_values = true)]
        priority: i32,
    },
    /// Route to an account again
    Enable {
        #[arg(help = ACCOUNT)]
        account: String,
    },
    /// Stop routing to an account (its tokens are still kept fresh)
    Disable {
        #[arg(help = ACCOUNT)]
        account: String,
    },
    /// Forget an account
    Remove {
        #[arg(help = ACCOUNT)]
        account: String,
    },
    /// Redeem a banked reset credit, resetting a ChatGPT account's limits
    Redeem {
        #[arg(help = ACCOUNT)]
        account: String,
        /// Skip the confirmation prompt
        #[arg(short, long)]
        yes: bool,
    },
    /// Run the proxy in the foreground
    Serve,
    /// Start the proxy in the background
    Start,
    /// Stop the background proxy
    Stop,
    /// Launch an agent through the proxy, starting the proxy if needed
    Run {
        agent: Provider,
        /// Arguments passed to the agent
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Print shell exports that point an agent at the proxy
    Env { agent: Provider },
    /// Point an agent's own config at the proxy (or restore it)
    Setup {
        agent: Provider,
        /// Restore what setup replaced
        #[arg(long)]
        undo: bool,
    },
}

#[derive(Debug, Default, Args)]
struct StatusArgs {
    /// Fetch fresh usage from the providers first
    #[arg(short, long)]
    refresh: bool,
    /// Keep the display updated
    #[arg(short, long)]
    watch: bool,
    /// Print machine-readable JSON
    #[arg(long, conflicts_with = "watch")]
    json: bool,
}

/// Runs the parsed command and returns the process exit code.
pub async fn run(cli: Cli) -> Result<i32> {
    let config = Config::load()?;
    let store = Store::open();
    match cli
        .command
        .unwrap_or(Command::Status(StatusArgs::default()))
    {
        Command::Status(args) => status(&config, &store, args).await?,
        Command::Login {
            provider,
            label,
            device,
            no_browser,
        } => login(&store, provider, label, LoginOptions { device, no_browser }).await?,
        Command::Import { source } => import(&store, source).await?,
        Command::Use { account } => use_account(&store, &account)?,
        Command::Label { account, label } => {
            let id = store.find(&account)?.id;
            let a = store.update(&id, |a| a.label = Some(label))?;
            println!("Renamed {} to {}", a.id, ui::bold(a.name()));
        }
        Command::Priority { account, priority } => {
            let id = store.find(&account)?.id;
            let a = store.update(&id, |a| a.priority = priority)?;
            println!("{} now has priority {priority}", ui::bold(a.name()));
        }
        Command::Enable { account } => set_disabled(&store, &account, false)?,
        Command::Disable { account } => set_disabled(&store, &account, true)?,
        Command::Remove { account } => remove(&store, &account)?,
        Command::Redeem { account, yes } => redeem(&config, &store, &account, yes).await?,
        Command::Serve => daemon::run(config).await?,
        Command::Start => start(&config).await?,
        Command::Stop => stop(&config).await?,
        Command::Run { agent, args } => {
            ensure_running(&config).await?;
            return agents::run(agent, &config, &args);
        }
        Command::Env { agent } => print!("{}", agents::env_script(agent, &config)),
        Command::Setup { agent, undo } => setup(&config, agent, undo)?,
    }
    Ok(0)
}

/// Talks to a running proxy.
struct Daemon {
    base: String,
    key: String,
    http: reqwest::Client,
}

impl Daemon {
    fn new(config: &Config) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(1))
            .build()
            .expect("TLS backend initializes");
        Self {
            base: config.base_url(),
            key: config.api_key.clone(),
            http,
        }
    }

    async fn is_running(&self) -> bool {
        let Ok(response) = self.http.get(format!("{}/healthz", self.base)).send().await else {
            return false;
        };
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        body["service"] == "slopmax"
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
        let http = auth::http_client();
        let upstream = Upstream::default();
        for account in pool.accounts().iter().filter(|a| a.auth_error.is_none()) {
            match usage::poll(&http, store, &upstream, account, config.refresh_tokens).await {
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
    provider: Provider,
    label: Option<String>,
    options: LoginOptions,
) -> Result<()> {
    let mut account = auth::login(provider, options).await?;
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

async fn import(store: &Store, source: Source) -> Result<()> {
    let http = auth::http_client();
    let found = import::discover(&http, source).await;
    if found.is_empty() {
        println!("No logins found to import.");
        return Ok(());
    }
    let mut imported = 0;
    let mut from_cliproxyapi = false;
    for item in found {
        match item.account {
            Ok(account) => {
                let (account, created) = store.upsert(account)?;
                imported += 1;
                from_cliproxyapi |= item.origin.contains(".cli-proxy-api");
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
    if imported > 0 {
        println!(
            "\n{} Imported logins share refresh tokens with their source, and whichever\n\
             refreshes first invalidates the other's copy. Use the agents through slopmax\n\
             from now on (`slopmax setup claude`, `slopmax setup codex`).",
            ui::yellow("note:")
        );
        if from_cliproxyapi {
            println!(
                "      Stop CLIProxyAPI before starting slopmax, or set `refresh_tokens = false`\n      \
                 in {} while both run.",
                paths::config_file().display()
            );
        }
    }
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
    if account.provider != Provider::Codex {
        bail!(
            "reset credits are a ChatGPT feature; {} is a {} account",
            account.name(),
            account.provider
        );
    }
    let http = auth::http_client();
    let account = if config.refresh_tokens {
        auth::ensure_fresh(&http, store, &account, false).await?
    } else {
        account
    };
    let upstream = Upstream::default();
    let credits = credits::list(&http, &upstream, &account).await?;
    let Some(next) = credits.first() else {
        println!("{} has no reset credits.", ui::bold(account.name()));
        return Ok(());
    };
    let now = Timestamp::now();
    let expiry = next
        .expires()
        .map(|at| format!("; the next expires in {}", ui::until(at, now)))
        .unwrap_or_default();
    let s = if credits.len() == 1 { "" } else { "s" };
    println!(
        "{} has {} reset credit{s}{expiry}.",
        ui::bold(account.name()),
        credits.len()
    );
    if !yes && !confirm("Reset its usage windows now?")? {
        return Ok(());
    }
    match credits::redeem(&http, &upstream, &account, Some(&next.id)).await? {
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
    spawn_background(config).await?;
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
        spawn_background(config).await?;
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

fn setup(config: &Config, agent: Provider, undo: bool) -> Result<()> {
    let app = match agent {
        Provider::Claude => "Claude Code",
        Provider::Codex => "Codex",
    };
    if undo {
        let path = agents::undo(agent)?;
        println!(
            "Restored {} {}",
            app,
            ui::dim(format!("({})", path.display()))
        );
        return Ok(());
    }
    let path = agents::setup(agent, config)?;
    println!(
        "{app} now uses slopmax {}",
        ui::dim(format!("({})", path.display()))
    );
    println!(
        "{}",
        ui::dim("Start the proxy with `slopmax start` and restart the agent. Undo with `--undo`.")
    );
    Ok(())
}
