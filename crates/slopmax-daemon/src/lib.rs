//! The daemon: the proxy agents talk to, slopmax's API beside it, and the
//! background work that keeps the pool current (picking up account
//! changes, keeping tokens fresh, polling usage, redeeming limit resets,
//! telling notices) and saves its state. It is built on the engine,
//! [`slopmax_core`], and is the only process that writes what it holds while
//! it runs; the CLI and the apps reach it through `/slopmax/api`.

pub mod proxy;

// The engine's modules, under the names the daemon's code uses.
pub(crate) use slopmax_core::{
    account, agent, api, auth, blocking, config, doctor, fsx, history, import, ledger, limits,
    notify, paths, pool, provider, report, route, state, summary, usage, waste,
};
pub(crate) use slopmax_core::{human, ids, log, net, time, wire};

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::net::TcpListener;

use crate::account::Account;
use crate::config::Config;
use crate::net::{Origins, server};
use crate::paths::Home;
use crate::pool::State;
use crate::provider::credits::Outcome;
use crate::proxy::App;
use crate::time::{SignedDuration, Timestamp};

/// How often blocked accounts are re-checked, in case quota frees up early.
const RECHECK_BLOCKED: SignedDuration = SignedDuration::from_mins(10);
/// How close to expiry a reset credit is redeemed rather than lost.
pub const CREDIT_EXPIRY_LEAD: SignedDuration =
    SignedDuration::from_hours(slopmax_api::settings::REDEEM_LEAD_HOURS as i64);
/// How often an account's reset credits are listed again. They change only
/// when one is granted, spent, or expires, which the usage count and the
/// expiry dates already tell.
const LIST_CREDITS_EVERY: SignedDuration = SignedDuration::from_hours(6);
/// How often the credits of a provider whose usage does not count them, as
/// Claude's, are listed: a new one shows within the hour. A failed listing
/// waits as long, since it asks the usage endpoint, which rate-limits.
const LIST_UNCOUNTED_EVERY: SignedDuration = SignedDuration::from_hours(1);
/// How soon a new count from the usage has the credits listed again, at the
/// earliest.
const LIST_CREDITS_GAP: SignedDuration = SignedDuration::from_mins(10);
/// How often account conditions are compared for notifications.
const WATCH_EVERY: Duration = Duration::from_secs(15);

/// The runtime every command runs on: one thread unless `SLOPMAX_WORKERS`
/// asks for more. One thread carries a desktop's agents with room to spare,
/// and it hands no work between threads and holds the least memory. A
/// proxy shared by many clients sets `SLOPMAX_WORKERS` to a number of
/// threads, or to `auto` for one per CPU; blocking work (the disk, name
/// lookups) runs on threads of its own either way.
pub fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    let workers = std::env::var("SLOPMAX_WORKERS").ok();
    let mut builder = match workers.as_deref().map(str::trim) {
        Some("auto") => tokio::runtime::Builder::new_multi_thread(),
        Some(n) => match n.parse::<usize>() {
            Ok(n) if n > 1 => {
                let mut builder = tokio::runtime::Builder::new_multi_thread();
                builder.worker_threads(n);
                builder
            }
            _ => tokio::runtime::Builder::new_current_thread(),
        },
        None => tokio::runtime::Builder::new_current_thread(),
    };
    builder.enable_all().build()
}

pub async fn run(config: Config) -> Result<Stopped> {
    serve(config, Home::current(), Origins::default()).await
}

/// How the daemon stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stopped {
    /// Asked to stop, or signalled.
    Done,
    /// Asked to stop so it is started again (`POST /shutdown {"restart":
    /// true}` after an update): the service manager restarts it on exit
    /// code 75.
    Restart,
}

impl Stopped {
    /// The process's exit code: 75 (`EX_TEMPFAIL`) asks for a restart.
    pub fn code(self) -> i32 {
        match self {
            Self::Done => 0,
            Self::Restart => 75,
        }
    }
}

/// How long the daemon waits, when it stops, for background work in
/// flight: a usage poll, a refresh whose new token must be saved.
const SETTLE: Duration = Duration::from_secs(5);

