//! What a window draws, worked out once for every UI: the accounts grouped
//! by provider with their gauges and status, the lines about the proxy,
//! agents, and service, a sign-in's instructions, and the menu bar's line.
//! Account words come from the core, so they read as `slopmax status` does.

use slopmax_core::agent::Wiring;
use slopmax_core::config::{Config, Strategy};
use slopmax_core::daemon::CREDIT_EXPIRY_LEAD;
use slopmax_core::human;
use slopmax_core::limits::Window;
use slopmax_core::notify::Kind;
use slopmax_core::provider::ProviderId;
use slopmax_core::provider::credits::Credit;
use slopmax_core::report::{AccountReport, Condition, NextReport, Note, Report, Tone};
use slopmax_core::service;
use slopmax_core::time::{SignedDuration, Timestamp};

#[cfg(test)]
use crate::Doctor;
use crate::{AgentStatus, Proxy, Setting, SignIn, Snapshot, Step};

/// One provider's accounts.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub provider: ProviderId,
    pub title: &'static str,
    /// Whether its accounts have usage windows; keys bill per token.
    pub subscription: bool,
    /// The usage windows its accounts report, as columns: `5-hour`,
    /// `Weekly`, then any limited to one model, such as `Weekly · Fable`.
    pub limits: Vec<String>,
    pub accounts: Vec<Row>,
    /// Each window across the working accounts, as agents see them, with
    /// every account's share of it. Empty for keys.
    pub overview: Vec<Overview>,
    /// How many working accounts the overview reads as one.
    pub working: usize,
    /// Whether the pool weighs its accounts by their plans' sizes, rather
    /// than averaging them.
    pub weighted: bool,
    /// Its accounts' limit resets, and when the next expires: `4 limit
    /// resets · the next expires in 2d23h`.
    pub credits: Option<String>,
    /// Where a new session would go now, and why: `New sessions →
    /// claude0 · its quota resets soonest`; a warning when none can take
    /// one.
    pub next: Label,
    /// The same, short, for the menu bar panel: `New sessions → claude0 ·
    /// its quota resets soonest`.
    pub next_short: Label,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub id: String,
    pub name: String,
    /// The plan, or how a key is billed.
    pub plan: String,
    /// A gauge for each of the group's `limits`, or `None` where this
    /// account reports no such window.
    pub limits: Vec<Option<Gauge>>,
    pub status: Label,
    pub notes: Vec<Label>,
    pub pinned: bool,
    pub disabled: bool,
    pub priority: i32,
    /// When it last answered: `used 3m ago`.
    pub last_used: Option<String>,
    /// Its reset credits, when it has any.
    pub credits: Option<Credits>,
    /// Whether a new session would go to it now.
    pub next: bool,
    /// The tool whose copy of its login slopmax follows, such as Claude
    /// Code, rather than refreshing it itself.
    pub follows: Option<String>,
}

/// An account's reset credits, each of which clears its usage windows at
/// once.
#[derive(Debug, Clone, PartialEq)]
pub struct Credits {
    /// `2 limit resets`.
    pub title: String,
    /// Soonest to expire first; empty until slopmax has listed them.
    pub credits: Vec<CreditLine>,
    /// The windows one clears: `5-hour and weekly`.
    pub clears: String,
    /// Why none can be redeemed now: nothing to reset yet, or the account
    /// is off or signed out.
    pub held: Option<String>,
}

/// One reset credit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreditLine {
    /// `Expires Oct 9`, or that it does not.
    pub expires: String,
    /// `Expires in 2d23h · Oct 9`, or that it does not, as the dashboard
    /// says it.
    pub line: String,
    /// `in 2d23h`.
    pub left: Option<String>,
    /// `Granted Sep 21`, when the provider says.
    pub granted: Option<String>,
    /// A warning once it expires within [`EXPIRING`].
    pub tone: Tone,
}

/// How soon a credit's expiry is worth a warning.
const EXPIRING: SignedDuration = SignedDuration::from_hours(72);

/// One usage window across a provider's accounts.
#[derive(Debug, Clone, PartialEq)]
pub struct Overview {
    pub title: String,
    /// The working accounts' use, read as one.
    pub gauge: Gauge,
    /// Each account's use of it, in the group's order.
    pub shares: Vec<Share>,
}

/// One account's use of a window, as a segment of the overview's bar.
#[derive(Debug, Clone, PartialEq)]
pub struct Share {
    /// Its part of the pool, by its plan's size where every plan's is
    /// known; else an even part.
    pub weight: f32,
    pub fraction: f32,
    pub tone: Tone,
    /// Not serving: disabled, or its sign-in failed.
    pub idle: bool,
}

/// A usage window as a bar.
#[derive(Debug, Clone, PartialEq)]
pub struct Gauge {
    /// How full, from 0 to 1.
    pub fraction: f32,
    /// `42%`.
    pub percent: String,
    /// Time until it resets, when it has use to reset: `2h05m`.
    pub resets_in: Option<String>,
    /// When it resets on this machine's clock: `22:59` today, `Wed 20:27`
    /// within the week, `Nov 3` after.
    pub resets_at: Option<String>,
    pub tone: Tone,
    /// How the use compares with spending the window evenly until it
    /// resets.
    pub pace: Option<Pace>,
}

/// A window's use against an even spend.
#[derive(Debug, Clone, PartialEq)]
pub struct Pace {
    /// How far through the window it is, from 0 to 1: where an even spend
    /// would have reached.
    pub elapsed: f32,
    /// `On pace`, `Runs out ~14:10`, or `18% in reserve`.
    pub label: Label,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub text: String,
    pub tone: Tone,
}

/// How the accounts stand, in a line: what an overview leads with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// `All 4 accounts are ready`, or `3 of 4 accounts are ready`.
    pub headline: String,
    /// What keeps the rest: `1 limited · 1 needs signing in`.
    pub detail: Option<String>,
    pub tone: Tone,
}

pub fn status(report: &Report, now: Timestamp) -> Status {
    let enabled: Vec<Condition> = report
        .accounts
        .iter()
        .filter(|a| !a.disabled)
        .map(|a| a.condition(now))
        .collect();
    let ready = enabled
        .iter()
        .filter(|c| matches!(c, Condition::Ready | Condition::Active(_)))
        .count();
    let count = |want: fn(&Condition) -> bool| enabled.iter().filter(|c| want(c)).count();
    let limited = count(|c| matches!(c, Condition::Limited(_) | Condition::Throttled));
    let signed_out = count(|c| matches!(c, Condition::SignInNeeded(_)));
    let off = report.accounts.len() - enabled.len();
    let headline = match (enabled.len(), ready) {
        (0, _) if off == 0 => "No accounts yet".to_owned(),
        (0, _) => "Every account is turned off".to_owned(),
        (1, 1) => "Your account is ready".to_owned(),
        (n, r) if r == n => format!("All {n} accounts are ready"),
        (n, r) => format!("{r} of {n} accounts are ready"),
    };
    let mut parts = Vec::new();
    if limited > 0 {
        parts.push(format!("{limited} limited"));
    }
    match signed_out {
        0 => {}
        1 => parts.push("1 needs signing in".to_owned()),
        n => parts.push(format!("{n} need signing in")),
    }
    if off > 0 {
        parts.push(format!("{off} turned off"));
    }
    Status {
        headline,
        detail: (!parts.is_empty()).then(|| parts.join(" · ")),
        tone: if signed_out > 0 {
            Tone::Bad
        } else if limited > 0 {
            Tone::Warn
        } else {
            Tone::Good
        },
    }
}

/// What a notice that wants a look offers to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Remedy {
    /// Sign in to the account again.
    SignIn,
    /// Redeem one of its reset credits.
    Redeem,
    /// Look at the account.
    Look,
}

/// Something about an account that wants a look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attention {
    pub provider: ProviderId,
    /// The account's id.
    pub account: String,
    pub text: String,
    /// The same, short, for the menu bar panel: who, by the local part of
    /// their address, and what and when, which a narrow line keeps whole.
    pub who: String,
    pub what: String,
    pub tone: Tone,
    pub remedy: Remedy,
}

/// An account's name, short: an address's local part.
fn short_name(name: &str) -> String {
    name.split('@').next().unwrap_or(name).to_owned()
}

