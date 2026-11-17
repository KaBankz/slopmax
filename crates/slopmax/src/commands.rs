//! Running the command the command line asks for. What each command takes
//! is declared in [`crate::cli`]; this is what it does.

mod accounts;
mod agents;
mod background;
pub mod complete;
mod doctor;
mod init;
mod remote;
mod requests;
mod status;
mod tailscale;
mod update;
mod usage;

use std::io::IsTerminal;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};

use self::background::ensure_running;
use crate::cli::{
    Account, AccountCommand, Agent, AgentCommand, Command, Key, KeyCommand, Notify, NotifyCommand,
    OnOff, Proxy, ProxyCommand, Setup, Slopmax, TailnetListCommand, Tailscale, TailscaleCommand,
};
use crate::{term, ui};
use slopmax_core::account::Store;
use slopmax_core::auth;
use slopmax_core::config::{Config, Strategy};
use slopmax_core::error::ConfigError;
use slopmax_core::net::Origins;
use slopmax_core::notify;
use slopmax_core::time::Timestamp;
use slopmax_daemon as daemon;

/// What every command runs with: the config, as it read, and the accounts.
pub struct Ctx {
    pub config: Config,
    pub store: Store,
    /// Why config.toml did not read, for the commands that go on without
    /// it (see [`Command::tolerates_broken_config`]).
    pub broken: Option<ConfigError>,
}

#[derive(Debug, Default)]
pub(super) struct StatusArgs {
    refresh: bool,
    watch: bool,
    json: bool,
}

/// Commands that moved, as they were typed before, and where they went.
/// They fail with the new spelling rather than run, so a script learns it
/// once.
const MOVED: &[(&[&str], &str)] = &[
    (&["ls"], "account list"),
    (&["import"], "account import"),
    (&["own"], "account adopt"),
    (&["use"], "account use"),
    (&["label"], "account rename"),
    (&["priority"], "account priority"),
    (&["order"], "account order"),
    (&["enable"], "account enable"),
    (&["disable"], "account disable"),
    (&["redeem"], "account redeem"),
    (&["remove"], "account remove"),
    (&["start"], "proxy start"),
    (&["stop"], "proxy stop"),
    (&["logs"], "proxy logs"),
    (&["service", "install"], "proxy install"),
    (&["service", "uninstall"], "proxy uninstall"),
    (&["service"], "proxy status"),
    (&["env"], "agent env"),
];

/// The new spelling of a command line that uses a moved command, if it
/// does: `slopmax account rename 1 work` → `slopmax account rename`.
pub fn moved(args: &[String]) -> Option<String> {
    let first = args.first()?.as_str();
    // `setup <agent>` became `agent connect`, and `--undo` `disconnect`.
    if first == "setup"
        && let Some(agent) = args
            .get(1)
            .filter(|a| slopmax_core::agent::find(a).is_some())
    {
        let verb = if args.iter().any(|a| a == "--undo") {
            "disconnect"
        } else {
            "connect"
        };
        return Some(format!("agent {verb} {agent}"));
    }
    MOVED
        .iter()
        .find(|(words, _)| words.len() <= args.len() && words.iter().zip(args).all(|(w, a)| w == a))
        .map(|(_, to)| (*to).to_owned())
}

