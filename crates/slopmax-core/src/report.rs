//! Account status: what `slopmax status` and the app show, and what
//! `/slopmax/status` serves.

use std::collections::{BTreeMap, HashMap};

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
    /// What is worth doing before it is lost: limit resets about to lapse
    /// unredeemed, and weeks about to reset with quota to spare.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nudges: Vec<crate::notify::Event>,
}

/// A provider's working accounts (enabled and signed in) read as one: each
/// window's average use, and the soonest reset that frees capacity.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolReport {
    pub provider: ProviderId,
    pub accounts: usize,
    /// The shared windows, then those for one model (a weekly cap on one
    /// Claude model), which stop only that model's requests.
    pub windows: Vec<Window>,
    /// The account a new session would get now, when one can serve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<NextReport>,
    /// Each account's share of the pool's capacity, by id, when every
    /// plan's size is known; the windows are then weighted by it. Empty,
    /// they are a plain average of the accounts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub shares: BTreeMap<String, f64>,
}

/// Where a new session would go, and why, worded for people.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NextReport {
    pub account: String,
    pub reason: crate::pool::Reason,
    pub why: String,
}

impl Report {
    /// Adds the [nudges](crate::notify::nudges) the accounts call for now.
    pub fn with_nudges(mut self, config: &Config, now: Timestamp) -> Self {
        let subjects: Vec<crate::notify::Subject> = self
            .accounts
            .iter()
            .map(crate::notify::Subject::of)
            .collect();
        self.nudges = crate::notify::nudges(
            &subjects,
            config.redeem_expiring_credits,
            &config.plan_prices,
            now,
        )
        .into_iter()
        .map(|(_, event)| event)
        .collect();
        self
    }