/// What wants a look, most pressing first: an account signed out, one
/// limited that holds a reset credit, a window running out before it
/// resets, and a reset credit soon to expire. An account merely limited is
/// slopmax's to work around, and wants nothing.
pub fn attention(report: &Report, now: Timestamp) -> Vec<Attention> {
    let mut found = Vec::new();
    for account in report.accounts.iter().filter(|a| !a.disabled) {
        let note = |text: String, what: String, tone, remedy| Attention {
            provider: account.provider,
            account: account.id.clone(),
            text,
            who: short_name(&account.name),
            what,
            tone,
            remedy,
        };
        let credits = account.state.credits_left(now);
        match account.condition(now) {
            Condition::SignInNeeded(_) => {
                found.push(note(
                    format!("{} needs signing in again", account.name),
                    "sign in again".to_owned(),
                    Tone::Bad,
                    Remedy::SignIn,
                ));
                continue;
            }
            Condition::Limited(until) if credits > 0 => found.push(note(
                format!(
                    "{} is limited until {}, and holds {}",
                    account.name,
                    clock(until, now, until.local_offset()),
                    credit_count(credits)
                ),
                format!(
                    "limited until {}, {} held",
                    clock(until, now, until.local_offset()),
                    credit_count(credits)
                ),
                Tone::Warn,
                Remedy::Redeem,
            )),
            Condition::Limited(_) => continue,
            _ => {}
        }
        for window in account
            .state
            .limits
            .windows
            .iter()
            .filter(|w| w.model.is_none())
        {
            let used = window.used_at(now);
            if let Some(pace) = pace(window, used, now).filter(|p| p.label.tone == Tone::Warn) {
                let title = lowercase_first(&Slot::of_window(window).title());
                found.push(note(
                    format!(
                        "{}'s {title} window {}",
                        account.name,
                        lowercase_first(&pace.label.text)
                    ),
                    format!("{title} {}", lowercase_first(&pace.label.text)),
                    Tone::Warn,
                    Remedy::Look,
                ));
            }
        }
        if let Some(at) = account
            .state
            .unexpired_credits(now)
            .find_map(|c| c.expires_at)
            .filter(|at| at.duration_since(now) < EXPIRING)
        {
            // slopmax would redeem it by itself unless a nudge says it won't.
            let held = report.nudges.iter().any(|n| {
                n.event == Kind::ResetExpiring && n.account.as_deref() == Some(&account.name)
            });
            found.push(note(
                format!(
                    "A limit reset on {} expires in {} · {}{}",
                    account.name,
                    human::until(at, now),
                    clock(at, now, at.local_offset()),
                    if held { "; auto-redeem is off" } else { "" }
                ),
                format!("reset expires in {}", human::until(at, now)),
                Tone::Warn,
                Remedy::Redeem,
            ));
        }
    }
    add_nudges(&mut found, report, now);
    found.sort_by_key(|a| a.tone != Tone::Bad);
    found
}

/// Adds the report's nudges to what wants a look, leaving out a limit
/// reset the list already offers to redeem.
fn add_nudges(found: &mut Vec<Attention>, report: &Report, now: Timestamp) {
    for nudge in &report.nudges {
        let Some(account) = nudge
            .account
            .as_deref()
            .and_then(|name| report.accounts.iter().find(|a| a.name == name))
        else {
            continue;
        };
        let until = nudge.until.unwrap_or(now);
        let item = |text: String, what: String, remedy| Attention {
            provider: account.provider,
            account: account.id.clone(),
            text,
            who: short_name(&account.name),
            what,
            tone: Tone::Warn,
            remedy,
        };
        let item = match nudge.event {
            // The list may already offer to redeem it, above.
            Kind::ResetExpiring
                if found
                    .iter()
                    .any(|f| f.account == account.id && f.remedy == Remedy::Redeem) =>
            {
                continue;
            }
            Kind::ResetExpiring => item(
                first_sentence(&nudge.message),
                format!("reset expires in {}", human::until(until, now)),
                Remedy::Redeem,
            ),
            // Quota about to go to waste: amber, as on the dashboard.
            Kind::QuotaUnused => {
                let (period, unused) = unused_at_reset(account, now);
                let worth = nudge
                    .worth
                    .filter(|d| *d >= 0.5)
                    .map(|d| format!(", about ${d:.0} of its plan"))
                    .unwrap_or_default();
                item(
                    format!(
                        "{}'s {period} resets in {} · {} with {unused:.0}% of it unused{worth}",
                        account.name,
                        human::until(until, now),
                        clock(until, now, until.local_offset()),
                    ),
                    format!(
                        "{period} ends in {}, {unused:.0}% unused",
                        human::until(until, now)
                    ),
                    Remedy::Look,
                )
            }
            _ => continue,
        };
        found.push(item);
    }
}

/// An account's long window, `week` or `month`, and how much of it is
/// unused, in percent.
fn unused_at_reset(account: &AccountReport, now: Timestamp) -> (&'static str, f64) {
    let long = account
        .state
        .limits
        .windows
        .iter()
        .filter(|w| w.model.is_none())
        .find(|w| matches!(w.span.as_str(), "7d" | "30d"));
    match long {
        Some(window) => (
            if window.span == "30d" {
                "month"
            } else {
                "week"
            },
            100.0 - window.used_at(now).clamp(0.0, 100.0),
        ),
        None => ("week", 0.0),
    }
}

/// A message's first sentence, without its full stop or the marks around
/// a command, and its times as the window sets them: `in 19h59m (19:12)`
/// as `in 19h59m · 19:12`.
fn first_sentence(message: &str) -> String {
    let first = message.split(". ").next().unwrap_or(message);
    let mut text = first.trim_end_matches('.').replace('`', "");
    while let Some(open) = text.find(" (")
        && let Some(close) = text[open..].find(')').map(|i| open + i)
    {
        let inner = text[open + 2..close].to_owned();
        text.replace_range(open..=close, &format!(" · {inner}"));
    }
    text
}

/// The accounts grouped by provider, in the order requests try them.
pub fn groups(report: &Report, now: Timestamp) -> Vec<Group> {
    ProviderId::ALL
        .into_iter()
        .filter_map(|provider| {
            let accounts: Vec<&AccountReport> = report
                .accounts
                .iter()
                .filter(|a| a.provider == provider)
                .collect();
            if accounts.is_empty() {
                return None;
            }
            let slots = slots(&accounts);
            let pool = report.pools.iter().find(|p| p.provider == provider);
            let shares = pool.map(|p| &p.shares).filter(|s| !s.is_empty());
            let weight = |account: &AccountReport| {
                shares.map_or(1.0, |s| s.get(&account.id).copied().unwrap_or(0.0) as f32)
            };
            let overview = slots
                .iter()
                .filter_map(|slot| {
                    // The pool's window, or a lone account's own.
                    let window = match pool {
                        Some(pool) => pool.windows.iter().find(|w| slot.holds(w)),
                        None if accounts.len() == 1 => slot.of(accounts[0]),
                        None => None,
                    }?;
                    Some(Overview {
                        title: slot.title(),
                        // Pooled accounts reset at staggered times, so an
                        // even spend of the pool means nothing.
                        gauge: Gauge {
                            pace: None,
                            ..gauge(window, now)
                        },
                        shares: accounts
                            .iter()
                            .map(|a| share(a, slot, weight(a), now))
                            .collect(),
                    })
                })
                .collect();
            let next = pool.and_then(|p| p.next.as_ref());
            let mut rows: Vec<Row> = accounts.iter().map(|a| row(a, &slots, now)).collect();
            for row in &mut rows {
                row.next = next.is_some_and(|n| n.account == row.id);
            }
            Some(Group {
                provider,
                title: provider.spec().title,
                subscription: provider.spec().is_subscription(),
                limits: slots.iter().map(Slot::title).collect(),
                accounts: rows,
                overview,
                working: pool.map_or_else(
                    || accounts.iter().filter(|a| serving(a)).count(),
                    |pool| pool.accounts,
                ),
                credits: pool_credits(&accounts, now),
                next: next_line(next, &accounts, now, false),
                next_short: next_line(next, &accounts, now, true),
                weighted: shares.is_some(),
            })
        })
        .collect()
}

