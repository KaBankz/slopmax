//! The desktop app apart from any UI toolkit: what it shows and what it can
//! do. Like the CLI, it asks [`slopmax_core`] and shows the answer, so the
//! app, the CLI, and the dashboard behave alike. This crate adds what a
//! window needs on top: a live [`Snapshot`] to draw, and actions that run
//! in the background and report back through it.
//!
//! A UI draws the latest snapshot ([`view`] works out the rows, gauges, and
//! menu bar line, [`history`] the charts of past use) and calls [`App`]'s
//! methods, none of which block.

pub use slopmax_core::history;
pub mod view;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use slopmax_core::account::{self, Account, Store};
use slopmax_core::agent::{self, AGENTS, Wiring};
use slopmax_core::auth::{self, LoginEvent, LoginOptions, Prompt, callback};
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::{Config, Strategy};
use slopmax_core::import::{self, Source};
use slopmax_core::net::Origins;
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
use slopmax_core::provider::credits::Outcome;
use slopmax_core::report::{self, Report};
use slopmax_core::service::{self, Manager};
use tokio::runtime::{Handle, Runtime};
use tokio::sync::{Notify, mpsc, watch};
use tokio::task::JoinHandle;

/// How often the app asks how things stand.
const POLL: Duration = Duration::from_secs(2);
/// How often it rereads what changes rarely: the agents' configs and the
/// login service.
const SLOW_POLL: Duration = Duration::from_secs(15);
/// How long a notice that something worked stays; errors stay until
/// dismissed.
const NOTICE_FOR: Duration = Duration::from_secs(6);

/// Everything a window shows, as of the last look.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub proxy: Proxy,
    /// Where agents reach the proxy.
    pub address: String,
    /// The accounts and pools: from the running proxy, or from disk while
    /// none runs.
    pub report: Option<Report>,
    pub agents: Vec<AgentStatus>,
    /// The login service, where this system has one.
    pub service: Option<service::Status>,
    /// The sign-in in progress.
    pub sign_in: Option<SignIn>,
    /// How the last action went.
    pub notice: Option<Notice>,
    /// What went through slopmax, once a UI asks with
    /// [`App::load_history`].
    pub history: Option<history::History>,
    /// Today's, apart from that, once a UI asks with [`App::load_today`]:
    /// for summaries that show today whatever range the charts show.
    pub today: Option<history::History>,
    /// The account a reset credit is being redeemed on.
    pub redeeming: Option<String>,
    /// The configuration as config.toml has it now, which the Settings
    /// page changes with [`App::set`].
    pub config: Config,
}

/// A setting the app changes while the proxy runs, which it applies at
/// once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    /// How a new session picks its account.
    Strategy(Strategy),
    /// Whether a session keeps the account it started on.
    SessionAffinity(bool),
    /// Whether a reset credit is redeemed before it would expire unused.
    RedeemExpiringCredits(bool),
    /// Whether one is redeemed once every account is spent.
    RedeemWhenExhausted(bool),
}

impl Setting {
    /// Its key in config.toml.
    pub fn key(self) -> &'static str {
        match self {
            Self::Strategy(_) => "strategy",
            Self::SessionAffinity(_) => "session_affinity",
            Self::RedeemExpiringCredits(_) => "redeem_expiring_credits",
            Self::RedeemWhenExhausted(_) => "redeem_when_exhausted",
        }
    }

    /// Writes it into the config at `path`, keeping the file's comments,
    /// and returns the config that makes.
    pub fn write(self, path: &Path) -> Result<Config> {
        let key = self.key();
        match self {
            Self::Strategy(strategy) => Config::set(path, &[(key, strategy.to_string().into())]),
            Self::SessionAffinity(on)
            | Self::RedeemExpiringCredits(on)
            | Self::RedeemWhenExhausted(on) => Config::set(path, &[(key, on.into())]),
        }
    }
}

/// The background proxy, as the app last saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Proxy {
    Checking,
    Starting,
    Running { version: String },
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStatus {
    pub id: &'static str,
    pub title: &'static str,
    pub wiring: Wiring,
}

