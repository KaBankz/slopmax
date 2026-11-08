//! The desktop app apart from any UI toolkit: what it shows and what it can
//! do. It is a client of the daemon's API and of nothing else: every change
//! goes through [`slopmax_client`], and the report, notices and sign-in
//! progress come pushed on the event stream, so the app writes no file of
//! slopmax's and polls nothing. What the API cannot do, because no daemon
//! runs to answer, it asks of the slopmax CLI it ships with: where the
//! daemon listens, starting it, and installing it as a login service.
//!
//! A UI draws the latest [`Snapshot`] ([`view`] works out the rows, gauges,
//! and menu bar line, [`history`] the charts of past use) and calls
//! [`App`]'s methods, none of which block.

pub mod alerts;
pub mod history;
pub mod view;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use slopmax_api::events::{Event, LoginEvent};
use slopmax_api::report::{AgentWiring, RedeemOutcome, Report, Section};
use slopmax_api::requests::{AccountPatch, AddAccount, ImportOutcome, MakeKey, StartLogin};
use slopmax_api::settings::{KeyInfo, LivePatch, SettingsView};
use slopmax_client::Client;
use tokio::runtime::{Handle, Runtime};
use tokio::sync::{Notify, mpsc, watch};

pub use slopmax_api::{AgentId, Dialect, Provider, Strategy, Tone};
pub use slopmax_common::{home, human, time};

/// How often it rereads what changes rarely and is not pushed: the agents'
/// configs, the login service, and settings edited in config.toml.
const SLOW_POLL: Duration = Duration::from_secs(15);
/// How long it waits before looking for the daemon again once it is gone.
const RETRY: Duration = Duration::from_secs(2);
/// How long a notice that something worked stays; errors stay until
/// dismissed.
const NOTICE_FOR: Duration = Duration::from_secs(6);

/// Everything a window shows, as of the last look.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub proxy: Proxy,
    /// Where agents reach the proxy.
    pub address: String,
    /// The accounts and pools, as the daemon last pushed them.
    pub report: Option<Report>,
    pub agents: Vec<AgentWiring>,
    /// The login service, where this system has one.
    pub service: Option<ServiceStatus>,
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
    /// The settings as the daemon has them, which the Settings page
    /// changes with [`App::set`].
    pub config: Settings,
    /// Whether notices are posted as notifications.
    pub notifications: bool,
    /// A client key just made, shown once.
    pub new_key: Option<NewKey>,
    /// What the doctor found, once asked with [`App::check_setup`].
    pub doctor: Doctor,
}

/// The settings the app shows and changes, as the daemon answers them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub strategy: Strategy,
    pub session_affinity: bool,
    pub redeem_expiring_credits: bool,
    pub redeem_when_exhausted: bool,
    pub session_ttl_mins: u64,
    pub poll_mins: u64,
    pub warm_windows: bool,
    pub paid_overflow: bool,
    /// The client keys, by name.
    pub keys: Vec<KeyInfo>,
}

impl Default for Settings {
    /// As a fresh config.toml has them, until the daemon answers.
    fn default() -> Self {
        Self {
            strategy: Strategy::ResetFirst,
            session_affinity: true,
            redeem_expiring_credits: true,
            redeem_when_exhausted: false,
            session_ttl_mins: 60,
            poll_mins: 5,
            warm_windows: false,
            paid_overflow: false,
            keys: Vec::new(),
        }
    }
}

impl Settings {
    pub fn of(view: &SettingsView) -> Self {
        let live = &view.settings.live;
        Self {
            strategy: live.strategy,
            session_affinity: live.session_affinity,
            redeem_expiring_credits: live.redeem_expiring,
            redeem_when_exhausted: live.redeem_when_exhausted,
            session_ttl_mins: live.session_minutes,
            poll_mins: live.poll_minutes,
            warm_windows: live.warm_windows,
            paid_overflow: live.paid_overflow,
            keys: view.settings.keys.clone(),
        }
    }
}

/// A client key just made: its name and the key, which is not shown again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewKey {
    pub name: String,
    pub key: String,
}

/// The setup checks, as far as they have gone.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Doctor {
    #[default]
    NotRun,
    Running,
    Done(Vec<Section>),
    Failed(String),
}