impl Command {
    /// The command's words, as `slopmax <words> --help` names it.
    fn words(&self) -> &'static str {
        match self {
            Self::Setup(_) => "setup",
            Self::Status(_) => "status",
            Self::Dashboard(_) => "dashboard",
            Self::Login(_) => "login",
            Self::Account(_) => "account",
            Self::Usage(_) => "usage",
            Self::Requests(_) => "requests",
            Self::Run(_) => "run",
            Self::Agent(_) => "agent",
            Self::Proxy(_) => "proxy",
            Self::Config(_) => "config",
            Self::Key(_) => "key",
            Self::Tailscale(_) => "tailscale",
            Self::Doctor(_) => "doctor",
            Self::Notify(_) => "notify",
            Self::Update(_) => "update",
            Self::Completion(_) => "completion",
            Self::Serve(_) => "serve",
        }
    }

    /// Whether the command goes on when config.toml does not read, with
    /// what of it does: the ones that inspect or stop the proxy, or set
    /// the setting that broke it.
    fn tolerates_broken_config(&self) -> bool {
        match self {
            Self::Doctor(_) => true,
            Self::Config(c) => c.value.is_some(),
            Self::Proxy(Proxy { command }) => matches!(
                command,
                None | Some(
                    ProxyCommand::Status(_) | ProxyCommand::Stop(_) | ProxyCommand::Logs(_)
                )
            ),
            _ => false,
        }
    }

    /// Whether the command runs or changes this machine's own proxy, which
    /// a machine that uses a hub has none of.
    fn needs_own_proxy(&self) -> bool {
        match self {
            Self::Serve(_) => true,
            Self::Proxy(Proxy {
                command: Some(command),
            }) => matches!(
                command,
                ProxyCommand::Start(_)
                    | ProxyCommand::Restart(_)
                    | ProxyCommand::Install(_)
                    | ProxyCommand::Serve(_)
            ),
            Self::Account(Account {
                command: Some(command),
            }) => {
                matches!(
                    command,
                    AccountCommand::Import(_) | AccountCommand::Adopt(_)
                )
            }
            _ => false,
        }
    }
}

/// Runs the command line `cli` parsed, and returns the process exit code.
pub async fn run(cli: Slopmax) -> Result<i32> {
    let command = match cli.command {
        // Needs nothing of slopmax's own, so it works whatever state that
        // is in.
        Some(Command::Completion(completion)) => {
            completion.run_split("slopmax", &mut std::io::stdout(), &mut std::io::stderr())?;
            return Ok(0);
        }
        command => command,
    };
    let tolerant = command
        .as_ref()
        .is_some_and(Command::tolerates_broken_config);
    let (config, broken) = match Config::load(home()) {
        Ok(config) => (config, None),
        Err(error) if tolerant => {
            if !matches!(command, Some(Command::Doctor(_))) {
                eprintln!("{} {error}", ui::yellow("warning:"));
            }
            (Config::salvage(home()), Some(error))
        }
        Err(error) => return Err(error.into()),
    };
    if broken.is_none() {
        config.apply()?;
    }
    let ctx = Ctx {
        config,
        store: Store::of(home()),
        broken,
    };
    let Some(command) = command else {
        // A first run at a terminal starts the guided setup; else the
        // accounts' standing.
        if init::wanted(&ctx.config, &ctx.store) {
            let plan = init::Plan {
                discover: true,
                ..init::Plan::default()
            };
            init::run(&ctx.config, &ctx.store, init::Answers::Ask, plan).await?;
            return Ok(0);
        }
        status::run(&ctx.config, &ctx.store, StatusArgs::default()).await?;
        return Ok(0);
    };
    if command.needs_own_proxy()
        && let Some(refusal) = ctx.config.hub_refusal()
    {
        bail!(refusal);
    }
    let words = command.words();
    let result = dispatch(command, &ctx).await;
    match (result, ctx.config.hub_url()) {
        (Err(e), Some(url)) => Err(from_hub(e, url, words)),
        (result, _) => result,
    }
}