/// A sign-in in progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignIn {
    pub provider: ProviderId,
    pub step: Step,
    /// Notes while waiting, such as a rejected paste.
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Starting,
    /// Authorize in the browser at `url`, which was `opened` if it could be.
    Authorize {
        url: String,
        opened: bool,
    },
    /// Enter `code` at `url`.
    DeviceCode {
        url: String,
        code: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub text: String,
    pub error: bool,
    shown: Instant,
}

/// The app's state and actions. Dropping it stops its background work.
pub struct App {
    shared: Arc<Shared>,
    runtime: Runtime,
}

struct Shared {
    config: Config,
    home: Home,
    store: Store,
    /// The slopmax CLI that runs the proxy, normally the one the app ships.
    cli: Option<PathBuf>,
    snapshot: watch::Sender<Snapshot>,
    /// Hands redirect addresses pasted by hand to the sign-in in progress.
    paste: Mutex<Option<mpsc::UnboundedSender<String>>>,
    sign_in: Mutex<Option<JoinHandle<()>>>,
    /// Wakes the watcher for a fresh look; `full` rereads the slow parts.
    look: Notify,
    full: Mutex<bool>,
}

impl App {
    /// Loads the configuration, starts the proxy if none is running, and
    /// begins watching it.
    pub fn start() -> Result<Self> {
        let config = Config::load()?;
        config.apply()?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("slopmax-app")
            .enable_all()
            .build()
            .context("starting the app's runtime")?;
        let (snapshot, _) = watch::channel(Snapshot {
            proxy: Proxy::Checking,
            address: config.base_url(),
            report: None,
            agents: Vec::new(),
            service: None,
            sign_in: None,
            notice: None,
            history: None,
            today: None,
            redeeming: None,
            config: config.clone(),
        });
        let shared = Arc::new(Shared {
            home: Home::current(),
            store: Store::open(),
            cli: bundled_cli(),
            config,
            snapshot,
            paste: Mutex::new(None),
            sign_in: Mutex::new(None),
            look: Notify::new(),
            full: Mutex::new(true),
        });
        runtime.spawn(watch_over(shared.clone()));
        runtime.spawn(start_proxy(shared.clone()));
        Ok(Self { shared, runtime })
    }

