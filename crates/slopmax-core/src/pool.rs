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
use std::sync::{Arc, Mutex};

use http::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;

use crate::account::Account;
use crate::config::Strategy;
use crate::limits::{Limits, PoolWindows, UNKNOWN_SCORE};
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
            .filter(|b| model.is_some_and(|m| m.eq_ignore_ascii_case(&b.model)))
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

/// Persisted runtime state, as `state.toml` has it: per-account health,
/// live sessions, pins, the nudges told, and what was seen of the clients
/// (see [`crate::state`]).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    /// Which layout wrote it: [`crate::state::FORMAT`], or 0 for one from
    /// before pins and nudges moved in.
    #[serde(default)]
    pub format: u32,
    #[serde(default)]
    pub accounts: BTreeMap<String, AccountState>,
    /// Kept so a restart does not move sessions (and lose their caches).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    sessions: Vec<SavedSession>,
    /// Each provider's own client, as its user agent was last seen in a
    /// request: Claude answers its limit resets to Claude Code alone.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub agents: BTreeMap<ProviderId, String>,
    /// Each provider's preferred account, set by `slopmax account use`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pins: Pins,
    /// The nudges told already, so a restart does not tell them again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub told: Vec<String>,
    #[serde(default, skip_serializing_if = "Codex::is_empty")]
    pub codex: Codex,
}

/// What was last seen of Codex: its version, which the model list answers
/// with, and the model it asked for, which window warmups use.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Codex {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl Codex {
    fn is_empty(&self) -> bool {
        self.version.is_none() && self.model.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedSession {
    provider: ProviderId,
    session: String,
    account: String,
    last_used: Timestamp,
}

/// Manual account preference per provider, set by `slopmax account use`.
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
    /// The accounts that may serve it, by id, when routing narrowed them
    /// down.
    pub candidates: Option<&'a [&'a str]>,
    /// Accounts already tried for this request.
    pub exclude: &'a [Arc<Account>],
}

