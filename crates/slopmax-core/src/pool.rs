//! The runtime account pool: health, session affinity, and selection.
//!
//! Selection is a pure function of in-memory state, so it is fast and easy
//! to test. Credentials are re-read from the store per request; the pool only
//! tracks which account to use and why.
//!
//! Two decisions are kept separate, because conflating them is expensive:
//!
//! - **Placement** picks an account for a new session using the strategy.
//! - **Eviction** moves an existing session only when its account can no
//!   longer serve (refused, exhausted, disabled, or signed out). Moving a
//!   session merely because another account looks cooler throws away the
//!   provider-side prompt cache, which costs far more than it saves.
//!
//! Session affinity can be turned off, for the whole proxy or one request.
//! Every request is then placed afresh, which spreads load at the cost of
//! the cache, but the session's last account is still remembered: state
//! another account minted must be dropped when a request lands elsewhere.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::account::Account;
use crate::config::Strategy;
use crate::limits::{Limits, PoolWindow, UNKNOWN_SCORE};
use crate::provider::ProviderId;
use crate::provider::credits::Credit;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Usage;

/// How long to sit out an account after a quota refusal without a reset time.
pub const DEFAULT_BLOCK: SignedDuration = SignedDuration::from_mins(5);
/// How long to sit out an account after short-term throttling.
pub const DEFAULT_THROTTLE: SignedDuration = SignedDuration::from_secs(30);

/// A block that applies to one model only, e.g. an overage-only cap.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelBlock {
    pub model: String,
    pub until: Timestamp,
}

/// What the proxy has learned about one account. Persisted between runs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccountState {
    #[serde(default)]
    pub limits: Limits,
    /// Quota refused: skip the account until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_until: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_blocks: Vec<ModelBlock>,
    /// Briefly throttled; other accounts are preferred until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub throttled_until: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default)]
    pub usage: Usage,
    /// Its reset credits as last listed, for providers that grant them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<CreditList>,
}

/// An account's reset credits as listed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreditList {
    /// Unspent, soonest-expiring first.
    pub credits: Vec<Credit>,
    pub listed_at: Timestamp,
    /// The count its usage reported when they were listed: a new count
    /// means one came or went since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub counted: Option<u32>,
}

impl AccountState {
    /// Its reset credits that have not expired: from the list, once there
    /// is one, else the count its usage reports.
    pub fn credits_left(&self, now: Timestamp) -> u32 {
        match &self.credits {
            Some(_) => self.unexpired_credits(now).count() as u32,
            None => self.limits.reset_credits.unwrap_or(0),
        }
    }

    /// The listed credits that have not expired, soonest-expiring first.
    pub fn unexpired_credits(&self, now: Timestamp) -> impl Iterator<Item = &Credit> {
        self.credits
            .iter()
            .flat_map(|list| &list.credits)
            .filter(move |c| c.expires_at.is_none_or(|at| at > now))
    }

    /// When the account can serve `model` again, or `Ok` if it can now.
    fn blocked(&self, model: Option<&str>, now: Timestamp) -> Result<(), Timestamp> {
        let model_block = self
            .model_blocks
            .iter()
            .filter(|b| model.is_some_and(|m| m == b.model))
            .map(|b| b.until);
        let quota = self.limits.is_exhausted(now).then(|| {
            self.limits
                .exhausted_until(now)
                .unwrap_or(now + DEFAULT_BLOCK)
        });
        let until = [self.blocked_until, self.throttled_until, quota]
            .into_iter()
            .flatten()
            .chain(model_block)
            .filter(|at| *at > now)
            .max();
        until.map_or(Ok(()), Err)
    }

    /// Whether the account is sitting out for quota reasons (not throttling).
    pub fn is_blocked(&self, now: Timestamp) -> bool {
        self.blocked_until.is_some_and(|at| at > now) || self.limits.is_exhausted(now)
    }

    /// When an account sitting out for quota reasons is expected back.
    pub fn limited_until(&self, now: Timestamp) -> Option<Timestamp> {
        let block = self.blocked_until.filter(|at| *at > now);
        let quota = self.limits.is_exhausted(now).then(|| {
            self.limits
                .exhausted_until(now)
                .unwrap_or(now + DEFAULT_BLOCK)
        });
        block.max(quota)
    }
}

/// Persisted runtime state: per-account health and live sessions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountState>,
    /// Kept so a restart does not move sessions (and lose their caches).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sessions: Vec<SavedSession>,
    /// Each provider's own client, as its user agent was last seen in a
    /// request: Claude answers its limit resets to Claude Code alone.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agents: BTreeMap<ProviderId, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedSession {
    provider: ProviderId,
    session: String,
    account: String,
    last_used: Timestamp,
}