/// Runs `command`.
async fn dispatch(command: Command, ctx: &Ctx) -> Result<i32> {
    let (config, store) = (&ctx.config, &ctx.store);
    match command {
        Command::Setup(setup) => run_setup(ctx, setup).await?,
        Command::Status(s) => {
            let args = StatusArgs {
                refresh: s.refresh,
                watch: s.watch,
                json: s.json.json,
            };
            status::run(config, store, args).await?;
        }
        Command::Dashboard(d) => dashboard(config, d.no_browser).await?,
        Command::Login(add) => accounts::add(ctx, add).await?,
        Command::Account(Account { command }) => match command {
            None => accounts::list(ctx, false).await?,
            Some(AccountCommand::List(l)) => accounts::list(ctx, l.json.json).await?,
            Some(AccountCommand::Add(add)) => accounts::add(ctx, add).await?,
            Some(AccountCommand::Import(i)) => {
                let source = i.source.word().parse().map_err(anyhow::Error::msg)?;
                accounts::import(config, store, source, i.adopt).await?;
            }
            Some(AccountCommand::Use(u)) => {
                accounts::use_account(config, store, u.account.as_deref()).await?;
            }
            Some(AccountCommand::Rename(r)) => {
                accounts::rename(config, store, &r.account, r.label).await?;
            }
            Some(AccountCommand::Priority(p)) => {
                accounts::set_priority(config, store, &p.account, p.tier).await?;
            }
            Some(AccountCommand::Order(o)) => accounts::order(config, store, &o.accounts).await?,
            Some(AccountCommand::Enable(a)) => {
                accounts::set_disabled(config, store, &a.account, false).await?;
            }
            Some(AccountCommand::Disable(a)) => {
                accounts::set_disabled(config, store, &a.account, true).await?;
            }
            Some(AccountCommand::Check(a)) => accounts::check(config, store, &a.account).await?,
            Some(AccountCommand::Redeem(r)) => {
                accounts::redeem(config, store, &r.account, r.yes.yes).await?;
            }
            Some(AccountCommand::Adopt(a)) => accounts::adopt(config, store, &a.account).await?,
            Some(AccountCommand::Remove(r)) => {
                accounts::remove(config, store, &r.account, r.yes.yes).await?;
            }
        },
        Command::Usage(u) => {
            usage::run(config, store, u.range.word(), u.by.word(), u.json.json).await?;
        }
        Command::Requests(r) => requests::run(ctx, r).await?,
        Command::Run(run) => return agents::run(config, run).await,
        Command::Agent(Agent { command }) => match command {
            None => agents::list(config, false)?,
            Some(AgentCommand::List(l)) => agents::list(config, l.json.json)?,
            Some(AgentCommand::Connect(a)) => agents::connect(config, store, a.agent).await?,
            Some(AgentCommand::Disconnect(a)) => agents::disconnect(a.agent)?,
            Some(AgentCommand::Run(run)) => return agents::run(config, run).await,
            Some(AgentCommand::Env(a)) => agents::env(config, a.agent)?,
        },
        Command::Proxy(Proxy { command }) => match command {
            None => background::status(config, false).await?,
            Some(ProxyCommand::Status(s)) => background::status(config, s.json.json).await?,
            Some(ProxyCommand::Start(_)) => background::start(config).await?,
            Some(ProxyCommand::Stop(_)) => background::stop(config).await?,
            Some(ProxyCommand::Restart(_)) => background::restart(config).await?,
            Some(ProxyCommand::Logs(l)) => logs(config, l.lines, l.follow).await?,
            Some(ProxyCommand::Install(_)) => background::install(config).await?,
            Some(ProxyCommand::Uninstall(_)) => background::uninstall()?,
            Some(ProxyCommand::Serve(_)) => return serve(ctx).await,
        },
        Command::Serve(_) => return serve(ctx).await,
        Command::Config(c) => {
            settings(
                config,
                c.name.as_deref().unwrap_or_default(),
                c.value.as_deref().unwrap_or_default(),
                c.json.json,
            )
            .await?;
        }
        Command::Key(Key { command }) => match command {
            None => key_list(config, false).await?,
            Some(KeyCommand::List(l)) => key_list(config, l.json.json).await?,
            Some(KeyCommand::Add(a)) => key_add(config, &a.name, a.models.as_deref()).await?,
            Some(KeyCommand::Remove(r)) => key_remove(config, &r.name).await?,
        },
        Command::Tailscale(Tailscale { command }) => {
            let args = match command {
                None => tailscale::Args::Status { json: false },
                Some(TailscaleCommand::Status(s)) => tailscale::Args::Status { json: s.json.json },
                Some(TailscaleCommand::On(on)) => tailscale::Args::On(on),
                Some(TailscaleCommand::Off(_)) => tailscale::Args::Off,
                Some(TailscaleCommand::User(list)) => tailscale::Args::Users(list_op(list.command)),
                Some(TailscaleCommand::Admin(list)) => {
                    tailscale::Args::Admins(list_op(list.command))
                }
            };
            tailscale::run(config, args).await?;
        }
        Command::Doctor(d) => {
            return doctor::run(config, store, ctx.broken.as_ref(), d.json.json).await;
        }
        Command::Notify(Notify { command }) => match command {
            None => notify_show(config).await?,
            Some(NotifyCommand::Test(_)) => notify_test(config).await?,
        },
        Command::Update(u) => return update::run(config, u.check).await,
        Command::Completion(_) => unreachable!("answered before the config is read"),
    }
    Ok(0)
}

