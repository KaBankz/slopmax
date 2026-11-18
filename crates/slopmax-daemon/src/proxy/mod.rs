//! The local HTTP proxy that agents talk to.
//!
//! Claude Code reaches it through `ANTHROPIC_BASE_URL` and Codex through a
//! custom model provider. Each request is authenticated with a slopmax key,
//! or, from the user's other machines on their tailnet, by the login
//! tailscaled names; it is then assigned an account by the [`Pool`] and
//! forwarded upstream with that account's credentials.

mod api;
mod forward;
mod hub;
mod models;
mod relay;
mod socket;
mod start;
mod tailnet;
mod transcode;
mod ui;
pub mod warm;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use serde::Serialize;
use serde_json::json;
use slopmax_api::tailnet::{Access, TailnetView};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::account::{Account, Store};
use crate::auth::{self, RefreshError};
use crate::config::{ClientKey, Config};
use crate::ledger::Ledger;
use crate::log;
use crate::net::body;
use crate::net::server::{Channel, Request, Response};
use crate::net::{Client, Origins};
use crate::paths::Home;
use crate::pool::{Pool, Routing, State as PoolState};
use crate::provider::ProviderId;
use crate::provider::credits::Outcome;
use crate::report::{self, Report};
use crate::tailscale::{LazyWhois, Tailscale, Whois};
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;
use tailnet::Seen;

/// A background task, boxed to share one task type.
pub type BoxedTask = std::pin::Pin<Box<dyn Future<Output = ()> + Send>>;

/// Shared state for request handlers and background tasks.
pub struct App {
    /// The config, swapped whole when config.toml changes.
    config: RwLock<Arc<Config>>,
    /// The slopmax directory this proxy reads and writes.
    pub home: Home,
    pub store: Store,
    pub pool: Pool,
    /// Inference traffic: long-lived streams, so only a stall timeout.
    http: Client,
    /// OAuth and usage calls, with bounded timeouts.
    pub auth_http: Client,
    /// Cancelled when the daemon stops: by a signal or `POST
    /// /slopmax/shutdown`. Background loops and event streams end on it.
    pub stop: CancellationToken,
    /// The background work the daemon waits for when it stops.
    pub tasks: TaskTracker,
    /// Held while redeeming a reset credit, so concurrent requests that
    /// all find the pool spent redeem one credit, not one each.
    pub redeeming: tokio::sync::Mutex<()>,
    /// Held while polling every account on request, so callers that ask
    /// at once share one poll.
    refreshing: tokio::sync::Mutex<()>,
    /// Where answered requests are recorded for `slopmax usage`.
    pub ledger: Ledger,
    /// The last month of the ledger by hour, for histories, once one is
    /// asked for.
    pub hours: crate::history::index::Kept,
    /// The last week of the pools' quota readings and of what each account
    /// served, once a pool's detail is asked for.
    pub quota: crate::quota::Kept,
    /// The reading last written of each pool, to write only what changed.
    quota_written: Mutex<HashMap<ProviderId, crate::quota::Sample>>,
    /// Reasoning state kept between turns of translated conversations.
    replay: Mutex<transcode::Replay>,
    /// Each account's model list, and when it was read.
    catalogs: Mutex<HashMap<String, (Instant, Vec<String>)>>,
    /// When each account was last warmed.
    warmed: Mutex<HashMap<String, Instant>>,
    /// config.toml as last read, to tell when it changes.
    config_text: Mutex<Option<String>>,
    /// The account files as last read, to tell when they change.
    seen: Mutex<Option<u64>>,
    /// The API's event stream, as server-sent event frames: each request
    /// answered and each sign-in's progress.
    pub api_events: broadcast::Sender<Bytes>,
    /// Sign-ins started through the API, by id.
    logins: Mutex<HashMap<String, api::Login>>,
    /// Asked to stop so the service manager starts it again.
    pub restart: std::sync::atomic::AtomicBool,
    /// Moving to another binary ([`crate::handoff`]): set while it starts,
    /// and for good once it serves.
    pub handing_off: std::sync::atomic::AtomicBool,
    /// Set while handing off: the state is no longer this process's to save.
    pub frozen: std::sync::atomic::AtomicBool,
    /// The listener and lock a handoff passes on, once serving.
    pub handles: std::sync::OnceLock<crate::handoff::Handles>,
    /// The process the proxy was handed to, and whether systemd adopted it.
    pub successor: Mutex<Option<(u32, bool)>>,
    /// Handed on, to a successor or to launchd's process making this one
    /// make way: what this one holds drains as its clients finish.
    pub handed_over: std::sync::atomic::AtomicBool,
    /// The home's serve lock while this process serves the home. Let go of
    /// early when this one makes way ([`crate::handoff::make_way`]).
    pub serving: Mutex<Option<std::fs::File>>,
    /// launchd started this process: it keeps the listening socket, and
    /// starts the service's binary again once this process exits.
    pub launchd: std::sync::atomic::AtomicBool,
    /// The listening socket is launchd's, whoever started this process.
    pub launchd_socket: std::sync::atomic::AtomicBool,
    /// Cancelled when a handed-off daemon should stop draining: the new
    /// process stopped, or this one was signalled.
    pub cut: CancellationToken,
    /// Cancelled once the proxy's TCP listener takes no more connections.
    pub let_go: CancellationToken,
    /// The exit code of the process the proxy was handed to, once it ended.
    pub successor_exit: Mutex<Option<i32>>,
    /// The binary this daemon runs, to notice a newer one installed.
    pub running: Option<crate::handoff::Running>,
    /// A release newer than this binary, as the last lookup found.
    release: Mutex<Option<String>>,
    /// What looking for a newer install has seen.
    pub install_seen: tokio::sync::Mutex<crate::handoff::Seen>,
    /// The machines behind the tailnet addresses requests came from.
    pub(crate) peers: tailnet::Peers,
    /// How Tailscale is asked who is at an address, and what it publishes.
    tailscale: RwLock<Tailnet>,
    /// `/slopmax/api/tailnet` as last read from Tailscale, and when.
    pub(crate) tailnet_view: Mutex<Option<(Instant, TailnetView)>>,
}

/// How the daemon asks Tailscale what it needs to know: which machine is
/// at a tailnet address, and what the hub publishes. By default the real
/// `tailscale` command, found when first needed; tests give fakes, so no
/// test runs it.
#[derive(Clone)]
pub struct Tailnet {
    /// Which machine is at a tailnet address.
    pub whois: Arc<dyn Whois>,
    /// The `tailscale` command, looked for each time slopmax reads what it
    /// publishes; `None` when there is none.
    pub cli: Arc<dyn Fn() -> Option<Tailscale> + Send + Sync>,
}

impl Default for Tailnet {
    fn default() -> Self {
        Self {
            whois: Arc::new(LazyWhois::default()),
            cli: Arc::new(|| Tailscale::find().ok()),
        }
    }
}