/// Manual account preference per provider, set by `slopmax use`.
pub type Pins = BTreeMap<ProviderId, String>;

#[derive(Debug, Clone)]
struct Binding {
    account: String,
    last_used: Timestamp,
}

/// How the pool places requests; the config's, and changed with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Routing {
    pub strategy: Strategy,
    /// How long a session is remembered after its last request.
    pub session_ttl: SignedDuration,
    /// Whether a session stays on its account while that account can serve.
    pub affinity: bool,
}

impl Routing {
    pub fn of(config: &crate::config::Config) -> Self {
        Self {
            strategy: config.strategy,
            session_ttl: SignedDuration::from_mins(config.session_ttl_mins as i64),
            affinity: config.session_affinity,
        }
    }
}

/// A request for an account.
#[derive(Debug, Clone, Copy)]
pub struct Pick<'a> {
    pub provider: ProviderId,
    /// Conversation id from the agent, used to keep a session on one account.
    pub session: Option<&'a str>,
    /// The request's own say on session affinity, over the pool's.
    pub affinity: Option<bool>,
    /// An agent's housekeeping (listing models, counting tokens) rather
    /// than work: it takes no turn from round-robin.
    pub housekeeping: bool,
    pub model: Option<&'a str>,
    /// The accounts that may serve it, when routing narrowed them down.
    pub candidates: Option<&'a [String]>,
    /// Accounts already tried for this request.
    pub exclude: &'a [String],
}

/// The account chosen for a request.
#[derive(Debug, Clone)]
pub struct Choice {
    pub account: Account,
    /// The account this session used before, when the pick moved it.
    /// Account-bound state in the request (e.g. encrypted reasoning) must
    /// then be dropped.
    pub moved_from: Option<String>,
}

/// The account a new session would get now, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Next {
    pub account: String,
    pub reason: Reason,
}

/// Why placement would choose an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Reason {
    /// Chosen with `slopmax use`.
    Pinned,
    /// No other account of the provider can serve.
    OnlyReady,
    /// Its used quota resets soonest (reset-first).
    ResetsSoonest,
    /// The oldest in the top priority tier (fill-first).
    FirstInOrder,
    /// The most room left (least-used, or reset-first among idle ones).
    MostRoom,
    /// Handed a request longest ago (round-robin).
    NextInTurn,
}

impl Reason {
    /// Why, in a phrase for people.
    pub fn text(self) -> &'static str {
        match self {
            Self::Pinned => "pinned for new sessions",
            Self::OnlyReady => "the only account ready",
            Self::ResetsSoonest => "its quota resets soonest",
            Self::FirstInOrder => "first in priority order",
            Self::MostRoom => "the most room left",
            Self::NextInTurn => "next in turn",
        }
    }
}

/// No account can serve the request right now.
#[derive(Debug, Clone, PartialEq)]
pub struct Unavailable {
    /// The earliest time some account is expected back, if any.
    pub until: Option<Timestamp>,
    pub reason: String,
}

#[derive(Debug, Default)]
struct Inner {
    accounts: Vec<Account>,
    states: HashMap<String, AccountState>,
    sessions: HashMap<(ProviderId, String), Binding>,
    pins: Pins,
    agents: BTreeMap<ProviderId, String>,
    /// When each account was last handed a request, as a count of picks:
    /// round-robin hands the next to the one handed one longest ago.
    picked: HashMap<String, u64>,
    picks: u64,
    dirty: bool,
}

/// Thread-safe pool shared by the proxy and its background tasks.
#[derive(Debug)]
pub struct Pool {
    routing: Mutex<Routing>,
    inner: Mutex<Inner>,
}

impl Pool {
    pub fn new(strategy: Strategy, session_ttl: SignedDuration, state: State) -> Self {
        let now = Timestamp::now();
        let sessions = state
            .sessions
            .into_iter()
            .filter(|s| now.duration_since(s.last_used) < session_ttl)
            .map(|s| {
                let binding = Binding {
                    account: s.account,
                    last_used: s.last_used,
                };
                ((s.provider, s.session), binding)
            })
            .collect();
        let inner = Inner {
            states: state.accounts.into_iter().collect(),
            sessions,
            agents: state.agents,
            ..Inner::default()
        };
        Self {
            routing: Mutex::new(Routing {
                strategy,
                session_ttl,
                affinity: true,
            }),
            inner: Mutex::new(inner),
        }
    }