    /// Changes to the snapshot, for a UI to redraw on. Works under any
    /// executor.
    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.shared.snapshot.subscribe()
    }

    pub fn snapshot(&self) -> Snapshot {
        self.shared.snapshot.borrow().clone()
    }

    /// The app's runtime, for a UI's own background tasks.
    pub fn handle(&self) -> Handle {
        self.runtime.handle().clone()
    }

    /// The configuration the app started with, which says where the proxy
    /// listens. The snapshot's `config` follows changes to config.toml.
    pub fn config(&self) -> &Config {
        &self.shared.config
    }

    /// Signs in to a subscription in the browser.
    pub fn sign_in(&self, provider: ProviderId) {
        self.connect(provider, LoginOptions::default());
    }

    /// Connects an API key.
    pub fn add_key(&self, provider: ProviderId, key: String) {
        let options = LoginOptions {
            key: Some(key),
            ..LoginOptions::default()
        };
        self.connect(provider, options);
    }

    /// Hands a redirect address pasted by hand to the sign-in in progress,
    /// for a browser on another machine.
    pub fn paste(&self, address: String) {
        if let Some(paste) = lock(&self.shared.paste).as_ref() {
            let _ = paste.send(address);
        }
    }

    pub fn cancel_sign_in(&self) {
        if let Some(task) = lock(&self.shared.sign_in).take() {
            task.abort();
        }
        *lock(&self.shared.paste) = None;
        self.shared.update(|s| s.sign_in = None);
    }

    /// Imports the logins Claude Code, Codex, and CLIProxyAPI already have.
    pub fn import(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let http = auth::http_client(Origins::default());
            let found = import::discover(&http, Source::All).await;
            let store = shared.store.clone();
            let saved = tokio::task::spawn_blocking(move || import::save(&store, found, false))
                .await
                .unwrap_or_default();
            let imported = saved.iter().filter(|s| s.account.is_ok()).count();
            let text = match (imported, saved.len()) {
                (0, 0) => "No logins found to import.".to_owned(),
                (n, found) if n == found => format!("Imported {}.", accounts(n)),
                (n, found) => format!("Imported {} of {found} logins found.", accounts(n)),
            };
            shared.tell(text, false);
            shared.sync().await;
        });
    }

    /// Prefers an account for its provider's new sessions.
    pub fn pin(&self, id: &str) {
        self.change(id, |shared, account| {
            account::pin(&shared.home, account)?;
            Ok(format!(
                "New {} sessions will use {} while it has quota.",
                account.provider,
                account.name()
            ))
        });
    }

    /// Lets slopmax choose every provider's accounts again.
    pub fn unpin_all(&self) {
        self.act(|shared| {
            account::unpin_all(&shared.home)?;
            Ok("slopmax will choose accounts automatically.".to_owned())
        });
    }

    pub fn set_disabled(&self, id: &str, disabled: bool) {
        self.change(id, move |shared, account| {
            let account = shared
                .store
                .update(&account.id, |a| a.disabled = disabled)?;
            let verb = if disabled { "Disabled" } else { "Enabled" };
            Ok(format!("{verb} {}.", account.name()))
        });
    }

    pub fn set_priority(&self, id: &str, priority: i32) {
        self.change(id, move |shared, account| {
            let account = shared
                .store
                .update(&account.id, |a| a.priority = priority)?;
            Ok(format!("{} now has priority {priority}.", account.name()))
        });
    }

    /// Renames an account; `None` goes back to its email or key.
    pub fn rename(&self, id: &str, label: Option<String>) {
        self.change(id, move |shared, account| {
            let account = shared.store.update(&account.id, |a| a.label = label)?;
            Ok(format!("Renamed it {}.", account.name()))
        });
    }

    pub fn remove(&self, id: &str) {
        self.change(id, |shared, account| {
            account::forget(&shared.store, &shared.home, account)?;
            Ok(format!("Removed {}.", account.name()))
        });
    }

    /// Points an agent's own config at slopmax.
    pub fn connect_agent(&self, id: &str) {
        let Some(agent) = agent::find(id) else { return };
        self.act(move |shared| {
            agent::setup(agent, &shared.config)?;
            Ok(format!(
                "{} now uses slopmax. {}",
                agent.title(),
                agent.setup_note()
            ))
        });
    }

    /// Restores what connecting an agent replaced.
    pub fn disconnect_agent(&self, id: &str) {
        let Some(agent) = agent::find(id) else { return };
        self.act(move |_| {
            agent::undo(agent)?;
            Ok(format!("{} is back to its own setup.", agent.title()))
        });
    }

    pub fn start_proxy(&self) {
        self.runtime.spawn(start_proxy(self.shared.clone()));
    }

    pub fn stop_proxy(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            match background::stop(&shared.config).await {
                Ok(_) => shared.tell("Stopped the proxy.".to_owned(), false),
                Err(e) => shared.tell(format!("Could not stop the proxy: {e:#}"), true),
            }
            shared.look_again(true);
        });
    }

    /// Runs the proxy as a service that starts at login.
    pub fn install_service(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let result = async {
                let manager = Manager::detect().context("this system has no service manager")?;
                let cli = shared.cli()?;
                background::install_service(&shared.config, manager, &cli).await
            }
            .await;
            match result {
                Ok(_) => shared.tell("slopmax now starts at login.".to_owned(), false),
                Err(e) => shared.tell(format!("Could not install the service: {e:#}"), true),
            }
            shared.look_again(true);
        });
    }

    /// Stops running the proxy as a login service, then runs it as the app
    /// does, since removing the service stops it.
    pub fn uninstall_service(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let removed = tokio::task::spawn_blocking(|| {
                Manager::detect()
                    .context("this system has no service manager")?
                    .uninstall()
            })
            .await
            .context("the action stopped")
            .and_then(|result| result);
            match removed {
                Ok(_) => shared.tell("slopmax no longer starts at login.".to_owned(), false),
                Err(e) => shared.tell(format!("Could not remove the service: {e:#}"), true),
            }
            start_proxy(shared).await;
        });
    }

    /// Redeems a reset credit on account `id`, the soonest to expire, which
    /// clears its usage windows at once. The running proxy redeems it, so
    /// it knows at once.
    pub fn redeem(&self, id: &str) {
        let shared = self.shared.clone();
        let id = id.to_owned();
        shared.update(|s| s.redeeming = Some(id.clone()));
        self.runtime.spawn(async move {
            let (name, provider) = {
                let snapshot = shared.snapshot.borrow();
                let account = snapshot
                    .report
                    .iter()
                    .flat_map(|r| &r.accounts)
                    .find(|a| a.id == id);
                (
                    account.map_or_else(|| id.clone(), |a| a.name.clone()),
                    account.map_or("Its provider", |a| a.provider.spec().title),
                )
            };
            let result = Daemon::new(&shared.config).redeem(&id).await;
            shared.update(|s| s.redeeming = None);
            match result {
                Ok((outcome, report)) => {
                    shared.update(|s| s.report = Some(report));
                    let text = match outcome {
                        Outcome::Reset => format!("Reset the usage windows on {name}."),
                        Outcome::NothingToReset => {
                            format!("{name} had nothing to reset yet, so the limit reset was kept.")
                        }
                        Outcome::NoCredit => format!("{name} has no limit reset left."),
                        Outcome::AlreadyRedeemed => "That limit reset was already used.".to_owned(),
                        Outcome::Declined => format!(
                            "{provider} would not use a limit reset on {name} right now, so it was kept."
                        ),
                    };
                    shared.tell(text, outcome == Outcome::NoCredit);
                }
                Err(e) => shared.tell(format!("Could not redeem a limit reset: {e:#}"), true),
            }
        });
    }

    /// Changes a setting in config.toml and has the proxy apply it at once.
    pub fn set(&self, setting: Setting) {
        self.act(move |shared| {
            let written = setting.write(&shared.home.config())?;
            let config = adopt(&shared.config, written);
            shared.update(|s| s.config = config);
            Ok(view::setting_changed(setting))
        });
    }

    /// Polls every account's usage now.
    pub fn refresh(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            if let Some(report) = Daemon::new(&shared.config).report(true).await {
                shared.update(|s| s.report = Some(report));
            }
        });
    }

    /// Reads the ledger over `range` into the snapshot's `history`, off the
    /// UI's thread. Accounts take the names the last report gave them.
    pub fn load_history(&self, range: history::Range) {
        self.load(range, |s, history| s.history = Some(history));
    }

    /// Reads today's ledger into the snapshot's `today`.
    pub fn load_today(&self) {
        self.load(history::Range::Today, |s, history| s.today = Some(history));
    }

    fn load(
        &self,
        range: history::Range,
        keep: impl FnOnce(&mut Snapshot, history::History) + Send + 'static,
    ) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let names: HashMap<String, String> = shared
                .snapshot
                .borrow()
                .report
                .iter()
                .flat_map(|r| &r.accounts)
                .map(|a| (a.id.clone(), a.name.clone()))
                .collect();
            let worker = shared.clone();
            let loaded = tokio::task::spawn_blocking(move || {
                history::load(
                    &worker.home.usage(),
                    range,
                    slopmax_core::time::Timestamp::now(),
                    &worker.config.prices,
                    &names,
                )
            })
            .await;
            if let Ok(loaded) = loaded {
                shared.update(|s| keep(s, loaded));
            }
        });
    }

    /// Opens the web dashboard in the browser.
    pub fn open_dashboard(&self) {
        if !callback::open_browser(&self.shared.config.dashboard_url()) {
            self.shared
                .tell("Could not open a browser.".to_owned(), true);
        }
    }

    pub fn dismiss_notice(&self) {
        self.shared.update(|s| s.notice = None);
    }

    fn connect(&self, provider: ProviderId, options: LoginOptions) {
        self.cancel_sign_in();
        let shared = self.shared.clone();
        let (paste, pasted) = mpsc::unbounded_channel();
        *lock(&shared.paste) = Some(paste);
        let prompt = {
            let shared = shared.clone();
            Prompt::new(move |event| shared.update(|s| progress(s, event))).with_pasted(pasted)
        };
        shared.update(|s| {
            s.notice = None;
            s.sign_in = Some(SignIn {
                provider,
                step: Step::Starting,
                notes: Vec::new(),
            });
        });
        let task = self.runtime.spawn(async move {
            let result = auth::connect(&shared.store, provider, None, options, prompt).await;
            *lock(&shared.paste) = None;
            shared.update(|s| s.sign_in = None);
            match result {
                Ok((account, created)) => {
                    let verb = if created { "Connected" } else { "Updated" };
                    shared.tell(format!("{verb} {}.", account.name()), false);
                }
                Err(e) => shared.tell(format!("Sign-in failed: {e:#}"), true),
            }
            shared.sync().await;
        });
        *lock(&self.shared.sign_in) = Some(task);
    }

    /// Runs a change to account `id` on a blocking thread, as file locks
    /// may wait, then shows its outcome.
    fn change(
        &self,
        id: &str,
        change: impl FnOnce(&Shared, &Account) -> Result<String> + Send + 'static,
    ) {
        let id = id.to_owned();
        self.act(move |shared| {
            let account = shared
                .store
                .get(&id)?
                .with_context(|| format!("account {id} is gone"))?;
            change(shared, &account)
        });
    }

    /// Runs `action` on a blocking thread, shows its outcome, and has the
    /// proxy pick up what it changed.
    fn act(&self, action: impl FnOnce(&Shared) -> Result<String> + Send + 'static) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let worker = shared.clone();
            let outcome = tokio::task::spawn_blocking(move || action(&worker))
                .await
                .context("the action stopped")
                .and_then(|result| result);
            match outcome {
                Ok(text) => shared.tell(text, false),
                Err(e) => shared.tell(format!("{e:#}"), true),
            }
            shared.sync().await;
        });
    }
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut Snapshot)) {
        self.snapshot.send_modify(change);
    }

    fn tell(&self, text: String, error: bool) {
        let shown = Instant::now();
        self.update(|s| s.notice = Some(Notice { text, error, shown }));
    }

    /// Asks for a fresh look now; `full` rereads the slow parts too.
    fn look_again(&self, full: bool) {
        if full {
            *lock(&self.full) = true;
        }
        self.look.notify_one();
    }

    /// Has the proxy apply changes made on disk, and shows the result.
    async fn sync(&self) {
        match Daemon::new(&self.config).sync().await {
            Some(report) => self.update(|s| s.report = Some(report)),
            None => self.look_again(false),
        }
        self.look_again(true);
    }

    fn cli(&self) -> Result<PathBuf> {
        self.cli.clone().context(
            "cannot find the slopmax command line, which the app runs the proxy with; \
             reinstall the app",
        )
    }
}