impl App {
    /// `origins` reroutes provider URLs; tests point them at a mock.
    pub fn new(config: Config, home: Home, state: PoolState, origins: Origins) -> Arc<Self> {
        let store = Store::at(home.accounts());
        let ledger = Ledger::at(home.usage());
        let config_text = std::fs::read_to_string(home.config()).ok();
        let release = crate::update::Checked::read(&home)
            .and_then(|c| c.newer())
            .map(|v| v.to_string());
        let http = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(600))
            .origins(origins.clone())
            .build();
        let pool = Pool::new(
            config.strategy,
            SignedDuration::from_mins(config.session_ttl_mins as i64),
            state,
        );
        pool.set_routing(Routing::of(&config));
        Arc::new(Self {
            config: RwLock::new(Arc::new(config)),
            home,
            store,
            pool,
            http,
            auth_http: crate::auth::http_client(origins),
            stop: CancellationToken::new(),
            tasks: TaskTracker::new(),
            redeeming: tokio::sync::Mutex::new(()),
            refreshing: tokio::sync::Mutex::new(()),
            ledger,
            hours: Default::default(),
            quota: Default::default(),
            quota_written: Default::default(),
            replay: Default::default(),
            catalogs: Default::default(),
            warmed: Default::default(),
            config_text: Mutex::new(config_text),
            seen: Mutex::default(),
            api_events: broadcast::channel(256).0,
            logins: Mutex::default(),
            restart: std::sync::atomic::AtomicBool::new(false),
            handing_off: std::sync::atomic::AtomicBool::new(false),
            frozen: std::sync::atomic::AtomicBool::new(false),
            handles: std::sync::OnceLock::new(),
            successor: Mutex::default(),
            handed_over: std::sync::atomic::AtomicBool::new(false),
            serving: Mutex::default(),
            launchd: std::sync::atomic::AtomicBool::new(false),
            launchd_socket: std::sync::atomic::AtomicBool::new(false),
            cut: CancellationToken::new(),
            let_go: CancellationToken::new(),
            successor_exit: Mutex::default(),
            running: crate::handoff::Running::now(),
            release: Mutex::new(release),
            install_seen: Default::default(),
            peers: tailnet::Peers::default(),
            tailscale: RwLock::new(Tailnet::default()),
            tailnet_view: Mutex::default(),
        })
    }

    /// Asks Tailscale through `tailnet` from now on.
    pub fn set_tailnet(&self, tailnet: Tailnet) {
        *self.tailscale.write().unwrap_or_else(|p| p.into_inner()) = tailnet;
    }

    /// Asks `whois` from now on which machine is at a tailnet address.
    pub fn set_whois(&self, whois: Arc<dyn Whois>) {
        self.tailscale
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .whois = whois;
    }

    /// What answers which machine is at a tailnet address.
    pub(crate) fn whois(&self) -> Arc<dyn Whois> {
        self.tailscale
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .whois
            .clone()
    }

    /// The `tailscale` command, if there is one.
    pub(crate) fn tailscale_cli(&self) -> Option<Tailscale> {
        let find = self
            .tailscale
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .cli
            .clone();
        find()
    }

    /// Runs `task` in the background, as work the daemon finishes before it
    /// stops.
    pub fn spawn(&self, task: impl Future<Output = ()> + Send + 'static) {
        // Boxed, so every caller shares one copy of the task machinery.
        let task: BoxedTask = Box::pin(task);
        self.tasks.spawn(task);
    }

    /// The config as it stands.
    pub fn config(&self) -> Arc<Config> {
        self.config
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Applies a changed config to requests from now on. The address, the
    /// upstream proxy, and which background tasks run are set at start, so
    /// changing those needs a restart; everything else applies at once.
    pub fn set_config(&self, config: Config) {
        self.pool.set_routing(Routing::of(&config));
        *self.config.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(config);
    }

    /// Applies config.toml if it changed since it was last read. A config
    /// that does not parse is logged and left unapplied.
    pub fn reload_config(&self) {
        let Ok(text) = std::fs::read_to_string(self.home.config()) else {
            return;
        };
        let mut seen = self.config_text.lock().unwrap_or_else(|p| p.into_inner());
        if seen.as_deref() == Some(text.as_str()) {
            return;
        }
        match Config::from_toml(&text) {
            Ok(mut config) => {
                let current = self.config();
                // Bound at start: the listener stays where it is.
                config.listen = current.listen;
                if config.api_key.is_empty() {
                    config.api_key.clone_from(&current.api_key);
                }
                log::info!("config.toml changed; applying it");
                self.set_config(config);
            }
            Err(e) => log::warn!("config.toml is invalid, keeping the last good one: {e}"),
        }
        *seen = Some(text);
    }

    /// Reloads the accounts from disk, picking up logins, removals and
    /// refreshed tokens from other processes.
    pub fn sync(&self) -> Result<()> {
        let seen = self.fingerprint();
        let accounts = self.store.list()?;
        self.pool.sync(accounts);
        *self.seen.lock().unwrap_or_else(|p| p.into_inner()) = seen;
        Ok(())
    }

    /// Reloads the accounts if a file changed since they were last read, which costs a directory listing and a stat per file otherwise.
    pub fn rescan(&self) -> Result<()> {
        let now = self.fingerprint();
        if now.is_some() && now == *self.seen.lock().unwrap_or_else(|p| p.into_inner()) {
            return Ok(());
        }
        self.sync()
    }

    /// The names, sizes and modification times of the account files,
    /// hashed: what changes when another process writes one.
    fn fingerprint(&self) -> Option<u64> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::hash::DefaultHasher::new();
        let stat = |path: &std::path::Path, hasher: &mut std::hash::DefaultHasher| {
            match std::fs::metadata(path) {
                Ok(meta) => (meta.len(), meta.modified().ok()).hash(hasher),
                Err(_) => 0u8.hash(hasher),
            }
        };
        let mut names: Vec<_> = match std::fs::read_dir(self.store.dir()) {
            Ok(listing) => listing.filter_map(|e| e.ok()).map(|e| e.path()).collect(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(_) => return None,
        };
        names.sort();
        for path in names
            .iter()
            .filter(|p| p.extension().is_some_and(|x| x == "toml" || x == "json"))
        {
            path.hash(&mut hasher);
            stat(path, &mut hasher);
        }
        Some(hasher.finish())
    }

    /// The account with current credentials, or `None` if it cannot be used.
    /// The pool's copy is current: refreshes here put their tokens back into
    /// it, and changes from other processes arrive with [`App::sync`], so a
    /// request reads no files unless its token is due.
    pub async fn ready(&self, picked: &Account) -> Option<Arc<Account>> {
        // The pool's own copy, shared; a copy of `picked` only when it was
        // removed meanwhile.
        let account = self
            .pool
            .account(&picked.id)
            .unwrap_or_else(|| Arc::new(picked.clone()));
        // Another process may have found its sign-in revoked; trying it
        // would cost a refusal and a refresh.
        if let Some(error) = &account.auth_error {
            self.pool.record_error(&account.id, error);
            return None;
        }
        // Following a linked account's source is read-only, so it happens
        // even when refreshing is off.
        if !self.config().refresh_tokens && account.link.is_none() {
            return Some(account);
        }
        // Not due, as nearly always: the pool's own copy serves.
        if !auth::due(&account, Timestamp::now()) {
            return Some(account);
        }
        match auth::ensure_fresh(&self.auth_http, &self.store, &account, false).await {
            Ok(fresh) => {
                self.adopt(&account, &fresh);
                Some(Arc::new(fresh))
            }
            Err(RefreshError::Transient(e)) if !account.tokens.is_expired(Timestamp::now()) => {
                log::warn!("{}: refresh failed, using current token: {e:#}", account.id);
                Some(account)
            }
            Err(e) => {
                log::warn!("{}: {e}", account.id);
                self.refresh_failed(&account, &e);
                None
            }
        }
    }

    /// Records a failed refresh. A revoked sign-in is marked on the pool's
    /// copy too, as the refresh marked the stored one, so no request tries
    /// it again.
    pub fn refresh_failed(&self, account: &Account, error: &RefreshError) {
        self.pool.record_error(&account.id, &error.to_string());
        if let RefreshError::Revoked(reason) = error {
            let mut revoked = account.clone();
            revoked.auth_error = Some(reason.clone());
            self.pool.put(&revoked);
        }
    }

    /// Keeps the tokens of a refreshed account for the requests after it.
    pub fn adopt(&self, held: &Account, fresh: &Account) {
        if fresh.tokens.access_token != held.tokens.access_token
            || fresh.auth_error != held.auth_error
        {
            self.pool.put(fresh);
        }
    }

    /// Puts the pool's usage windows in place of the serving account's in
    /// response headers, so the agent sees its provider's accounts as one.
    pub(crate) fn show_pool(&self, provider: ProviderId, headers: &mut HeaderMap) {
        if !provider.spec().is_subscription() {
            return;
        }
        let Some(pooled) = self.pool.pooled_headers(provider, Timestamp::now()) else {
            return;
        };
        provider.get().strip_standing(headers);
        for (name, value) in pooled.iter() {
            headers.insert(name.clone(), value.clone());
        }
    }

    /// Builds the indexes kept of the ledger, the history's and the
    /// pools', so the first page that asks for them needs no wait. Blocks:
    /// for a blocking thread. A page that asks meanwhile waits for this
    /// build rather than starting its own.
    pub fn warm_indexes(&self) {
        let now = Timestamp::now();
        let usage = self.home.usage();
        self.hours
            .build(&usage, &self.home.windows(), now, |start| {
                self.ledger.mark(start)
            });
        self.quota
            .build(&usage, now, &self.config().prices, |start| {
                self.ledger.mark(start)
            });
    }

    /// What went through over `range`, by display name, from the index
    /// kept of the ledger: built as the daemon starts, or else the first
    /// time it is asked for.
    pub async fn history(
        self: &Arc<Self>,
        range: crate::history::Range,
    ) -> crate::history::History {
        let app = Arc::clone(self);
        crate::blocking::run(move || {
            let names: HashMap<String, String> = app
                .pool
                .accounts()
                .iter()
                .map(|a| (a.id.clone(), a.name()))
                .collect();
            let config = app.config();
            let prices = crate::history::Prices::of(&config);
            let now = Timestamp::now();
            if let Some(history) = app.hours.history(range, now, &prices, &names) {
                return history;
            }
            app.hours
                .build(&app.home.usage(), &app.home.windows(), now, |start| {
                    app.ledger.mark(start)
                });
            app.hours
                .history(range, now, &prices, &names)
                .unwrap_or_else(|| crate::history::load(&app.home, range, now, &prices, &names))
        })
        .await
    }

    /// A page of the ledger's requests from `since` on: the totals counted
    /// from the index kept of the ledger, built the first time, and the rows
    /// read from the hours they are in.
    pub async fn requests(
        self: &Arc<Self>,
        query: crate::browse::Query,
        range: slopmax_api::ledger::HistoryRange,
        since: Timestamp,
    ) -> slopmax_api::ledger::RequestPage {
        let app = Arc::clone(self);
        crate::blocking::run(move || {
            let (config, usage) = (app.config(), app.home.usage());
            let now = Timestamp::now();
            // Counted while no request is written, and the ledger's
            // lengths then: the rows read are the ones counted.
            let count = || {
                let mut tally = None;
                let lengths = app.ledger.mark(&mut || {
                    tally = app.hours.requests(&query, since, now, &config.prices);
                });
                tally.map(|tally| (tally, lengths))
            };
            let counted = count().or_else(|| {
                app.hours.build(&usage, &app.home.windows(), now, |start| {
                    app.ledger.mark(start)
                });
                count()
            });
            match counted {
                Some((tally, lengths)) => {
                    let rows = crate::browse::rows(&usage, &query, &tally, &lengths);
                    crate::browse::tallied(tally, &rows, &query, range, since, &config.prices)
                }
                None => {
                    let entries = crate::ledger::read(&usage, since);
                    crate::browse::page(&entries, &query, range, since, &config.prices)
                }
            }
        })
        .await
    }

    /// Reads each pool's quota and writes the readings that changed, or
    /// that were last written an hour ago, to the ledger.
    pub fn sample_quota(&self) {
        let now = Timestamp::now();
        let samples = crate::quota::sample(&self.report(), now);
        let mut written = self.quota_written.lock().unwrap_or_else(|p| p.into_inner());
        let due = crate::quota::due(samples, &written);
        if due.is_empty() {
            return;
        }
        self.ledger
            .record_samples_then(&due, |due| self.quota.sampled(due));
        for sample in due {
            written.insert(sample.provider, sample);
        }
    }

    /// `provider`'s pool over time, from the readings and spending kept:
    /// read from the ledger once, the first time. `None` when it has no
    /// working account.
    pub async fn pool_detail(
        self: &Arc<Self>,
        provider: ProviderId,
    ) -> Option<slopmax_api::pools::PoolDetail> {
        let app = Arc::clone(self);
        crate::blocking::run(move || {
            let report = app.report();
            let now = Timestamp::now();
            if let Some(detail) = app.quota.detail(provider, &report, now) {
                return detail;
            }
            let config = app.config();
            app.quota
                .build(&app.home.usage(), now, &config.prices, |start| {
                    app.ledger.mark(start)
                });
            app.quota.detail(provider, &report, now).flatten()
        })
        .await
    }

    /// The model Codex asked for last.
    pub(crate) fn last_codex_model(&self) -> Option<String> {
        self.pool.codex().model
    }

    /// Writes a finished request to the usage ledger, tells the dashboard's
    /// live feed about it, and remembers the model of a Codex one.
    pub fn record(&self, entry: &crate::ledger::Entry) {
        let config = self.config();
        self.ledger.record_then(entry, |entry| {
            self.hours.add(entry);
            self.quota.add(entry, &config.prices);
        });
        if entry.provider == ProviderId::Codex
            && let Some(model) = &entry.model
        {
            self.pool.saw_codex_model(model);
        }
        // An agent's housekeeping is no request the feed lists.
        if self.api_events.receiver_count() > 0 && (entry.answered() || entry.failed()) {
            let event = slopmax_api::events::Event::Request {
                record: slopmax_api::ledger::LedgerRecord::Request(crate::api::record(entry)),
            };
            let _ = self.api_events.send(event.frame().into());
        }
    }

    /// Polls every account's usage and lists its limit resets now. A
    /// caller that asks while a poll runs waits for that one instead of
    /// starting another, and sees what it found.
    pub async fn refresh(self: &Arc<Self>) {
        match self.refreshing.try_lock() {
            Ok(_polling) => {
                crate::poll_all(self, true).await;
                crate::list_credits(self, true).await;
            }
            Err(_) => drop(self.refreshing.lock().await),
        }
    }

    /// The status report in the API's types.
    pub fn api_report(&self) -> slopmax_api::report::Report {
        let mut report = crate::api::report(&self.report(), &self.config(), Timestamp::now());
        report.update = self.newer_release();
        report
    }

    /// The newer release the last lookup found, and how this install takes
    /// it.
    fn newer_release(&self) -> Option<slopmax_api::report::UpdateView> {
        let version = self
            .release
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()?;
        let command = self
            .running
            .as_ref()
            .map_or_else(|| "slopmax update".to_owned(), |r| r.update_command());
        Some(slopmax_api::report::UpdateView { version, command })
    }

    /// Notes the newest release, as `look_for_releases` found it.
    pub fn saw_release(&self, checked: &crate::update::Checked) {
        *self.release.lock().unwrap_or_else(|p| p.into_inner()) =
            checked.newer().map(|v| v.to_string());
    }

    pub fn report(&self) -> Report {
        let now = Timestamp::now();
        report::build(
            // A report owns its accounts; it is built only when asked for.
            self.pool
                .accounts()
                .iter()
                .map(|a| Account::clone(a))
                .collect(),
            |id| self.pool.state(id),
            &self.pool.pins(),
            &self.pool.session_counts(now),
            self.config().strategy,
            true,
            now,
        )
        .with_next(&self.pool, now)
    }
}