/// Where a new session goes, worded: the account and why, or, when none
/// can take one, when the soonest is back.
/// With `short`, an account goes by its address's local part.
fn next_line(
    next: Option<&NextReport>,
    accounts: &[&AccountReport],
    now: Timestamp,
    short: bool,
) -> Label {
    let call = |name: &str| {
        if short {
            short_name(name)
        } else {
            name.to_owned()
        }
    };
    if let Some(next) = next {
        let name = call(
            accounts
                .iter()
                .find(|a| a.id == next.account)
                .map_or(next.account.as_str(), |a| a.name.as_str()),
        );
        return Label {
            text: format!("New sessions → {name} · {}", next.why),
            tone: Tone::Muted,
        };
    }
    let back = accounts
        .iter()
        .filter(|a| !a.disabled)
        .filter_map(|a| match a.condition(now) {
            Condition::Limited(until) => Some((until, a.name.as_str())),
            _ => None,
        })
        .min_by_key(|(until, _)| *until);
    Label {
        text: match back {
            Some((until, name)) => format!(
                "No account can take a new session until {}, when {} is back",
                clock(until, now, until.local_offset()),
                call(name)
            ),
            None => "No account can take a new session".to_owned(),
        },
        tone: Tone::Warn,
    }
}

/// A kind of usage window: its span, and the model it is limited to. Sorts
/// windows covering every request first, shortest first, then the rest.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Slot {
    scoped: bool,
    order: u8,
    span: String,
    model: Option<String>,
}

impl Slot {
    fn of_window(window: &Window) -> Self {
        Self {
            scoped: window.model.is_some(),
            order: match window.span.as_str() {
                "5h" => 0,
                "7d" => 1,
                "30d" => 2,
                _ => 3,
            },
            span: window.span.clone(),
            model: window.model.clone(),
        }
    }

    fn holds(&self, window: &Window) -> bool {
        window.span == self.span && window.model == self.model
    }

    fn of<'a>(&self, account: &'a AccountReport) -> Option<&'a Window> {
        account.state.limits.windows.iter().find(|w| self.holds(w))
    }

    fn title(&self) -> String {
        let span = match self.span.as_str() {
            "5h" => "5-hour",
            "7d" => "Weekly",
            "30d" => "Monthly",
            other => other,
        };
        match &self.model {
            Some(model) => format!("{span} · {model}"),
            None => span.to_owned(),
        }
    }
}

/// Every kind of window the accounts report, in column order.
fn slots(accounts: &[&AccountReport]) -> Vec<Slot> {
    let mut slots: Vec<Slot> = accounts
        .iter()
        .flat_map(|a| a.state.limits.windows.iter().map(Slot::of_window))
        .collect();
    slots.sort();
    slots.dedup();
    slots
}

/// A provider's reset credits across its accounts, and the next to expire.
fn pool_credits(accounts: &[&AccountReport], now: Timestamp) -> Option<String> {
    let total: u32 = accounts.iter().map(|a| a.state.credits_left(now)).sum();
    if total == 0 {
        return None;
    }
    let next = accounts
        .iter()
        .flat_map(|a| a.state.unexpired_credits(now))
        .filter_map(|c| c.expires_at)
        .min();
    let count = credit_count(total);
    Some(match next {
        Some(at) => format!("{count} · the next expires in {}", human::until(at, now)),
        None => count,
    })
}

fn credit_count(n: u32) -> String {
    match n {
        1 => "1 limit reset".to_owned(),
        n => format!("{n} limit resets"),
    }
}

/// The account's reset credits, for a provider that grants them.
fn credits(account: &AccountReport, now: Timestamp) -> Option<Credits> {
    let state = &account.state;
    let left = state.credits_left(now);
    if left == 0 || account.provider.get().credits().is_none() {
        return None;
    }
    let windows: Vec<&Window> = state
        .limits
        .windows
        .iter()
        .filter(|w| w.model.is_none())
        .collect();
    let clears: Vec<String> = windows
        .iter()
        .map(|w| lowercase_first(&Slot::of_window(w).title()))
        .collect();
    let held = if account.auth_error.is_some() {
        Some("Sign in again to redeem one")
    } else if account.disabled {
        Some("Turn it on to redeem one")
    } else if windows.iter().all(|w| w.used_at(now) <= 0.0) {
        Some("Nothing to reset yet")
    } else {
        None
    };
    Some(Credits {
        title: credit_count(left),
        credits: state
            .unexpired_credits(now)
            .map(|c| credit_line(c, now))
            .collect(),
        clears: listed(&clears),
        held: held.map(str::to_owned),
    })
}

fn credit_line(credit: &Credit, now: Timestamp) -> CreditLine {
    let expires = credit.expires_at;
    CreditLine {
        expires: match expires {
            Some(at) => format!("Expires {}", clock(at, now, at.local_offset())),
            None => "Does not expire".to_owned(),
        },
        line: match expires {
            Some(at) => format!(
                "Expires in {} · {}",
                human::until(at, now),
                clock(at, now, at.local_offset())
            ),
            None => "Does not expire".to_owned(),
        },
        left: expires.map(|at| format!("in {}", human::until(at, now))),
        granted: credit
            .granted_at
            .map(|at| format!("Granted {}", day(at, now, at.local_offset()))),
        tone: match expires {
            Some(at) if at.duration_since(now) < EXPIRING => Tone::Warn,
            _ => Tone::Muted,
        },
    }
}

/// When slopmax redeems `provider`'s reset credits by itself, as `config`
/// has it, if it does.
pub fn auto_redeem(config: &Config, provider: &str) -> Option<String> {
    let lead = CREDIT_EXPIRY_LEAD.as_secs() / 3_600;
    match (config.redeem_when_exhausted, config.redeem_expiring_credits) {
        (true, true) => Some(format!(
            "slopmax redeems one by itself when every {provider} account is spent, \
             and {lead} hours before one would expire unused."
        )),
        (false, true) => Some(format!(
            "slopmax redeems one by itself {lead} hours before it would expire unused, \
             if the account has quota to reset."
        )),
        (true, false) => Some(format!(
            "slopmax redeems one by itself when every {provider} account is spent."
        )),
        (false, false) => None,
    }
}

/// A strategy's name, as Settings lists it: `Reset first`.
pub fn strategy_title(strategy: Strategy) -> &'static str {
    match strategy {
        Strategy::ResetFirst => "Reset first",
        Strategy::FillFirst => "Fill first",
        Strategy::LeastUsed => "Least used",
        Strategy::RoundRobin => "Round robin",
    }
}

/// What a strategy does, as a sentence.
pub fn strategy_detail(strategy: Strategy) -> String {
    format!("{}.", strategy.summary())
}

/// How requests find their account, in a line: `Reset first · sessions
/// keep their account`.
pub fn routing(config: &Config) -> String {
    let sessions = if config.session_affinity {
        "sessions keep their account"
    } else {
        "sessions move between accounts"
    };
    format!("{} · {sessions}", strategy_title(config.strategy))
}

/// What session affinity does.
pub const AFFINITY: &str = "Keep a conversation on the account it started on, so its prompt \
                            cache stays warm. Off, the strategy places every request.";

/// How one request can ask otherwise.
pub const AFFINITY_HEADER: &str =
    "A request can ask otherwise with the x-slopmax-affinity header, set to on or off.";

/// What `redeem_expiring_credits` does.
pub fn redeem_expiring_detail() -> String {
    let lead = CREDIT_EXPIRY_LEAD.as_secs() / 3_600;
    format!("Redeem it {lead} hours before, if the account has quota to reset.")
}

/// What `redeem_when_exhausted` does.
pub const REDEEM_EXHAUSTED: &str =
    "Redeem one so the pool keeps serving, rather than wait for a reset.";

/// What the app says once `setting` is changed.
pub fn setting_changed(setting: Setting) -> String {
    match setting {
        Setting::Strategy(strategy) => format!(
            "slopmax now routes {}.",
            strategy_title(strategy).to_lowercase()
        ),
        Setting::SessionAffinity(true) => "Sessions keep the account they started on.".to_owned(),
        Setting::SessionAffinity(false) => "The strategy now places every request.".to_owned(),
        Setting::RedeemExpiringCredits(true) => {
            "Limit resets are redeemed before they expire.".to_owned()
        }
        Setting::RedeemExpiringCredits(false) => "Limit resets are left to expire.".to_owned(),
        Setting::RedeemWhenExhausted(true) => {
            "A limit reset is redeemed once every account is spent.".to_owned()
        }
        Setting::RedeemWhenExhausted(false) => {
            "Once every account is spent, the pool waits for a reset.".to_owned()
        }
        Setting::SessionTtlMins(mins) => format!(
            "A session keeps its account through {} idle.",
            minutes(mins)
        ),
        Setting::WarmWindows(true) => "Idle ChatGPT windows start as they reset.".to_owned(),
        Setting::WarmWindows(false) => "Idle windows wait for their first request.".to_owned(),
        Setting::PaidOverflow(true) => {
            "API keys take over once subscriptions are limited.".to_owned()
        }
        Setting::PaidOverflow(false) => {
            "API keys serve a subscription's models only when asked for by name.".to_owned()
        }
        Setting::PollMins(0) => "slopmax no longer polls usage.".to_owned(),
        Setting::PollMins(mins) => format!("slopmax polls usage every {}.", minutes(mins)),
    }
}