/// The account chosen for a request.
#[derive(Debug, Clone)]
pub struct Choice {
    pub account: Arc<Account>,
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
    /// Chosen with `slopmax account use`.
    Pinned,
    /// No other account of the provider can serve.
    OnlyReady,
    /// Its week resets within the day with quota to spare (reset-first).
    WeekEndsSoonest,
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
            Self::WeekEndsSoonest => "its week resets within the day with quota to spare",
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

/// Why none of `req`'s accounts may serve at all: none is connected, or
/// each is disabled or signed out, named with what to run.
fn unusable(accounts: &[Arc<Account>], req: &Pick) -> String {
    let (id, title) = (req.provider, req.provider.spec().title);
    let mine: Vec<&Arc<Account>> = accounts
        .iter()
        .filter(|a| a.provider == id && req.candidates.is_none_or(|c| c.contains(&a.id.as_str())))
        .collect();
    if mine.is_empty() {
        return format!(
            "slopmax has no {title} account connected yet; run `slopmax login {id}` (or `slopmax account import`)"
        );
    }
    // What `slopmax account enable` and the other commands find an account by.
    let handle = |a: &Account| {
        a.label
            .clone()
            .or_else(|| a.email.clone())
            .unwrap_or_else(|| a.id.clone())
    };
    let named: Vec<String> = mine
        .iter()
        .take(4)
        .map(|a| {
            let why = if a.disabled { "disabled" } else { "signed out" };
            format!("{}: {why}", handle(a))
        })
        .collect();
    let more = match mine.len().saturating_sub(named.len()) {
        0 => String::new(),
        n => format!(", {n} more"),
    };
    let mut fixes = Vec::new();
    if let Some(a) = mine.iter().find(|a| a.disabled) {
        fixes.push(format!("`slopmax account enable {}`", handle(a)));
    }
    if mine.iter().any(|a| !a.disabled) {
        fixes.push(format!("`slopmax login {id}`"));
    }
    format!(
        "every {title} account is disabled or signed out ({}{more}); run {}",
        named.join(", "),
        fixes.join(" or ")
    )
}

#[derive(Debug, Default)]
struct Inner {
    /// Shared with requests as it is: a pick copies a pointer, not the
    /// accounts. Replaced whole on change, which is rare.
    accounts: Arc<[Arc<Account>]>,
    states: HashMap<String, AccountState>,
    /// By provider, then session id: a pick looks its session up by the
    /// id it was given, without copying it.
    sessions: HashMap<ProviderId, HashMap<String, Binding>>,
    pins: Pins,
    agents: BTreeMap<ProviderId, String>,
    told: Vec<String>,
    codex: Codex,
    /// When each account was last handed a request, as a count of picks:
    /// round-robin hands the next to the one handed one longest ago.
    picked: HashMap<String, u64>,
    picks: u64,
    /// Windows that reset since they were last taken, by account, and
    /// those already taken.
    lapses: Vec<(String, crate::limits::Lapse)>,
    taken: Vec<(String, crate::limits::Lapse)>,
    dirty: bool,
    /// The pool's windows as response headers, by provider, with the
    /// windows they were rendered from.
    shown: Vec<(ProviderId, PoolWindows, PoolHeaders)>,
}

/// Response headers that show a provider's pool as one account, as
/// [`Provider::pool_headers`](crate::provider::Provider::pool_headers)
/// renders them. Shared: handing them out copies a pointer, and each value
/// a reference count.
pub type PoolHeaders = Arc<[(HeaderName, HeaderValue)]>;

impl Inner {
    /// See [`Pool::pooled`]. Each account counts by its share of the pool,
    /// as [`pricing::shares`](crate::pricing::shares) gives it, worked out
    /// here in two passes over the accounts.
    fn pooled(&self, provider: ProviderId, now: Timestamp) -> PoolWindows {
        let unknown = AccountState::default();
        let working = || {
            self.accounts
                .iter()
                .filter(move |a| a.provider == provider && !a.disabled && a.auth_error.is_none())
        };
        let capacity = |a: &Account| crate::pricing::capacity(provider, a.plan.as_deref());
        // Shares are even unless every plan's size is known.
        let total = working()
            .map(|a| capacity(a))
            .sum::<Option<f64>>()
            .filter(|total| *total > 0.0);
        let accounts = working().map(|a| {
            let share = total.and_then(|total| Some(capacity(a)? / total));
            let state = self.states.get(&a.id).unwrap_or(&unknown);
            (&state.limits, state.is_blocked(now), share.unwrap_or(1.0))
        });
        crate::limits::pooled_by(accounts, now)
    }
}

impl Inner {
    /// The account's state, made on first use. Its id is copied only then.
    fn state_mut(&mut self, id: &str) -> &mut AccountState {
        if !self.states.contains_key(id) {
            self.states.insert(id.to_owned(), AccountState::default());
        }
        self.states.get_mut(id).expect("inserted above")
    }