    /// Says, for each pool, which account `pool` would give a new session.
    pub fn with_next(mut self, pool: &Pool, now: Timestamp) -> Self {
        for report in &mut self.pools {
            report.next = pool.next(report.provider, now).map(|next| NextReport {
                why: next.reason.text().to_owned(),
                account: next.account,
                reason: next.reason,
            });
        }
        self
    }
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
            Self::ResetCredits(1) => "1 limit reset".into(),
            Self::ResetCredits(credits) => format!("{credits} limit resets"),
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
        match state.credits_left(now) {
            0 => {}
            credits => notes.push(Note::ResetCredits(credits)),
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

    /// Windows that cover one model only.
    pub fn scoped_windows(&self) -> impl Iterator<Item = &Window> {
        self.windows.iter().filter(|w| w.model.is_some())
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
        nudges: Vec::new(),
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
    let plans: Vec<Option<&str>> = working.iter().map(|a| a.plan.as_deref()).collect();
    let shares = crate::pricing::shares(provider, &plans);
    let weights = shares.clone().unwrap_or_else(|| vec![1.0; working.len()]);
    let mut windows: Vec<Window> = limits::pooled_by(
        working
            .iter()
            .zip(&weights)
            .map(|(a, w)| (&a.state.limits, a.state.is_blocked(now), *w)),
        now,
    )
    .into_iter()
    .map(|w| Window::new(w.span, w.used, w.resets_at))
    .collect();
    // A model's own window, read as one over the accounts that report it.
    let mut scoped: Vec<(&str, &str)> = working
        .iter()
        .flat_map(|a| &a.state.limits.windows)
        .filter_map(|w| Some((w.span.as_str(), w.model.as_deref()?)))
        .collect();
    scoped.sort_unstable();
    scoped.dedup();
    for (span, model) in scoped {
        let readings: Vec<(&Window, f64)> = working
            .iter()
            .zip(&weights)
            .flat_map(|(a, w)| a.state.limits.windows.iter().map(move |win| (win, *w)))
            .filter(|(w, _)| w.span == span && w.model.as_deref() == Some(model))
            .collect();
        let weight: f64 = readings.iter().map(|r| r.1).sum();
        let used = readings
            .iter()
            .map(|(w, s)| w.used_at(now) * s)
            .sum::<f64>()
            / weight;
        let resets_at = readings
            .iter()
            .filter(|(w, _)| w.used_at(now) > 0.0)
            .filter_map(|(w, _)| w.upcoming_reset(now))
            .min();
        let mut window = Window::new(span, used, resets_at);
        window.model = Some(model.to_owned());
        windows.push(window);
    }
    let shares = shares
        .map(|shares| working.iter().map(|a| a.id.clone()).zip(shares).collect())
        .unwrap_or_default();
    Some(PoolReport {
        provider,
        accounts: working.len(),
        windows,
        next: None,
        shares,
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
        let accounts = pool.accounts();
        let polled = accounts
            .iter()
            .filter(|a| a.auth_error.is_none() && a.provider.spec().is_subscription());
        for account in polled {
            match usage::poll(&http, store, account, config.refresh_tokens).await {
                Ok((_, reading)) => pool.observe(&account.id, reading.limits, Timestamp::now()),
                Err(e) => pool.record_error(&account.id, &format!("usage poll: {e:#}")),
            }
        }
        let (state, _) = pool.snapshot(Timestamp::now());
        fsx::write_json(&paths::state_file(), &state)?;
    }
    let now = Timestamp::now();
    Ok(build(
        store.list()?,
        |id| pool.state(id),
        &pins,
        &HashMap::new(),
        config.strategy,
        false,
        now,
    )
    .with_next(&pool, now)
    .with_nudges(config, now))
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

    fn subscription(provider: ProviderId, email: &str) -> Account {
        let mut account = Account::new(provider, Tokens::default());
        account.email = Some(email.into());
        account.assign_id();
        account
    }

    fn windowed(windows: Vec<Window>) -> AccountState {
        AccountState {
            limits: Limits {
                windows,
                ..Limits::default()
            },
            ..AccountState::default()
        }
    }

    fn scoped(span: &str, model: &str, used: f64, resets_at: Option<Timestamp>) -> Window {
        let mut window = Window::new(span, used, resets_at);
        window.model = Some(model.into());
        window
    }

    fn report_of(accounts: Vec<Account>, states: HashMap<String, AccountState>) -> Report {
        build(
            accounts,
            |id| states.get(id).cloned().unwrap_or_default(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            true,
            ts(1_000),
        )
    }

    use crate::limits::Limits;

    #[test]
    fn conditions_read_the_same_in_every_front_end() {
        let now = ts(1_000);
        let cases = [
            (
                Condition::SignInNeeded("revoked".into()),
                "sign in again (revoked)",
                Tone::Bad,
            ),
            (Condition::Disabled, "disabled", Tone::Muted),
            (
                Condition::Limited(ts(1_090)),
                "limited · back in 1m30s",
                Tone::Warn,
            ),
            (Condition::Throttled, "throttled", Tone::Warn),
            (Condition::Active(1), "● active · 1 session", Tone::Good),
            (Condition::Active(3), "● active · 3 sessions", Tone::Good),
            (Condition::Ready, "ready", Tone::Good),
        ];
        for (condition, text, tone) in cases {
            assert_eq!(condition.describe(now), text);
            assert_eq!(condition.tone(), tone, "{text}");
        }
    }

    #[test]
    fn notes_read_the_same_in_every_front_end() {
        let cases = [
            (Note::Pinned, "pinned", Tone::Accent),
            (Note::Priority(-2), "priority -2", Tone::Muted),
            (
                Note::Follows("cliproxyapi".into()),
                "follows cliproxyapi",
                Tone::Muted,
            ),
            (Note::ResetCredits(1), "1 limit reset", Tone::Accent),
            (Note::ResetCredits(4), "4 limit resets", Tone::Accent),
            (
                Note::Served {
                    requests: 12,
                    tokens: 1_500_000,
                },
                "12 req · 1.5M tok",
                Tone::Muted,
            ),
            (
                Note::LastError("boom".into()),
                "last error: boom",
                Tone::Muted,
            ),
        ];
        for (note, text, tone) in cases {
            assert_eq!(note.describe(), text);
            assert_eq!(note.tone(), tone, "{text}");
        }
    }

    #[test]
    fn limits_and_idle_accounts_have_their_own_conditions() {
        let now = ts(1_000);
        let account = subscription(ProviderId::Claude, "a@x.com");
        let id = account.id.clone();
        let full = windowed(vec![Window::new("5h", 100.0, Some(ts(4_600)))]);
        let report = report_of(vec![account], HashMap::from([(id, full)]));
        let mut account = report.accounts[0].clone();
        assert_eq!(account.condition(now), Condition::Limited(ts(4_600)));
        account.state = AccountState::default();
        assert_eq!(account.condition(now), Condition::Ready);
        // A throttle that has passed no longer counts.
        account.state.throttled_until = Some(ts(900));
        assert_eq!(account.condition(now), Condition::Ready);
    }

    #[test]
    fn notes_come_in_order_and_skip_errors_the_condition_explains() {
        let now = ts(1_000);
        let mut account = subscription(ProviderId::Codex, "a@x.com");
        account.priority = 5;
        account.link = Some(crate::account::Link {
            tool: "cliproxyapi".into(),
            path: "/tmp/x.json".into(),
        });
        let id = account.id.clone();
        let mut state = AccountState::default();
        state.limits.reset_credits = Some(2);
        state.usage.requests = 3;
        state.usage.input_tokens = 1_000;
        state.usage.output_tokens = 200;
        state.last_error = Some("upstream 500".into());
        let mut pins = Pins::new();
        pins.insert(ProviderId::Codex, id.clone());
        let report = build(
            vec![account],
            |_| state.clone(),
            &pins,
            &HashMap::from([(id, 2)]),
            Strategy::FillFirst,
            true,
            now,
        );
        let mut account = report.accounts[0].clone();
        assert!(account.pinned);
        assert_eq!(account.sessions, 2);
        assert_eq!(account.follows.as_deref(), Some("cliproxyapi"));
        assert_eq!(
            account.notes(now),
            vec![
                Note::Pinned,
                Note::Priority(5),
                Note::Follows("cliproxyapi".into()),
                Note::ResetCredits(2),
                Note::Served {
                    requests: 3,
                    tokens: 1_200
                },
                Note::LastError("upstream 500".into()),
            ]
        );

        // Signed out: the condition says so, so the last error is dropped.
        account.auth_error = Some("revoked".into());
        assert!(
            !account
                .notes(now)
                .iter()
                .any(|n| matches!(n, Note::LastError(_)))
        );
        // Limited: likewise.
        account.auth_error = None;
        account.state.blocked_until = Some(ts(2_000));
        assert!(
            !account
                .notes(now)
                .iter()
                .any(|n| matches!(n, Note::LastError(_)))
        );

        // A plain account has no notes at all.
        account.state = AccountState::default();
        account.pinned = false;
        account.priority = 0;
        account.follows = None;
        assert!(account.notes(now).is_empty());
    }

    #[test]
    fn windows_are_found_by_span_and_scope() {
        let account = subscription(ProviderId::Claude, "a@x.com");
        let id = account.id.clone();
        let state = windowed(vec![
            Window::new("5h", 10.0, None),
            scoped("7d", "opus", 80.0, None),
            Window::new("30d", 30.0, None),
        ]);
        let report = report_of(vec![account], HashMap::from([(id, state)]));
        let account = &report.accounts[0];
        assert_eq!(account.window("5h").unwrap().used, 10.0);
        // The model's own weekly window is not the shared one.
        assert!(account.window("7d").is_none());
        assert_eq!(account.long_window().unwrap().span, "30d");
        let scoped: Vec<_> = account.scoped_windows().collect();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].model.as_deref(), Some("opus"));
    }

    #[test]
    fn keys_report_their_endpoint_and_models_and_get_no_pool() {
        let mut key = Account::new(
            ProviderId::Xai,
            Tokens {
                access_token: "xai-secret".into(),
                ..Tokens::default()
            },
        );
        key.assign_id();
        let mut compat = Account::new(
            ProviderId::Compat,
            Tokens {
                access_token: "k".into(),
                ..Tokens::default()
            },
        );
        compat.endpoint = Some(crate::account::Endpoint {
            base_url: "http://localhost:1234/v1".into(),
            dialect: crate::wire::Dialect::Chat,
            models: vec!["llama-*".into()],
        });
        compat.assign_id();
        let sub = subscription(ProviderId::Claude, "a@x.com");
        let report = report_of(vec![key, compat, sub], HashMap::new());

        let key = &report.accounts[0];
        assert_eq!(key.endpoint.as_deref(), Some(ProviderId::Xai.spec().api));
        assert_eq!(
            key.models,
            ProviderId::Xai
                .spec()
                .models
                .iter()
                .map(|m| m.to_string())
                .collect::<Vec<_>>()
        );
        let compat = &report.accounts[1];
        assert_eq!(compat.endpoint.as_deref(), Some("http://localhost:1234/v1"));
        assert_eq!(compat.models, ["llama-*"]);
        let sub = &report.accounts[2];
        assert!(sub.endpoint.is_none());
        assert!(sub.models.is_empty());

        // Only subscriptions are pooled, and only those with an account.
        assert_eq!(report.pools.len(), 1);
        assert_eq!(report.pools[0].provider, ProviderId::Claude);
        assert!(report.live);
        assert_eq!(report.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn pools_average_working_accounts_and_their_model_windows() {
        let now = ts(1_000);
        let a = subscription(ProviderId::Claude, "a@x.com");
        let b = subscription(ProviderId::Claude, "b@x.com");
        let mut off = subscription(ProviderId::Claude, "off@x.com");
        off.disabled = true;
        let mut out = subscription(ProviderId::Claude, "out@x.com");
        out.auth_error = Some("revoked".into());
        let states = HashMap::from([
            (
                a.id.clone(),
                windowed(vec![
                    Window::new("5h", 20.0, Some(ts(5_000))),
                    Window::new("7d", 50.0, Some(ts(90_000))),
                    scoped("7d", "opus", 60.0, Some(ts(80_000))),
                ]),
            ),
            (
                b.id.clone(),
                windowed(vec![
                    Window::new("5h", 40.0, Some(ts(3_000))),
                    Window::new("7d", 30.0, Some(ts(70_000))),
                    // Already reset: counts as unused, and its reset is past.
                    scoped("7d", "opus", 90.0, Some(ts(500))),
                ]),
            ),
            // Neither of these may sway the pool.
            (
                off.id.clone(),
                windowed(vec![Window::new("5h", 100.0, None)]),
            ),
            (
                out.id.clone(),
                windowed(vec![Window::new("5h", 100.0, None)]),
            ),
        ]);
        let report = report_of(vec![a, b, off, out], states);
        assert_eq!(report.pools.len(), 1);
        let pool = &report.pools[0];
        assert_eq!(pool.accounts, 2);
        assert_eq!(pool.window("5h").unwrap().used, 30.0);
        assert_eq!(pool.long_window().unwrap().span, "7d");
        let opus: Vec<_> = pool.scoped_windows().collect();
        assert_eq!(opus.len(), 1);
        assert_eq!(opus[0].model.as_deref(), Some("opus"));
        assert_eq!(opus[0].used, 30.0);
        assert_eq!(opus[0].resets_at, Some(ts(80_000)));
        assert!(opus[0].used_at(now) > 0.0);

        // A pool with only a monthly window reads it as the long one.
        let c = subscription(ProviderId::Codex, "c@x.com");
        let id = c.id.clone();
        let report = report_of(
            vec![c],
            HashMap::from([(id, windowed(vec![Window::new("30d", 10.0, None)]))]),
        );
        assert_eq!(report.pools[0].long_window().unwrap().span, "30d");
    }

    #[test]
    fn a_pool_with_no_working_account_is_left_out() {
        let mut off = subscription(ProviderId::Codex, "off@x.com");
        off.disabled = true;
        let report = report_of(vec![off], HashMap::new());
        assert!(report.pools.is_empty());
    }

    #[test]
    fn with_next_names_the_account_a_new_session_gets_and_why() {
        let now = Timestamp::now();
        let a = subscription(ProviderId::Claude, "a@x.com");
        let id = a.id.clone();
        let pool = Pool::new(
            Strategy::FillFirst,
            SignedDuration::from_hours(1),
            State::default(),
        );
        pool.sync(vec![a.clone()], Pins::new());
        let report = build(
            vec![a],
            |id| pool.state(id),
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            false,
            now,
        )
        .with_next(&pool, now);
        let next = report.pools[0].next.as_ref().unwrap();
        assert_eq!(next.account, id);
        assert_eq!(next.why, next.reason.text());
    }

    #[test]
    fn reports_survive_a_json_round_trip() {
        let account = subscription(ProviderId::Claude, "a@x.com");
        let id = account.id.clone();
        let state = windowed(vec![
            Window::new("5h", 25.0, Some(ts(5_000))),
            scoped("7d", "opus", 60.0, None),
        ]);
        let report = report_of(vec![account], HashMap::from([(id, state)]));
        let json = serde_json::to_string(&report).unwrap();
        let back: Report = serde_json::from_str(&json).unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].email.as_deref(), Some("a@x.com"));
        assert_eq!(back.accounts[0].state.limits.windows.len(), 2);
        assert_eq!(back.pools[0].windows.len(), report.pools[0].windows.len());
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}