    pub fn routing(&self) -> Routing {
        *self.routing.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Places requests from now on as `routing` says. Sessions already
    /// bound keep their accounts, if affinity is still on.
    pub fn set_routing(&self, routing: Routing) {
        *self.routing.lock().unwrap_or_else(|p| p.into_inner()) = routing;
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Replaces the account list (from disk) and pins. Sessions bound to a
    /// removed account, or to a provider whose pin changed, are released.
    pub fn sync(&self, accounts: Vec<Account>, pins: Pins) {
        let mut inner = self.lock();
        let changed_pins: Vec<ProviderId> = ProviderId::ALL
            .into_iter()
            .filter(|p| inner.pins.get(p) != pins.get(p))
            .collect();
        let ids: Vec<&str> = accounts.iter().map(|a| a.id.as_str()).collect();
        inner.sessions.retain(|(provider, _), binding| {
            ids.contains(&binding.account.as_str()) && !changed_pins.contains(provider)
        });
        inner.accounts = accounts;
        inner.pins = pins;
    }

    pub fn accounts(&self) -> Vec<Account> {
        self.lock().accounts.clone()
    }

    pub fn pins(&self) -> Pins {
        self.lock().pins.clone()
    }

    /// The user agent of `provider`'s own client, as last seen in a request.
    pub fn agent(&self, provider: ProviderId) -> Option<String> {
        self.lock().agents.get(&provider).cloned()
    }

    /// Notes the user agent of a request from `provider`'s own client.
    pub fn saw_agent(&self, provider: ProviderId, agent: &str) {
        let mut inner = self.lock();
        if inner.agents.get(&provider).map(String::as_str) != Some(agent) {
            inner.agents.insert(provider, agent.to_owned());
            inner.dirty = true;
        }
    }

    /// Chooses an account for a request.
    pub fn pick(&self, req: &Pick, now: Timestamp) -> Result<Choice, Unavailable> {
        let routing = self.routing();
        let mut inner = self.lock();
        let session_key = req.session.map(|s| (req.provider, s.to_owned()));
        // The account the session used last, kept to even when affinity is
        // off, to tell whether the request moved.
        let bound = session_key
            .as_ref()
            .and_then(|key| inner.sessions.get(key))
            .filter(|b| now.duration_since(b.last_used) < routing.session_ttl)
            .map(|b| b.account.clone());
        let sticky = req.affinity.unwrap_or(routing.affinity);

        let usable: Vec<&Account> = inner
            .accounts
            .iter()
            .filter(|a| a.provider == req.provider && !a.disabled && a.auth_error.is_none())
            .filter(|a| req.candidates.is_none_or(|c| c.contains(&a.id)))
            .collect();
        if usable.is_empty() {
            let reason = if inner.accounts.iter().any(|a| a.provider == req.provider) {
                format!("every {} account is disabled or signed out", req.provider)
            } else {
                format!(
                    "no {} accounts connected; run `slopmax login {}`",
                    req.provider, req.provider
                )
            };
            return Err(Unavailable {
                until: None,
                reason,
            });
        }

        // Accounts already tried for this request are skipped, but their
        // blocks still count toward when the pool frees up again.
        let state_of = |id: &str| inner.states.get(id).cloned().unwrap_or_default();
        let mut ready = Vec::new();
        let mut soonest: Option<Timestamp> = None;
        for account in usable {
            match state_of(&account.id).blocked(req.model, now) {
                Ok(()) if !req.exclude.contains(&account.id) => ready.push(account),
                Ok(()) => {}
                Err(until) => soonest = Some(soonest.map_or(until, |s| s.min(until))),
            }
        }

        // Keep the session where it is whenever its account can still serve.
        let chosen = bound
            .as_deref()
            .filter(|_| sticky)
            .and_then(|id| ready.iter().find(|a| a.id == id))
            .or_else(|| {
                let pinned = inner.pins.get(&req.provider)?;
                ready.iter().find(|a| &a.id == pinned)
            })
            .copied()
            .or_else(|| place(routing.strategy, &ready, &inner, now));

        let Some(account) = chosen.cloned() else {
            let reason = match soonest {
                Some(_) => format!("every {} account is rate limited", req.provider),
                None => format!("every {} account failed this request", req.provider),
            };
            return Err(Unavailable {
                until: soonest,
                reason,
            });
        };
        let moved_from = bound.filter(|id| *id != account.id);
        if !req.housekeeping {
            inner.picks += 1;
            let picks = inner.picks;
            inner.picked.insert(account.id.clone(), picks);
        }
        if let Some(key) = session_key {
            inner.sessions.insert(
                key,
                Binding {
                    account: account.id.clone(),
                    last_used: now,
                },
            );
            inner.dirty = true;
        }
        Ok(Choice {
            account,
            moved_from,
        })
    }

    /// The account a new session of `provider` would get now, and why;
    /// `None` when none can serve. Nothing changes: this is what `pick`
    /// would do for a request with no session.
    pub fn next(&self, provider: ProviderId, now: Timestamp) -> Option<Next> {
        let strategy = self.routing().strategy;
        let inner = self.lock();
        let ready: Vec<&Account> = inner
            .accounts
            .iter()
            .filter(|a| a.provider == provider && !a.disabled && a.auth_error.is_none())
            .filter(|a| {
                inner
                    .states
                    .get(&a.id)
                    .is_none_or(|s| s.blocked(None, now).is_ok())
            })
            .collect();
        let next = |account: &Account, reason| {
            Some(Next {
                account: account.id.clone(),
                reason,
            })
        };
        if let Some(pinned) = inner.pins.get(&provider)
            && let Some(account) = ready.iter().find(|a| &a.id == pinned)
        {
            return next(account, Reason::Pinned);
        }
        let chosen = place(strategy, &ready, &inner, now)?;
        let top = ready
            .iter()
            .filter(|a| a.priority == chosen.priority)
            .count();
        let reason = match strategy {
            _ if top == 1 => Reason::OnlyReady,
            Strategy::ResetFirst => {
                let limits = inner.states.get(&chosen.id).map(|s| &s.limits);
                match limits.and_then(|l| l.expiring_at(now)) {
                    Some(_) => Reason::ResetsSoonest,
                    None => Reason::MostRoom,
                }
            }
            Strategy::FillFirst => Reason::FirstInOrder,
            Strategy::LeastUsed => Reason::MostRoom,
            Strategy::RoundRobin => Reason::NextInTurn,
        };
        next(chosen, reason)
    }

    /// Records a successful request: binds the session and clears throttling.
    pub fn record_success(&self, id: &str, now: Timestamp) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.last_used = Some(now);
        state.throttled_until = None;
        state.last_error = None;
        inner.dirty = true;
    }

    /// Folds a usage reading into the account's limits.
    pub fn observe(&self, id: &str, limits: Limits, now: Timestamp) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.limits.merge(limits);
        // A fresh reading below the limit proves an earlier block has lifted,
        // often well before the advertised reset.
        if state.blocked_until.is_some() && !state.limits.is_exhausted(now) {
            state.blocked_until = None;
        }
        inner.dirty = true;
    }