/// `tailscale user|admin [list|add|remove]`.
fn list_op(command: Option<TailnetListCommand>) -> tailscale::ListOp {
    match command {
        None | Some(TailnetListCommand::List(_)) => tailscale::ListOp::List,
        Some(TailnetListCommand::Add(n)) => tailscale::ListOp::Add(n.names),
        Some(TailnetListCommand::Remove(n)) => tailscale::ListOp::Remove(n.names),
    }
}

/// `slopmax setup`: the guided setup, or with --hub, a hub's.
async fn run_setup(ctx: &Ctx, s: Setup) -> Result<()> {
    let (config, store) = (&ctx.config, &ctx.store);
    let answers = if s.yes || !std::io::stdin().is_terminal() {
        init::Answers::Defaults
    } else {
        init::Answers::Ask
    };
    let list = |words: &[String]| (!words.is_empty()).then(|| words.join(","));
    let hub = if s.find_hub {
        Some(String::new())
    } else {
        s.hub.clone()
    };
    if hub.is_none() && (s.hub_key.is_some() || s.key_name.is_some()) {
        bail!(
            "--hub-key and --key-name go with --hub: `slopmax setup --hub <machine> --hub-key <key>`"
        );
    }
    let plan = init::Plan {
        import: list(&s.import).as_deref().map(init::sources).transpose()?,
        own: s.adopt,
        login: list(&s.login)
            .as_deref()
            .map(init::subscriptions)
            .transpose()?,
        keys_from_env: s.keys_from_env,
        strategy: s
            .strategy
            .map(|st| Strategy::parse(st.word()).context("a strategy the parser knows"))
            .transpose()?,
        affinity: s.affinity.map(|a| a == OnOff::On),
        agents: list(&s.agents).as_deref().map(init::agents).transpose()?,
        no_service: s.no_service,
        hub,
        key: s.hub_key,
        name: s.key_name,
        discover: false,
    };
    // A new machine set up at a terminal, with nothing else asked for, is
    // offered a hub on the tailnet first.
    let plan = init::Plan {
        discover: plan.hub.is_none()
            && plan.import.is_none()
            && plan.login.is_none()
            && plan.agents.is_none()
            && !plan.keys_from_env
            && !plan.own
            && init::wanted(config, store),
        ..plan
    };
    let hub_setup = plan.hub.is_some();
    init::run(config, store, answers, plan).await?;
    // Setup imports the logins it finds on disk itself: a daemon already
    // running takes them in now, rather than at its next look at the files.
    if config.hub.is_none()
        && !hub_setup
        && let Ok(Some(client)) = daemon(config).await
    {
        let _ = client.sync().await;
    }
    Ok(())
}