/// A live setting's description, as `slopmax config` lists it, as a
/// sentence.
pub fn live_detail(name: &str) -> String {
    let phrase = slopmax_core::config::LIVE
        .iter()
        .find(|(n, _)| *n == name)
        .map_or("", |(_, phrase)| phrase);
    let mut chars = phrase.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

/// The idle minutes a session may keep its account, as Settings offers
/// them.
pub const SESSION_TTL_STEPS: &[u64] = &[5, 15, 30, 60, 120, 240, 480, 1_440];
/// The minutes between usage polls, as Settings offers them; 0 is off.
pub const POLL_STEPS: &[u64] = &[0, 1, 2, 5, 10, 15, 30, 60];

/// The step after `current` among `steps`, `up` or down, if there is one.
/// A value set by hand between two steps goes to the nearer one that way.
pub fn step(steps: &[u64], current: u64, up: bool) -> Option<u64> {
    if up {
        steps.iter().copied().find(|s| *s > current)
    } else {
        steps.iter().rev().copied().find(|s| *s < current)
    }
}

/// `45 min`, `2 h`, `1 day`.
pub fn minutes(mins: u64) -> String {
    match mins {
        1_440 => "1 day".to_owned(),
        m if m >= 60 && m % 60 == 0 => format!("{} h", m / 60),
        m => format!("{m} min"),
    }
}

/// What weekly resets left unused over a range, in a line, as the
/// dashboard and `slopmax usage` say it: `4 weekly windows · 62% unused on
/// average across them`.
pub fn left_line(windows: u64, unused: f64) -> String {
    match windows {
        0 => "No weekly window reset in this range".to_owned(),
        1 => format!("1 weekly window · {unused:.0}% unused"),
        n => format!("{n} weekly windows · {unused:.0}% unused on average across them"),
    }
}

/// `a`, `a and b`, or `a, b, and c`.
fn listed(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

fn lowercase_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_lowercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn serving(account: &AccountReport) -> bool {
    !account.disabled && account.auth_error.is_none()
}

fn share(account: &AccountReport, slot: &Slot, weight: f32, now: Timestamp) -> Share {
    let used = slot.of(account).map_or(0.0, |w| w.used_at(now));
    Share {
        weight,
        fraction: (used / 100.0).clamp(0.0, 1.0) as f32,
        tone: Tone::of_use(used),
        idle: !serving(account),
    }
}

/// How long until any countdown the report shows reads differently: a
/// window's reset, a block or throttle lifting, a limit reset expiring, a
/// nudge's deadline. A UI redraws then, instead of every second; `None`
/// when nothing counts down.
pub fn next_change(report: &Report, now: Timestamp) -> Option<SignedDuration> {
    let accounts = report.accounts.iter().flat_map(|a| {
        let state = &a.state;
        let windows = state.limits.windows.iter().filter_map(|w| w.resets_at);
        let credits = state.unexpired_credits(now).filter_map(|c| c.expires_at);
        windows
            .chain(credits)
            .chain(state.blocked_until)
            .chain(state.throttled_until)
            .chain(state.limited_until(now))
    });
    let pools = report
        .pools
        .iter()
        .flat_map(|p| p.windows.iter().filter_map(|w| w.resets_at));
    let nudges = report.nudges.iter().filter_map(|n| n.until);
    accounts
        .chain(pools)
        .chain(nudges)
        .filter_map(|at| human::next_change(at, now))
        .min()
}

/// The menu bar's line: each subscription's use in its 5-hour window,
/// across its working accounts, as `Claude 42% · ChatGPT 18%`.
pub fn menu_bar(report: &Report, now: Timestamp) -> String {
    let parts: Vec<String> = report
        .pools
        .iter()
        .map(|pool| {
            let title = pool.provider.spec().title;
            match pool.window("5h") {
                Some(window) => format!("{title} {:.0}%", window.used_at(now)),
                None => format!("{title} —"),
            }
        })
        .collect();
    if parts.is_empty() {
        "slopmax".to_owned()
    } else {
        parts.join(" · ")
    }
}

/// The header's line about the proxy.
pub fn proxy_line(snapshot: &Snapshot) -> String {
    match &snapshot.proxy {
        Proxy::Checking => "Looking for the proxy…".to_owned(),
        Proxy::Starting => "Starting the proxy…".to_owned(),
        Proxy::Running { version } => format!("Running {version} at {}", snapshot.address),
        Proxy::Stopped => "Stopped: agents cannot reach slopmax".to_owned(),
    }
}

/// How an agent is wired, and whether that is through slopmax.
pub fn agent_line(agent: &AgentStatus) -> (String, bool) {
    match &agent.wiring {
        Wiring::Slopmax => ("Goes through slopmax".to_owned(), true),
        Wiring::Elsewhere(target) => (format!("Goes to {target}"), false),
        Wiring::Direct => ("Goes straight to its provider".to_owned(), false),
    }
}

/// The Start at login setting: whether it is on, whether it can change,
/// and what it says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Login {
    pub on: bool,
    pub available: bool,
    pub detail: String,
}

pub fn login(service: Option<&service::Status>) -> Login {
    match service {
        None => Login {
            on: false,
            available: false,
            detail: "This system has no login service slopmax can use, so the app starts the \
                     proxy while it runs."
                .to_owned(),
        },
        Some(s) => Login {
            on: s.installed,
            available: true,
            detail: if s.installed && !s.running {
                "Runs the proxy whenever you log in. It is not running now.".to_owned()
            } else {
                "Runs the proxy whenever you log in, even while the app is closed.".to_owned()
            },
        },
    }
}

/// What a sign-in in progress asks of the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInView {
    pub title: String,
    pub detail: String,
    /// The address to open, to show in full and copy.
    pub link: Option<String>,
    /// A device code to enter.
    pub code: Option<String>,
    /// Notes while waiting, such as a rejected paste.
    pub notes: String,
}

pub fn sign_in(sign_in: &SignIn) -> SignInView {
    let title = sign_in.provider.spec().title;
    let (detail, link, code) = match &sign_in.step {
        Step::Starting => ("Starting…".to_owned(), None, None),
        Step::Authorize { url, opened: true } => (
            format!("Finish signing in to {title} in your browser, which opened this address:"),
            Some(url.clone()),
            None,
        ),
        Step::Authorize { url, opened: false } => (
            format!("Open this address in a browser and sign in to {title}:"),
            Some(url.clone()),
            None,
        ),
        Step::DeviceCode { url, code } => (
            format!("Open {url} and enter this code:"),
            None,
            Some(code.clone()),
        ),
    };
    SignInView {
        title: format!("Signing in to {title}"),
        detail,
        link,
        code,
        notes: sign_in.notes.join("\n"),
    }
}

pub fn gauge(window: &Window, now: Timestamp) -> Gauge {
    let used = window.used_at(now);
    let reset = window.upcoming_reset(now).filter(|_| used > 0.0);
    Gauge {
        fraction: (used / 100.0).clamp(0.0, 1.0) as f32,
        percent: format!("{used:.0}%"),
        resets_in: reset.map(|at| human::until(at, now)),
        resets_at: reset.map(|at| clock(at, now, at.local_offset())),
        tone: Tone::of_use(used),
        pace: pace(window, used, now),
    }
}

/// How far within an even spend counts as on pace, in points.
const ON_PACE: f64 = 5.;