    /// Sits an account out after a quota refusal. Deadlines only extend.
    pub fn block(&self, id: &str, until: Timestamp, model: Option<&str>, reason: &str) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        match model {
            Some(model) => {
                state
                    .model_blocks
                    .retain(|b| b.model != model || b.until > until);
                if !state.model_blocks.iter().any(|b| b.model == model) {
                    state.model_blocks.push(ModelBlock {
                        model: model.to_owned(),
                        until,
                    });
                }
            }
            None => state.blocked_until = state.blocked_until.max(Some(until)),
        }
        state.last_error = Some(reason.to_owned());
        inner.dirty = true;
    }

    /// Briefly prefers other accounts after throttling.
    pub fn throttle(&self, id: &str, until: Timestamp) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.throttled_until = state.throttled_until.max(Some(until));
        inner.dirty = true;
    }

    /// Notes a non-quota failure for display.
    pub fn record_error(&self, id: &str, error: &str) {
        let mut inner = self.lock();
        inner.states.entry(id.to_owned()).or_default().last_error = Some(error.to_owned());
        inner.dirty = true;
    }

    /// Records the account's reset credits as just listed.
    pub fn record_credits(&self, id: &str, credits: Vec<Credit>, now: Timestamp) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.credits = Some(CreditList {
            credits,
            listed_at: now,
            counted: state.limits.reset_credits,
        });
        inner.dirty = true;
    }

    /// Records that an account's windows were just reset by redeeming
    /// `credit`, or one the provider chose: lifts every block and zeroes its
    /// usage until the next reading, and takes the credit off its list.
    pub fn record_reset(&self, id: &str, now: Timestamp, credit: Option<&str>) {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.blocked_until = None;
        state.model_blocks.clear();
        state.throttled_until = None;
        state.last_error = None;
        for window in &mut state.limits.windows {
            window.used = 0.0;
            window.resets_at = None;
        }
        state.limits.observed_at = Some(now);
        if let Some(credits) = &mut state.limits.reset_credits {
            *credits = credits.saturating_sub(1);
        }
        if let Some(list) = &mut state.credits {
            match credit.and_then(|id| list.credits.iter().position(|c| c.id == id)) {
                Some(i) => {
                    list.credits.remove(i);
                    list.counted = list.counted.map(|n| n.saturating_sub(1));
                }
                // Which one went is unknown, so the list is due again.
                None => list.counted = None,
            }
        }
        inner.dirty = true;
    }

    /// Lifts the account's blocks and throttling, so the next request tries
    /// it again; a refusal sets it aside anew if its quota is still spent.
    /// Returns the models whose blocks were lifted.
    pub fn clear_blocks(&self, id: &str) -> Vec<String> {
        let mut inner = self.lock();
        let state = inner.states.entry(id.to_owned()).or_default();
        state.blocked_until = None;
        state.throttled_until = None;
        let models = std::mem::take(&mut state.model_blocks)
            .into_iter()
            .map(|b| b.model)
            .collect();
        inner.dirty = true;
        models
    }

    pub fn add_usage(&self, id: &str, usage: &Usage) {
        let mut inner = self.lock();
        inner
            .states
            .entry(id.to_owned())
            .or_default()
            .usage
            .add(usage);
        inner.dirty = true;
    }

    /// The provider's working accounts read as one account: see
    /// [`limits::pooled`](crate::limits::pooled).
    pub fn pooled(&self, provider: ProviderId, now: Timestamp) -> Vec<PoolWindow> {
        let inner = self.lock();
        let unknown = AccountState::default();
        let accounts = inner
            .accounts
            .iter()
            .filter(|a| a.provider == provider && !a.disabled && a.auth_error.is_none())
            .map(|a| {
                let state = inner.states.get(&a.id).unwrap_or(&unknown);
                (&state.limits, state.is_blocked(now))
            });
        crate::limits::pooled(accounts, now)
    }

    pub fn state(&self, id: &str) -> AccountState {
        self.lock().states.get(id).cloned().unwrap_or_default()
    }

    /// A copy of all state, plus whether it changed since the last call.
    pub fn snapshot(&self, now: Timestamp) -> (State, bool) {
        let mut guard = self.lock();
        let inner = &mut *guard;
        let dirty = std::mem::take(&mut inner.dirty);
        // Before the first sync every account is unknown; keep all state.
        let known =
            |id: &str| inner.accounts.is_empty() || inner.accounts.iter().any(|a| a.id == id);
        let mut accounts = BTreeMap::new();
        for (id, state) in &mut inner.states {
            state.model_blocks.retain(|b| b.until > now);
            if known(id) {
                accounts.insert(id.clone(), state.clone());
            }
        }
        let ttl = self.routing().session_ttl;
        inner
            .sessions
            .retain(|_, b| now.duration_since(b.last_used) < ttl);
        let sessions = inner
            .sessions
            .iter()
            .map(|((provider, session), b)| SavedSession {
                provider: *provider,
                session: session.clone(),
                account: b.account.clone(),
                last_used: b.last_used,
            })
            .collect();
        let agents = inner.agents.clone();
        (
            State {
                accounts,
                sessions,
                agents,
            },
            dirty,
        )
    }

    /// The account each live session is bound to, for display.
    pub fn session_counts(&self, now: Timestamp) -> HashMap<String, usize> {
        let ttl = self.routing().session_ttl;
        let inner = self.lock();
        let mut counts = HashMap::new();
        for binding in inner.sessions.values() {
            if now.duration_since(binding.last_used) < ttl {
                *counts.entry(binding.account.clone()).or_default() += 1;
            }
        }
        counts
    }
}