/// `slopmax proxy serve`: the proxy, in the foreground, until it stops.
async fn serve(ctx: &Ctx) -> Result<i32> {
    let stopped = daemon::run(ctx.config.clone(), home().clone()).await?;
    Ok(stopped.finish().await)
}

/// `slopmax proxy logs`: the background proxy's log, which on a machine
/// that uses a hub is on the hub.
async fn logs(config: &Config, lines: usize, follow: bool) -> Result<()> {
    if let (Some(refusal), Some(url)) = (config.hub_refusal(), config.hub_url()) {
        bail!(
            "{refusal} The hub's log is on {}: run `slopmax proxy logs` there.",
            remote::host_name(url)
        );
    }
    background::logs(lines, follow).await
}

/// `slopmax dashboard`.
async fn dashboard(config: &Config, no_browser: bool) -> Result<()> {
    let url = if config.hub.is_some() {
        // The hub must answer; its dashboard asks for no key.
        daemon(config).await?;
        format!("{}/slopmax/", config.agent_base())
    } else {
        ensure_running(config).await?;
        config.dashboard_url()
    };
    if !no_browser && auth::callback::open_browser(&url) {
        println!("Opened the dashboard in your browser.");
    } else {
        println!("Open the dashboard at:\n\n  {url}\n");
        if config.hub.is_none() {
            println!("{}", ui::dim(tailscale::dashboard_hint(config).await));
        }
    }
    Ok(())
}

/// `slopmax notify`: where notifications go, and which events send one.
async fn notify_show(config: &Config) -> Result<()> {
    if config.hub.is_some() {
        println!("This machine uses the hub; its notifications are set on the hub.");
        return Ok(());
    }
    let n = &config.notify;
    if !n.is_enabled() {
        println!(
            "Notifications are off. Set a webhook or a command under [notify] in {}.",
            home().config().display()
        );
        return Ok(());
    }
    if let Some(webhook) = &n.webhook {
        println!("webhook  {}", ui::bold(webhook));
    }
    if let Some(command) = &n.command {
        println!("command  {}", ui::bold(command));
    }
    let events = if n.events.is_empty() {
        notify::DEFAULT_EVENTS
    } else {
        &n.events
    };
    let words: Vec<String> = events
        .iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    println!("events   {}", words.join(", "));
    println!(
        "{}",
        ui::dim("`slopmax notify test` sends a test notification.")
    );
    Ok(())
}

/// `slopmax notify test`.
async fn notify_test(config: &Config) -> Result<()> {
    if config.hub.is_some() {
        if let Some(client) = daemon(config).await? {
            client.notify_test().await?;
        }
        println!("The hub sent a test notification.");
        return Ok(());
    }
    if !config.notify.is_enabled() {
        bail!(
            "notifications are off; set a webhook or command under [notify] in {}",
            home().config().display()
        );
    }
    let http = auth::http_client(Origins::default());
    let event = notify::Event::test(Timestamp::now());
    config.notify.send(&http, &event).await?;
    println!("Sent a test notification.");
    Ok(())
}

/// Whether to go ahead with something that can't be undone: --yes, else
/// an answer typed at the terminal. Without a terminal there is no one to
/// ask, so it fails saying to pass --yes, rather than doing nothing.
pub(super) fn confirmed(yes: bool, question: &str) -> Result<bool> {
    if yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        bail!("{question} Pass --yes to go ahead without a terminal to ask at.");
    }
    Ok(term::confirm(question, false)?)
}