/// A compatible endpoint to add: an API that speaks one of the formats
/// slopmax does, at `url`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEndpoint {
    pub url: String,
    pub dialect: Dialect,
    /// The models it serves, as patterns; empty, any.
    pub models: Vec<String>,
    pub key: String,
    /// What to call it; else its address.
    pub label: Option<String>,
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
    /// Idle minutes before a session's account is forgotten.
    SessionTtlMins(u64),
    /// Whether idle ChatGPT accounts' windows are started as they reset.
    WarmWindows(bool),
    /// Whether API keys take over once subscriptions are limited.
    PaidOverflow(bool),
    /// Minutes between usage polls; 0 turns them off.
    PollMins(u64),
}

impl Setting {
    /// Its key in config.toml.
    pub fn key(self) -> &'static str {
        match self {
            Self::Strategy(_) => "strategy",
            Self::SessionAffinity(_) => "session_affinity",
            Self::RedeemExpiringCredits(_) => "redeem_expiring_credits",
            Self::RedeemWhenExhausted(_) => "redeem_when_exhausted",
            Self::SessionTtlMins(_) => "session_ttl_mins",
            Self::WarmWindows(_) => "warm_windows",
            Self::PaidOverflow(_) => "paid_overflow",
            Self::PollMins(_) => "poll_mins",
        }
    }

    /// The change as the API takes it.
    pub fn patch(self) -> LivePatch {
        let mut patch = LivePatch::default();
        match self {
            Self::Strategy(strategy) => patch.strategy = Some(strategy),
            Self::SessionAffinity(on) => patch.session_affinity = Some(on),
            Self::RedeemExpiringCredits(on) => patch.redeem_expiring = Some(on),
            Self::RedeemWhenExhausted(on) => patch.redeem_when_exhausted = Some(on),
            Self::SessionTtlMins(mins) => patch.session_minutes = Some(mins),
            Self::WarmWindows(on) => patch.warm_windows = Some(on),
            Self::PaidOverflow(on) => patch.paid_overflow = Some(on),
            Self::PollMins(mins) => patch.poll_minutes = Some(mins),
        }
        patch
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

/// The login service that runs the proxy, as the CLI reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct ServiceStatus {
    pub installed: bool,
    pub running: bool,
}

/// A sign-in in progress.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignIn {
    pub provider: Provider,
    pub step: Step,
    /// Notes while waiting, such as a rejected paste.
    pub notes: Vec<String>,
    /// The daemon's id for it, once it has started.
    id: Option<String>,
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
    /// New notices to post, until a UI takes them.
    heard: Mutex<Option<mpsc::UnboundedReceiver<alerts::Alert>>>,
}

struct Shared {
    /// Whether notices are handed to the UI at all: not while drawing the
    /// pages to images.
    notify: bool,
    alerts: mpsc::UnboundedSender<alerts::Alert>,
    /// The slopmax CLI that runs the proxy, normally the one the app ships.
    cli: Option<PathBuf>,
    /// Where the daemon is, as the CLI last said.
    found: Mutex<Option<Found>>,
    snapshot: watch::Sender<Snapshot>,
    /// Wakes the watcher for a fresh look; `full` rereads the slow parts.
    look: Notify,
    full: Mutex<bool>,
}

/// What `slopmax daemon-info` says.
#[derive(Debug, Clone, serde::Deserialize)]
struct Found {
    base: String,
    key: String,
    home: PathBuf,
    running: bool,
    #[serde(default)]
    service: Option<ServiceStatus>,
}

impl Found {
    fn client(&self) -> Client {
        Client::new(&self.base, &self.key)
    }
}

impl App {
    /// Finds the daemon, starts it if none is running, and follows it,
    /// handing notices to the UI to post (see [`App::alerts`]).
    pub fn start() -> Result<Self> {
        Self::start_with(true)
    }

    /// As [`App::start`]; without `notify`, no notice is handed to the UI,
    /// as while drawing the pages to images.
    pub fn start_with(notify: bool) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("slopmax-app")
            .enable_all()
            .build()
            .context("starting the app's runtime")?;
        let (alerts, heard) = mpsc::unbounded_channel();
        let (snapshot, _) = watch::channel(Snapshot {
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
            config: Settings::default(),
            notifications: true,
            new_key: None,
            doctor: Doctor::NotRun,
        });
        let shared = Arc::new(Shared {
            notify,
            alerts,
            cli: bundled_cli(),
            found: Mutex::new(None),
            snapshot,
            look: Notify::new(),
            full: Mutex::new(true),
        });
        runtime.spawn(follow(shared.clone()));
        Ok(Self {
            shared,
            runtime,
            heard: Mutex::new(Some(heard)),
        })
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