/// Why a limit reset someone asked for was not redeemed.
#[derive(Debug)]
pub(crate) enum RedeemError {
    /// The account's provider grants none.
    NoResets,
    SignedOut,
    /// Listing or redeeming failed at the provider.
    Failed(anyhow::Error),
}

impl App {
    /// Redeems a limit reset someone asked for, through slopmax's API or a
    /// hub client: `credit`, or the one that expires soonest. `request` is
    /// the asker's idempotency key, when it sends one.
    pub(crate) async fn redeem(
        &self,
        account: &Account,
        credit: Option<&str>,
        request: Option<&str>,
    ) -> Result<Outcome, RedeemError> {
        let Some(credits) = account.provider.get().credits() else {
            return Err(RedeemError::NoResets);
        };
        let _redeeming = self.redeeming.lock().await;
        let account = self.ready(account).await.ok_or(RedeemError::SignedOut)?;
        let agent = self.pool.agent(account.provider);
        let credit = match credit {
            Some(credit) => credit.to_owned(),
            None => {
                let listed = credits
                    .list(&self.auth_http, &account, agent.as_deref())
                    .await
                    .map_err(RedeemError::Failed)?;
                let soonest = listed.first().map(|c| c.id.clone());
                self.pool
                    .record_credits(&account.id, listed, Timestamp::now());
                match soonest {
                    Some(credit) => credit,
                    None => return Ok(Outcome::NoCredit),
                }
            }
        };
        let outcome = credits
            .redeem(
                &self.auth_http,
                &account,
                agent.as_deref(),
                Some(&credit),
                request,
            )
            .await
            .map_err(RedeemError::Failed)?;
        if outcome == Outcome::Reset {
            log::info!("{}: redeemed a limit reset on request", account.id);
            self.pool
                .record_reset(&account.id, Timestamp::now(), Some(&credit));
        }
        Ok(outcome)
    }
}