/// An error from a command run against the hub, as the hub's refusal reads
/// to this machine's user.
fn from_hub(e: anyhow::Error, url: &str, command: &str) -> anyhow::Error {
    use slopmax_client::api::ApiError;
    let Some(error) = e
        .chain()
        .find_map(|c| c.downcast_ref::<slopmax_client::Error>())
    else {
        return e;
    };
    let url = url.trim_end_matches('/');
    match error {
        // The daemon's 403 to a machine allowed less than the command
        // needs, naming the machine.
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if message.starts_with("this machine may ") =>
        {
            let machine = message
                .rsplit_once("admins add ")
                .or_else(|| message.rsplit_once("admin add "))
                .map(|(_, machine)| machine.trim())
                .filter(|m| !m.is_empty() && *m != "<machine>")
                .map(str::to_owned)
                .or_else(|| hub_health().and_then(|h| h.machine.clone()))
                .unwrap_or_else(|| "<this machine>".to_owned());
            let may = if message.contains("may not change") {
                "may use the hub but not change it"
            } else {
                "may use the hub but not see its accounts"
            };
            anyhow::anyhow!("This machine {may}. On the hub: slopmax tailscale admin add {machine}")
        }
        // The daemon's 403 to a client key, which reaches its proxy only.
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if message.contains("reaches the proxy only") =>
        {
            anyhow::anyhow!(
                "the hub at {url} takes this machine's key for its agents only, not for \
                 `slopmax {command}`; run it on the hub"
            )
        }
        slopmax_client::Error::Api(ApiError::Unauthorized { message })
            if !message.contains("hub") =>
        {
            anyhow::anyhow!(
                "the hub at {url} doesn't take this machine: {message}. `slopmax setup --hub {url}` \
                 sets it up again."
            )
        }
        _ => e,
    }
}

/// What the hub said of itself and of this machine, once [`daemon`] heard
/// it.
pub(super) fn hub_health() -> Option<&'static slopmax_client::Health> {
    HUB.get()
}

static HUB: OnceLock<slopmax_client::Health> = OnceLock::new();

/// `slopmax key list`.
async fn key_list(config: &Config, json: bool) -> Result<()> {
    use slopmax_client::api::settings::KeyInfo;
    let keys: Vec<KeyInfo> = match daemon(config).await? {
        Some(client) => client.keys().await?,
        None => config
            .keys
            .iter()
            .map(slopmax_core::api::key_info)
            .collect(),
    };
    if json {
        println!("{}", serde_json::to_string_pretty(&keys)?);
        return Ok(());
    }
    if keys.is_empty() {
        println!("No client keys. Make one with `slopmax key add <name>`.");
    }
    let width = keys.iter().map(|k| k.name.len()).max().unwrap_or(0);
    for key in &keys {
        let models = if key.models.is_empty() {
            "any model".to_owned()
        } else {
            key.models.join(", ")
        };
        println!(
            "{}  {}",
            ui::bold(ui::pad(&key.name, width)),
            ui::dim(models)
        );
    }
    Ok(())
}

/// `slopmax key add`: makes the key and prints it, once.
async fn key_add(config: &Config, name: &str, models: Option<&str>) -> Result<()> {
    use slopmax_client::api::requests::MakeKey;
    let models: Vec<String> = models
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    let (key, applied) = match daemon(config).await? {
        Some(client) => {
            let asked = MakeKey {
                name: name.to_owned(),
                models,
            };
            (client.make_key(&asked).await?.key, "the proxy takes it now")
        }
        None => (
            Config::add_key(&home().config(), name, &models)?,
            "the proxy takes it when it starts",
        ),
    };
    println!("{key}");
    eprintln!(
        "{}",
        ui::dim(format!(
            "Added the key {name:?}. Clients present it as a bearer token or x-api-key; {applied}."
        ))
    );
    if config.hub.is_none()
        && let Some((url, _)) = tailscale::published_url(config).await
    {
        eprintln!(
            "{}",
            ui::dim(format!(
                "On that machine: slopmax setup --hub {url} --hub-key {key}"
            ))
        );
    }
    Ok(())
}