    /// Signs in to a subscription in the browser, which the app opens.
    pub fn sign_in(&self, provider: Provider) {
        self.cancel_sign_in();
        self.shared.update(|s| {
            s.notice = None;
            s.sign_in = Some(SignIn {
                provider,
                step: Step::Starting,
                notes: Vec::new(),
                id: None,
            });
        });
        self.call(move |client, shared| async move {
            let asked = StartLogin {
                provider,
                device: false,
                label: None,
                // The app opens it, in the session the person sits at,
                // which a daemon run by the service manager may not reach.
                no_browser: true,
            };
            match client.start_login(&asked).await {
                Ok(started) => {
                    shared.update(|s| {
                        if let Some(sign_in) = &mut s.sign_in {
                            sign_in.id = Some(started.id);
                        }
                    });
                    Ok(None)
                }
                Err(e) => {
                    shared.update(|s| s.sign_in = None);
                    Err(anyhow::anyhow!("Sign-in failed: {e}"))
                }
            }
        });
    }

    /// Connects an API key.
    pub fn add_key(&self, provider: Provider, key: String) {
        let asked = AddAccount::Key {
            provider,
            key,
            label: None,
        };
        self.add(asked);
    }

    /// Connects a compatible endpoint; its key is checked before it is
    /// saved.
    pub fn add_endpoint(&self, endpoint: NewEndpoint) {
        let asked = AddAccount::Endpoint {
            url: endpoint.url.trim().trim_end_matches('/').to_owned(),
            dialect: endpoint.dialect,
            models: endpoint.models,
            key: Some(endpoint.key).filter(|k| !k.is_empty()),
            label: endpoint.label,
        };
        self.add(asked);
    }

    fn add(&self, asked: AddAccount) {
        self.call(move |client, shared| async move {
            let added = client.add_account(&asked).await?;
            shared.update(|s| s.report = Some(added.report));
            Ok(Some(format!("Connected {}.", added.account.name)))
        });
    }

    /// Makes a client key named `name`, held to `models` (patterns) if any
    /// are given, and shows it once.
    pub fn add_client_key(&self, name: String, models: Vec<String>) {
        self.call(move |client, shared| async move {
            let asked = MakeKey {
                name: name.trim().to_owned(),
                models,
            };
            let made = client.make_key(&asked).await?;
            shared.update(|s| {
                s.new_key = Some(NewKey {
                    name: made.name.clone(),
                    key: made.key,
                });
            });
            shared.reread_settings(&client).await;
            Ok(Some(format!("Made the key {}.", made.name)))
        });
    }

    /// Revokes the client key named `name`; whatever used it is refused
    /// from now on.
    pub fn revoke_key(&self, name: &str) {
        let name = name.to_owned();
        self.call(move |client, shared| async move {
            client.remove_key(&name).await?;
            shared.update(|s| {
                if s.new_key.as_ref().is_some_and(|k| k.name == name) {
                    s.new_key = None;
                }
            });
            shared.reread_settings(&client).await;
            Ok(Some(format!("Revoked the key {name}.")))
        });
    }

    /// Forgets the key just made, once it has been copied.
    pub fn dismiss_new_key(&self) {
        self.shared.update(|s| s.new_key = None);
    }

    /// Runs the setup checks `slopmax doctor` runs.
    pub fn check_setup(&self) {
        self.shared.update(|s| s.doctor = Doctor::Running);
        self.call(move |client, shared| async move {
            let found = match client.doctor().await {
                Ok(sections) => Doctor::Done(sections),
                Err(e) => Doctor::Failed(e.to_string()),
            };
            shared.update(|s| s.doctor = found);
            Ok(None)
        });
    }

    /// Has slopmax refresh an imported login itself, rather than follow the
    /// tool it came from.
    pub fn own(&self, id: &str) {
        let id = id.to_owned();
        self.change(move |client| async move {
            let report = client.own(&id).await?;
            let name = name_in(&report, &id);
            Ok((report, format!("slopmax now refreshes {name} itself.")))
        });
    }

    /// Hands a redirect address pasted by hand to the sign-in in progress,
    /// for a browser on another machine.
    pub fn paste(&self, address: String) {
        let Some(id) = self.sign_in_id() else { return };
        self.call(move |client, _| async move {
            client.paste_login(&id, address.trim()).await?;
            Ok(None)
        });
    }

    pub fn cancel_sign_in(&self) {
        let id = self.sign_in_id();
        self.shared.update(|s| s.sign_in = None);
        if let Some(id) = id {
            self.call(move |client, _| async move {
                let _ = client.cancel_login(&id).await;
                Ok(None)
            });
        }
    }

