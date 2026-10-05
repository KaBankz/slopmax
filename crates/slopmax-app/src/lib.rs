//! The desktop app apart from any UI toolkit: what it shows and what it can
//! do. Like the CLI, it asks [`slopmax_core`] and shows the answer, so the
//! app, the CLI, and the dashboard behave alike. This crate adds what a
//! window needs on top: a live [`Snapshot`] to draw, and actions that run
//! in the background and report back through it.
//!
//! A UI draws the latest snapshot ([`view`] works out the rows, gauges, and
//! menu bar line) and calls [`App`]'s methods, none of which block.

pub mod view;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use slopmax_core::account::{self, Account, Store};
use slopmax_core::agent::{self, AGENTS, Wiring};
use slopmax_core::auth::{self, LoginEvent, LoginOptions, Prompt, callback};
use slopmax_core::background::{self, Daemon};
use slopmax_core::config::Config;
use slopmax_core::import::{self, Source};
use slopmax_core::net::Origins;
use slopmax_core::paths::Home;
use slopmax_core::provider::ProviderId;
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

    /// Polls every account's usage now.
    pub fn refresh(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            if let Some(report) = Daemon::new(&shared.config).report(true).await {
                shared.update(|s| s.report = Some(report));
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
        self.update(|s| s.notice = Some(Notice { text, error }));
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
            s.proxy = match (running, &s.proxy) {
                (Some(version), _) => Proxy::Running { version },
                (None, Proxy::Starting) => Proxy::Starting,
                (None, _) => Proxy::Stopped,
            };
        });

        let full = std::mem::take(&mut *lock(&shared.full)) || last_full.elapsed() >= SLOW_POLL;
        if full {
            last_full = Instant::now();
            let config = shared.config.clone();
            if let Ok((agents, service)) =
                tokio::task::spawn_blocking(move || look_around(&config)).await
            {
                shared.update(|s| {
                    s.agents = agents;
                    s.service = service;
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