/// Answers one request: slopmax's own endpoints, else the proxy.
pub async fn handle(app: Arc<App>, mut request: Request) -> Response {
    if request
        .uri()
        .path()
        .starts_with(crate::tailscale::PRIVATE_PREFIX)
    {
        let private = crate::tailscale::private_path(&app.config().api_key);
        tailnet::route(&mut request, &private);
    }
    let seen = tailnet::take(&mut request);
    // Funnel opens the port to the internet, and slopmax serves the user's
    // own machines only: nothing is answered, not even the page.
    if seen.funnel {
        return refuse(&Denied::Funnel(funnel_port(&seen, &app.config())), None);
    }
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/healthz") => health(&app, request.headers(), &seen).await,
        // Claude Code's unauthenticated connectivity check; HEAD probes alike.
        (_, "/api/hello") | (&Method::HEAD, _) => empty_reply(StatusCode::OK),
        (_, path) if path.starts_with("/slopmax/api/") => api::handle(app, request, &seen).await,
        (&Method::GET, "/slopmax" | "/slopmax/dashboard") => ui::to_page(),
        (&Method::GET, path) if path.strip_prefix("/slopmax/").is_some_and(ui::serves) => {
            ui::answer(&path["/slopmax/".len()..], request.headers())
        }
        (_, path) if path.starts_with("/slopmax/") => error(
            None,
            StatusCode::NOT_FOUND,
            "no such slopmax endpoint; slopmax's API is under /slopmax/api",
        ),
        (_, path) if path.starts_with("/v0/management/") => hub::handle(app, request, &seen).await,
        (&Method::GET, "/v1/models")
            if models::wants_list(request.headers(), request.uri().query().unwrap_or("")) =>
        {
            let config = app.config();
            let headers = request.headers();
            match caller(&app, &config, headers, &seen, Access::Use).await {
                Ok(caller) => models::list(&app, caller.who().key.as_ref()).await,
                Err(denied) => refuse(&denied, Some(Dialect::Chat)),
            }
        }
        _ => proxy(app, request, &seen).await,
    }
}

/// Who serves: the program, its version and, to programs on this machine,
/// its process. A request that carries a key or a token also learns what it
/// may do (`access`), who slopmax takes it for (`login`, `machine`), and
/// whether its key is this proxy's owner key, so a front end can tell a
/// proxy started from another home (or before the key changed) from its
/// own; the key itself is never answered.
async fn health(app: &Arc<App>, headers: &HeaderMap, seen: &Seen) -> Response {
    let mut body = json!({
        "status": "ok",
        "service": "slopmax",
        "version": env!("CARGO_PKG_VERSION"),
    });
    let local = seen.channel == Channel::Tcp;
    if local {
        body["pid"] = json!(std::process::id());
    }
    body["via"] = json!(if local { "local" } else { "tailnet" });
    if has_credential(headers) {
        let config = app.config();
        body["owner"] = json!(matches!(by_key(&config, headers), Some(Caller::Owner)));
        // Asked of whois now: this is where a machine learns the most it
        // may do.
        match identify(app, &config, headers, seen, true, Access::Admin).await {
            Ok(caller) => {
                body["access"] = json!(caller.access());
                match &caller {
                    Caller::Member { login, machine, .. } => {
                        body["login"] = json!(login);
                        if let Some(machine) = machine {
                            body["machine"] = json!(machine);
                        }
                    }
                    Caller::Client(key) => body["machine"] = json!(key.name),
                    Caller::Owner => {}
                }
            }
            Err(_) => body["access"] = json!(Access::None),
        }
    }
    json_reply(StatusCode::OK, &body)
}