/// Runs the proxy from `home`, sending provider traffic to `origins`
/// (benchmarks point them at a local mock).
///
/// Stopping runs in order: the listener stops taking connections and
/// drains the ones open, background loops end and the work they started
/// finishes, refreshes in flight save their tokens, and state is saved
/// last, by the only writer left.
pub async fn serve(config: Config, home: Home, origins: Origins) -> Result<Stopped> {
    let serving = serve_lock(&home)?;
    let listen = config.listen;
    let listener = TcpListener::bind(listen).await.with_context(|| {
        match server::port_holder(listen.port()) {
            Some(holder) => format!("cannot listen on {listen}: {holder} is using that port"),
            None => format!("cannot listen on {listen}"),
        }
    })?;
    let state = read_state(&home);
    let app = App::new(config, home, state, origins);
    app.sync()?;

    // Logins, removals and `slopmax use` from the CLI and the apps are told
    // to the daemon at once (`/slopmax/sync`); the rescan catches the rest.
    // Each job asks the config as it runs, so a changed config.toml turns it
    // on or off without a restart. Every period is a multiple of 15 s, so the
    // jobs share their wakeups.
    let watching = Arc::new(tokio::sync::Mutex::new(Watch::open(&app)));
    let jobs: Vec<Job> = vec![
        Job::new("save state", Duration::from_secs(15), |app| async move {
            // Nothing to write: no blocking thread woken for nothing.
            if app.pool.needs_save() {
                blocking::run(move || save_state(&app)).await;
            }
        }),
        Job::new("watch", WATCH_EVERY, move |app| {
            let watching = watching.clone();
            async move { watching.lock().await.step(&app).await }
        }),
        Job::new("rescan", RESCAN, |app| async move {
            if let Err(e) = app.rescan() {
                log::warn!("reloading accounts: {e:#}");
            }
            app.reload_config();
        }),
        Job::new("poll", Duration::from_secs(60), |app| async move {
            if app.config().poll_mins > 0 {
                poll_all(&app, false).await;
            }
        }),
        Job::new("list credits", Duration::from_secs(60), |app| async move {
            list_credits(&app, false).await;
        }),
        Job::new("warm windows", Duration::from_secs(60), |app| async move {
            if app.config().warm_windows {
                proxy::warm::idle_accounts(&app).await;
            }
        }),
        Job::new(
            "refresh tokens",
            Duration::from_secs(300),
            |app| async move {
                if app.config().refresh_tokens {
                    refresh_all(&app).await;
                }
            },
        ),
        Job::new(
            "redeem expiring",
            Duration::from_secs(1800),
            |app| async move {
                if app.config().redeem_expiring_credits {
                    redeem_expiring(&app).await;
                }
            },
        ),
    ];
    app.spawn(schedule(app.clone(), jobs));

    log::info!(
        "slopmax {} listening on {}",
        env!("CARGO_PKG_VERSION"),
        app.config().base_url()
    );
    let handler = {
        let app = Arc::clone(&app);
        move |request| proxy::handle(Arc::clone(&app), request)
    };
    server::serve(listener, handler, shutdown(app.clone())).await;
    app.tasks.close();
    if tokio::time::timeout(SETTLE, app.tasks.wait())
        .await
        .is_err()
    {
        log::warn!("stopping without waiting longer for background work");
    }
    auth::settle(SETTLE).await;
    save_state(&app);
    app.ledger.sync();
    drop(serving);
    log::info!("stopped");
    Ok(
        match app.restart.load(std::sync::atomic::Ordering::Relaxed) {
            true => Stopped::Restart,
            false => Stopped::Done,
        },
    )
}

/// How often the account files are checked for changes the daemon was not
/// told about.
const RESCAN: Duration = Duration::from_secs(30);

/// Takes the home's serve lock, held while the daemon runs, so a second
/// daemon on the same home fails to start instead of racing the first for
/// its files. The CLI holds it a moment to change the state of a home no
/// daemon serves ([`crate::state::change`]), which is waited out.
fn serve_lock(home: &Home) -> Result<std::fs::File> {
    use std::io::{Read, Seek, Write};
    let path = home.dir().join(".serve.lock");
    fsx::private_dir(home.dir())?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    let mut tries = 0;
    let taken = loop {
        match file.try_lock() {
            Err(std::fs::TryLockError::WouldBlock) if tries < 20 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(50));
            }
            taken => break taken,
        }
    };
    match taken {
        Ok(()) => {
            file.set_len(0)?;
            write!(file, "{}", std::process::id())?;
            Ok(file)
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            let mut pid = String::new();
            let _ = file.rewind().and_then(|()| file.read_to_string(&mut pid));
            let holder = match pid.trim() {
                "" => String::new(),
                pid => format!(" (pid {pid})"),
            };
            bail!(
                "another slopmax{holder} is already serving {}",
                home.dir().display()
            )
        }
        Err(std::fs::TryLockError::Error(e)) => {
            Err(e).with_context(|| format!("locking {}", path.display()))
        }
    }
}