/// The window's use against spending it evenly until it resets: nothing
/// before 3% of it has passed, too soon to say, nor once it is spent.
fn pace(window: &Window, used: f64, now: Timestamp) -> Option<Pace> {
    let length = match window.span.as_str() {
        "5h" => 5 * 3_600,
        "7d" => 7 * 86_400,
        "30d" => 30 * 86_400,
        _ => return None,
    };
    let resets = window.upcoming_reset(now)?;
    let passed = length - resets.duration_since(now).as_secs();
    let elapsed = passed as f64 / length as f64;
    if !(0.03..1.).contains(&elapsed) || used >= 100. {
        return None;
    }
    let ahead = used - elapsed * 100.;
    let label = if ahead.abs() < ON_PACE {
        Label {
            text: "On pace".to_owned(),
            tone: Tone::Muted,
        }
    } else if ahead > 0. {
        // Ahead of an even spend, the same rate fills it before the reset.
        let rate = used / passed as f64;
        let out = now + SignedDuration::from_secs(((100. - used) / rate) as i64);
        Label {
            text: format!("Runs out ~{}", clock(out, now, out.local_offset())),
            tone: Tone::Warn,
        }
    } else {
        Label {
            text: format!("{:.0}% in reserve", -ahead),
            tone: Tone::Muted,
        }
    };
    Some(Pace {
        elapsed: elapsed as f32,
        label,
    })
}

/// `used 3m ago`, coarsely.
fn ago(at: Timestamp, now: Timestamp) -> String {
    let secs = now.duration_since(at).as_secs().max(0);
    match secs {
        0..60 => "used just now".to_owned(),
        60..3_600 => format!("used {}m ago", secs / 60),
        3_600..86_400 => format!("used {}h ago", secs / 3_600),
        _ => format!("used {}d ago", secs / 86_400),
    }
}

const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The day `at` fell on, on a clock `offset` east of UTC: `today`,
/// `yesterday`, or `Sep 21`.
fn day(at: Timestamp, now: Timestamp, offset: SignedDuration) -> String {
    let day = |t: Timestamp| (t.as_second() + offset.as_secs()).div_euclid(86_400);
    match day(now) - day(at) {
        0 => "today".to_owned(),
        1 => "yesterday".to_owned(),
        _ => {
            let (_, month, date) = at.date(offset);
            format!("{} {date}", MONTHS[month as usize - 1])
        }
    }
}

/// When `at` comes on a clock `offset` east of UTC: `22:59` on `now`'s day,
/// `Wed 20:27` within the week, `Nov 3` after.
fn clock(at: Timestamp, now: Timestamp, offset: SignedDuration) -> String {
    let day = |t: Timestamp| (t.as_second() + offset.as_secs()).div_euclid(86_400);
    let (hour, minute) = at.time_of_day(offset);
    match day(at) - day(now) {
        0 => format!("{hour:02}:{minute:02}"),
        // The first day, January 1st 1970, was a Thursday.
        1..=6 => format!(
            "{} {hour:02}:{minute:02}",
            WEEKDAYS[(day(at) + 3).rem_euclid(7) as usize]
        ),
        _ => {
            let (_, month, date) = at.date(offset);
            format!("{} {date}", MONTHS[month as usize - 1])
        }
    }
}

fn row(account: &AccountReport, slots: &[Slot], now: Timestamp) -> Row {
    let condition = account.condition(now);
    let plan = match &account.plan {
        Some(plan) => title_case(plan),
        None if !account.provider.spec().is_subscription() => "per token".to_owned(),
        None => String::new(),
    };
    Row {
        id: account.id.clone(),
        name: account.name.clone(),
        plan,
        limits: slots
            .iter()
            .map(|slot| slot.of(account).map(|w| gauge(w, now)))
            .collect(),
        status: Label {
            text: match condition {
                // A pin is how it stands too, so it says so here.
                Condition::Disabled => condition.describe(now),
                _ if account.pinned => format!("{} · pinned", condition.describe(now)),
                _ => condition.describe(now),
            },
            tone: condition.tone(),
        },
        // Reset credits show apart, where they can be redeemed, and a pin
        // in the status.
        notes: account
            .notes(now)
            .iter()
            .filter(|note| !matches!(note, Note::ResetCredits(_) | Note::Pinned))
            .map(note)
            .collect(),
        pinned: account.pinned,
        disabled: account.disabled,
        priority: account.priority,
        last_used: account.state.last_used.map(|at| ago(at, now)),
        credits: credits(account, now),
        next: false,
        follows: account.follows.clone(),
    }
}

/// `1,312`.
fn grouped(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, digit) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// `max 20x` as `Max 20x`: each word capitalized.
fn title_case(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Model patterns as typed, with commas or spaces between them.
pub fn patterns(text: &str) -> Vec<String> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A range's name as a choice: `7 days`.
pub fn range_title(range: crate::history::Range) -> &'static str {
    match range {
        crate::history::Range::Today => "Today",
        crate::history::Range::Week => "7 days",
        crate::history::Range::Month => "30 days",
    }
}

/// How a pool reads its accounts as one: `weighted by plan`, or an
/// average.
pub fn pool_basis(group: &Group) -> &'static str {
    if group.weighted {
        "weighted by plan"
    } else {
        "average of accounts"
    }
}

/// What a pool's bar shows, for a tooltip.
pub fn segments_tip(group: &Group) -> &'static str {
    if group.weighted {
        "One segment per account, as wide as its plan's share of the pool"
    } else {
        "One segment per account; the pool reads as their average"
    }
}

/// How bad a finding of the doctor's is.
pub fn level_tone(level: slopmax_core::doctor::Level) -> Tone {
    use slopmax_core::doctor::Level;
    match level {
        Level::Ok => Tone::Good,
        Level::Note => Tone::Muted,
        Level::Warn => Tone::Warn,
        Level::Fail => Tone::Bad,
    }
}