async fn proxy(app: Arc<App>, request: Request, seen: &Seen) -> Response {
    let path_and_query = request.uri().path_and_query().map_or("/", |pq| pq.as_str());
    let Some(target) = route(path_and_query, request.headers()) else {
        return error(
            None,
            StatusCode::NOT_FOUND,
            "unknown path; slopmax serves /v1/*, /claude/*, /codex/*, and /grok/*",
        );
    };
    let dialect = target.dialect;
    let who = {
        let config = app.config();
        let headers = request.headers();
        match caller(&app, &config, headers, seen, Access::Use).await {
            Ok(caller) => caller.who(),
            Err(denied) => return refuse(&denied, Some(dialect)),
        }
    };
    if let Some(version) = crate::provider::codex::wire::client_version(request.headers()) {
        app.pool.saw_codex_version(&version);
    }
    if let Some(agent) = crate::provider::claude::wire::client_agent(request.headers()) {
        app.pool.saw_agent(ProviderId::Claude, agent);
    }
    // Codex's sockets are relayed when they can be; refusing a handshake
    // with 426 makes Codex stream over HTTP at once instead of retrying.
    if is_websocket(request.headers()) {
        return socket::accept(app, target, request, &who, seen).await;
    }
    forward::forward(app, target, request, who).await
}

/// Where a request goes, judged from its path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    /// The provider whose API the path belongs to, if any. It serves the
    /// request unless the model routes it elsewhere.
    pub provider: Option<ProviderId>,
    /// The path to forward, relative to the API's base URL.
    pub path: String,
    /// The format the client speaks.
    pub dialect: Dialect,
    /// Whether the model in the body picks the provider.
    pub by_model: bool,
}

fn is_websocket(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

fn json_reply(status: StatusCode, value: &impl Serialize) -> Response {
    let body = serde_json::to_vec(value).expect("replies serialize");
    let mut response = Response::new(body::full(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn empty_reply(status: StatusCode) -> Response {
    let mut response = Response::new(body::empty());
    *response.status_mut() = status;
    response
}

/// Maps a request path to its target.
fn route(path_and_query: &str, headers: &HeaderMap) -> Option<Target> {
    let strip = |prefix: &str| {
        path_and_query
            .strip_prefix(prefix)
            .filter(|rest| rest.is_empty() || rest.starts_with(['/', '?']))
    };
    let starts = |path: &str, prefix: &str| {
        path.split('?')
            .next()
            .unwrap_or_default()
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    };
    let claude = |path: String| Target {
        provider: Some(ProviderId::Claude),
        by_model: starts(&path, "/v1/messages"),
        dialect: Dialect::Messages,
        path,
    };
    let codex = |path: String| Target {
        provider: Some(ProviderId::Codex),
        by_model: starts(&path, "/responses"),
        dialect: Dialect::Responses,
        path,
    };
    if let Some(rest) = strip("/claude") {
        return Some(claude(rest.to_owned()));
    }
    if let Some(rest) = strip("/codex") {
        return Some(codex(rest.to_owned()));
    }
    // Grok Build's CLI chat proxy: model work over Responses (or Chat for
    // models that ask for it), and the plan's settings, models and billing.
    if let Some(rest) = strip("/grok") {
        let chat = starts(rest, "/v1/chat/completions");
        return Some(Target {
            provider: Some(ProviderId::Grok),
            by_model: chat || starts(rest, "/v1/responses"),
            dialect: if chat {
                Dialect::Chat
            } else {
                Dialect::Responses
            },
            path: rest.strip_prefix("/v1").unwrap_or(rest).to_owned(),
        });
    }
    // Unprefixed /v1 paths, as an OpenAI- or Anthropic-style base URL sends.
    let rest = strip("/v1")?;
    if starts(rest, "/chat/completions") {
        return Some(Target {
            provider: None,
            path: rest.to_owned(),
            dialect: Dialect::Chat,
            by_model: true,
        });
    }
    let path = rest.split('?').next().unwrap_or_default();
    let is_codex = path.starts_with("/responses")
        || (path == "/models"
            && rest.contains("client_version=")
            && !headers.contains_key("anthropic-version"));
    Some(if is_codex {
        codex(rest.to_owned())
    } else {
        // `/v1` and the rest: the path as it came.
        claude(path_and_query.to_owned())
    })
}

/// Who a request comes from: a key it presents, or the tailnet login
/// tailscaled named.
#[derive(Debug, Clone)]
pub(crate) enum Caller<'a> {
    /// The owner's `api_key`.
    Owner,
    /// One of the config's client keys.
    Client(&'a ClientKey),
    /// A machine of a login in `[tailscale] users`, over the tailnet.
    Member {
        login: String,
        /// The machine's name, once whois has told it.
        machine: Option<String>,
        access: Access,
    },
}

impl Caller<'_> {
    /// What it may do.
    pub fn access(&self) -> Access {
        match self {
            Self::Owner => Access::Admin,
            Self::Client(_) => Access::Use,
            Self::Member { access, .. } => *access,
        }
    }

    /// What its requests are recorded under, and the key that holds it to
    /// some models.
    pub fn who(&self) -> Who {
        match self {
            Self::Owner => Who::default(),
            Self::Client(key) => Who {
                label: Some(key.name.clone()),
                key: Some((*key).clone()),
            },
            Self::Member { login, machine, .. } => Who {
                label: Some(machine.clone().unwrap_or_else(|| login.clone())),
                key: None,
            },
        }
    }
}

/// Who sent a request the proxy serves.
#[derive(Debug, Clone, Default)]
pub(crate) struct Who {
    /// What the ledger records as its machine: the client key's name, else
    /// the tailnet machine's, else the login; `None` for the owner key,
    /// which is this machine's own.
    pub label: Option<String>,
    /// The client key it came with, if any.
    pub key: Option<ClientKey>,
}

/// The key a request presents, as a bearer token or `x-api-key`.
fn by_key<'a>(config: &'a Config, headers: &HeaderMap) -> Option<Caller<'a>> {
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        });
    let key = bearer
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))?
        .trim()
        .as_bytes();
    if constant_time_eq(key, config.api_key.as_bytes()) {
        return Some(Caller::Owner);
    }
    config
        .keys
        .iter()
        .find(|k| constant_time_eq(key, k.key.as_bytes()))
        .map(Caller::Client)
}

/// Whether the request carries a key or token of any kind, as agents and
/// slopmax's page send, and another site's script cannot without asking.
fn has_credential(headers: &HeaderMap) -> bool {
    headers.contains_key(header::AUTHORIZATION) || headers.contains_key("x-api-key")
}

/// Why a request is refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Denied {
    /// It came through Tailscale Funnel, on this port.
    Funnel(u16),
    /// A tailnet login, with no token at all.
    NoCredential,
    /// A tailnet login, from another site's page.
    CrossSite,
    /// A tailnet login not in `[tailscale] users`.
    NotAllowed(String),
    /// A tagged machine, with no key.
    Tagged,
    /// No key, or a wrong one.
    NoKey,
    /// A caller allowed less than the request needs.
    Needs {
        need: Access,
        /// The machine's name, when known.
        machine: Option<String>,
        /// The client key it came with, which reaches the proxy only.
        key: Option<String>,
    },
}

