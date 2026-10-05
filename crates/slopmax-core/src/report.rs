//! Account status: what `slopmax status` and the app show, and what
//! `/slopmax/status` serves.

use std::collections::HashMap;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::account::{Account, Store};
use crate::auth;
use crate::config::{Config, Strategy};
use crate::limits::{self, Window};
use crate::net::Origins;
use crate::pool::{AccountState, Pins, Pool, State};
use crate::provider::ProviderId;
use crate::time::{SignedDuration, Timestamp};
use crate::{fsx, paths, usage};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub version: String,
    pub strategy: Strategy,
    /// Whether this came from a running proxy (live sessions and state).
    pub live: bool,
    pub generated_at: Timestamp,
    pub accounts: Vec<AccountReport>,
    /// Each subscription's working accounts read as one, as agents see them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pools: Vec<PoolReport>,
}

/// A provider's working accounts (enabled and signed in) read as one: each
/// window's average use, and the soonest reset that frees capacity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolReport {
    pub provider: ProviderId,
    pub accounts: usize,
    pub windows: Vec<Window>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountReport {
    pub id: String,
    pub provider: ProviderId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub disabled: bool,
    pub priority: i32,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_error: Option<String>,
    /// The tool whose copy of the tokens slopmax follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<Timestamp>,
    /// For keys and endpoints: where requests go and the models served.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    pub sessions: usize,
    pub state: AccountState,
}

pub fn build(
    accounts: Vec<Account>,
    state_of: impl Fn(&str) -> AccountState,
    pins: &Pins,
    sessions: &HashMap<String, usize>,
    strategy: Strategy,
    live: bool,
    now: Timestamp,
) -> Report {
    let accounts: Vec<AccountReport> = accounts
        .into_iter()
        .map(|a| AccountReport {
            endpoint: (!a.provider.spec().is_subscription())
                .then(|| a.provider.get().api(&a).to_owned()),
            models: match &a.endpoint {
                Some(endpoint) => endpoint.models.clone(),
                None if !a.provider.spec().is_subscription() => a
                    .provider
                    .spec()
                    .models
                    .iter()
                    .map(|m| m.to_string())
                    .collect(),
                None => Vec::new(),
            },
            name: a.name(),
            pinned: pins.get(&a.provider) == Some(&a.id),
            sessions: sessions.get(&a.id).copied().unwrap_or(0),
            state: state_of(&a.id),
            token_expires_at: a.tokens.expires_at,
            id: a.id,
            provider: a.provider,
            email: a.email,
            plan: a.plan,
            disabled: a.disabled,
            priority: a.priority,
            auth_error: a.auth_error,
            follows: a.link.map(|link| link.tool),
        })
        .collect();
    let pools = ProviderId::ALL
        .into_iter()
        .filter(|p| p.spec().is_subscription())
        .filter_map(|p| pool(p, &accounts, now))
        .collect();
    Report {
        version: env!("CARGO_PKG_VERSION").into(),
        strategy,
        live,
        generated_at: now,
        accounts,
        pools,
    }
}

/// See [`limits::pooled`].
fn pool(provider: ProviderId, accounts: &[AccountReport], now: Timestamp) -> Option<PoolReport> {
    let working: Vec<&AccountReport> = accounts
        .iter()
        .filter(|a| a.provider == provider && !a.disabled && a.auth_error.is_none())
        .collect();
    if working.is_empty() {
        return None;
    }
    let windows = limits::pooled(
        working
            .iter()
            .map(|a| (&a.state.limits, a.state.is_blocked(now))),
        now,
    )
    .into_iter()
    .map(|w| Window::new(w.span, w.used, w.resets_at))
    .collect();
    Some(PoolReport {
        provider,
        accounts: working.len(),
        windows,
    })
}

/// The report from disk when no proxy is running, after polling the
/// providers directly with `refresh`. Failed polls show as the account's
/// last error.
pub async fn offline(config: &Config, store: &Store, refresh: bool) -> Result<Report> {
    let state: State = fsx::read_json(&paths::state_file())?.unwrap_or_default();
    let pins: Pins = fsx::read_json(&paths::pins_file())?.unwrap_or_default();
    let pool = Pool::new(config.strategy, SignedDuration::from_hours(1), state);
    pool.sync(store.list()?, pins.clone());
    if refresh {
        let http = auth::http_client(Origins::default());
        let polled = pool
            .accounts()
            .into_iter()
            .filter(|a| a.auth_error.is_none() && a.provider.spec().is_subscription());
        for account in polled {
            match usage::poll(&http, store, &account, config.refresh_tokens).await {
                Ok((_, reading)) => pool.observe(&account.id, reading.limits, Timestamp::now()),
                Err(e) => pool.record_error(&account.id, &format!("usage poll: {e:#}")),
            }
        }
        let (state, _) = pool.snapshot(Timestamp::now());
        fsx::write_json(&paths::state_file(), &state)?;
    }
    Ok(build(
        store.list()?,
        |id| pool.state(id),
        &pins,
        &HashMap::new(),
        config.strategy,
        false,
        Timestamp::now(),
    ))
}