    fn sign_in_id(&self) -> Option<String> {
        self.shared
            .snapshot
            .borrow()
            .sign_in
            .as_ref()
            .and_then(|s| s.id.clone())
    }

    /// Imports the logins Claude Code, Codex, and CLIProxyAPI already have.
    pub fn import(&self) {
        self.call(move |client, shared| async move {
            let result = client.import(&Default::default()).await?;
            let found = result.outcomes.len();
            let imported = result
                .outcomes
                .iter()
                .filter(|o| matches!(o, ImportOutcome::Saved { .. }))
                .count();
            shared.update(|s| s.report = Some(result.report));
            Ok(Some(match (imported, found) {
                (0, 0) => "No logins found to import.".to_owned(),
                (n, found) if n == found => format!("Imported {}.", accounts(n)),
                (n, found) => format!("Imported {} of {found} logins found.", accounts(n)),
            }))
        });
    }

    /// Prefers an account for its provider's new sessions.
    pub fn pin(&self, id: &str) {
        let id = id.to_owned();
        self.change(move |client| async move {
            let report = client.pin(&id).await?;
            let account = report.accounts.iter().find(|a| a.id == id);
            let text = match account {
                Some(a) => format!(
                    "New {} sessions will use {} while it has quota.",
                    a.provider, a.name
                ),
                None => "Pinned it.".to_owned(),
            };
            Ok((report, text))
        });
    }

    /// Lets slopmax choose every provider's accounts again.
    pub fn unpin_all(&self) {
        self.change(|client| async move {
            let report = client.unpin_all().await?;
            Ok((
                report,
                "slopmax will choose accounts automatically.".to_owned(),
            ))
        });
    }

    pub fn set_disabled(&self, id: &str, disabled: bool) {
        let patch = AccountPatch {
            disabled: Some(disabled),
            ..AccountPatch::default()
        };
        let verb = if disabled { "Disabled" } else { "Enabled" };
        self.patch(id, patch, move |name| format!("{verb} {name}."));
    }

    pub fn set_priority(&self, id: &str, priority: i32) {
        let patch = AccountPatch {
            priority: Some(priority),
            ..AccountPatch::default()
        };
        self.patch(id, patch, move |name| {
            format!("{name} now has priority {priority}.")
        });
    }

    /// Renames an account; `None` goes back to its email or key.
    pub fn rename(&self, id: &str, label: Option<String>) {
        let patch = AccountPatch {
            label: Some(label),
            ..AccountPatch::default()
        };
        self.patch(id, patch, |name| format!("Renamed it {name}."));
    }

    fn patch(
        &self,
        id: &str,
        patch: AccountPatch,
        said: impl FnOnce(&str) -> String + Send + 'static,
    ) {
        let id = id.to_owned();
        self.change(move |client| async move {
            let report = client.update_account(&id, &patch).await?;
            let text = said(&name_in(&report, &id));
            Ok((report, text))
        });
    }

    pub fn remove(&self, id: &str) {
        let id = id.to_owned();
        let name = self.name_of(&id);
        self.change(move |client| async move {
            let report = client.remove_account(&id).await?;
            Ok((report, format!("Removed {name}.")))
        });
    }

    fn name_of(&self, id: &str) -> String {
        self.shared
            .snapshot
            .borrow()
            .report
            .as_ref()
            .map_or_else(|| id.to_owned(), |r| name_in(r, id))
    }

    /// Points an agent's own config at slopmax.
    pub fn connect_agent(&self, id: AgentId) {
        self.call(move |client, shared| async move {
            let connected = client.connect_agent(id).await?;
            shared.reread_agents(&client).await;
            Ok(Some(format!(
                "{} now uses slopmax. {}",
                agent_title(id),
                connected.note
            )))
        });
    }

    /// Restores what connecting an agent replaced.
    pub fn disconnect_agent(&self, id: AgentId) {
        self.call(move |client, shared| async move {
            client.disconnect_agent(id).await?;
            shared.reread_agents(&client).await;
            Ok(Some(format!(
                "{} is back to its own setup.",
                agent_title(id)
            )))
        });
    }

    pub fn start_proxy(&self) {
        let shared = self.shared.clone();
        self.runtime
            .spawn(async move { shared.start_proxy().await });
    }

    pub fn stop_proxy(&self) {
        self.call(|client, _| async move {
            client.shutdown(false).await?;
            Ok(Some("Stopped the proxy.".to_owned()))
        });
    }