/// Placement for a session without a usable binding.
fn place<'a>(
    strategy: Strategy,
    ready: &[&'a Account],
    inner: &Inner,
    now: Timestamp,
) -> Option<&'a Account> {
    let states = &inner.states;
    let top = ready.iter().map(|a| a.priority).max()?;
    let tier = ready.iter().copied().filter(|a| a.priority == top);
    let limits = |a: &Account| {
        states
            .get(&a.id)
            .map(|s| s.limits.clone())
            .unwrap_or_default()
    };
    let last_used = |a: &Account| states.get(&a.id).and_then(|s| s.last_used);
    let score = |a: &Account| Score(limits(a).score(now));

    match strategy {
        // Store order is priority then age, so the first ready account is
        // the one to keep filling.
        Strategy::FillFirst => tier.min_by_key(|a| a.added_at),
        // Earliest-deadline-first over spare capacity: an account whose
        // window resets soon loses its unused quota at that reset, while an
        // idle account loses nothing by waiting. Ties go to the less used.
        Strategy::ResetFirst => tier.min_by_key(|a| {
            let deadline = limits(a).expiring_at(now).unwrap_or(Timestamp::MAX);
            (deadline, score(a), last_used(a))
        }),
        Strategy::LeastUsed => tier.min_by_key(|a| (score(a), last_used(a))),
        // Each in turn: the one handed a request longest ago, oldest
        // account first among those never handed one.
        Strategy::RoundRobin => {
            tier.min_by_key(|a| (inner.picked.get(&a.id).copied().unwrap_or(0), a.added_at))
        }
    }
}

/// Total order over usage scores (they are finite by construction).
#[derive(Debug, Clone, Copy)]
struct Score(f64);

impl PartialEq for Score {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other).is_eq()
    }
}

impl Eq for Score {}

