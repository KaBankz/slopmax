//! Window warmup (opt-in, `warm_windows`): ChatGPT starts an account's
//! 5-hour window at its first request, so an account left idle after a
//! reset gets its next reset late. One tiny request on an idle account
//! starts the window early, and its reset comes sooner when the account is
//! needed. Only ChatGPT accounts are warmed; slopmax never sends traffic of
//! its own to Claude subscriptions.

use std::sync::Arc;
use std::time::{Duration, Instant};

use http::{HeaderMap, HeaderValue};
use serde_json::json;

use super::App;
use crate::account::Account;
use crate::ledger::Entry;
use crate::log;
use crate::provider::ProviderId;
use crate::time::Timestamp;
use crate::wire::Dialect;
use crate::wire::ir::{Answer, Request};
use crate::wire::translate::Decoder;

/// At most one warmup per account per window.
const COOLDOWN: Duration = Duration::from_secs(5 * 3600);

/// Warms every idle ChatGPT account, using the model Codex last used.
pub async fn idle_accounts(app: &Arc<App>) {
    let Some(model) = app.last_codex_model() else {
        return;
    };
    let now = Timestamp::now();
    let idle: Vec<Account> = app
        .pool
        .accounts()
        .into_iter()
        .filter(|a| a.provider == ProviderId::Codex && !a.disabled && a.auth_error.is_none())
        .filter(|a| {
            let state = app.pool.state(&a.id);
            let five_hours = state
                .limits
                .windows
                .iter()
                .find(|w| w.span == "5h" && w.model.is_none());
            !state.is_blocked(now) && five_hours.is_some_and(|w| w.used_at(now) == 0.0)
        })
        .collect();
    for account in idle {
        {
            let mut warmed = app.warmed.lock().unwrap_or_else(|p| p.into_inner());
            if warmed
                .get(&account.id)
                .is_some_and(|at| at.elapsed() < COOLDOWN)
            {
                continue;
            }
            warmed.insert(account.id.clone(), Instant::now());
        }
        match warm(app, &account, &model).await {
            Ok(()) => log::info!("{}: started its 5-hour window early", account.id),
            Err(e) => log::warn!("{}: warmup failed: {e}", account.id),
        }
    }
}

/// One tiny request on `account`.
async fn warm(app: &App, account: &Account, model: &str) -> Result<(), String> {
    let Some(account) = app.ready(account).await else {
        return Err("its sign-in could not be refreshed".into());
    };
    let provider = account.provider.get();
    let mut own = HeaderMap::new();
    own.insert("content-type", HeaderValue::from_static("application/json"));
    own.insert("accept", HeaderValue::from_static("text/event-stream"));
    own.insert(
        "user-agent",
        HeaderValue::from_static(concat!("slopmax/", env!("CARGO_PKG_VERSION"))),
    );
    let body = json!({
        "model": model,
        "instructions": "Reply with OK.",
        "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
        "store": false,
        "stream": true,
    });
    let started = Instant::now();
    let response = app
        .http
        .post(format!("{}/responses", provider.api(&account)))
        .headers(provider.headers(&own, &account, false))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let now = Timestamp::now();
    if let Some(limits) = provider.limits(response.headers(), now) {
        app.pool.observe(&account.id, limits, now);
    }
    let status = response.status();
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("answered {status}"));
    }
    let decoder = Decoder::new(Dialect::Responses, &Request::default());
    let events = super::transcode::events(decoder, false, &bytes, Box::new(|_| {}));
    let usage = Answer::collect(events).usage;
    app.pool.add_usage(&account.id, &usage);
    let entry = Entry {
        at: now,
        account: account.id.clone(),
        provider: ProviderId::Codex,
        model: Some(model.to_owned()),
        status: status.as_u16(),
        input: usage.input_tokens,
        output: usage.output_tokens,
        cache_read: usage.cache_read_tokens,
        cache_write: usage.cache_write_tokens,
        ms: started.elapsed().as_millis() as u64,
        first_byte_ms: None,
        attempts: 1,
        agent: Some("slopmax".to_owned()),
        session: None,
    };
    app.record(&entry);
    Ok(())
}