    /// Runs the proxy as a service that starts at login.
    pub fn install_service(&self) {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            match shared.run_cli(&["service", "install"]).await {
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
            match shared.run_cli(&["service", "uninstall"]).await {
                Ok(_) => shared.tell("slopmax no longer starts at login.".to_owned(), false),
                Err(e) => shared.tell(format!("Could not remove the service: {e:#}"), true),
            }
            shared.start_proxy().await;
        });
    }

    /// Redeems a reset credit on account `id`, the soonest to expire, which
    /// clears its usage windows at once.
    pub fn redeem(&self, id: &str) {
        let id = id.to_owned();
        let (name, provider) = {
            let snapshot = self.shared.snapshot.borrow();
            let account = snapshot
                .report
                .iter()
                .flat_map(|r| &r.accounts)
                .find(|a| a.id == id);
            (
                account.map_or_else(|| id.clone(), |a| a.name.clone()),
                account.map_or("Its provider", |a| a.provider.title()),
            )
        };
        self.shared.update(|s| s.redeeming = Some(id.clone()));
        self.call(move |client, shared| async move {
            let result = client.redeem(&id, &Default::default()).await;
            shared.update(|s| s.redeeming = None);
            let redeemed =
                result.map_err(|e| anyhow::anyhow!("Could not redeem a limit reset: {e}"))?;
            shared.update(|s| s.report = Some(redeemed.report));
            let text = match redeemed.outcome {
                RedeemOutcome::Reset => format!("Reset the usage windows on {name}."),
                RedeemOutcome::NothingToReset => {
                    format!("{name} had nothing to reset yet, so the limit reset was kept.")
                }
                RedeemOutcome::NoCredit => bail!("{name} has no limit reset left."),
                RedeemOutcome::AlreadyRedeemed => "That limit reset was already used.".to_owned(),
                RedeemOutcome::Declined => format!(
                    "{provider} would not use a limit reset on {name} right now, so it was kept."
                ),
            };
            Ok(Some(text))
        });
    }

    /// Changes a setting, which the daemon applies at once and writes to
    /// config.toml.
    pub fn set(&self, setting: Setting) {
        self.call(move |client, shared| async move {
            let view = client.change_settings(&setting.patch()).await?;
            shared.update(|s| s.config = Settings::of(&view));
            Ok(Some(view::setting_changed(setting)))
        });
    }

    /// The notices to post as notifications, as they come, while they are
    /// on; once, for the UI that posts them. Works under any executor.
    pub fn alerts(&self) -> Option<mpsc::UnboundedReceiver<alerts::Alert>> {
        lock(&self.heard).take()
    }

    /// Turns notifications on or off, for this and later runs.
    pub fn set_notifications(&self, on: bool) {
        self.shared.update(|s| s.notifications = on);
        if let Some(home) = lock(&self.shared.found).as_ref().map(|f| f.home.clone()) {
            prefs::save(&home, &prefs::Prefs { notifications: on });
        }
    }

    /// Polls every account's usage now.
    pub fn refresh(&self) {
        self.call(|client, shared| async move {
            let report = client.refresh().await?;
            shared.update(|s| s.report = Some(report));
            Ok(None)
        });
    }

    /// Reads what went through over `range` into the snapshot's `history`.
    pub fn load_history(&self, range: history::Range) {
        self.call(move |client, shared| async move {
            let history = client.history(range).await?;
            shared.update(|s| s.history = Some(history));
            Ok(None)
        });
    }

    /// Reads today's into the snapshot's `today`.
    pub fn load_today(&self) {
        self.call(|client, shared| async move {
            let today = client.history(history::Range::Today).await?;
            shared.update(|s| s.today = Some(today));
            Ok(None)
        });
    }

    /// Opens the web dashboard in the browser.
    pub fn open_dashboard(&self) {
        let found = lock(&self.shared.found).clone();
        let Some(found) = found else {
            self.shared
                .tell("The proxy has not been found yet.".to_owned(), true);
            return;
        };
        let url = format!("{}/slopmax/#key={}", found.base, found.key);
        if !open_browser(&url) {
            self.shared
                .tell("Could not open a browser.".to_owned(), true);
        }
    }

    pub fn dismiss_notice(&self) {
        self.shared.update(|s| s.notice = None);
    }

    /// Runs `call` with a client of the daemon, and shows its outcome: the
    /// words it answers with, or the error.
    fn call<F, Fut>(&self, call: F)
    where
        F: FnOnce(Client, Arc<Shared>) -> Fut + Send + 'static,
        Fut: Future<Output = Result<Option<String>>> + Send,
    {
        let shared = self.shared.clone();
        self.runtime.spawn(async move {
            let Some(client) = shared.client() else {
                shared.tell("The proxy is not running.".to_owned(), true);
                return;
            };
            match call(client, shared.clone()).await {
                Ok(Some(text)) => shared.tell(text, false),
                Ok(None) => {}
                Err(e) => shared.tell(format!("{e:#}"), true),
            }
        });
    }

    /// A change that answers with the report, shown at once.
    fn change<F, Fut>(&self, change: F)
    where
        F: FnOnce(Client) -> Fut + Send + 'static,
        Fut: Future<Output = Result<(Report, String)>> + Send,
    {
        self.call(move |client, shared| async move {
            let (report, text) = change(client).await?;
            shared.update(|s| s.report = Some(report));
            Ok(Some(text))
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

    fn client(&self) -> Option<Client> {
        lock(&self.found).as_ref().map(Found::client)
    }

    fn cli(&self) -> Result<&Path> {
        self.cli.as_deref().context(
            "cannot find the slopmax command line, which the app runs the proxy with; \
             reinstall the app",
        )
    }

    /// Runs the CLI with `args`, giving what it printed, or what it said
    /// went wrong.
    async fn run_cli(&self, args: &[&str]) -> Result<String> {
        let out = tokio::process::Command::new(self.cli()?)
            .args(args)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .context("running the slopmax command line")?;
        let printed = String::from_utf8_lossy(&out.stdout).into_owned();
        if out.status.success() {
            return Ok(printed);
        }
        let said = String::from_utf8_lossy(&out.stderr);
        let said = said.trim().trim_start_matches("error: ");
        bail!(
            "{}",
            if said.is_empty() {
                printed.trim()
            } else {
                said
            }
        )
    }

    /// Where the daemon listens, and whether one is running, as the CLI
    /// says.
    async fn locate(&self) -> Result<Found> {
        let printed = self.run_cli(&["daemon-info", "--json"]).await?;
        let found: Found =
            serde_json::from_str(&printed).context("reading what the slopmax CLI said")?;
        if lock(&self.found).is_none() {
            let prefs = prefs::load(&found.home);
            self.update(|s| s.notifications = prefs.notifications);
        }
        self.update(|s| {
            s.address.clone_from(&found.base);
            s.service = found.service;
        });
        *lock(&self.found) = Some(found.clone());
        Ok(found)
    }

    /// Starts the proxy unless it is running.
    async fn start_proxy(&self) {
        self.update(|s| s.proxy = Proxy::Starting);
        let started = match self.locate().await {
            Ok(found) if found.running => Ok(()),
            Ok(_) => self.run_cli(&["start"]).await.map(drop),
            Err(e) => Err(e),
        };
        if let Err(e) = started {
            self.update(|s| s.proxy = Proxy::Stopped);
            self.tell(format!("Could not start the proxy: {e:#}"), true);
        }
        self.look_again(true);
    }

    async fn reread_settings(&self, client: &Client) {
        if let Ok(view) = client.settings().await {
            self.update(|s| s.config = Settings::of(&view));
        }
    }

    async fn reread_agents(&self, client: &Client) {
        if let Ok(agents) = client.agents().await {
            self.update(|s| s.agents = agents);
        }
    }

    /// What changes rarely and is not pushed: the agents' wiring, the
    /// settings (config.toml may be edited by hand), and the login service.
    async fn reread_slow(&self, client: &Client) {
        self.reread_agents(client).await;
        self.reread_settings(client).await;
        let _ = self.locate().await;
    }

    /// Takes in one event from the daemon.
    fn heard(&self, event: Event) {
        match event {
            Event::Hello { version, .. } => self.update(|s| s.proxy = Proxy::Running { version }),
            Event::Status { report } => self.update(|s| s.report = Some(*report)),
            Event::Notice { notice } => {
                if self.notify && self.snapshot.borrow().notifications {
                    let _ = self.alerts.send(alerts::Alert::of(&notice));
                }
            }
            Event::Login { id, event } => self.signing_in(&id, event),
            Event::Request { .. } | Event::Ping {} => {}
        }
    }

    /// Moves the sign-in `id` along, if it is the one in progress.
    fn signing_in(&self, id: &str, event: LoginEvent) {
        let ours = self
            .snapshot
            .borrow()
            .sign_in
            .as_ref()
            .is_some_and(|s| s.id.as_deref() == Some(id));
        if !ours {
            return;
        }
        match event {
            LoginEvent::Authorize { url, .. } => {
                let opened = open_browser(&url);
                self.update(|s| progress(s, Step::Authorize { url, opened }));
            }
            LoginEvent::DeviceCode { url, code } => {
                self.update(|s| progress(s, Step::DeviceCode { url, code }));
            }
            LoginEvent::Note { text } => self.update(|s| {
                if let Some(sign_in) = &mut s.sign_in {
                    sign_in.notes.push(text);
                }
            }),
            LoginEvent::Done { account, is_new } => {
                self.update(|s| s.sign_in = None);
                let verb = if is_new { "Connected" } else { "Updated" };
                self.tell(format!("{verb} {}.", account.name), false);
            }
            LoginEvent::Failed { message } => {
                self.update(|s| s.sign_in = None);
                self.tell(format!("Sign-in failed: {message}"), true);
            }
        }
    }

    /// Clears a notice of success once it has shown long enough, and says
    /// when the next one will be due.
    fn expire_notice(&self) -> Option<Instant> {
        let mut due = None;
        self.update(|s| match &s.notice {
            Some(n) if !n.error && n.shown.elapsed() >= NOTICE_FOR => s.notice = None,
            Some(n) if !n.error => due = Some(n.shown + NOTICE_FOR),
            _ => {}
        });
        due
    }
}

/// Keeps the snapshot current: finds the daemon (starting it once, at
/// first), then follows its event stream, rereading the slow parts every
/// [`SLOW_POLL`] or when an action changed them. When the stream ends, the
/// proxy shows as stopped, with the report the files hold, until it answers
/// again.
async fn follow(shared: Arc<Shared>) {
    shared.start_proxy().await;
    let mut offline: Option<Instant> = None;
    loop {
        // Asked of the CLI again only now and then: its config.toml may have
        // moved the daemon to another port.
        let found = match shared.client() {
            Some(client) if !std::mem::take(&mut *lock(&shared.full)) => Ok(client),
            _ => shared.locate().await.map(|found| found.client()),
        };
        let client = match found {
            Ok(client) => client,
            Err(e) => {
                shared.update(|s| s.proxy = Proxy::Stopped);
                shared.tell(format!("{e:#}"), true);
                wait(&shared, SLOW_POLL).await;
                continue;
            }
        };
        if let Ok(mut events) = client.events().await {
            let mut slow = tokio::time::Instant::now();
            *lock(&shared.full) = true;
            loop {
                if std::mem::take(&mut *lock(&shared.full)) || slow <= tokio::time::Instant::now() {
                    shared.reread_slow(&client).await;
                    slow = tokio::time::Instant::now() + SLOW_POLL;
                }
                let notice = shared.expire_notice().map(tokio::time::Instant::from_std);
                let wake = notice.map_or(slow, |at| at.min(slow));
                tokio::select! {
                    event = events.next() => match event {
                        Some(Ok(event)) => shared.heard(event),
                        // Another version's event: skipped.
                        Some(Err(slopmax_client::Error::Unexpected(_))) => {}
                        Some(Err(_)) | None => break,
                    },
                    () = tokio::time::sleep_until(wake) => {}
                    () = shared.look.notified() => {}
                }
            }
        }
        shared.update(|s| {
            s.proxy = match s.proxy {
                Proxy::Starting => Proxy::Starting,
                _ => Proxy::Stopped,
            };
        });
        // With no daemon to push it, the report as the files have it, now
        // and then: read-only until one runs again.
        if offline.is_none_or(|at: Instant| at.elapsed() >= SLOW_POLL)
            && !matches!(shared.snapshot.borrow().proxy, Proxy::Starting)
        {
            offline = Some(Instant::now());
            if let Ok(printed) = shared.run_cli(&["status", "--json"]).await
                && let Ok(report) = serde_json::from_str::<Report>(&printed)
            {
                shared.update(|s| s.report = Some(report));
            }
        }
        wait(&shared, RETRY).await;
    }
}

/// Waits `for_`, or until an action asks for a fresh look.
async fn wait(shared: &Shared, for_: Duration) {
    tokio::select! {
        () = tokio::time::sleep(for_) => {}
        () = shared.look.notified() => {}
    }
}

fn progress(snapshot: &mut Snapshot, step: Step) {
    if let Some(sign_in) = &mut snapshot.sign_in {
        sign_in.step = step;
    }
}

/// An account's name in `report`, or its id.
fn name_in(report: &Report, id: &str) -> String {
    report
        .accounts
        .iter()
        .find(|a| a.id == id)
        .map_or_else(|| id.to_owned(), |a| a.name.clone())
}

fn agent_title(id: AgentId) -> &'static str {
    match id {
        AgentId::ClaudeCode => "Claude Code",
        AgentId::Codex => "Codex",
    }
}

/// What the app keeps of its own, beside slopmax's files: `app.toml`.
mod prefs {
    use std::path::Path;

    #[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    pub struct Prefs {
        /// Whether notices are posted as notifications.
        pub notifications: bool,
    }

    impl Default for Prefs {
        fn default() -> Self {
            Self {
                notifications: true,
            }
        }
    }

    pub fn load(home: &Path) -> Prefs {
        std::fs::read_to_string(home.join("app.toml"))
            .ok()
            .and_then(|text| toml_edit::de::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// A failure only means the choice is asked again next time.
    pub fn save(home: &Path, prefs: &Prefs) {
        if let Ok(text) = toml_edit::ser::to_string(prefs) {
            let _ = std::fs::write(home.join("app.toml"), text);
        }
    }
}

/// Opens `url` in the person's browser; whether it could.
fn open_browser(url: &str) -> bool {
    let program = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
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
    use super::*;

    #[test]
    fn each_setting_is_one_live_change() {
        let keys = [
            Setting::Strategy(Strategy::ResetFirst),
            Setting::SessionAffinity(true),
            Setting::RedeemExpiringCredits(true),
            Setting::RedeemWhenExhausted(true),
            Setting::SessionTtlMins(30),
            Setting::WarmWindows(true),
            Setting::PaidOverflow(true),
            Setting::PollMins(0),
        ];
        for setting in keys {
            let changes = setting.patch().changes();
            assert_eq!(changes.len(), 1, "{setting:?}");
            // The API's row for it is the config.toml key the app names.
            assert_eq!(changes[0].0.toml, setting.key(), "{setting:?}");
        }
    }

    #[test]
    fn notifications_are_kept_beside_slopmax_files() {
        let dir = std::env::temp_dir().join(format!("slopmax-app-prefs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(prefs::load(&dir).notifications, "on until turned off");
        prefs::save(
            &dir,
            &prefs::Prefs {
                notifications: false,
            },
        );
        assert!(!prefs::load(&dir).notifications);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn sign_in_progress_moves_the_step_along() {
        let (alerts, _heard) = mpsc::unbounded_channel();
        let (snapshot, _) = watch::channel(Snapshot {
            proxy: Proxy::Checking,
            address: String::new(),
            report: None,
            agents: Vec::new(),
            service: None,
            sign_in: Some(SignIn {
                provider: Provider::Codex,
                step: Step::Starting,
                notes: Vec::new(),
                id: Some("login-1".to_owned()),
            }),
            notice: None,
            history: None,
            today: None,
            redeeming: None,
            config: Settings::default(),
            notifications: true,
            new_key: None,
            doctor: Doctor::NotRun,
        });
        let shared = Shared {
            notify: true,
            alerts,
            cli: None,
            found: Mutex::new(None),
            snapshot,
            look: Notify::new(),
            full: Mutex::new(false),
        };
        // Another sign-in's progress is not this one's.
        shared.signing_in(
            "login-2",
            LoginEvent::Note {
                text: "ignored".into(),
            },
        );
        assert!(
            shared
                .snapshot
                .borrow()
                .sign_in
                .as_ref()
                .unwrap()
                .notes
                .is_empty()
        );
        shared.signing_in(
            "login-1",
            LoginEvent::DeviceCode {
                url: "https://example.invalid/device".into(),
                code: "ABCD".into(),
            },
        );
        shared.signing_in(
            "login-1",
            LoginEvent::Note {
                text: "Still waiting.".into(),
            },
        );
        let sign_in = shared.snapshot.borrow().sign_in.clone().unwrap();
        assert_eq!(
            sign_in.step,
            Step::DeviceCode {
                url: "https://example.invalid/device".to_owned(),
                code: "ABCD".to_owned()
            }
        );
        assert_eq!(sign_in.notes, ["Still waiting."]);
        shared.signing_in(
            "login-1",
            LoginEvent::Failed {
                message: "denied".into(),
            },
        );
        let snapshot = shared.snapshot.borrow();
        assert!(snapshot.sign_in.is_none());
        assert_eq!(
            snapshot.notice.as_ref().unwrap().text,
            "Sign-in failed: denied"
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