impl PartialOrd for Score {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Score {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

/// Whether an account has never been measured.
pub fn is_unmeasured(state: &AccountState, now: Timestamp) -> bool {
    state.limits.score(now) >= UNKNOWN_SCORE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::Tokens;
    use crate::limits::Window;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn account(provider: ProviderId, org: &str, added: i64) -> Account {
        let mut account = Account::new(provider, Tokens::default());
        account.org_id = Some(org.into());
        account.account_id = Some(org.into());
        account.added_at = ts(added);
        account.assign_id();
        account
    }

    fn window(span: &str, used: f64, resets: Option<i64>) -> Window {
        Window {
            span: span.into(),
            model: None,
            used,
            resets_at: resets.map(ts),
        }
    }

    fn limits(windows: Vec<Window>) -> Limits {
        Limits {
            windows,
            observed_at: Some(ts(1000)),
            reset_credits: None,
        }
    }

    fn pool(strategy: Strategy, accounts: &[&Account]) -> Pool {
        let pool = Pool::new(strategy, SignedDuration::from_hours(1), State::default());
        pool.sync(accounts.iter().map(|a| (*a).clone()).collect(), Pins::new());
        pool
    }

    fn pick(pool: &Pool, session: Option<&str>, now: i64) -> Result<String, Unavailable> {
        let req = Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session,
            model: None,
            candidates: None,
            exclude: &[],
        };
        pool.pick(&req, ts(now)).map(|c| c.account.id)
    }

    #[test]
    fn round_robin_takes_turns_within_the_top_tier() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let mut reserve = account(ProviderId::Claude, "c", 3);
        reserve.priority = -1;
        let pool = pool(Strategy::RoundRobin, &[&a, &b, &reserve]);
        let turns: Vec<String> = (0..4).map(|_| pick(&pool, None, 1000).unwrap()).collect();
        assert_eq!(
            turns,
            [a.id.clone(), b.id.clone(), a.id.clone(), b.id.clone()]
        );
        // The reserve tier serves only once the top tier cannot.
        pool.block(&a.id, ts(5000), None, "limit");
        pool.block(&b.id, ts(5000), None, "limit");
        assert_eq!(pick(&pool, None, 1000).unwrap(), reserve.id);
    }

