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
use crate::{fsx, human, paths, usage};

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

/// Where an account stands, most pressing first: what the status column of
/// `slopmax status` and the app shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Condition {
    /// Its sign-in stopped working; only signing in again fixes it.
    SignInNeeded(String),
    Disabled,
    /// Out of quota until then.
    Limited(Timestamp),
    /// Briefly held back by the provider.
    Throttled,
    /// Serving this many sessions.
    Active(usize),
    Ready,
}

impl Condition {
    /// How it reads, the same in every front end.
    pub fn describe(&self, now: Timestamp) -> String {
        match self {
            Self::SignInNeeded(error) => format!("sign in again ({error})"),
            Self::Disabled => "disabled".into(),
            Self::Limited(until) => format!("limited · back in {}", human::until(*until, now)),
            Self::Throttled => "throttled".into(),
            Self::Active(1) => "● active · 1 session".into(),
            Self::Active(sessions) => format!("● active · {sessions} sessions"),
            Self::Ready => "ready".into(),
        }
    }

    pub fn tone(&self) -> Tone {
        match self {
            Self::SignInNeeded(_) => Tone::Bad,
            Self::Disabled => Tone::Muted,
            Self::Limited(_) | Self::Throttled => Tone::Warn,
            Self::Active(_) | Self::Ready => Tone::Good,
        }
    }
}

/// How a front end colors a window's use or an account's condition, so
/// every one colors them alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Good,
    Muted,
    /// Worth noticing without being a problem, such as a pin.
    Accent,
    Warn,
    Bad,
}

/// A note beside an account's condition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Note {
    Pinned,
    Priority(i32),
    /// The tool whose copy of the tokens slopmax follows.
    Follows(String),
    ResetCredits(u32),
    /// Requests served, and the tokens they used.
    Served {
        requests: u64,
        tokens: u64,
    },
    LastError(String),
}

impl Note {
    pub fn describe(&self) -> String {
        match self {
            Self::Pinned => "pinned".into(),
            Self::Priority(priority) => format!("priority {priority}"),
            Self::Follows(tool) => format!("follows {tool}"),
            Self::ResetCredits(1) => "1 reset credit".into(),
            Self::ResetCredits(credits) => format!("{credits} reset credits"),
            Self::Served { requests, tokens } => {
                format!("{requests} req · {} tok", human::compact(*tokens))
            }
            Self::LastError(error) => format!("last error: {error}"),
        }
    }

    pub fn tone(&self) -> Tone {
        match self {
            Self::Pinned | Self::ResetCredits(_) => Tone::Accent,
            _ => Tone::Muted,
        }
    }
}

impl Tone {
    /// For a window's use: a warning from 70%, bad from 90%.
    pub fn of_use(used: f64) -> Self {
        match used {
            u if u >= 90.0 => Self::Bad,
            u if u >= 70.0 => Self::Warn,
            _ => Self::Good,
        }
    }
}

impl AccountReport {
    pub fn condition(&self, now: Timestamp) -> Condition {
        let state = &self.state;
        if let Some(error) = &self.auth_error {
            Condition::SignInNeeded(error.clone())
        } else if self.disabled {
            Condition::Disabled
        } else if let Some(until) = state.limited_until(now) {
            Condition::Limited(until)
        } else if state.throttled_until.is_some_and(|at| at > now) {
            Condition::Throttled
        } else if self.sessions > 0 {
            Condition::Active(self.sessions)
        } else {
            Condition::Ready
        }
    }

    /// The window covering every request over `span` (`5h`, `7d`, `30d`).
    pub fn window(&self, span: &str) -> Option<&Window> {
        shared(&self.state.limits.windows, span)
    }

    /// The longer window: the week, or for plans without one, the month.
    pub fn long_window(&self) -> Option<&Window> {
        self.window("7d").or_else(|| self.window("30d"))
    }

    /// Windows that cover one model only.
    pub fn scoped_windows(&self) -> impl Iterator<Item = &Window> {
        self.state
            .limits
            .windows
            .iter()
            .filter(|w| w.model.is_some())
    }

    /// The notes beside its condition, in the order front ends show them.
    pub fn notes(&self, now: Timestamp) -> Vec<Note> {
        let state = &self.state;
        let mut notes = Vec::new();
        if self.pinned {
            notes.push(Note::Pinned);
        }
        if self.priority != 0 {
            notes.push(Note::Priority(self.priority));
        }
        if let Some(tool) = &self.follows {
            notes.push(Note::Follows(tool.clone()));
        }
        if let Some(credits) = state.limits.reset_credits.filter(|n| *n > 0) {
            notes.push(Note::ResetCredits(credits));
        }
        if state.usage.requests > 0 {
            notes.push(Note::Served {
                requests: state.usage.requests,
                tokens: state.usage.total_tokens(),
            });
        }
        // The condition already says when sign-in failed or the account is
        // limited.
        let explained = self.auth_error.is_some() || state.limited_until(now).is_some();
        if let Some(error) = state.last_error.as_ref().filter(|_| !explained) {
            notes.push(Note::LastError(error.clone()));
        }
        notes
    }
}

impl PoolReport {
    pub fn window(&self, span: &str) -> Option<&Window> {
        shared(&self.windows, span)
    }

    pub fn long_window(&self) -> Option<&Window> {
        self.window("7d").or_else(|| self.window("30d"))
    }
}

fn shared<'a>(windows: &'a [Window], span: &str) -> Option<&'a Window> {
    windows.iter().find(|w| w.model.is_none() && w.span == span)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    #[test]
    fn conditions_put_the_most_pressing_first() {
        let now = ts(1_000);
        let mut account = Account::new(ProviderId::Codex, Tokens::default());
        account.disabled = true;
        account.auth_error = Some("refresh token rejected".into());
        let report = build(
            vec![account],
            |_| AccountState {
                throttled_until: Some(ts(1_030)),
                ..AccountState::default()
            },
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            false,
            now,
        );
        let mut account = report.accounts[0].clone();
        let condition = |a: &AccountReport| a.condition(now);
        assert!(matches!(condition(&account), Condition::SignInNeeded(_)));
        account.auth_error = None;
        assert_eq!(condition(&account), Condition::Disabled);
        account.disabled = false;
        assert_eq!(condition(&account), Condition::Throttled);
        account.state.throttled_until = None;
        account.sessions = 2;
        assert_eq!(condition(&account), Condition::Active(2));
    }

    #[test]
    fn use_turns_yellow_at_70_and_red_at_90_percent() {
        assert_eq!(Tone::of_use(69.9), Tone::Good);
        assert_eq!(Tone::of_use(70.0), Tone::Warn);
        assert_eq!(Tone::of_use(90.0), Tone::Bad);
    }
}