/// The state saved at the last stop. One that cannot be read is moved
/// aside, and the daemon starts without it: health and readings come back
/// with the next requests and polls, while a daemon that refused to start
/// would stop every agent.
fn read_state(home: &Home) -> State {
    let path = home.state();
    match fsx::read_toml(&path) {
        Ok(state) => crate::state::upgrade(home, state.unwrap_or_default()),
        Err(e) => {
            // The file that failed: the TOML, or the JSON an earlier
            // version left, which was being read in its place.
            let bad = match path.exists() {
                true => path,
                false => path.with_extension("json"),
            };
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            let name = bad
                .file_name()
                .map_or("state".into(), |n| n.to_string_lossy());
            let aside = bad.with_file_name(format!("{name}.bad-{at}"));
            match std::fs::rename(&bad, &aside) {
                Ok(()) => log::warn!(
                    "{name} could not be read ({e}); moved it to {} and started afresh",
                    aside.display()
                ),
                Err(moving) => log::warn!(
                    "{name} could not be read ({e}) or moved aside ({moving}); started afresh"
                ),
            }
            crate::state::upgrade(home, State::default())
        }
    }
}

/// One background job: what it is called, how often it runs, and what it
/// does.
struct Job {
    name: &'static str,
    every: Duration,
    run: Box<dyn Fn(Arc<App>) -> proxy::BoxedTask + Send + Sync>,
}

impl Job {
    fn new<F, Fut>(name: &'static str, every: Duration, run: F) -> Self
    where
        F: Fn(Arc<App>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        Self {
            name,
            every,
            run: Box::new(move |app| Box::pin(run(app))),
        }
    }
}

/// Runs every job on one timer, until the daemon stops: it sleeps until the
/// soonest is due, then starts each one due as a task of its own. A job runs
/// once at a time and never catches up on runs it missed; one that panics is
/// logged and runs again on schedule. Jobs due at once start together, so
/// the daemon wakes once for them.
async fn schedule(app: Arc<App>, jobs: Vec<Job>) {
    let start = tokio::time::Instant::now();
    let mut next = vec![start; jobs.len()];
    let mut running: Vec<Option<tokio::task::JoinHandle<()>>> = jobs.iter().map(|_| None).collect();
    loop {
        let soonest = next.iter().copied().min().unwrap_or(start);
        tokio::select! {
            () = tokio::time::sleep_until(soonest) => {}
            () = app.stop.cancelled() => return,
        }
        let now = tokio::time::Instant::now();
        for (i, job) in jobs.iter().enumerate() {
            if next[i] > now {
                continue;
            }
            // From the slot it was due in, so jobs of the same period stay
            // in step however long a run takes.
            while next[i] <= now {
                next[i] += job.every;
            }
            if running[i].as_ref().is_some_and(|run| !run.is_finished()) {
                continue;
            }
            if let Some(run) = running[i].take()
                && let Err(e) = run.await
                && e.is_panic()
            {
                log::error!("{} failed; it runs again on schedule: {e}", job.name);
            }
            running[i] = Some(app.tasks.spawn((job.run)(app.clone())));
        }
    }
}

async fn shutdown(app: Arc<App>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut stream) => {
                stream.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
        () = app.stop.cancelled() => {},
    }
    app.stop.cancel();
}

/// Watches the accounts' conditions, telling each change: in the log, on
/// the API's event stream (which the apps post as notifications), and to
/// the configured webhook or command. The nudges told are kept with the
/// state, so a restart does not tell them again.
struct Watch {
    watcher: notify::Watcher,
}

impl Watch {
    fn open(app: &App) -> Self {
        Self {
            watcher: notify::Watcher::remembering(app.pool.told()),
        }
    }

    async fn step(&mut self, app: &App) {
        let now = Timestamp::now();
        let accounts = app.pool.accounts();
        let mut events = self
            .watcher
            .changes(&accounts, |id| app.pool.state(id), now);
        let config = app.config();
        let report = app.report();
        let subjects: Vec<notify::Subject> =
            report.accounts.iter().map(notify::Subject::of).collect();
        let nudges = notify::nudges(
            &subjects,
            config.redeem_expiring_credits,
            &config.plan_prices,
            now,
        );
        let fresh = self.watcher.new_nudges(nudges);
        if !fresh.is_empty() {
            app.pool.set_told(self.watcher.told());
        }
        events.extend(fresh);
        for event in events {
            log::info!("{}", event.message);
            if app.api_events.receiver_count() > 0 {
                let key = format!(
                    "{}:{}:{}",
                    event.event.as_str(),
                    event.account.as_deref().unwrap_or("-"),
                    event.until.map_or(0, |at| at.as_second())
                );
                let notice = slopmax_api::events::Event::Notice {
                    notice: crate::api::notice(&key, &event),
                };
                let _ = app.api_events.send(notice.frame().into());
            }
            if !config.notify.is_enabled() {
                continue;
            }
            if let Err(e) = config.notify.send(&app.auth_http, &event).await {
                log::warn!("sending a notification: {e:#}");
            }
        }
    }
}