    #[test]
    fn next_says_who_a_new_session_would_get_and_why() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::ResetFirst, &[&a, &b]);
        let next = |pool: &Pool| pool.next(ProviderId::Claude, ts(1000)).unwrap();
        // Neither has a window running: the less used, as placement does.
        assert_eq!(next(&pool).reason, Reason::MostRoom);
        pool.observe(
            &b.id,
            limits(vec![window("5h", 40.0, Some(1000 + 3600))]),
            ts(1000),
        );
        assert_eq!(
            next(&pool),
            Next {
                account: b.id.clone(),
                reason: Reason::ResetsSoonest
            }
        );
        // Previewing changes nothing: the pick agrees.
        assert_eq!(pick(&pool, Some("s"), 1000).unwrap(), b.id);
        pool.block(&b.id, ts(5000), None, "limit");
        assert_eq!(next(&pool).reason, Reason::OnlyReady);
        pool.sync(
            vec![a.clone(), b.clone()],
            Pins::from([(ProviderId::Claude, a.id.clone())]),
        );
        assert_eq!(next(&pool).reason, Reason::Pinned);
        pool.block(&a.id, ts(5000), None, "limit");
        assert!(pool.next(ProviderId::Claude, ts(1000)).is_none());
        assert!(pool.next(ProviderId::Codex, ts(1000)).is_none());
    }

    #[test]
    fn without_affinity_a_session_is_placed_afresh_but_its_move_is_known() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::RoundRobin, &[&a, &b]);
        let routing = Routing {
            affinity: false,
            ..pool.routing()
        };
        pool.set_routing(routing);
        let req = |affinity| Pick {
            provider: ProviderId::Claude,
            affinity,
            housekeeping: false,
            session: Some("s"),
            model: None,
            candidates: None,
            exclude: &[],
        };
        let first = pool.pick(&req(None), ts(1000)).unwrap();
        assert_eq!((first.account.id, first.moved_from), (a.id.clone(), None));
        // Placed afresh, on the next account, which must drop the first's
        // state.
        let second = pool.pick(&req(None), ts(1001)).unwrap();
        assert_eq!(second.account.id, b.id);
        assert_eq!(second.moved_from, Some(a.id.clone()));
        // The request may ask for affinity anyway.
        let third = pool.pick(&req(Some(true)), ts(1002)).unwrap();
        assert_eq!((third.account.id, third.moved_from), (b.id.clone(), None));
    }

    #[test]
    fn a_shorter_session_ttl_forgets_sessions_sooner() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::RoundRobin, &[&a, &b]);
        assert_eq!(pick(&pool, Some("s"), 1000).unwrap(), a.id);
        pool.set_routing(Routing {
            session_ttl: SignedDuration::from_mins(1),
            ..pool.routing()
        });
        // Within a minute the session keeps its account; after, it is new.
        assert_eq!(pick(&pool, Some("s"), 1030).unwrap(), a.id);
        assert_eq!(pick(&pool, Some("s"), 1200).unwrap(), b.id);
        assert_eq!(pool.session_counts(ts(1200)).len(), 1);
    }

    #[test]
    fn reset_first_spends_the_window_that_expires_soonest() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let c = account(ProviderId::Claude, "c", 3);
        let pool = pool(Strategy::ResetFirst, &[&a, &b, &c]);
        // a: idle. b: 5h window resets in 3h. c: weekly resets in 2 days.
        pool.observe(&a.id, limits(vec![window("5h", 0.0, None)]), ts(1000));
        pool.observe(
            &b.id,
            limits(vec![window("5h", 60.0, Some(1000 + 3 * 3600))]),
            ts(1000),
        );
        pool.observe(
            &c.id,
            limits(vec![window("7d", 30.0, Some(1000 + 2 * 86_400))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
    }

    #[test]
    fn fill_first_drains_in_order() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&b, &a]);
        assert_eq!(pick(&pool, None, 1000).unwrap(), a.id);
        pool.block(&a.id, ts(5000), None, "limit");
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
        assert_eq!(
            pick(&pool, None, 6000).unwrap(),
            a.id,
            "returns after the reset"
        );
    }

    #[test]
    fn least_used_prefers_headroom_and_ranks_unknown_last() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let c = account(ProviderId::Claude, "c", 3);
        let pool = pool(Strategy::LeastUsed, &[&a, &b, &c]);
        pool.observe(
            &a.id,
            limits(vec![window("7d", 80.0, Some(9000))]),
            ts(1000),
        );
        pool.observe(
            &b.id,
            limits(vec![window("7d", 20.0, Some(9000))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
    }

    #[test]
    fn sessions_stick_until_their_account_cannot_serve() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::LeastUsed, &[&a, &b]);
        pool.observe(
            &a.id,
            limits(vec![window("7d", 10.0, Some(9000))]),
            ts(1000),
        );
        pool.observe(
            &b.id,
            limits(vec![window("7d", 50.0, Some(9000))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, Some("s1"), 1000).unwrap(), a.id);

        // a becomes the busier account, but the session stays put.
        pool.observe(
            &a.id,
            limits(vec![window("7d", 90.0, Some(9000))]),
            ts(1001),
        );
        assert_eq!(pick(&pool, Some("s1"), 1002).unwrap(), a.id);
        assert_eq!(
            pick(&pool, Some("s2"), 1002).unwrap(),
            b.id,
            "new sessions place freshly"
        );

        // Once a is refused, the session moves and reports where it came from.
        pool.block(&a.id, ts(5000), None, "limit");
        let req = Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session: Some("s1"),
            model: None,
            candidates: None,
            exclude: &[],
        };
        let choice = pool.pick(&req, ts(1003)).unwrap();
        assert_eq!(choice.account.id, b.id);
        assert_eq!(
            choice.moved_from.as_deref(),
            Some(a.id.as_str()),
            "the move is reported, so account-bound state can be dropped up front"
        );
    }

    #[test]
    fn sessions_survive_a_restart() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let first = pool(Strategy::LeastUsed, &[&a, &b]);
        first.observe(
            &a.id,
            limits(vec![window("7d", 90.0, Some(9000))]),
            ts(1000),
        );
        first.observe(
            &b.id,
            limits(vec![window("7d", 10.0, Some(9000))]),
            ts(1000),
        );
        assert_eq!(pick(&first, Some("s1"), 1000).unwrap(), b.id);

        let (state, _) = first.snapshot(ts(1001));
        let json = serde_json::to_string(&state).unwrap();
        let restored = Pool::new(
            Strategy::LeastUsed,
            SignedDuration::from_hours(1_000_000),
            serde_json::from_str(&json).unwrap(),
        );
        restored.sync(vec![a.clone(), b.clone()], Pins::default());
        // b is now the busier account, but the session stays on it.
        restored.observe(
            &b.id,
            limits(vec![window("7d", 95.0, Some(9000))]),
            ts(1001),
        );
        assert_eq!(pick(&restored, Some("s1"), 1002).unwrap(), b.id);
    }

    #[test]
    fn moved_from_reports_a_session_leaving_its_account() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        assert_eq!(pick(&pool, Some("s"), 1000).unwrap(), a.id);
        let exclude = [a.id.clone()];
        let req = Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session: Some("s"),
            model: None,
            candidates: None,
            exclude: &exclude,
        };
        let choice = pool.pick(&req, ts(1001)).unwrap();
        assert_eq!(choice.account.id, b.id);
        assert_eq!(choice.moved_from.as_deref(), Some(a.id.as_str()));
    }

    #[test]
    fn sessions_expire_after_ttl() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        pool.block(&a.id, ts(1500), None, "limit");
        assert_eq!(pick(&pool, Some("s"), 1000).unwrap(), b.id);
        // Within the TTL the session stays on b even though a is back.
        assert_eq!(pick(&pool, Some("s"), 2000).unwrap(), b.id);
        // After an idle hour it is placed afresh.
        assert_eq!(pick(&pool, Some("s"), 2000 + 3601).unwrap(), a.id);
    }

    #[test]
    fn priority_tiers_and_pins_come_before_strategy() {
        let a = account(ProviderId::Claude, "a", 1);
        let mut b = account(ProviderId::Claude, "b", 2);
        b.priority = 5;
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
        pool.sync(
            vec![a.clone(), b.clone()],
            Pins::from([(ProviderId::Claude, a.id.clone())]),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), a.id);
    }

    #[test]
    fn known_exhaustion_is_skipped_without_a_request() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        pool.observe(
            &a.id,
            limits(vec![window("5h", 100.0, Some(4000))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
        assert_eq!(pick(&pool, None, 4001).unwrap(), a.id);
    }

    #[test]
    fn unavailable_reports_the_earliest_return() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        pool.block(&a.id, ts(9000), None, "limit");
        pool.block(&b.id, ts(7000), None, "limit");
        let err = pick(&pool, None, 1000).unwrap_err();
        assert_eq!(err.until, Some(ts(7000)));
    }

    #[test]
    fn model_blocks_only_affect_that_model() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.block(&a.id, ts(9000), Some("claude-fable"), "overage cap");
        let req = |model| Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session: None,
            model: Some(model),
            candidates: None,
            exclude: &[],
        };
        assert!(pool.pick(&req("claude-fable"), ts(1000)).is_err());
        assert!(pool.pick(&req("claude-sonnet"), ts(1000)).is_ok());
    }

    #[test]
    fn fresh_reading_lifts_a_block_early() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.block(&a.id, ts(90_000), None, "limit");
        assert!(pick(&pool, None, 1000).is_err());
        pool.observe(
            &a.id,
            limits(vec![window("7d", 40.0, Some(90_000))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), a.id);
    }

    #[test]
    fn disabled_and_signed_out_accounts_are_skipped() {
        let mut a = account(ProviderId::Claude, "a", 1);
        a.disabled = true;
        let mut b = account(ProviderId::Claude, "b", 2);
        b.auth_error = Some("revoked".into());
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        assert!(
            pick(&pool, None, 1000)
                .unwrap_err()
                .reason
                .contains("disabled")
        );
    }

    #[test]
    fn blocks_on_tried_accounts_still_report_when_the_pool_frees_up() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.block(&a.id, ts(5000), None, "limit");
        let exclude = [a.id.clone()];
        let req = Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session: None,
            model: None,
            candidates: None,
            exclude: &exclude,
        };
        assert_eq!(pool.pick(&req, ts(1000)).unwrap_err().until, Some(ts(5000)));
    }

    #[test]
    fn credits_count_from_their_list_and_leave_it_when_redeemed() {
        let a = account(ProviderId::Codex, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        let credit = |id: &str, expires: i64| Credit {
            id: id.into(),
            title: None,
            granted_at: Some(ts(0)),
            expires_at: Some(ts(expires)),
        };
        let counted = Limits {
            reset_credits: Some(2),
            ..limits(vec![window("5h", 100.0, Some(4000))])
        };
        pool.observe(&a.id, counted, ts(1000));
        // Before a list, the usage's count stands.
        assert_eq!(pool.state(&a.id).credits_left(ts(1000)), 2);
        pool.record_credits(
            &a.id,
            vec![credit("soon", 2000), credit("later", 9000)],
            ts(1000),
        );
        let state = pool.state(&a.id);
        assert_eq!(state.credits_left(ts(1000)), 2);
        // One that has lapsed no longer counts.
        assert_eq!(state.credits_left(ts(3000)), 1);

        pool.record_reset(&a.id, ts(1500), Some("soon"));
        let state = pool.state(&a.id);
        let left: Vec<&str> = state
            .unexpired_credits(ts(1500))
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(left, ["later"]);
        // The list and the count agree still, so nothing asks for a new list.
        assert_eq!(state.limits.reset_credits, Some(1));
        assert_eq!(state.credits.unwrap().counted, Some(1));
        assert_eq!(state.limits.windows[0].used, 0.0);
    }
}
