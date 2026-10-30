//! The long-running proxy and its background work: picking up account
//! changes, keeping tokens fresh, polling usage, and saving state.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::TcpListener;

use crate::account::Account;
use crate::auth;
use crate::config::Config;
use crate::log;
use crate::net::{Origins, server};
use crate::paths::Home;
use crate::pool::State;
use crate::provider::credits::Outcome;
use crate::proxy::{self, App};
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, notify, usage};

/// How often blocked accounts are re-checked, in case quota frees up early.
const RECHECK_BLOCKED: SignedDuration = SignedDuration::from_mins(10);
/// How close to expiry a reset credit is redeemed rather than lost.
pub const CREDIT_EXPIRY_LEAD: SignedDuration = SignedDuration::from_hours(3);
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

pub async fn run(config: Config) -> Result<()> {
    serve(config, Home::current(), Origins::default()).await
}

/// Runs the proxy from `home`, sending provider traffic to `origins`
/// (benchmarks point them at a local mock).
pub async fn serve(config: Config, home: Home, origins: Origins) -> Result<()> {
    let listen = config.listen;
    let listener = TcpListener::bind(listen).await.with_context(|| {
        match server::port_holder(listen.port()) {
            Some(holder) => format!("cannot listen on {listen}: {holder} is using that port"),
            None => format!("cannot listen on {listen}"),
        }
    })?;
    let state: State = fsx::read_json(&home.state())?.unwrap_or_default();
    let app = App::new(config, home, state, origins);
    app.sync()?;

    tokio::spawn(every(
        Duration::from_secs(2),
        app.clone(),
        |app| async move {
            if let Err(e) = app.sync() {
                log::warn!("reloading accounts: {e:#}");
            }
            app.reload_config();
        },
    ));
    tokio::spawn(every(
        Duration::from_secs(10),
        app.clone(),
        |app| async move {
            save_state(&app);
        },
    ));
    // Each task asks the config as it runs, so a changed config.toml turns
    // it on or off without a restart.
    tokio::spawn(every(
        Duration::from_secs(300),
        app.clone(),
        |app| async move {
            if app.config().refresh_tokens {
                refresh_all(&app).await;
            }
        },
    ));
    tokio::spawn(every(
        Duration::from_secs(60),
        app.clone(),
        |app| async move {
            list_credits(&app, false).await;
        },
    ));
    tokio::spawn(every(
        Duration::from_secs(1800),
        app.clone(),
        |app| async move {
            if app.config().redeem_expiring_credits {
                redeem_expiring(&app).await;
            }
        },
    ));
    tokio::spawn(every(
        Duration::from_secs(60),
        app.clone(),
        |app| async move {
            if app.config().warm_windows {
                proxy::warm::idle_accounts(&app).await;
            }
        },
    ));
    if app.config().notify.is_enabled() {
        tokio::spawn(watch(app.clone()));
    }
    tokio::spawn(every(
        Duration::from_secs(60),
        app.clone(),
        |app| async move {
            if app.config().poll_mins > 0 {
                poll_all(&app, false).await;
            }
        },
    ));

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
    save_state(&app);
    log::info!("stopped");
    Ok(())
}

/// Runs `task` now and then every `period`.
async fn every<F, Fut>(period: Duration, app: Arc<App>, task: F)
where
    F: Fn(Arc<App>) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        task(app.clone()).await;
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
        () = app.shutdown.notified() => {},
    }
}

/// Sends a notification for each change in the accounts' conditions.
async fn watch(app: Arc<App>) {
    let mut watcher = notify::Watcher::default();
    let mut ticker = tokio::time::interval(WATCH_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let accounts = app.pool.accounts();
        let events = watcher.changes(&accounts, |id| app.pool.state(id), Timestamp::now());
        for event in events {
            log::info!("{}", event.message);
            if let Err(e) = app.config().notify.send(&app.auth_http, &event).await {
                log::warn!("sending a notification: {e:#}");
            }
        }
    }
}

fn save_state(app: &App) {
    let (state, dirty) = app.pool.snapshot(Timestamp::now());
    if dirty && let Err(e) = fsx::write_json(&app.home.state(), &state) {
        log::warn!("saving state: {e}");
    }
}

/// Refreshes tokens that are close to expiring, so a request never waits
/// on a refresh. Disabled accounts are kept fresh too.
async fn refresh_all(app: &App) {
    for account in app.pool.accounts() {
        if account.auth_error.is_some() {
            continue;
        }
        if let Err(e) = auth::ensure_fresh(&app.auth_http, &app.store, &account, false).await {
            log::warn!("{}: {e}", account.id);
            app.pool.record_error(&account.id, &e.to_string());
        }
    }
}

/// Polls usage for accounts whose reading is due (or all, with `force`).
pub async fn poll_all(app: &Arc<App>, force: bool) {
    let now = Timestamp::now();
    let interval = SignedDuration::from_mins(app.config().poll_mins.max(1) as i64);
    let due: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.auth_error.is_none() && a.provider.spec().is_subscription())
        .filter(|a| force || is_due(app, a, now, interval))
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
            app.pool
                .observe(&account.id, reading.limits, Timestamp::now());
            if reading.plan.is_some() && reading.plan != fresh.plan {
                let (store, id, plan) = (app.store.clone(), fresh.id.clone(), reading.plan);
                let saved =
                    tokio::task::spawn_blocking(move || store.update(&id, |a| a.plan = plan)).await;
                if let Ok(Err(e)) = saved {
                    log::warn!("{}: saving plan: {e:#}", fresh.id);
                }
            }
        }
        Err(e) => {
            log::warn!("{}: usage poll failed: {e:#}", account.id);
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
    for account in app.pool.accounts() {
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
        let Some(account) = app.ready(&account).await else {
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
    for account in app.pool.accounts() {
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
        let Some(account) = app.ready(&account).await else {
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