/// Starts the proxy unless it is running.
async fn start_proxy(shared: Arc<Shared>) {
    let daemon = Daemon::new(&shared.config);
    if daemon.is_running().await {
        return;
    }
    shared.update(|s| s.proxy = Proxy::Starting);
    let result = async {
        let cli = shared.cli()?;
        background::ensure_running(&shared.config, &cli).await
    }
    .await;
    if let Err(e) = result {
        shared.update(|s| s.proxy = Proxy::Stopped);
        shared.tell(format!("Could not start the proxy: {e:#}"), true);
    }
    shared.look_again(true);
}

/// Keeps the snapshot current: the report every [`POLL`], and the agents
/// and login service every [`SLOW_POLL`] or when an action changed them.
async fn watch_over(shared: Arc<Shared>) {
    let daemon = Daemon::new(&shared.config);
    let mut last_full = Instant::now();
    loop {
        let live = daemon.report(false).await;
        let running = live.as_ref().map(|r| r.version.clone());
        let report = match live {
            Some(report) => Some(report),
            None => report::offline(&shared.config, &shared.store, false)
                .await
                .ok(),
        };
        shared.update(|s| {
            s.report = report;
            if s.notice
                .as_ref()
                .is_some_and(|n| !n.error && n.shown.elapsed() >= NOTICE_FOR)
            {
                s.notice = None;
            }
            s.proxy = match (running, &s.proxy) {
                (Some(version), _) => Proxy::Running { version },
                (None, Proxy::Starting) => Proxy::Starting,
                (None, _) => Proxy::Stopped,
            };
        });

        let full = std::mem::take(&mut *lock(&shared.full)) || last_full.elapsed() >= SLOW_POLL;
        if full {
            last_full = Instant::now();
            let (config, path) = (shared.config.clone(), shared.home.config());
            if let Ok((agents, service, current)) = tokio::task::spawn_blocking(move || {
                let (agents, service) = look_around(&config);
                // As config.toml has it, should someone have edited it.
                let current = Config::load_from(&path).ok().map(|c| adopt(&config, c));
                (agents, service, current)
            })
            .await
            {
                shared.update(|s| {
                    s.agents = agents;
                    s.service = service;
                    if let Some(current) = current {
                        s.config = current;
                    }
                });
            }
        }

        tokio::select! {
            () = tokio::time::sleep(POLL) => {}
            () = shared.look.notified() => {}
        }
    }
}