fn save_state(app: &App) {
    let now = Timestamp::now();
    record_lapses(app, now);
    let (state, dirty) = app.pool.snapshot(now);
    if dirty && let Err(e) = fsx::write_toml(&app.home.state(), &state) {
        log::warn!("saving state: {e}");
    }
}

/// Writes down the windows that reset, with how much of each was used, for
/// what was left on the table.
fn record_lapses(app: &App, now: Timestamp) {
    let lapses = app.pool.take_lapses(now);
    if lapses.is_empty() {
        return;
    }
    let accounts = app.pool.accounts();
    let records: Vec<crate::waste::Record> = lapses
        .into_iter()
        .filter_map(|(id, lapse)| {
            let account = accounts.iter().find(|a| a.id == id)?;
            Some(crate::waste::Record {
                ended_at: lapse.ended_at,
                account: id,
                provider: account.provider,
                plan: account.plan.clone(),
                span: lapse.span,
                model: lapse.model,
                used: lapse.used,
            })
        })
        .collect();
    app.hours.lapsed(&records);
    if let Err(e) = crate::waste::append(&app.home.windows(), &records) {
        log::warn!("recording reset windows: {e:#}");
    }
}

/// Refreshes tokens that are close to expiring, so a request never waits
/// on a refresh. Disabled accounts are kept fresh too.
async fn refresh_all(app: &App) {
    for account in app.pool.accounts().iter() {
        if account.auth_error.is_some() {
            continue;
        }
        match auth::ensure_fresh(&app.auth_http, &app.store, account, false).await {
            Ok(fresh) => app.adopt(account, &fresh),
            Err(e) => {
                log::warn!("{}: {e}", account.id);
                app.refresh_failed(account, &e);
            }
        }
    }
}

/// Polls usage for accounts whose reading is due (or all, with `force`).
pub async fn poll_all(app: &Arc<App>, force: bool) {
    let now = Timestamp::now();
    let interval = SignedDuration::from_mins(app.config().poll_mins.max(1) as i64);
    let due: Vec<Arc<Account>> = app
        .pool
        .accounts()
        .iter()
        .filter(|&a| a.auth_error.is_none() && a.provider.spec().is_subscription())
        .filter(|&a| force || is_due(app, a, now, interval))
        .cloned()
        .collect();
    let mut polls = tokio::task::JoinSet::new();
    for account in due {
        let app = Arc::clone(app);
        polls.spawn(async move { poll_one(&app, &account).await });
    }
    while polls.join_next().await.is_some() {}
}

/// Polls one account's usage and records the reading, or the failure.
pub async fn poll_one(app: &App, account: &Account) {
    let result = usage::poll(
        &app.auth_http,
        &app.store,
        account,
        app.config().refresh_tokens,
    )
    .await;
    match result {
        Ok((fresh, reading)) => {
            app.adopt(account, &fresh);
            app.pool
                .observe(&account.id, reading.limits, Timestamp::now());
            if reading.plan.is_some() && reading.plan != fresh.plan {
                let (store, id, plan) = (app.store.clone(), fresh.id.clone(), reading.plan);
                let saved = blocking::run(move || store.update(&id, |a| a.plan = plan)).await;
                if let Err(e) = saved {
                    log::warn!("{}: saving plan: {e:#}", fresh.id);
                }
            }
        }
        Err(e) => {
            log::warn!("{}: usage poll failed: {e:#}", account.id);
            // A refresh during the poll may have found the sign-in revoked,
            // and marked the stored copy.
            if let Ok(Some(stored)) = app.store.get(&account.id)
                && stored.auth_error.is_some()
            {
                app.pool.put(&stored);
            }
            app.pool
                .record_error(&account.id, &format!("usage poll: {e:#}"));
        }
    }
}

