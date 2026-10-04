//! The long-running proxy and its background work: picking up account
//! changes, keeping tokens fresh, polling usage, and saving state.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::net::TcpListener;

use crate::account::{Account, Provider, Store};
use crate::auth;
use crate::config::Config;
use crate::credits::{self, Outcome};
use crate::log;
use crate::net::{Origins, server};
use crate::pool::State;
use crate::proxy::{self, App};
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, paths, usage};

/// How often blocked accounts are re-checked, in case quota frees up early.
const RECHECK_BLOCKED: SignedDuration = SignedDuration::from_mins(10);
/// How close to expiry a reset credit is redeemed rather than lost.
const CREDIT_EXPIRY_LEAD: SignedDuration = SignedDuration::from_hours(3);

pub async fn run(config: Config) -> Result<()> {
    let listen = config.listen;
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("cannot listen on {listen} (is slopmax already running?)"))?;
    let state: State = fsx::read_json(&paths::state_file())?.unwrap_or_default();
    let app = App::new(config, Store::open(), state, Origins::default());
    app.sync()?;

    tokio::spawn(every(
        Duration::from_secs(2),
        app.clone(),
        |app| async move {
            if let Err(e) = app.sync() {
                log::warn!("reloading accounts: {e:#}");
            }
        },
    ));
    tokio::spawn(every(
        Duration::from_secs(10),
        app.clone(),
        |app| async move {
            save_state(&app);
        },
    ));
    if app.config.refresh_tokens {
        tokio::spawn(every(
            Duration::from_secs(300),
            app.clone(),
            |app| async move {
                refresh_all(&app).await;
            },
        ));
    }
    if app.config.redeem_expiring_credits {
        tokio::spawn(every(
            Duration::from_secs(1800),
            app.clone(),
            |app| async move {
                redeem_expiring(&app).await;
            },
        ));
    }
    if app.config.poll_mins > 0 {
        tokio::spawn(every(
            Duration::from_secs(60),
            app.clone(),
            |app| async move {
                poll_all(&app, false).await;
            },
        ));
    }

    log::info!(
        "slopmax {} listening on {}",
        env!("CARGO_PKG_VERSION"),
        app.config.base_url()
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

fn save_state(app: &App) {
    let (state, dirty) = app.pool.snapshot(Timestamp::now());
    if dirty && let Err(e) = fsx::write_json(&paths::state_file(), &state) {
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
    let interval = SignedDuration::from_mins(app.config.poll_mins.max(1) as i64);
    let due: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.auth_error.is_none())
        .filter(|a| force || is_due(app, a, now, interval))
        .collect();
    let mut polls = tokio::task::JoinSet::new();
    for account in due {
        let app = Arc::clone(app);
        polls.spawn(async move {
            let result = usage::poll(
                &app.auth_http,
                &app.store,
                &account,
                app.config.refresh_tokens,
            )
            .await;
            (account, result)
        });
    }
    while let Some(joined) = polls.join_next().await {
        let Ok((account, result)) = joined else {
            continue;
        };
        match result {
            Ok((fresh, reading)) => {
                app.pool
                    .observe(&account.id, reading.limits, Timestamp::now());
                if reading.plan.is_some() && reading.plan != fresh.plan {
                    let (store, id, plan) = (app.store.clone(), fresh.id.clone(), reading.plan);
                    let saved =
                        tokio::task::spawn_blocking(move || store.update(&id, |a| a.plan = plan))
                            .await;
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
}

/// Redeems reset credits about to expire on accounts with usage to reset.
/// A lapsed credit is simply lost, so spending it first is free quota.
pub async fn redeem_expiring(app: &App) {
    let now = Timestamp::now();
    for account in app.pool.accounts() {
        let state = app.pool.state(&account.id);
        let used = state.limits.windows.iter().any(|w| w.used_at(now) > 0.0);
        if account.provider != Provider::Codex
            || account.disabled
            || account.auth_error.is_some()
            || state.limits.reset_credits.unwrap_or(0) == 0
            || !used
        {
            continue;
        }
        let _redeeming = app.redeeming.lock().await;
        let Some(account) = app.ready(&account).await else {
            continue;
        };
        match redeem_if_expiring(app, &account, now).await {
            Ok(Some(Outcome::Reset)) => {
                log::info!("{}: redeemed a reset credit before it expired", account.id);
                app.pool.record_reset(&account.id, Timestamp::now());
            }
            Ok(Some(outcome)) => {
                log::info!(
                    "{}: expiring reset credit not used ({outcome:?})",
                    account.id
                );
            }
            Ok(None) => {}
            Err(e) => log::warn!("{}: checking reset credits: {e:#}", account.id),
        }
    }
}

/// Redeems the account's soonest-expiring credit if it lapses within
/// [`CREDIT_EXPIRY_LEAD`].
async fn redeem_if_expiring(
    app: &App,
    account: &Account,
    now: Timestamp,
) -> Result<Option<Outcome>> {
    let credits = credits::list(&app.auth_http, account).await?;
    let expiring = credits.first().filter(|c| {
        c.expires()
            .is_some_and(|at| at.duration_since(now) <= CREDIT_EXPIRY_LEAD)
    });
    let Some(credit) = expiring else {
        return Ok(None);
    };
    let outcome = credits::redeem(&app.auth_http, account, Some(&credit.id)).await?;
    Ok(Some(outcome))
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