/// How the agents are wired, and the login service's status: file reads
/// and, for the service, a call to systemd or launchd.
fn look_around(config: &Config) -> (Vec<AgentStatus>, Option<service::Status>) {
    let agents = AGENTS
        .iter()
        .map(|agent| AgentStatus {
            id: agent.id(),
            title: agent.title(),
            wiring: agent::wiring(*agent, config),
        })
        .collect();
    (agents, Manager::detect().map(Manager::status))
}

/// A config read from config.toml, as the app runs with it: on the address
/// and with the key it started with, which `SLOPMAX_LISTEN` may have set
/// and only a restart changes.
fn adopt(running: &Config, mut read: Config) -> Config {
    read.listen = running.listen;
    read.api_key.clone_from(&running.api_key);
    read
}

fn progress(snapshot: &mut Snapshot, event: LoginEvent) {
    let Some(sign_in) = &mut snapshot.sign_in else {
        return;
    };
    match event {
        LoginEvent::Authorize { url, opened, .. } => sign_in.step = Step::Authorize { url, opened },
        LoginEvent::DeviceCode { url, code } => sign_in.step = Step::DeviceCode { url, code },
        LoginEvent::Notice(text) => sign_in.notes.push(text),
    }
}

/// The slopmax CLI shipped beside the app: in the same directory (a macOS
/// bundle, a cargo target directory) or in `../bin` (an install that keeps
/// the app in `libexec`). Else whichever is on PATH.
fn bundled_cli() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "slopmax.exe"
    } else {
        "slopmax"
    };
    let beside = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?;
        [dir.join(name), dir.join("../bin").join(name)]
            .into_iter()
            .find(|path| path.is_file())
    });
    beside.or_else(|| on_path(name))
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| Path::is_file(candidate))
}