/// `slopmax key remove`.
async fn key_remove(config: &Config, name: &str) -> Result<()> {
    use slopmax_client::api::ApiError;
    let removed = match daemon(config).await? {
        Some(client) => match client.remove_key(name).await {
            Ok(_) => true,
            Err(slopmax_client::Error::Api(ApiError::NotFound { .. })) => false,
            Err(e) => return Err(e.into()),
        },
        None => Config::remove_key(&home().config(), name)?,
    };
    if !removed {
        bail!("no key named {name:?}; `slopmax key list` shows them");
    }
    println!("Revoked the key {name:?}.");
    Ok(())
}

/// `slopmax config [name [value]]`: shows the live settings, or one, or
/// sets one and has the running proxy apply it at once. Settings go by
/// their config.toml names (the API's names work too), and messages use
/// the name as typed.
async fn settings(config: &Config, name: &str, value: &str, json: bool) -> Result<()> {
    use slopmax_client::api::settings::{LIVE, LivePatch};
    let path = home().config();
    // A machine that uses a hub shows the hub's settings.
    let shown = if config.hub.is_some() && value.is_empty() && name != "listen" {
        match daemon(config).await? {
            Some(client) => Some(client.settings().await?.settings),
            None => None,
        }
    } else {
        None
    };
    let current = |config: &Config, name: &str| {
        let settings = match &shown {
            Some(settings) => settings.clone(),
            None => slopmax_core::api::settings(config),
        };
        settings
            .live
            .get(name)
            .map(|v| v.text())
            .unwrap_or_default()
    };
    let rest = if config.hub.is_some() {
        "the hub's config.toml".to_owned()
    } else {
        path.display().to_string()
    };
    if json && value.is_empty() {
        let settings = match &shown {
            Some(settings) => settings.clone(),
            None => slopmax_core::api::settings(config),
        };
        let shown = if name.is_empty() {
            serde_json::to_value(&settings.live)?
        } else {
            if slopmax_client::api::settings::live(name).is_none() {
                LivePatch::parse(name, "").map_err(anyhow::Error::msg)?;
            }
            serde_json::json!({ name: current(config, name) })
        };
        println!("{}", serde_json::to_string_pretty(&shown)?);
        return Ok(());
    }
    if name.is_empty() {
        let width = LIVE.iter().map(|l| l.toml.len()).max().unwrap_or(0);
        for live in LIVE {
            println!(
                "{}  {}  {}",
                ui::pad(live.toml, width),
                ui::bold(ui::pad(&current(config, live.toml), 11)),
                ui::dim(live.summary)
            );
        }
        println!(
            "\n{}",
            ui::dim(format!(
                "`slopmax config <name> <value>` changes one; the rest live in {rest}."
            ))
        );
        return Ok(());
    }
    // Where the proxy listens is read once, as it starts.
    if name == "listen" {
        let from = if std::env::var_os("SLOPMAX_LISTEN").is_some_and(|v| !v.is_empty()) {
            "set by SLOPMAX_LISTEN".to_owned()
        } else {
            format!("set in {}", path.display())
        };
        if value.is_empty() {
            println!(
                "listen = {} {}",
                ui::bold(config.listen.to_string()),
                ui::dim(format!("({from}; restart the proxy after changing it)"))
            );
            return Ok(());
        }
        bail!(
            "`slopmax config` can't change listen: set it in {}, then restart the proxy (`slopmax proxy restart`)",
            path.display()
        );
    }
    if value.is_empty() {
        // Checks the name, with the same message a change would give.
        if slopmax_client::api::settings::live(name).is_none() {
            LivePatch::parse(name, "").map_err(anyhow::Error::msg)?;
        }
        println!("{}", current(config, name));
        return Ok(());
    }
    let patch = LivePatch::parse(name, value).map_err(anyhow::Error::msg)?;
    let (now, applied) = match daemon(config).await? {
        Some(client) => {
            let view = client.change_settings(&patch).await?;
            let now = view.settings.live.get(name).map(|v| v.text());
            (now.unwrap_or_default(), "applied now")
        }
        None => {
            let values: Vec<_> = patch
                .changes()
                .into_iter()
                .map(|(live, value)| (live.toml, slopmax_core::api::toml_value(value)))
                .collect();
            let changed = Config::set(&path, &values)?;
            (
                current(&changed, name),
                "the proxy applies it when it starts",
            )
        }
    };
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({ name: now }))?
        );
        return Ok(());
    }
    println!(
        "{name} = {} {}",
        ui::bold(now),
        ui::dim(format!("({applied})"))
    );
    Ok(())
}