impl Denied {
    /// The status and message it goes out with.
    pub fn answer(&self) -> (StatusCode, String) {
        match self {
            Self::Funnel(port) => (
                StatusCode::FORBIDDEN,
                format!(
                    "slopmax serves your tailnet only; turn Funnel off: tailscale funnel --https={port} off"
                ),
            ),
            Self::NoCredential => (
                StatusCode::UNAUTHORIZED,
                "send a token with the request (any value, e.g. Authorization: Bearer tailnet); \
                 agents set up with `slopmax setup --hub` send one"
                    .to_owned(),
            ),
            Self::CrossSite => (
                StatusCode::FORBIDDEN,
                "requests from other sites can't use your tailnet identity".to_owned(),
            ),
            Self::NotAllowed(login) => (
                StatusCode::UNAUTHORIZED,
                format!(
                    "{login} isn't allowed on this slopmax; on the hub: slopmax tailscale user add {login}"
                ),
            ),
            Self::Tagged => (
                StatusCode::UNAUTHORIZED,
                "tagged machines need a key: on the hub, run slopmax key add <name>".to_owned(),
            ),
            Self::NoKey => (
                StatusCode::UNAUTHORIZED,
                "missing or invalid slopmax key; see `slopmax agent env`".to_owned(),
            ),
            Self::Needs { key: Some(key), .. } => (
                StatusCode::FORBIDDEN,
                format!("the key {key:?} reaches the proxy only, not slopmax's own API"),
            ),
            Self::Needs { need, machine, .. } => {
                let what = match need {
                    Access::Admin => "this machine may not change slopmax",
                    _ => "this machine may use slopmax but not see its accounts",
                };
                let machine = machine.as_deref().unwrap_or("<machine>");
                (
                    StatusCode::FORBIDDEN,
                    format!("{what}; on the hub: slopmax tailscale admin add {machine}"),
                )
            }
        }
    }
}

/// The port Funnel reaches slopmax on, as the request was addressed: what
/// `tailscale funnel --https=<port> off` needs.
fn funnel_port(seen: &Seen, config: &Config) -> u16 {
    let addressed = seen.origin_host.as_deref().map(|host| {
        match host
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse().ok())
        {
            Some(port) => port,
            None if seen.proto.as_deref() == Some("http") => 80,
            None => 443,
        }
    });
    addressed.unwrap_or(config.listen.port())
}

/// Who sent a request, as far as is told without asking Tailscale.
enum Known<'a, 's> {
    /// A key.
    Key(Caller<'a>),
    /// A tailnet login slopmax takes.
    Login(&'s str),
}

/// The part of [`caller`] that asks nothing of Tailscale, which an open
/// event stream runs again as the config changes.
fn known<'a, 's>(
    config: &'a Config,
    headers: &HeaderMap,
    seen: &'s Seen,
) -> Result<Known<'a, 's>, Denied> {
    if seen.funnel {
        return Err(Denied::Funnel(funnel_port(seen, config)));
    }
    // A key is not ambient, so it needs no browser check: a page cannot
    // send one it doesn't have.
    if let Some(caller) = by_key(config, headers) {
        return Ok(Known::Key(caller));
    }
    let on_tailnet = seen.channel == Channel::Tailnet;
    if on_tailnet
        && !config.tailnet_users().is_empty()
        && let Some(login) = seen.login.as_deref()
    {
        if !has_credential(headers) {
            return Err(Denied::NoCredential);
        }
        if !tailnet::browser_ok(headers, seen) {
            return Err(Denied::CrossSite);
        }
        if !config.allows_login(login) {
            return Err(Denied::NotAllowed(login.to_owned()));
        }
        return Ok(Known::Login(login));
    }
    // A login on the tailnet with no list to be on, as after the last
    // user is removed, hears how to let it in rather than to find a key.
    Err(match (on_tailnet, seen.login.as_deref()) {
        (true, None) => Denied::Tagged,
        (true, Some(login)) => Denied::NotAllowed(login.to_owned()),
        (false, _) => Denied::NoKey,
    })
}

/// The tailnet login a client key came with, when slopmax takes it: a
/// machine set up with `slopmax setup --hub` sends its key, and may also do
/// what its login may.
pub(crate) fn login_beside_key<'s>(
    config: &Config,
    headers: &HeaderMap,
    seen: &'s Seen,
) -> Option<&'s str> {
    let login = seen.login.as_deref()?;
    (seen.channel == Channel::Tailnet
        && !config.tailnet_users().is_empty()
        && tailnet::browser_ok(headers, seen)
        && config.allows_login(login))
    .then_some(login)
}

/// Who sent a request, for what it `need`s. A tailnet login may use and
/// see slopmax; its machine may also manage it when whois says the machine
/// is untagged, signed in as that login, and in `[tailscale] admins`. A
/// client key reaches the proxy only, so for more its machine is taken by
/// its login. With `resolve`, whois is asked now (for at most two
/// seconds); otherwise the machine is read from what is known and looked
/// up in the background, for the next request. A lookup that fails leaves
/// the machine able to see, not manage.
async fn identify<'a>(
    app: &Arc<App>,
    config: &'a Config,
    headers: &HeaderMap,
    seen: &Seen,
    resolve: bool,
    need: Access,
) -> Result<Caller<'a>, Denied> {
    let login = match known(config, headers, seen)? {
        Known::Key(caller @ Caller::Client(_)) if caller.access() < need => {
            match login_beside_key(config, headers, seen) {
                Some(login) => login,
                None => return Ok(caller),
            }
        }
        Known::Key(caller) => return Ok(caller),
        Known::Login(login) => login,
    };
    let machine = match seen.peer {
        Some(peer) if resolve => app.peers.resolve(app, peer, login).await.filter(|m| {
            m.login
                .as_deref()
                .is_some_and(|own| own.eq_ignore_ascii_case(login))
        }),
        Some(peer) => {
            app.peers.warm(app, peer, login);
            app.peers.cached(peer, login)
        }
        None => None,
    };
    Ok(Caller::Member {
        login: login.to_owned(),
        access: member_access(config, machine.as_ref()),
        machine: machine.map(|m| m.name),
    })
}

/// What a tailnet login allowed in may do from `machine` (as whois named
/// it, signed in as that login): manage slopmax when the machine is
/// untagged and in `[tailscale] admins`, else look.
fn member_access(config: &Config, machine: Option<&tailnet::Machine>) -> Access {
    let admin = machine.is_some_and(|m| !m.tagged && config.admin_ids().any(|id| id == m.id));
    if admin { Access::Admin } else { Access::View }
}

/// Who sent a request, if they may do what it `need`s.
pub(crate) async fn caller<'a>(
    app: &Arc<App>,
    config: &'a Config,
    headers: &HeaderMap,
    seen: &Seen,
    need: Access,
) -> Result<Caller<'a>, Denied> {
    // Only managing waits for whois, and only when some machine may.
    let resolve = need == Access::Admin && config.admin_ids().next().is_some();
    let caller = identify(app, config, headers, seen, resolve, need).await?;
    if caller.access() < need {
        return Err(Denied::Needs {
            need,
            key: caller.who().key.map(|k| k.name),
            machine: match caller {
                Caller::Member { machine, .. } => machine,
                _ => None,
            },
        });
    }
    Ok(caller)
}