fn accounts(n: usize) -> String {
    format!("{n} account{}", if n == 1 { "" } else { "s" })
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A config.toml of its own in the system's temporary directory, with
    /// a comment to keep.
    fn config_file(text: &str) -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "slopmax-app-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, text).unwrap();
        path
    }

    const CONFIG: &str =
        "# Mine.\napi_key = \"sm-test\"\nstrategy = \"fill-first\" # chosen by hand\n";

    #[test]
    fn settings_are_written_into_config_toml() {
        let path = config_file(CONFIG);
        let config = Setting::Strategy(Strategy::RoundRobin)
            .write(&path)
            .unwrap();
        assert_eq!(config.strategy, Strategy::RoundRobin);
        let text = std::fs::read_to_string(&path).unwrap();
        // The comments stay, the one beside the value too.
        assert!(text.starts_with("# Mine.\n"), "{text}");
        assert!(
            text.contains("strategy = \"round-robin\" # chosen by hand"),
            "{text}"
        );

        let config = Setting::SessionAffinity(false).write(&path).unwrap();
        assert!(!config.session_affinity);
        // What was set before stays set.
        assert_eq!(config.strategy, Strategy::RoundRobin);
        let config = Setting::RedeemExpiringCredits(false).write(&path).unwrap();
        assert!(!config.redeem_expiring_credits);
        let config = Setting::RedeemWhenExhausted(true).write(&path).unwrap();
        assert!(config.redeem_when_exhausted);

        let reread = Config::load_from(&path).unwrap();
        assert_eq!(reread, config);
        assert!(!reread.session_affinity && !reread.redeem_expiring_credits);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_config_that_will_not_load_is_left_alone() {
        let broken = "api_key = \"sm-test\"\nstrategy = 3\n";
        let path = config_file(broken);
        assert!(Setting::SessionAffinity(false).write(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn each_setting_has_its_key() {
        let keys = [
            Setting::Strategy(Strategy::ResetFirst),
            Setting::SessionAffinity(true),
            Setting::RedeemExpiringCredits(true),
            Setting::RedeemWhenExhausted(true),
        ]
        .map(Setting::key);
        assert_eq!(
            keys,
            [
                "strategy",
                "session_affinity",
                "redeem_expiring_credits",
                "redeem_when_exhausted"
            ]
        );
    }

    #[test]
    fn a_reread_config_keeps_the_address_and_key_the_app_runs_with() {
        let running = Config {
            listen: "127.0.0.1:9401".parse().unwrap(),
            api_key: "sm-running".to_owned(),
            ..Config::default()
        };
        let read = Config {
            api_key: "sm-on-disk".to_owned(),
            strategy: Strategy::LeastUsed,
            ..Config::default()
        };
        let adopted = adopt(&running, read);
        assert_eq!(adopted.listen, running.listen);
        assert_eq!(adopted.api_key, "sm-running");
        assert_eq!(adopted.strategy, Strategy::LeastUsed);
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            proxy: Proxy::Checking,
            address: String::new(),
            report: None,
            agents: Vec::new(),
            service: None,
            sign_in: None,
            notice: None,
            history: None,
            today: None,
            redeeming: None,
            config: Config::default(),
        }
    }

    #[test]
    fn sign_in_progress_moves_the_step_along() {
        let mut s = snapshot();
        // Nothing to move along.
        progress(&mut s, LoginEvent::Notice("ignored".to_owned()));
        assert_eq!(s.sign_in, None);

        s.sign_in = Some(SignIn {
            provider: ProviderId::Codex,
            step: Step::Starting,
            notes: Vec::new(),
        });
        progress(
            &mut s,
            LoginEvent::DeviceCode {
                url: "https://example.invalid/device".to_owned(),
                code: "ABCD".to_owned(),
            },
        );
        progress(&mut s, LoginEvent::Notice("Still waiting.".to_owned()));
        let sign_in = s.sign_in.clone().unwrap();
        assert_eq!(
            sign_in.step,
            Step::DeviceCode {
                url: "https://example.invalid/device".to_owned(),
                code: "ABCD".to_owned()
            }
        );
        assert_eq!(sign_in.notes, ["Still waiting."]);

        progress(
            &mut s,
            LoginEvent::Authorize {
                title: "ChatGPT",
                url: "https://example.invalid/authorize".to_owned(),
                opened: false,
                port: 1455,
            },
        );
        assert_eq!(
            s.sign_in.unwrap().step,
            Step::Authorize {
                url: "https://example.invalid/authorize".to_owned(),
                opened: false
            }
        );
    }

    #[test]
    fn counts_of_accounts_agree() {
        assert_eq!(accounts(0), "0 accounts");
        assert_eq!(accounts(1), "1 account");
        assert_eq!(accounts(3), "3 accounts");
    }

    #[test]
    fn commands_are_looked_up_on_path() {
        assert_eq!(on_path("slopmax-surely-not-a-command"), None);
        if cfg!(unix) {
            assert!(on_path("sh").is_some_and(|sh| sh.is_file()));
        }
    }
}