/// The home this process works in: made once, from the environment, and
/// handed to the engine, which reads no environment of its own.
pub(super) fn home() -> &'static slopmax_core::paths::Home {
    static HOME: std::sync::OnceLock<slopmax_core::paths::Home> = std::sync::OnceLock::new();
    HOME.get_or_init(slopmax_core::paths::Home::current)
}

/// The daemon serving this home, if one answers at the address config.toml
/// gives. While it runs it is the only writer of the state, so changes go
/// through it.
///
/// A proxy on that address that refuses this home's key (one started from
/// another home) is an error: changes made here would never reach it.
///
///
/// A machine that uses a hub goes to the hub instead, and only to it: a hub
/// that doesn't answer is an error, never a reason to read this machine's
/// files.
pub(super) async fn daemon(config: &Config) -> Result<Option<slopmax_client::Client>> {
    if config.hub.is_some() {
        let url = config.agent_base();
        let client = slopmax_client::Client::remote(&url, config.agent_token());
        return match client.health_within(Duration::from_secs(10)).await {
            Some(health) => {
                let _ = HUB.set(health);
                Ok(Some(client))
            }
            None => bail!(remote::unreachable(&url).await),
        };
    }
    let client = slopmax_client::Client::new(config.base_url(), &config.api_key);
    // One on this machine answers at once.
    match client
        .health_within(std::time::Duration::from_secs(1))
        .await
    {
        None => Ok(None),
        Some(health) if health.owner == Some(false) => {
            bail!(slopmax_core::background::foreign(config.listen, health.pid))
        }
        Some(_) => Ok(Some(client)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_owned).collect()
    }

    #[test]
    fn moved_commands_name_their_new_spelling() {
        for (old, new) in [
            ("label 1 work", "account rename"),
            ("use auto", "account use"),
            ("own all", "account adopt"),
            ("ls", "account list"),
            ("start", "proxy start"),
            ("logs -f", "proxy logs"),
            ("service install", "proxy install"),
            ("service", "proxy status"),
            ("env claude", "agent env"),
            ("setup claude", "agent connect claude"),
            ("setup codex --undo", "agent disconnect codex"),
        ] {
            assert_eq!(moved(&words(old)).as_deref(), Some(new), "{old}");
        }
        for current in ["setup --yes", "status", "account use 1", "proxy start", ""] {
            assert_eq!(moved(&words(current)), None, "{current}");
        }
    }

    #[test]
    fn the_hub_s_refusals_say_what_this_machine_may_do() {
        use slopmax_client::api::ApiError;
        let refused = |message: &str, command: &str| {
            let e = anyhow::Error::new(slopmax_client::Error::Api(ApiError::Unauthorized {
                message: message.to_owned(),
            }));
            from_hub(e, "https://hub.example.ts.net:7567/", command).to_string()
        };
        // As this version's hub words it, and as older hubs did.
        for said in ["admin add mac", "admins add mac"] {
            assert_eq!(
                refused(
                    &format!(
                        "this machine may not change slopmax; on the hub: slopmax tailscale {said}"
                    ),
                    "account use"
                ),
                "This machine may use the hub but not change it. On the hub: slopmax tailscale \
                 admin add mac"
            );
        }
        assert_eq!(
            refused(
                "the key \"ci\" reaches the proxy only, not slopmax's own API",
                "status"
            ),
            "the hub at https://hub.example.ts.net:7567 takes this machine's key for its agents \
             only, not for `slopmax status`; run it on the hub"
        );
    }
}