/// A refusal in the shape the agent understands.
fn refuse(denied: &Denied, dialect: Option<Dialect>) -> Response {
    let (status, message) = denied.answer();
    error(dialect, status, &message)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An error in the shape the agent understands (Messages when unknown).
fn error(dialect: Option<Dialect>, status: StatusCode, message: &str) -> Response {
    let kind = match status.as_u16() {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        529 => "overloaded_error",
        s if s >= 500 => "api_error",
        _ => "invalid_request_error",
    };
    let body = dialect.unwrap_or(Dialect::Messages).error(kind, message);
    json_reply(status, &body)
}

/// A request's own say on session affinity: `x-slopmax-affinity: off`
/// places it by the strategy alone, `on` keeps it on its session's
/// account even when the config turns affinity off.
pub(crate) fn affinity(headers: &HeaderMap) -> Option<bool> {
    let value = headers.get("x-slopmax-affinity")?.to_str().ok()?.trim();
    match value.to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_prefixed_and_v1_paths() {
        let none = HeaderMap::new();
        let at = |path: &str| {
            let t = route(path, &none)?;
            Some((t.provider, t.path, t.dialect, t.by_model))
        };
        use Dialect::{Chat, Messages, Responses};
        use ProviderId::{Claude, Codex, Grok};
        assert_eq!(
            at("/claude/v1/messages?beta=true"),
            Some((
                Some(Claude),
                "/v1/messages?beta=true".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/claude/v1/messages/count_tokens"),
            Some((
                Some(Claude),
                "/v1/messages/count_tokens".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/codex/responses"),
            Some((Some(Codex), "/responses".into(), Responses, true))
        );
        assert_eq!(
            at("/codex/models?client_version=1"),
            Some((
                Some(Codex),
                "/models?client_version=1".into(),
                Responses,
                false
            ))
        );
        assert_eq!(
            at("/v1/messages?beta=true"),
            Some((
                Some(Claude),
                "/v1/messages?beta=true".into(),
                Messages,
                true
            ))
        );
        assert_eq!(
            at("/v1/responses"),
            Some((Some(Codex), "/responses".into(), Responses, true))
        );
        assert_eq!(
            at("/v1/chat/completions"),
            Some((None, "/chat/completions".into(), Chat, true))
        );
        assert_eq!(
            at("/v1/models?client_version=0.159.3"),
            Some((
                Some(Codex),
                "/models?client_version=0.159.3".into(),
                Responses,
                false
            ))
        );
        assert_eq!(
            at("/v1/models?limit=1000"),
            Some((
                Some(Claude),
                "/v1/models?limit=1000".into(),
                Messages,
                false
            ))
        );
        assert_eq!(
            at("/v1/messagesx"),
            Some((Some(Claude), "/v1/messagesx".into(), Messages, false))
        );
        assert_eq!(at("/codexx/responses"), None);
        assert_eq!(
            at("/grok/v1/responses"),
            Some((Some(Grok), "/responses".into(), Responses, true))
        );
        assert_eq!(
            at("/grok/v1/chat/completions"),
            Some((Some(Grok), "/chat/completions".into(), Chat, true))
        );
        assert_eq!(
            at("/grok/v1/user?include=coding_data_team"),
            Some((
                Some(Grok),
                "/user?include=coding_data_team".into(),
                Responses,
                false
            ))
        );
        assert_eq!(
            at("/grok/v1/billing"),
            Some((Some(Grok), "/billing".into(), Responses, false))
        );
        assert_eq!(at("/grokx/v1/responses"), None);
        assert_eq!(at("/other"), None);
    }

    fn keyed(value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", HeaderValue::from_static(value));
        headers
    }

    #[test]
    fn client_keys_reach_the_proxy_but_not_the_admin_api() {
        let config = Config {
            api_key: "sm-owner".into(),
            keys: vec![ClientKey {
                name: "laptop".into(),
                key: "sm-laptop".into(),
                models: vec!["gpt-*".into()],
            }],
            ..Config::default()
        };
        let laptop = by_key(&config, &keyed("Bearer sm-laptop"));
        assert!(matches!(laptop, Some(Caller::Client(k)) if k.name == "laptop"));
        let laptop = laptop.unwrap();
        assert_eq!(laptop.access(), Access::Use);
        let who = laptop.who();
        assert_eq!(who.label.as_deref(), Some("laptop"));
        assert_eq!(who.key.map(|k| k.models), Some(vec!["gpt-*".to_owned()]));
        let owner = by_key(&config, &keyed("Bearer sm-owner"));
        assert!(matches!(owner, Some(Caller::Owner)));
        assert_eq!(owner.unwrap().access(), Access::Admin);
        assert!(by_key(&config, &keyed("Bearer sm-other")).is_none());
    }

    #[test]
    fn auth_accepts_bearer_or_api_key() {
        let config = Config {
            api_key: "sm-key".into(),
            ..Config::default()
        };
        let owner = |headers: &HeaderMap| matches!(by_key(&config, headers), Some(Caller::Owner));
        assert!(!owner(&HeaderMap::new()));
        assert!(owner(&keyed("Bearer sm-key")));
        assert!(owner(&keyed("bearer sm-key")));
        assert!(!owner(&keyed("Bearer nope")));
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_static("sm-key"));
        assert!(owner(&headers));
    }

    /// Answers whois from a fixed list.
    struct Whoami(
        Vec<(
            &'static str,
            &'static str,
            &'static str,
            Option<&'static str>,
        )>,
    );

    impl Whois for Whoami {
        fn whois<'a>(
            &'a self,
            ip: std::net::IpAddr,
        ) -> crate::tailscale::BoxFuture<
            'a,
            Result<crate::tailscale::Machine, crate::tailscale::TsError>,
        > {
            let found = self
                .0
                .iter()
                .find(|(at, ..)| at.parse::<std::net::IpAddr>().ok() == Some(ip))
                .map(|&(_, id, name, login)| crate::tailscale::Machine {
                    id: id.into(),
                    name: name.into(),
                    login: login.map(str::to_owned),
                    tags: match login {
                        Some(_) => vec![],
                        None => vec!["tag:ci".into()],
                    },
                })
                .ok_or(crate::tailscale::TsError::Failed {
                    line: "no machine has that address".into(),
                });
            Box::pin(async move { found })
        }
    }

    /// A proxy whose tailnet has `me@test` on `mac` (an admin), `phone`
    /// and `lent` (the same id as `mac`, but signed in as someone else),
    /// and a tagged machine.
    fn tailnet_app() -> (Arc<App>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("slopmax-caller-{}", crate::ids::token()));
        let config = Config {
            api_key: "sm-owner".into(),
            keys: vec![ClientKey {
                name: "laptop".into(),
                key: "sm-laptop".into(),
                models: vec![],
            }],
            tailscale: Some(crate::config::Tailnet {
                users: vec!["me@test".into()],
                admins: vec![crate::config::AdminMachine {
                    machine: "mac".into(),
                    id: "nADMIN".into(),
                }],
            }),
            ..Config::default()
        };
        let app = App::new(
            config,
            Home::at(&dir),
            PoolState::default(),
            Origins::new([]),
        );
        app.set_whois(Arc::new(Whoami(vec![
            ("100.64.0.1", "nADMIN", "mac", Some("me@test")),
            ("100.64.0.2", "nOTHER", "phone", Some("me@test")),
            ("100.64.0.3", "nADMIN", "ci", None),
            ("100.64.0.4", "nADMIN", "lent", Some("else@test")),
        ])));
        (app, dir)
    }

    fn from(peer: &str, login: Option<&str>) -> Seen {
        Seen {
            channel: Channel::Tailnet,
            login: login.map(str::to_owned),
            peer: Some(peer.parse().unwrap()),
            funnel: false,
            origin_host: Some("hub.example.ts.net".into()),
            proto: Some("https".into()),
        }
    }

    #[tokio::test]
    async fn callers_are_told_apart_in_order() {
        let (app, dir) = tailnet_app();
        let config = app.config();
        let token = keyed("Bearer tailnet");
        let ask = |headers: HeaderMap, seen: Seen, need: Access| {
            let (app, config) = (app.clone(), config.clone());
            async move {
                caller(&app, &config, &headers, &seen, need)
                    .await
                    .map(|c| (c.access(), c.who().label))
            }
        };
        let me = from("100.64.0.2", Some("me@test"));

        // Funnel first, even with the owner key.
        let funneled = Seen {
            funnel: true,
            origin_host: Some("hub.example.ts.net:8443".into()),
            ..me.clone()
        };
        assert_eq!(
            ask(keyed("Bearer sm-owner"), funneled, Access::Use).await,
            Err(Denied::Funnel(8443))
        );
        // A key wins over an identity, and needs no browser check.
        let mut owner = keyed("Bearer sm-owner");
        owner.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert_eq!(
            ask(owner, me.clone(), Access::Admin).await,
            Ok((Access::Admin, None))
        );
        // An identity needs a token of some kind, from no other site.
        assert_eq!(
            ask(HeaderMap::new(), me.clone(), Access::Use).await,
            Err(Denied::NoCredential)
        );
        let mut same_site = token.clone();
        same_site.insert("sec-fetch-site", HeaderValue::from_static("same-site"));
        assert_eq!(
            ask(same_site, me.clone(), Access::Use).await,
            Err(Denied::CrossSite)
        );
        let mut foreign = token.clone();
        foreign.insert(
            "origin",
            HeaderValue::from_static("https://dev.example.ts.net"),
        );
        assert_eq!(
            ask(foreign, me.clone(), Access::Use).await,
            Err(Denied::CrossSite)
        );
        assert_eq!(
            ask(
                token.clone(),
                from("100.64.0.2", Some("you@test")),
                Access::Use
            )
            .await,
            Err(Denied::NotAllowed("you@test".into()))
        );
        // Tagged machines, and requests with no key anywhere else.
        assert_eq!(
            ask(token.clone(), from("100.64.0.3", None), Access::Use).await,
            Err(Denied::Tagged)
        );
        assert_eq!(
            ask(token.clone(), Seen::tcp(), Access::Use).await,
            Err(Denied::NoKey)
        );

        // A login may see; whois says which machine may manage.
        assert_eq!(
            ask(token.clone(), me.clone(), Access::View).await,
            Ok((Access::View, Some("me@test".into())))
        );
        assert_eq!(
            ask(token.clone(), me.clone(), Access::Admin).await,
            Err(Denied::Needs {
                need: Access::Admin,
                machine: Some("phone".into()),
                key: None,
            })
        );
        // Once looked up, the machine is known without waiting.
        assert_eq!(
            ask(token.clone(), me.clone(), Access::Use).await,
            Ok((Access::View, Some("phone".into())))
        );
        let mac = from("100.64.0.1", Some("ME@test"));
        assert_eq!(
            ask(token.clone(), mac, Access::Admin).await,
            Ok((Access::Admin, Some("mac".into())))
        );
        // An admin's id behind another login, or on a tagged machine, is
        // no admin; nor is an address whois doesn't know.
        for peer in ["100.64.0.4", "100.64.0.9"] {
            let seen = from(peer, Some("me@test"));
            assert!(matches!(
                ask(token.clone(), seen, Access::Admin).await,
                Err(Denied::Needs {
                    need: Access::Admin,
                    machine: None,
                    ..
                })
            ));
        }
        // A client key reaches the proxy only; its machine may do what its
        // login may.
        assert_eq!(
            ask(keyed("Bearer sm-laptop"), me.clone(), Access::View).await,
            Ok((Access::View, Some("phone".into())))
        );
        assert_eq!(
            ask(keyed("Bearer sm-laptop"), Seen::tcp(), Access::View).await,
            Err(Denied::Needs {
                need: Access::View,
                machine: None,
                key: Some("laptop".into()),
            })
        );
        drop(config);
        // Without users, a login is no one, and hears how to be let in.
        app.set_config(Config {
            api_key: "sm-owner".into(),
            ..Config::default()
        });
        let config = app.config();
        let headers = token.clone();
        assert_eq!(
            caller(&app, &config, &headers, &me, Access::Use)
                .await
                .map(|c| c.access()),
            Err(Denied::NotAllowed("me@test".into()))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refusals_say_what_to_do() {
        let text = |denied: Denied| denied.answer();
        assert_eq!(
            text(Denied::Funnel(7567)),
            (
                StatusCode::FORBIDDEN,
                "slopmax serves your tailnet only; turn Funnel off: tailscale funnel --https=7567 off"
                    .into()
            )
        );
        assert_eq!(
            text(Denied::NotAllowed("you@test".into())),
            (
                StatusCode::UNAUTHORIZED,
                "you@test isn't allowed on this slopmax; on the hub: slopmax tailscale user add you@test"
                    .into()
            )
        );
        assert_eq!(
            text(Denied::Needs {
                need: Access::Admin,
                machine: Some("phone".into()),
                key: None
            }),
            (
                StatusCode::FORBIDDEN,
                "this machine may not change slopmax; on the hub: slopmax tailscale admin add phone"
                    .into()
            )
        );
        assert_eq!(
            text(Denied::Needs {
                need: Access::View,
                machine: None,
                key: None
            })
            .1,
            "this machine may use slopmax but not see its accounts; on the hub: slopmax tailscale admin add <machine>"
        );
        assert_eq!(text(Denied::Tagged).0, StatusCode::UNAUTHORIZED);
        assert_eq!(text(Denied::NoCredential).0, StatusCode::UNAUTHORIZED);
        assert_eq!(text(Denied::CrossSite).0, StatusCode::FORBIDDEN);
    }

    #[test]
    fn funnel_is_turned_off_on_the_port_it_was_reached_on() {
        let config = Config::default();
        let at = |host: Option<&str>, proto: Option<&str>| {
            let seen = Seen {
                origin_host: host.map(str::to_owned),
                proto: proto.map(str::to_owned),
                ..Seen::tcp()
            };
            funnel_port(&seen, &config)
        };
        assert_eq!(at(Some("hub.example.ts.net:8443"), None), 8443);
        assert_eq!(at(Some("hub.example.ts.net"), Some("https")), 443);
        assert_eq!(at(Some("hub.example.ts.net"), Some("http")), 80);
        assert_eq!(at(None, None), config.listen.port());
    }
}