/// Lists the reset credits of each account that may have some, when its
/// list is due: never listed, listed [`LIST_CREDITS_EVERY`] ago, or no
/// longer matching the count its usage reports; or, for a provider whose
/// usage keeps no count, listed [`LIST_UNCOUNTED_EVERY`] ago. `force` lists
/// them all now.
pub async fn list_credits(app: &App, force: bool) {
    let now = Timestamp::now();
    for account in app.pool.accounts().iter() {
        let Some(credits) = account.provider.get().credits() else {
            continue;
        };
        let agent = app.pool.agent(account.provider);
        let state = app.pool.state(&account.id);
        let counted = state.limits.reset_credits;
        let none = credits.counted() && counted.unwrap_or(0) == 0 && state.credits_left(now) == 0;
        if account.disabled
            || account.auth_error.is_some()
            || none
            || (credits.needs_agent() && agent.is_none())
        {
            continue;
        }
        let every = if credits.counted() {
            LIST_CREDITS_EVERY
        } else {
            LIST_UNCOUNTED_EVERY
        };
        let due = match &state.credits {
            None => true,
            Some(list) => {
                let age = now.duration_since(list.listed_at);
                age >= every || (age >= LIST_CREDITS_GAP && list.counted != counted)
            }
        };
        if !force && !due {
            continue;
        }
        let Some(account) = app.ready(account).await else {
            continue;
        };
        match credits
            .list(&app.auth_http, &account, agent.as_deref())
            .await
        {
            Ok(listed) => app.pool.record_credits(&account.id, listed, now),
            Err(e) => {
                log::warn!("{}: listing limit resets: {e:#}", account.id);
                if !credits.counted() {
                    let kept = state.unexpired_credits(now).cloned().collect();
                    app.pool.record_credits(&account.id, kept, now);
                }
            }
        }
    }
}

/// Redeems reset credits about to expire on accounts with usage to reset.
/// A lapsed credit is simply lost, so spending it first is free quota.
pub async fn redeem_expiring(app: &App) {
    let now = Timestamp::now();
    for account in app.pool.accounts().iter() {
        let Some(credits) = account.provider.get().credits() else {
            continue;
        };
        let state = app.pool.state(&account.id);
        let used = state.limits.windows.iter().any(|w| w.used_at(now) > 0.0);
        if (credits.needs_agent() && app.pool.agent(account.provider).is_none())
            || account.disabled
            || account.auth_error.is_some()
            || state.credits_left(now) == 0
            || !used
        {
            continue;
        }
        let _redeeming = app.redeeming.lock().await;
        let Some(account) = app.ready(account).await else {
            continue;
        };
        match redeem_if_expiring(app, &account, now).await {
            Ok(Some((Outcome::Reset, credit))) => {
                log::info!("{}: redeemed a limit reset before it expired", account.id);
                app.pool
                    .record_reset(&account.id, Timestamp::now(), Some(&credit));
            }
            Ok(Some((outcome, _))) => {
                log::info!(
                    "{}: expiring limit reset not used ({outcome:?})",
                    account.id
                );
            }
            Ok(None) => {}
            Err(e) => log::warn!("{}: checking limit resets: {e:#}", account.id),
        }
    }
}

/// Redeems the account's soonest-expiring credit if it lapses within
/// [`CREDIT_EXPIRY_LEAD`], returning how that went and the credit's id. The
/// list it reads is kept for the account.
async fn redeem_if_expiring(
    app: &App,
    account: &Account,
    now: Timestamp,
) -> Result<Option<(Outcome, String)>> {
    let Some(credits) = account.provider.get().credits() else {
        return Ok(None);
    };
    let agent = app.pool.agent(account.provider);
    let available = credits
        .list(&app.auth_http, account, agent.as_deref())
        .await?;
    app.pool.record_credits(&account.id, available.clone(), now);
    let expiring = available.first().filter(|c| {
        c.expires_at
            .is_some_and(|at| at.duration_since(now) <= CREDIT_EXPIRY_LEAD)
    });
    let Some(credit) = expiring else {
        return Ok(None);
    };
    let outcome = credits
        .redeem(&app.auth_http, account, agent.as_deref(), Some(&credit.id))
        .await?;
    Ok(Some((outcome, credit.id.clone())))
}

/// A reading is due when it is stale, when a window has reset since it was
/// taken (so the fresh window is picked up promptly), or periodically while
/// the account is blocked (quota often frees up before the stated reset).
fn is_due(app: &App, account: &Account, now: Timestamp, interval: SignedDuration) -> bool {
    let state = app.pool.state(&account.id);
    let Some(observed) = state.limits.observed_at else {
        return true;
    };
    let age = now.duration_since(observed);
    let window_reset = state
        .limits
        .windows
        .iter()
        .filter_map(|w| w.resets_at)
        .any(|at| at > observed && at <= now);
    age >= interval || window_reset || (state.is_blocked(now) && age >= RECHECK_BLOCKED)
}