/// A note beside an account. What it has served counts every request since
/// it was added, which it says, as the Usage page counts a range.
fn note(note: &Note) -> Label {
    let text = match note {
        Note::Served { requests, tokens } => format!(
            "{} {}, {} tokens all time",
            grouped(*requests),
            if *requests == 1 {
                "request"
            } else {
                "requests"
            },
            human::compact(*tokens)
        ),
        other => other.describe(),
    };
    Label {
        text,
        tone: note.tone(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use slopmax_core::account::{Account, Tokens};
    use slopmax_core::limits::Limits;
    use slopmax_core::pool::{AccountState, CreditList, Pins};
    use slopmax_core::report::build;

    use super::*;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn window(span: &str, used: f64, resets_at: i64) -> Window {
        Window {
            span: span.into(),
            model: None,
            used,
            resets_at: Some(ts(resets_at)),
        }
    }

    /// Claude accounts with these windows each.
    fn report_of(now: Timestamp, accounts: Vec<(&str, Vec<Window>)>) -> Report {
        let accounts: Vec<(Account, Vec<Window>)> = accounts
            .into_iter()
            .map(|(email, windows)| {
                let mut account = Account::new(ProviderId::Claude, Tokens::default());
                account.email = Some(email.into());
                account.org_id = Some(email.into());
                account.assign_id();
                (account, windows)
            })
            .collect();
        let windows: HashMap<String, Vec<Window>> = accounts
            .iter()
            .map(|(a, windows)| (a.id.clone(), windows.clone()))
            .collect();
        build(
            accounts.into_iter().map(|(a, _)| a).collect(),
            |id| AccountState {
                limits: Limits {
                    windows: windows[id].clone(),
                    observed_at: Some(now),
                    reset_credits: None,
                },
                ..AccountState::default()
            },
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            true,
            now,
        )
    }

    fn report(now: Timestamp) -> Report {
        report_of(
            now,
            [("a@x.dev", 80.0), ("b@x.dev", 20.0)]
                .into_iter()
                .map(|(email, used)| {
                    (
                        email,
                        vec![window("5h", used, 4_600), window("7d", 10.0, 90_000)],
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn groups_carry_gauges_status_and_the_pool() {
        let now = ts(1_000);
        let groups = groups(&report(now), now);
        assert_eq!(groups.len(), 1);
        let claude = &groups[0];
        assert_eq!(claude.title, "Claude");
        assert_eq!(claude.limits, ["5-hour", "Weekly"]);
        assert_eq!(claude.accounts.len(), 2);
        let busy = &claude.accounts[0];
        let five_hour = busy.limits[0].as_ref().unwrap();
        assert_eq!(five_hour.percent, "80%");
        assert_eq!(five_hour.resets_in.as_deref(), Some("1h00m"));
        assert_eq!(five_hour.tone, Tone::Warn);
        assert_eq!(busy.status.text, "ready");
        assert_eq!(claude.working, 2);
        let pool = &claude.overview[0];
        assert_eq!(pool.title, "5-hour");
        assert_eq!(pool.gauge.percent, "50%");
        let shares: Vec<f32> = pool.shares.iter().map(|s| s.fraction).collect();
        assert_eq!(shares, [0.8, 0.2]);
    }

    #[test]
    fn a_window_for_one_model_gets_a_column_after_the_shared_ones() {
        let now = ts(1_000);
        let fable = Window {
            model: Some("Fable".into()),
            ..window("7d", 30.0, 90_000)
        };
        let report = report_of(
            now,
            vec![
                ("a@x.dev", vec![fable, window("5h", 10.0, 4_600)]),
                ("b@x.dev", vec![window("7d", 5.0, 90_000)]),
            ],
        );
        let claude = &groups(&report, now)[0];
        assert_eq!(claude.limits, ["5-hour", "Weekly", "Weekly · Fable"]);
        let percents = |row: &Row| -> Vec<Option<String>> {
            row.limits
                .iter()
                .map(|g| g.as_ref().map(|g| g.percent.clone()))
                .collect()
        };
        assert_eq!(
            percents(&claude.accounts[0]),
            [Some("10%".into()), None, Some("30%".into())]
        );
        assert_eq!(
            percents(&claude.accounts[1]),
            [None, Some("5%".into()), None]
        );
    }

    #[test]
    fn resets_read_on_the_local_clock() {
        // 1970-01-01 00:16:40 UTC, a Thursday.
        let now = ts(1_000);
        let utc = SignedDuration::ZERO;
        assert_eq!(clock(ts(1_000 + 22 * 3_600), now, utc), "22:16");
        assert_eq!(clock(ts(1_000 + 2 * 86_400), now, utc), "Sat 00:16");
        assert_eq!(clock(ts(1_000 + 10 * 86_400), now, utc), "Jan 11");
        // Five hours west, `now` is still Wednesday evening, so 00:16 UTC
        // the next morning lands on Thursday there.
        let west = SignedDuration::from_secs(-5 * 3_600);
        assert_eq!(clock(ts(1_000 + 5 * 3_600), now, west), "Thu 00:16");
    }

    #[test]
    fn pace_compares_use_with_an_even_spend() {
        let now = ts(100_000);
        // Halfway through a 5-hour window.
        let half = |used: f64| window("5h", used, 100_000 + 9_000);
        let label = |used| pace(&half(used), used, now).unwrap().label;
        assert_eq!(pace(&half(50.), 50., now).unwrap().elapsed, 0.5);
        assert_eq!(label(52.).text, "On pace");
        assert_eq!(label(20.).text, "30% in reserve");
        let ahead = label(70.);
        assert!(ahead.text.starts_with("Runs out ~"), "{}", ahead.text);
        assert_eq!(ahead.tone, Tone::Warn);
        // Too soon to say, and nothing left to pace.
        assert_eq!(pace(&window("5h", 10., 100_000 + 17_900), 10., now), None);
        assert_eq!(pace(&half(100.), 100., now), None);
    }

    #[test]
    fn last_use_reads_coarsely() {
        let now = ts(100_000);
        assert_eq!(ago(ts(99_990), now), "used just now");
        assert_eq!(ago(ts(100_000 - 180), now), "used 3m ago");
        assert_eq!(ago(ts(100_000 - 7_300), now), "used 2h ago");
        assert_eq!(ago(ts(100_000 - 200_000), now), "used 2d ago");
    }

    #[test]
    fn reset_credits_show_their_dates_and_what_they_clear() {
        // Midday, so the dates hold on any local clock.
        let day = 86_400;
        let noon = |n: i64| n * day + day / 2;
        let now = ts(noon(100));
        let mut account = Account::new(ProviderId::Codex, Tokens::default());
        account.email = Some("c@x.dev".into());
        account.account_id = Some("c".into());
        account.assign_id();
        let credit = |id: &str, granted: i64, expires: i64| Credit {
            id: id.into(),
            title: None,
            granted_at: Some(ts(granted)),
            expires_at: Some(ts(expires)),
        };
        let state = AccountState {
            limits: Limits {
                windows: vec![
                    window("5h", 100.0, noon(100) + 3_600),
                    window("7d", 64.0, noon(102)),
                ],
                observed_at: Some(now),
                reset_credits: Some(2),
            },
            credits: Some(CreditList {
                credits: vec![
                    credit("soon", noon(71), noon(102)),
                    credit("later", noon(99), noon(129)),
                ],
                listed_at: now,
                counted: Some(2),
            }),
            ..AccountState::default()
        };
        let report = build(
            vec![account],
            |_| state.clone(),
            &Pins::new(),
            &HashMap::new(),
            Strategy::FillFirst,
            true,
            now,
        );
        let chatgpt = &groups(&report, now)[0];
        assert_eq!(
            chatgpt.credits.as_deref(),
            Some("2 limit resets · the next expires in 2d0h")
        );
        let row = &chatgpt.accounts[0];
        // Shown apart from the notes, where they can be redeemed.
        assert!(row.notes.iter().all(|n| !n.text.contains("reset")));
        let credits = row.credits.as_ref().unwrap();
        assert_eq!(credits.title, "2 limit resets");
        assert_eq!(credits.clears, "5-hour and weekly");
        assert_eq!(credits.held, None);
        let soon = &credits.credits[0];
        assert_eq!(soon.left.as_deref(), Some("in 2d0h"));
        assert_eq!(soon.granted.as_deref(), Some("Granted Mar 13"));
        assert_eq!(soon.tone, Tone::Warn);
        let later = &credits.credits[1];
        assert_eq!(later.expires, "Expires May 10");
        assert_eq!(later.granted.as_deref(), Some("Granted yesterday"));
        assert_eq!(later.tone, Tone::Muted);
    }

    #[test]
    fn status_and_attention_say_what_wants_a_look() {
        let now = ts(10_000);
        let mut report = report_of(
            now,
            vec![
                ("out@x.dev", vec![window("5h", 10.0, 10_000 + 9_000)]),
                // Ninety percent used with three of five hours to go.
                ("busy@x.dev", vec![window("5h", 90.0, 10_000 + 10_800)]),
                ("calm@x.dev", vec![window("5h", 10.0, 10_000 + 9_000)]),
            ],
        );
        report.accounts[0].auth_error = Some("revoked".into());
        report.accounts[2].disabled = true;
        let status = status(&report, now);
        assert_eq!(status.headline, "1 of 2 accounts are ready");
        assert_eq!(
            status.detail.as_deref(),
            Some("1 needs signing in · 1 turned off")
        );
        assert_eq!(status.tone, Tone::Bad);

        let attention = attention(&report, now);
        let found: Vec<(&str, Remedy)> = attention
            .iter()
            .map(|a| (a.text.as_str(), a.remedy))
            .collect();
        // The signed-out account first; a turned-off one wants nothing.
        assert_eq!(
            found[0],
            ("out@x.dev needs signing in again", Remedy::SignIn)
        );
        assert_eq!(found.len(), 2);
        assert!(
            found[1]
                .0
                .starts_with("busy@x.dev's 5-hour window runs out ~"),
            "{}",
            found[1].0
        );
        assert_eq!(found[1].1, Remedy::Look);

        report.accounts.clear();
        assert_eq!(status_of(&report, now), "No accounts yet");
    }

    fn status_of(report: &Report, now: Timestamp) -> String {
        status(report, now).headline
    }

    #[test]
    fn the_menu_bar_shows_each_pool() {
        let now = ts(1_000);
        assert_eq!(menu_bar(&report(now), now), "Claude 50%");
        // Once the window resets, its use is gone.
        assert_eq!(menu_bar(&report(now), ts(5_000)), "Claude 0%");
    }

    #[test]
    fn a_pool_says_where_new_sessions_go() {
        let now = ts(1_000);
        let mut report = report(now);
        let b = report.accounts[1].id.clone();
        report.pools[0].next = Some(NextReport {
            account: b.clone(),
            reason: slopmax_core::pool::Reason::ResetsSoonest,
            why: "its quota resets soonest".to_owned(),
        });
        let group = &groups(&report, now)[0];
        assert_eq!(
            group.next,
            Label {
                text: "New sessions → b@x.dev · its quota resets soonest".to_owned(),
                tone: Tone::Muted,
            }
        );
        assert_eq!(
            group.next_short.text,
            "New sessions → b · its quota resets soonest"
        );
        let next: Vec<bool> = group.accounts.iter().map(|row| row.next).collect();
        assert_eq!(next, [false, true]);
    }

    #[test]
    fn with_no_account_free_it_says_when_one_is_back() {
        let now = ts(1_000);
        let report = report(now);
        // No preview of the next session: nothing can take one.
        let group = &groups(&report, now)[0];
        assert_eq!(group.next.tone, Tone::Warn);
        assert_eq!(group.next.text, "No account can take a new session");
        assert!(group.accounts.iter().all(|row| !row.next));

        let limited = report_of(
            now,
            vec![
                ("a@x.dev", vec![window("5h", 100.0, 4_600)]),
                ("b@x.dev", vec![window("5h", 100.0, 9_000)]),
            ],
        );
        let line = &groups(&limited, now)[0].next;
        assert!(
            line.text
                .starts_with("No account can take a new session until ")
                && line.text.ends_with(", when a@x.dev is back"),
            "{}",
            line.text
        );
    }

    #[test]
    fn a_pin_reads_in_the_status_and_use_says_its_period() {
        let now = ts(1_000);
        let mut report = report(now);
        report.accounts[0].pinned = true;
        report.accounts[0].state.usage = slopmax_core::wire::Usage {
            requests: 120,
            input_tokens: 5_000_000,
            output_tokens: 150_000,
            cache_read_tokens: 0,
            cache_write_tokens: 50_000,
        };
        report.accounts[1].disabled = true;
        let rows = &groups(&report, now)[0].accounts;
        assert_eq!(rows[0].status.text, "ready · pinned");
        let notes: Vec<&str> = rows[0].notes.iter().map(|n| n.text.as_str()).collect();
        assert_eq!(notes, ["120 requests, 5.2M tokens all time"]);
        assert_eq!(grouped(1_312), "1,312");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000_000), "1,000,000");
        assert_eq!(rows[1].status.text, "disabled");
    }

    #[test]
    fn nudges_join_what_wants_a_look_once() {
        use slopmax_core::notify::Event;
        let now = ts(1_000);
        let mut report = report(now);
        let nudge = |kind, account: &str, message: &str| Event {
            event: kind,
            provider: Some(ProviderId::Claude),
            account: Some(account.to_owned()),
            until: Some(ts(60_000)),
            message: message.to_owned(),
            at: now,
            worth: None,
        };
        report.nudges = vec![
            nudge(
                Kind::QuotaUnused,
                "b@x.dev",
                "b@x.dev's week resets in 19h59m (19:12) with 79% of it unused, about $4 of its \
                 plan. Work sent there before then costs nothing extra.",
            ),
            nudge(
                Kind::ResetExpiring,
                "a@x.dev",
                "A limit reset on a@x.dev expires in 18h (18:10); redeem it with `slopmax redeem \
                 a@x.dev` before it is lost.",
            ),
            nudge(Kind::QuotaUnused, "nobody@x.dev", "Gone."),
        ];
        let items = attention(&report, now);
        let unused = items.iter().find(|a| a.remedy == Remedy::Look).unwrap();
        // Its words are the window's own, its time with the day it falls
        // on, as every other line has it.
        assert!(
            unused
                .text
                .starts_with("b@x.dev's week resets in 16h23m · ")
                && unused.text.ends_with(" with 90% of it unused"),
            "{}",
            unused.text
        );
        assert_eq!(unused.who, "b");
        assert_eq!(unused.what, "week ends in 16h23m, 90% unused");
        assert_eq!(unused.tone, Tone::Warn, "amber, as on the dashboard");
        assert_eq!(unused.account, report.accounts[1].id);
        let reset = items.iter().find(|a| a.remedy == Remedy::Redeem).unwrap();
        assert!(!reset.text.contains('`'), "{}", reset.text);
        assert_eq!(reset.account, report.accounts[0].id);
        // An account it cannot find is left out.
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn a_reset_already_offered_is_not_offered_twice() {
        use slopmax_core::notify::Event;
        let now = ts(1_000);
        let mut report = report(now);
        report.nudges = vec![Event {
            event: Kind::ResetExpiring,
            provider: Some(ProviderId::Claude),
            account: Some("a@x.dev".to_owned()),
            until: Some(ts(60_000)),
            message: "A limit reset on a@x.dev expires soon.".to_owned(),
            at: now,
            worth: None,
        }];
        let already = Attention {
            provider: ProviderId::Claude,
            account: report.accounts[0].id.clone(),
            text: "already offered".to_owned(),
            who: "a".to_owned(),
            what: "reset expires in 1h".to_owned(),
            tone: Tone::Warn,
            remedy: Remedy::Redeem,
        };
        let mut found = vec![already.clone()];
        add_nudges(&mut found, &report, now);
        assert_eq!(found, [already]);
        // Without it, the nudge is offered.
        let mut found = Vec::new();
        add_nudges(&mut found, &report, now);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].remedy, Remedy::Redeem);
    }

    #[test]
    fn advanced_settings_step_and_read() {
        assert_eq!(step(SESSION_TTL_STEPS, 60, true), Some(120));
        assert_eq!(step(SESSION_TTL_STEPS, 60, false), Some(30));
        // Set by hand between two steps, it goes to the nearer one each way.
        assert_eq!(step(SESSION_TTL_STEPS, 45, true), Some(60));
        assert_eq!(step(SESSION_TTL_STEPS, 45, false), Some(30));
        assert_eq!(step(SESSION_TTL_STEPS, 1_440, true), None);
        assert_eq!(step(POLL_STEPS, 0, false), None);
        assert_eq!(step(POLL_STEPS, 0, true), Some(1));
        assert_eq!(minutes(45), "45 min");
        assert_eq!(minutes(120), "2 h");
        assert_eq!(minutes(1_440), "1 day");
        assert_eq!(
            live_detail("session_ttl_mins"),
            "Idle minutes before a session's account is forgotten."
        );
        assert_eq!(live_detail("no_such_setting"), "");
        assert_eq!(
            setting_changed(Setting::PollMins(0)),
            "slopmax no longer polls usage."
        );
        assert_eq!(
            setting_changed(Setting::SessionTtlMins(120)),
            "A session keeps its account through 2 h idle."
        );
        for setting in [
            Setting::WarmWindows(true),
            Setting::WarmWindows(false),
            Setting::PaidOverflow(true),
            Setting::PaidOverflow(false),
            Setting::PollMins(5),
        ] {
            assert!(setting_changed(setting).ends_with('.'));
        }
    }

    #[test]
    fn what_resets_left_reads_as_a_line() {
        assert_eq!(left_line(0, 0.), "No weekly window reset in this range");
        assert_eq!(left_line(1, 38.4), "1 weekly window · 38% unused");
        assert_eq!(
            left_line(4, 26.),
            "4 weekly windows · 26% unused on average across them"
        );
    }

    #[test]
    fn a_weighted_pool_sizes_its_segments_by_plan() {
        let now = ts(1_000);
        let mut report = report(now);
        let group = &groups(&report, now)[0];
        assert!(!group.weighted);
        assert_eq!(pool_basis(group), "average of accounts");
        assert!(group.overview[0].shares.iter().all(|s| s.weight == 1.0));

        let (a, b) = (report.accounts[0].id.clone(), report.accounts[1].id.clone());
        report.pools[0].shares = [(a, 20.0 / 25.0), (b, 5.0 / 25.0)].into_iter().collect();
        let group = &groups(&report, now)[0];
        assert!(group.weighted);
        assert_eq!(pool_basis(group), "weighted by plan");
        assert!(segments_tip(group).contains("plan"));
        let weights: Vec<f32> = group.overview[0].shares.iter().map(|s| s.weight).collect();
        assert_eq!(weights, [0.8, 0.2]);
    }

    #[test]
    fn plans_read_in_title_case_and_a_followed_login_names_its_tool() {
        let now = ts(1_000);
        let mut report = report(now);
        report.accounts[0].plan = Some("max 20x".to_owned());
        report.accounts[0].follows = Some("Claude Code".to_owned());
        let rows = &groups(&report, now)[0].accounts;
        assert_eq!(rows[0].plan, "Max 20x");
        assert_eq!(rows[0].follows.as_deref(), Some("Claude Code"));
        assert_eq!(rows[1].follows, None);
    }

    #[test]
    fn small_words_for_the_access_page_and_ranges() {
        assert_eq!(
            patterns("claude-*, gpt-6-sol  local-*,,"),
            ["claude-*", "gpt-6-sol", "local-*"]
        );
        assert!(patterns("  ").is_empty());
        assert_eq!(range_title(crate::history::Range::Week), "7 days");
        assert_eq!(range_title(crate::history::Range::Month), "30 days");
        use slopmax_core::doctor::Level;
        assert_eq!(level_tone(Level::Ok), Tone::Good);
        assert_eq!(level_tone(Level::Note), Tone::Muted);
        assert_eq!(level_tone(Level::Warn), Tone::Warn);
        assert_eq!(level_tone(Level::Fail), Tone::Bad);
    }

    #[test]
    fn the_menu_bar_without_pools_shows_the_name() {
        let report = report_of(ts(1_000), Vec::new());
        assert_eq!(menu_bar(&report, ts(1_000)), "slopmax");
    }

    #[test]
    fn every_strategy_has_a_name_and_a_sentence() {
        let titles: Vec<&str> = Strategy::ALL.into_iter().map(strategy_title).collect();
        assert_eq!(
            titles,
            ["Reset first", "Fill first", "Least used", "Round robin"]
        );
        for strategy in Strategy::ALL {
            let detail = strategy_detail(strategy);
            assert!(detail.ends_with('.') && !detail.ends_with(".."), "{detail}");
            assert!(detail.starts_with(strategy.summary()));
        }
    }

    #[test]
    fn routing_reads_as_a_line() {
        let mut config = Config::default();
        assert_eq!(
            routing(&config),
            "Reset first · sessions keep their account"
        );
        config.strategy = Strategy::RoundRobin;
        config.session_affinity = false;
        assert_eq!(
            routing(&config),
            "Round robin · sessions move between accounts"
        );
    }

    #[test]
    fn changing_a_setting_says_what_it_does_now() {
        assert_eq!(
            setting_changed(Setting::Strategy(Strategy::FillFirst)),
            "slopmax now routes fill first."
        );
        let said: Vec<String> = [
            Setting::SessionAffinity(true),
            Setting::SessionAffinity(false),
            Setting::RedeemExpiringCredits(true),
            Setting::RedeemExpiringCredits(false),
            Setting::RedeemWhenExhausted(true),
            Setting::RedeemWhenExhausted(false),
        ]
        .into_iter()
        .map(setting_changed)
        .collect();
        for (i, text) in said.iter().enumerate() {
            assert!(text.ends_with('.'), "{text}");
            assert!(!said[..i].contains(text), "{text} said twice");
        }
        assert!(AFFINITY.contains("prompt cache"));
        assert!(AFFINITY_HEADER.contains("x-slopmax-affinity"));
        let lead = CREDIT_EXPIRY_LEAD.as_secs() / 3_600;
        assert!(redeem_expiring_detail().contains(&format!("{lead} hours")));
    }

    #[test]
    fn auto_redeem_follows_the_config() {
        let mut config = Config::default();
        let say = |config: &Config| auto_redeem(config, "ChatGPT");
        config.redeem_expiring_credits = false;
        config.redeem_when_exhausted = false;
        assert_eq!(say(&config), None);
        config.redeem_when_exhausted = true;
        assert_eq!(
            say(&config).as_deref(),
            Some("slopmax redeems one by itself when every ChatGPT account is spent.")
        );
        config.redeem_expiring_credits = true;
        let both = say(&config).unwrap();
        assert!(both.contains("every ChatGPT account is spent") && both.contains("hours before"));
        config.redeem_when_exhausted = false;
        let expiring = say(&config).unwrap();
        assert!(expiring.contains("before it would expire unused"));
        assert!(!expiring.contains("spent"));
    }

    #[test]
    fn lists_read_as_english() {
        let items = |list: &[&str]| -> Vec<String> { list.iter().map(|s| s.to_string()).collect() };
        assert_eq!(listed(&items(&[])), "");
        assert_eq!(listed(&items(&["a"])), "a");
        assert_eq!(listed(&items(&["a", "b"])), "a and b");
        assert_eq!(listed(&items(&["a", "b", "c"])), "a, b, and c");
    }

    fn snapshot(proxy: Proxy) -> Snapshot {
        Snapshot {
            proxy,
            address: "http://127.0.0.1:7567".to_owned(),
            report: None,
            agents: Vec::new(),
            service: None,
            sign_in: None,
            notice: None,
            history: None,
            today: None,
            redeeming: None,
            config: Config::default(),
            notifications: true,
            new_key: None,
            doctor: Doctor::NotRun,
        }
    }

    #[test]
    fn the_proxy_line_says_how_it_stands() {
        assert_eq!(
            proxy_line(&snapshot(Proxy::Running {
                version: "0.3.0".to_owned()
            })),
            "Running 0.3.0 at http://127.0.0.1:7567"
        );
        assert_eq!(
            proxy_line(&snapshot(Proxy::Stopped)),
            "Stopped: agents cannot reach slopmax"
        );
        assert_eq!(
            proxy_line(&snapshot(Proxy::Checking)),
            "Looking for the proxy…"
        );
        assert_eq!(
            proxy_line(&snapshot(Proxy::Starting)),
            "Starting the proxy…"
        );
    }

    #[test]
    fn agents_and_the_service_read_plainly() {
        let agent = |wiring| AgentStatus {
            id: "codex",
            title: "Codex",
            wiring,
        };
        assert_eq!(
            agent_line(&agent(Wiring::Slopmax)),
            ("Goes through slopmax".to_owned(), true)
        );
        assert_eq!(
            agent_line(&agent(Wiring::Elsewhere("http://elsewhere".to_owned()))),
            ("Goes to http://elsewhere".to_owned(), false)
        );
        assert!(!agent_line(&agent(Wiring::Direct)).1);

        let status = |installed, running| service::Status {
            installed,
            running,
            lingering: None,
        };
        // With no service manager, the switch is off and cannot change.
        let none = login(None);
        assert!(!none.on && !none.available);
        assert!(none.detail.contains("no login service"));
        let on = login(Some(&status(true, true)));
        assert!(on.on && on.available);
        assert!(on.detail.starts_with("Runs the proxy whenever you log in"));
        assert!(
            login(Some(&status(true, false)))
                .detail
                .contains("not running now")
        );
        let off = login(Some(&status(false, false)));
        assert!(!off.on && off.available);
    }

    #[test]
    fn a_sign_in_says_what_to_do_next() {
        let at = |step| SignIn {
            provider: ProviderId::Claude,
            step,
            notes: vec!["That address was not it.".to_owned()],
        };
        let starting = sign_in(&at(Step::Starting));
        assert_eq!(starting.title, "Signing in to Claude");
        assert_eq!(starting.notes, "That address was not it.");
        assert_eq!((starting.link, starting.code), (None, None));

        let url = "https://example.invalid/authorize".to_owned();
        let opened = sign_in(&at(Step::Authorize {
            url: url.clone(),
            opened: true,
        }));
        assert!(opened.detail.contains("in your browser"));
        assert_eq!(opened.link.as_deref(), Some(url.as_str()));
        let closed = sign_in(&at(Step::Authorize {
            url: url.clone(),
            opened: false,
        }));
        assert!(closed.detail.starts_with("Open this address"));

        let device = sign_in(&at(Step::DeviceCode {
            url: url.clone(),
            code: "ABCD-1234".to_owned(),
        }));
        assert_eq!(device.code.as_deref(), Some("ABCD-1234"));
        assert_eq!(device.link, None);
        assert!(device.detail.contains(&url));
    }

    #[test]
    fn a_window_redraws_when_its_soonest_countdown_reads_differently() {
        let now = ts(1_000_000);
        // Two hours and thirty seconds reads `2h00m` for 31 more seconds;
        // a week off, the soonest wins.
        let report = report_of(
            now,
            vec![
                ("a@x.dev", vec![window("5h", 40.0, 1_000_000 + 7_230)]),
                (
                    "b@x.dev",
                    vec![window("7d", 10.0, 1_000_000 + 7 * 86_400 + 1_800)],
                ),
            ],
        );
        assert_eq!(next_change(&report, now).map(|d| d.as_secs()), Some(31));
        // Under the hour, the seconds show: every second.
        let soon = report_of(
            now,
            vec![("a@x.dev", vec![window("5h", 40.0, 1_000_000 + 600)])],
        );
        assert_eq!(next_change(&soon, now).map(|d| d.as_secs()), Some(1));
        // Nothing counting down: nothing to redraw for.
        let still = report_of(
            now,
            vec![("a@x.dev", vec![window("5h", 40.0, 1_000_000 - 60)])],
        );
        assert_eq!(next_change(&still, now), None);
    }
}