    /// Forgets the error the account last showed, once it is known past.
    fn clear_error(&mut self, id: &str) {
        if let Some(state) = self.states.get_mut(id)
            && state.last_error.take().is_some()
        {
            self.dirty = true;
        }
    }
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
        let mut sessions: HashMap<ProviderId, HashMap<String, Binding>> = HashMap::new();
        for s in state.sessions {
            if now.duration_since(s.last_used) < session_ttl {
                let binding = Binding {
                    account: s.account,
                    last_used: s.last_used,
                };
                sessions
                    .entry(s.provider)
                    .or_default()
                    .insert(s.session, binding);
            }
        }
        let inner = Inner {
            states: state.accounts.into_iter().collect(),
            sessions,
            agents: state.agents,
            pins: state.pins,
            told: state.told,
            codex: state.codex,
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

    /// Replaces the account list (from disk). Sessions bound to a removed
    /// account are released, and an account signed in again drops the error
    /// that signed it out.
    pub fn sync(&self, accounts: Vec<Account>) {
        let mut inner = self.lock();
        let ids: Vec<&str> = accounts.iter().map(|a| a.id.as_str()).collect();
        for sessions in inner.sessions.values_mut() {
            sessions.retain(|_, binding| ids.contains(&binding.account.as_str()));
        }
        let signed_in: Vec<String> = accounts
            .iter()
            .filter(|a| {
                a.auth_error.is_none()
                    && inner
                        .accounts
                        .iter()
                        .any(|held| held.id == a.id && held.auth_error.is_some())
            })
            .map(|a| a.id.clone())
            .collect();
        for id in signed_in {
            inner.clear_error(&id);
        }
        inner.accounts = accounts.into_iter().map(Arc::new).collect();
    }

    /// Prefers account `id` for `provider`'s new sessions, releasing the
    /// sessions bound before so they move to it.
    pub fn pin(&self, provider: ProviderId, id: &str) {
        let mut inner = self.lock();
        if inner.pins.get(&provider).map(String::as_str) != Some(id) {
            inner.pins.insert(provider, id.to_owned());
            inner.sessions.remove(&provider);
            inner.dirty = true;
        }
    }

    /// Drops every pin, releasing the sessions of the providers that had
    /// one.
    pub fn unpin_all(&self) {
        let mut inner = self.lock();
        if inner.pins.is_empty() {
            return;
        }
        let pins = std::mem::take(&mut inner.pins);
        inner.sessions.retain(|p, _| !pins.contains_key(p));
        inner.dirty = true;
    }

    /// Drops the pin on account `id`, as when it is removed.
    pub fn unpin(&self, id: &str) {
        let mut inner = self.lock();
        let before = inner.pins.len();
        inner.pins.retain(|_, pinned| pinned != id);
        if inner.pins.len() != before {
            inner.dirty = true;
        }
    }

    /// The accounts as they stand: a shared snapshot, not a copy.
    pub fn accounts(&self) -> Arc<[Arc<Account>]> {
        Arc::clone(&self.lock().accounts)
    }

    /// The account as the pool holds it: its tokens as last refreshed here
    /// or read from the disk.
    pub fn account(&self, id: &str) -> Option<Arc<Account>> {
        self.lock().accounts.iter().find(|a| a.id == id).cloned()
    }

    /// Puts a refreshed copy of an account in place of the one held, so the
    /// next request uses its new tokens without reading the disk. An account
    /// removed meanwhile stays removed.
    pub fn put(&self, account: &Account) {
        let mut inner = self.lock();
        if inner.accounts.iter().any(|a| a.id == account.id) {
            inner.accounts = inner
                .accounts
                .iter()
                .map(|held| match held.id == account.id {
                    true => Arc::new(account.clone()),
                    false => Arc::clone(held),
                })
                .collect();
        }
    }

    pub fn pins(&self) -> Pins {
        self.lock().pins.clone()
    }

    /// The user agent of `provider`'s own client, as last seen in a request.
    pub fn agent(&self, provider: ProviderId) -> Option<String> {
        self.lock().agents.get(&provider).cloned()
    }

    /// The nudges told so far.
    pub fn told(&self) -> Vec<String> {
        self.lock().told.clone()
    }

    /// Remembers the nudges told, to save with the state.
    pub fn set_told(&self, told: Vec<String>) {
        let mut inner = self.lock();
        if inner.told != told {
            inner.told = told;
            inner.dirty = true;
        }
    }

    /// What was last seen of Codex.
    pub fn codex(&self) -> Codex {
        self.lock().codex.clone()
    }

    /// Notes the Codex release a request came from.
    pub fn saw_codex_version(&self, version: &str) {
        let mut inner = self.lock();
        if inner.codex.version.as_deref() != Some(version) {
            inner.codex.version = Some(version.to_owned());
            inner.dirty = true;
        }
    }

    /// Notes the model a Codex request asked for.
    pub fn saw_codex_model(&self, model: &str) {
        let mut inner = self.lock();
        if inner.codex.model.as_deref() != Some(model) {
            inner.codex.model = Some(model.to_owned());
            inner.dirty = true;
        }
    }

    /// Notes the user agent of a request from `provider`'s own client.
    pub fn saw_agent(&self, provider: ProviderId, agent: &str) {
        let mut inner = self.lock();
        if inner.agents.get(&provider).map(String::as_str) != Some(agent) {
            inner.agents.insert(provider, agent.to_owned());
            inner.dirty = true;
        }
    }

    /// Chooses an account for a request. It allocates nothing but for a
    /// new session, an account first handed a request, or a session that
    /// moved.
    pub fn pick(&self, req: &Pick, now: Timestamp) -> Result<Choice, Unavailable> {
        let routing = self.routing();
        let mut guard = self.lock();
        let inner = &mut *guard;
        // The account the session used last, kept to even when affinity is
        // off, to tell whether the request moved.
        let bound = req
            .session
            .and_then(|s| inner.sessions.get(&req.provider)?.get(s))
            .filter(|b| now.duration_since(b.last_used) < routing.session_ttl)
            .map(|b| b.account.as_str());
        let sticky = req.affinity.unwrap_or(routing.affinity);
        let pinned = inner.pins.get(&req.provider).map(String::as_str);

        // One pass over the accounts. Those already tried for this request
        // are skipped, but their blocks still count toward when the pool
        // frees up again.
        let mut usable = false;
        let mut ready: SmallVec<[&Arc<Account>; 8]> = SmallVec::new();
        let mut soonest: Option<Timestamp> = None;
        let (mut kept, mut pin) = (None, None);
        let accounts = inner.accounts.iter().filter(|a| {
            a.provider == req.provider
                && !a.disabled
                && a.auth_error.is_none()
                && req.candidates.is_none_or(|c| c.contains(&a.id.as_str()))
        });
        for account in accounts {
            usable = true;
            let blocked = match inner.states.get(&account.id) {
                Some(state) => state.blocked(req.model, now),
                None => Ok(()),
            };
            match blocked {
                Ok(()) if !req.exclude.iter().any(|t| t.id == account.id) => {
                    if sticky && kept.is_none() && bound == Some(account.id.as_str()) {
                        kept = Some(account);
                    }
                    if pin.is_none() && pinned == Some(account.id.as_str()) {
                        pin = Some(account);
                    }
                    ready.push(account);
                }
                Ok(()) => {}
                Err(until) => soonest = Some(soonest.map_or(until, |s| s.min(until))),
            }
        }
        if !usable {
            return Err(Unavailable {
                until: None,
                reason: unusable(&inner.accounts, req),
            });
        }

        // Keep the session where it is whenever its account can still serve.
        let chosen = kept
            .or(pin)
            .or_else(|| place(routing.strategy, &ready, inner, now));
        let Some(account) = chosen.map(Arc::clone) else {
            let title = req.provider.spec().title;
            let reason = match soonest {
                Some(_) => format!("every {title} account is rate limited"),
                None => {
                    // Why the last one tried failed: its error, just recorded.
                    let cause = req
                        .exclude
                        .iter()
                        .rev()
                        .filter(|a| a.provider == req.provider)
                        .find_map(|a| inner.states.get(&a.id)?.last_error.as_deref());
                    match cause {
                        Some(cause) => format!("every {title} account failed: {cause}"),
                        None => format!("every {title} account failed this request"),
                    }
                }
            };
            return Err(Unavailable {
                until: soonest,
                reason,
            });
        };
        let moved_from = bound.filter(|id| *id != account.id).map(str::to_owned);
        if !req.housekeeping {
            inner.picks += 1;
            let picks = inner.picks;
            match inner.picked.get_mut(&account.id) {
                Some(at) => *at = picks,
                None => {
                    inner.picked.insert(account.id.clone(), picks);
                }
            }
        }
        if let Some(session) = req.session {
            let sessions = inner.sessions.entry(req.provider).or_default();
            match sessions.get_mut(session) {
                Some(binding) => {
                    if binding.account != account.id {
                        binding.account.clone_from(&account.id);
                    }
                    binding.last_used = now;
                }
                None => {
                    let binding = Binding {
                        account: account.id.clone(),
                        last_used: now,
                    };
                    sessions.insert(session.to_owned(), binding);
                }
            }
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
        let ready: Vec<&Arc<Account>> = inner
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
                let urgency = inner.states.get(&chosen.id).map(|s| s.limits.urgency(now));
                match urgency {
                    Some(u) if u.week_ending.is_some() => Reason::WeekEndsSoonest,
                    Some(u) if u.short.or(u.long).is_some() => Reason::ResetsSoonest,
                    _ => Reason::MostRoom,
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
        let state = inner.state_mut(id);
        state.last_used = Some(now);
        state.throttled_until = None;
        state.last_error = None;
        inner.dirty = true;
    }

    /// Records a usage poll's reading. The poll got through, so the error
    /// the account last showed (a failed poll, a refused sign-in) is past.
    pub fn record_reading(&self, id: &str, limits: Limits, now: Timestamp) {
        self.observe(id, limits, now);
        self.lock().clear_error(id);
    }

    /// Folds a usage reading into the account's limits.
    pub fn observe(&self, id: &str, limits: Limits, now: Timestamp) {
        let mut inner = self.lock();
        let state = inner.state_mut(id);
        let lapsed = state.limits.lapsed(&limits, now);
        state.limits.merge(limits);
        // A fresh reading below the limit proves an earlier block has lifted,
        // often well before the advertised reset.
        if state.blocked_until.is_some() && !state.limits.is_exhausted(now) {
            state.blocked_until = None;
        }
        inner
            .lapses
            .extend(lapsed.into_iter().map(|lapse| (id.to_owned(), lapse)));
        inner.dirty = true;
    }

    /// The windows that reset since the last call, by account: those
    /// readings showed, and those whose time passed with no reading since.
    /// A window may be told twice (after a restart, say); readers drop
    /// the repeats.
    pub fn take_lapses(&self, now: Timestamp) -> Vec<(String, crate::limits::Lapse)> {
        let mut inner = self.lock();
        let inner = &mut *inner;
        let mut found = std::mem::take(&mut inner.lapses);
        for (id, state) in &inner.states {
            let lapsed = state.limits.lapsed(&Limits::default(), now);
            found.extend(lapsed.into_iter().map(|lapse| (id.clone(), lapse)));
        }
        let same = |a: &(String, crate::limits::Lapse), b: &(String, crate::limits::Lapse)| {
            a.0 == b.0
                && a.1.span == b.1.span
                && a.1.model == b.1.model
                && a.1.ended_at == b.1.ended_at
        };
        let mut taken: Vec<(String, crate::limits::Lapse)> = Vec::new();
        for lapse in found {
            if !inner.taken.iter().chain(&taken).any(|t| same(t, &lapse)) {
                taken.push(lapse);
            }
        }
        inner.taken.extend(taken.iter().cloned());
        // Only the recent ones can come round again.
        let week_ago = now - SignedDuration::from_hours(24 * 8);
        inner.taken.retain(|(_, l)| l.ended_at > week_ago);
        taken
    }

    /// Sits an account out after a quota refusal. Deadlines only extend.
    pub fn block(&self, id: &str, until: Timestamp, model: Option<&str>, reason: &str) {
        let mut inner = self.lock();
        let state = inner.state_mut(id);
        match model {
            Some(model) => {
                // One model however it is spelled: `Claude-Fable-5-2` is
                // `claude-fable-5-2`.
                state
                    .model_blocks
                    .retain(|b| !b.model.eq_ignore_ascii_case(model) || b.until > until);
                if !state
                    .model_blocks
                    .iter()
                    .any(|b| b.model.eq_ignore_ascii_case(model))
                {
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
        let state = inner.state_mut(id);
        state.throttled_until = state.throttled_until.max(Some(until));
        inner.dirty = true;
    }

    /// Notes a non-quota failure for display.
    pub fn record_error(&self, id: &str, error: &str) {
        let mut inner = self.lock();
        inner.state_mut(id).last_error = Some(error.to_owned());
        inner.dirty = true;
    }

    /// Records the account's reset credits as just listed.
    pub fn record_credits(&self, id: &str, credits: Vec<Credit>, now: Timestamp) {
        let mut inner = self.lock();
        let state = inner.state_mut(id);
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
        let state = inner.state_mut(id);
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
        let state = inner.state_mut(id);
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
        inner.state_mut(id).usage.add(usage);
        inner.dirty = true;
    }

    /// The provider's working accounts read as one account: see
    /// [`limits::pooled`](crate::limits::pooled).
    pub fn pooled(&self, provider: ProviderId, now: Timestamp) -> PoolWindows {
        self.lock().pooled(provider, now)
    }

    /// The pool's windows as the response headers the agent reads, or
    /// `None` when the pool has none. They are rendered again only when
    /// the windows change.
    pub fn pooled_headers(&self, provider: ProviderId, now: Timestamp) -> Option<PoolHeaders> {
        let mut inner = self.lock();
        let windows = inner.pooled(provider, now);
        if windows.is_empty() {
            return None;
        }
        let shown = &mut inner.shown;
        let at = shown.iter().position(|(p, ..)| *p == provider);
        if let Some(at) = at
            && shown[at].1 == windows
        {
            return Some(Arc::clone(&shown[at].2));
        }
        let mut rendered = Vec::new();
        provider.get().pool_headers(&windows, &mut rendered);
        let rendered = PoolHeaders::from(rendered);
        let entry = (provider, windows, Arc::clone(&rendered));
        match at {
            Some(at) => shown[at] = entry,
            None => shown.push(entry),
        }
        Some(rendered)
    }

    pub fn state(&self, id: &str) -> AccountState {
        self.lock().states.get(id).cloned().unwrap_or_default()
    }

    /// Whether a save would write anything: state changed, or windows
    /// reset and wait to be recorded.
    pub fn needs_save(&self) -> bool {
        let inner = self.lock();
        inner.dirty || !inner.lapses.is_empty()
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
        for sessions in inner.sessions.values_mut() {
            sessions.retain(|_, b| now.duration_since(b.last_used) < ttl);
        }
        inner.sessions.retain(|_, sessions| !sessions.is_empty());
        let sessions = inner
            .sessions
            .iter()
            .flat_map(|(provider, sessions)| {
                sessions.iter().map(|(session, b)| SavedSession {
                    provider: *provider,
                    session: session.clone(),
                    account: b.account.clone(),
                    last_used: b.last_used,
                })
            })
            .collect();
        (
            State {
                format: crate::state::FORMAT,
                accounts,
                sessions,
                agents: inner.agents.clone(),
                pins: inner.pins.clone(),
                told: inner.told.clone(),
                codex: inner.codex.clone(),
            },
            dirty,
        )
    }

    /// The account each live session is bound to, for display.
    pub fn session_counts(&self, now: Timestamp) -> HashMap<String, usize> {
        let ttl = self.routing().session_ttl;
        let inner = self.lock();
        let mut counts = HashMap::new();
        for binding in inner.sessions.values().flat_map(HashMap::values) {
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
    ready: &[&'a Arc<Account>],
    inner: &Inner,
    now: Timestamp,
) -> Option<&'a Arc<Account>> {
    let states = &inner.states;
    let top = ready.iter().map(|a| a.priority).max()?;
    let tier = ready.iter().copied().filter(|a| a.priority == top);
    let unknown = Limits::default();
    let limits = |a: &Account| states.get(&a.id).map_or(&unknown, |s| &s.limits);
    let last_used = |a: &Account| states.get(&a.id).and_then(|s| s.last_used);
    let score = |a: &Account| Score(limits(a).score(now));

    match strategy {
        // The first in the order `slopmax account order` set, then the oldest.
        Strategy::FillFirst => tier.min_by_key(|a| a.rank()),
        // Earliest-deadline-first over spare capacity: an account whose
        // window resets soon loses its unused quota at that reset, while an
        // idle account loses nothing by waiting. Ties go to the less used.
        Strategy::ResetFirst => tier.min_by_key(|a| {
            let deadline = limits(a).urgency(now).key();
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
        pool.sync(accounts.iter().map(|a| (*a).clone()).collect());
        pool
    }

    fn pool_of(accounts: &[&Account]) -> Pool {
        pool(Strategy::FillFirst, accounts)
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
        pool.pick(&req, ts(now)).map(|c| c.account.id.clone())
    }

    #[test]
    fn the_pool_reads_as_one_account_weighted_by_plan() {
        let mut max = account(ProviderId::Claude, "max", 1);
        max.plan = Some(" Max ".into());
        let mut pro = account(ProviderId::Claude, "pro", 2);
        pro.plan = Some("pro".into());
        let pool = pool(Strategy::FillFirst, &[&max, &pro]);
        pool.observe(
            &max.id,
            limits(vec![window("7d", 60.0, Some(9_000))]),
            ts(1000),
        );
        pool.observe(
            &pro.id,
            limits(vec![window("7d", 0.0, Some(8_000))]),
            ts(1000),
        );
        let windows = pool.pooled(ProviderId::Claude, ts(1000));
        assert_eq!(windows.len(), 1);
        // Max is five times Pro: 60% of five sixths of the pool.
        assert!((windows[0].used - 50.0).abs() < 1e-9, "{windows:?}");
        assert_eq!(windows[0].resets_at, Some(ts(9_000)));

        // Its headers are rendered once, and again when the windows change.
        let shown = pool.pooled_headers(ProviderId::Claude, ts(1000)).unwrap();
        let again = pool.pooled_headers(ProviderId::Claude, ts(1000)).unwrap();
        assert!(Arc::ptr_eq(&shown, &again));
        let value = |headers: &PoolHeaders, name: &str| {
            let (_, value) = headers.iter().find(|(n, _)| n == name).unwrap();
            value.to_str().unwrap().to_owned()
        };
        assert_eq!(
            value(&shown, "anthropic-ratelimit-unified-7d-utilization"),
            "0.50"
        );
        pool.observe(
            &pro.id,
            limits(vec![window("7d", 60.0, Some(8_000))]),
            ts(1000),
        );
        let changed = pool.pooled_headers(ProviderId::Claude, ts(1000)).unwrap();
        assert_eq!(
            value(&changed, "anthropic-ratelimit-unified-7d-utilization"),
            "0.60"
        );
        assert!(pool.pooled_headers(ProviderId::Codex, ts(1000)).is_none());
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
    fn reset_windows_are_told_once_with_what_was_used() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.observe(
            &a.id,
            limits(vec![
                window("7d", 70.0, Some(5_000)),
                window("5h", 10.0, Some(9_000)),
            ]),
            ts(1000),
        );
        assert!(pool.take_lapses(ts(2_000)).is_empty());
        // The week's time passes with no reading since.
        let lapsed = pool.take_lapses(ts(6_000));
        assert_eq!(lapsed.len(), 1);
        assert_eq!((lapsed[0].1.span.as_str(), lapsed[0].1.used), ("7d", 70.0));
        assert!(pool.take_lapses(ts(6_500)).is_empty(), "told once");
        // A reading of the next 5-hour period shows that one ended too.
        pool.observe(
            &a.id,
            limits(vec![window("5h", 1.0, Some(30_000))]),
            ts(9_500),
        );
        let lapsed = pool.take_lapses(ts(9_500));
        assert_eq!(lapsed.len(), 1);
        assert_eq!((lapsed[0].1.span.as_str(), lapsed[0].1.used), ("5h", 10.0));
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
        pool.pin(ProviderId::Claude, &a.id);
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
        assert_eq!(
            (first.account.id.clone(), first.moved_from),
            (a.id.clone(), None)
        );
        // Placed afresh, on the next account, which must drop the first's
        // state.
        let second = pool.pick(&req(None), ts(1001)).unwrap();
        assert_eq!(second.account.id, b.id);
        assert_eq!(second.moved_from, Some(a.id.clone()));
        // The request may ask for affinity anyway.
        let third = pool.pick(&req(Some(true)), ts(1002)).unwrap();
        assert_eq!(
            (third.account.id.clone(), third.moved_from),
            (b.id.clone(), None)
        );
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
    fn reset_first_saves_a_week_about_to_be_lost_before_any_5_hour_window() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::ResetFirst, &[&a, &b]);
        let hours = |h: i64| 1000 + h * 3600;
        // a: busy, its 5-hour window resets in 4h, its week in 6 days.
        pool.observe(
            &a.id,
            limits(vec![
                window("5h", 10.0, Some(hours(4))),
                window("7d", 50.0, Some(hours(144))),
            ]),
            ts(1000),
        );
        // b: no 5-hour window running, but 80% of a week lost in 10h.
        pool.observe(
            &b.id,
            limits(vec![window("7d", 20.0, Some(hours(10)))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), b.id);
        let next = pool.next(ProviderId::Claude, ts(1000)).unwrap();
        assert_eq!(next.reason, Reason::WeekEndsSoonest);
        // A week two days out is no emergency: the 5-hour window goes first.
        pool.observe(
            &b.id,
            limits(vec![window("7d", 20.0, Some(hours(48)))]),
            ts(1000),
        );
        assert_eq!(pick(&pool, None, 1000).unwrap(), a.id);
        // A full week is nothing to save.
        pool.observe(
            &b.id,
            limits(vec![
                window("7d", 100.0, Some(hours(10))),
                window("5h", 0.0, None),
            ]),
            ts(1000),
        );
        assert_ne!(
            pool.next(ProviderId::Claude, ts(1000)).unwrap().reason,
            Reason::WeekEndsSoonest
        );
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

        // `slopmax account order` comes before age.
        let mut b = b.clone();
        b.order = Some(1);
        let ordered = self::pool(Strategy::FillFirst, &[&a, &b]);
        assert_eq!(pick(&ordered, None, 1000).unwrap(), b.id);
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
        restored.sync(vec![a.clone(), b.clone()]);
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
        let exclude = [Arc::new(a.clone())];
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
        pool.pin(ProviderId::Claude, &a.id);
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
        assert!(pool.pick(&req("Claude-Fable"), ts(1000)).is_err());
        assert!(pool.pick(&req("claude-sonnet"), ts(1000)).is_ok());
        // The same model in other letters extends the one block.
        pool.block(&a.id, ts(9500), Some("CLAUDE-FABLE"), "overage cap");
        let blocks = pool.lock().states[&a.id].model_blocks.clone();
        assert_eq!(blocks.len(), 1, "{blocks:?}");
        assert_eq!(blocks[0].until, ts(9500));
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
        let reason = pick(&pool, None, 1000).unwrap_err().reason;
        assert_eq!(
            reason,
            format!(
                "every Claude account is disabled or signed out ({}: disabled, {}: signed out); \
                 run `slopmax account enable {}` or `slopmax login claude`",
                a.id, b.id, a.id
            )
        );
        // With none at all, the reason says to connect one.
        let none = pool_of(&[]);
        assert_eq!(
            pick(&none, None, 1000).unwrap_err().reason,
            "slopmax has no Claude account connected yet; run `slopmax login claude` (or `slopmax account import`)"
        );
    }

    #[test]
    fn a_usage_reading_clears_the_last_error() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.record_error(
            &a.id,
            "usage poll: refresh token rejected (400 Bad Request)",
        );
        // Headers on an answer fold in limits but say nothing of the error.
        pool.observe(&a.id, limits(vec![window("5h", 10.0, None)]), ts(1000));
        assert!(pool.state(&a.id).last_error.is_some());
        pool.record_reading(&a.id, limits(vec![window("5h", 10.0, None)]), ts(1000));
        assert_eq!(pool.state(&a.id).last_error, None);
    }

    #[test]
    fn signing_in_again_clears_the_last_error() {
        let mut a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        a.auth_error = Some("refresh token rejected (400 Bad Request)".into());
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        pool.record_error(
            &a.id,
            "usage poll: refresh token rejected (400 Bad Request)",
        );
        pool.record_error(&b.id, "server error 500");
        // A rescan that changes nothing keeps both.
        pool.sync(vec![a.clone(), b.clone()]);
        assert!(pool.state(&a.id).last_error.is_some());
        a.auth_error = None;
        pool.sync(vec![a.clone(), b.clone()]);
        assert_eq!(pool.state(&a.id).last_error, None);
        assert_eq!(
            pool.state(&b.id).last_error.as_deref(),
            Some("server error 500")
        );
    }

    #[test]
    fn when_every_account_failed_the_reason_carries_the_last_error() {
        let a = account(ProviderId::Claude, "a", 1);
        let b = account(ProviderId::Claude, "b", 2);
        let pool = pool(Strategy::FillFirst, &[&a, &b]);
        pool.record_error(&a.id, "an older error");
        pool.record_error(
            &b.id,
            "couldn't connect to api.anthropic.com (connection refused)",
        );
        let exclude = [Arc::new(a.clone()), Arc::new(b.clone())];
        let req = Pick {
            provider: ProviderId::Claude,
            affinity: None,
            housekeeping: false,
            session: None,
            model: None,
            candidates: None,
            exclude: &exclude,
        };
        assert_eq!(
            pool.pick(&req, ts(1000)).unwrap_err().reason,
            "every Claude account failed: couldn't connect to api.anthropic.com (connection refused)"
        );
    }

    #[test]
    fn blocks_on_tried_accounts_still_report_when_the_pool_frees_up() {
        let a = account(ProviderId::Claude, "a", 1);
        let pool = pool(Strategy::FillFirst, &[&a]);
        pool.block(&a.id, ts(5000), None, "limit");
        let exclude = [Arc::new(a.clone())];
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
