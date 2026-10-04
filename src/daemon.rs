//! The long-running proxy and its background work: picking up account
//! changes, keeping tokens fresh, polling usage, and saving state.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use jiff::{SignedDuration, Timestamp};
use tokio::net::TcpListener;

use crate::account::{Account, Store};
use crate::auth;
use crate::config::Config;
use crate::pool::State;
use crate::proxy::{App, router};
use crate::upstream::Upstream;
use crate::{fsx, paths, usage};

/// How often blocked accounts are re-checked, in case quota frees up early.
const RECHECK_BLOCKED: SignedDuration = SignedDuration::from_mins(10);

pub async fn run(config: Config) -> Result<()> {
    let listen = config.listen;
    let listener = TcpListener::bind(listen)
        .await
        .with_context(|| format!("cannot listen on {listen} (is slopmax already running?)"))?;
    let state: State = fsx::read_json(&paths::state_file())?.unwrap_or_default();
    let app = App::new(config, Store::open(), Upstream::default(), state);
    app.sync()?;

    tokio::spawn(every(
        Duration::from_secs(2),
        app.clone(),
        |app| async move {
            if let Err(e) = app.sync() {
                tracing::warn!("reloading accounts: {e:#}");
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
    if app.config.poll_mins > 0 {
        tokio::spawn(every(
            Duration::from_secs(60),
            app.clone(),
            |app| async move {
                poll_all(&app, false).await;
            },
        ));
    }

    tracing::info!(
        "slopmax {} listening on {}",
        env!("CARGO_PKG_VERSION"),
        app.config.base_url()
    );
    axum::serve(listener, router(app.clone()))
        .with_graceful_shutdown(shutdown(app.clone()))
        .await?;
    save_state(&app);
    tracing::info!("stopped");
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
        tracing::warn!("saving state: {e}");
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
            tracing::warn!("{}: {e}", account.id);
            app.pool.record_error(&account.id, &e.to_string());
        }
    }
}

/// Polls usage for accounts whose reading is due (or all, with `force`).
pub async fn poll_all(app: &App, force: bool) {
    let now = Timestamp::now();
    let interval = SignedDuration::from_mins(app.config.poll_mins.max(1) as i64);
    let due: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.auth_error.is_none())
        .filter(|a| force || is_due(app, a, now, interval))
        .collect();
    let polls = due.iter().map(|account| async move {
        let result = usage::poll(
            &app.auth_http,
            &app.store,
            &app.upstream,
            account,
            app.config.refresh_tokens,
        )
        .await;
        (account, result)
    });
    for (account, result) in futures_util::future::join_all(polls).await {
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
                        tracing::warn!("{}: saving plan: {e:#}", fresh.id);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("{}: usage poll failed: {e:#}", account.id);
                app.pool
                    .record_error(&account.id, &format!("usage poll: {e:#}"));
            }
        }
    }
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
