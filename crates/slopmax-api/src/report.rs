//! The status report: every account, how it stands, and each subscription's
//! accounts read as one pool. Every decision a front end shows (an
//! account's condition, the notes beside it, the tones they are colored in,
//! which account a new session would get) is made here by the daemon, so
//! the CLI, the web UI and the apps never disagree and only format.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{Instant, NoticeKind, Provider, Span, Strategy, Tone};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The version of the slopmax that built it.
    pub version: String,
    /// From a running proxy, with its live sessions, rather than read from
    /// disk.
    pub live: bool,
    pub generated_at: Instant,
    pub strategy: Strategy,
    pub accounts: Vec<AccountView>,
    pub pools: Vec<PoolView>,
    /// What is worth doing before it is lost: resets about to lapse, weeks
    /// about to reset with quota to spare.
    pub nudges: Vec<Notice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    pub provider: Provider,
    /// Its label, else its email, else its id.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub disabled: bool,
    pub priority: i32,
    pub pinned: bool,
    /// The tool whose copy of the tokens slopmax follows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<Instant>,
    /// For keys and endpoints: where requests go.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// For keys and endpoints: the models served, as patterns.
    pub models: Vec<String>,
    pub sessions: u64,
    pub condition: Condition,
    pub notes: Vec<Note>,
    pub windows: Vec<Window>,
    /// Limit resets it holds, soonest to expire first.
    pub resets: Vec<LimitReset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used: Option<Instant>,
    pub served: Usage,
}

/// Where an account stands, most pressing first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Condition {
    /// Its sign-in stopped working; only signing in again fixes it.
    SignInNeeded {
        error: String,
    },
    Disabled,
    /// Out of quota until then.
    Limited {
        until: Instant,
    },
    /// Briefly held back by the provider.
    Throttled {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until: Option<Instant>,
    },
    /// Serving this many sessions.
    Active {
        sessions: u64,
    },
    Ready,
}

impl Condition {
    /// As it stands at `now`: a limit or a hold whose time has passed is
    /// over, though the report was made before.
    pub fn at(&self, now: Instant) -> Condition {
        match self {
            Self::Limited { until } if *until <= now => Self::Ready,
            Self::Throttled { until: Some(until) } if *until <= now => Self::Ready,
            other => other.clone(),
        }
    }

    /// In words, as `slopmax status` says it.
    pub fn describe(&self, now: Instant) -> String {
        match self {
            Self::SignInNeeded { error } => format!("sign in again ({error})"),
            Self::Disabled => "disabled".into(),
            Self::Limited { until } => {
                format!(
                    "limited · back in {}",
                    slopmax_common::human::until(*until, now)
                )
            }
            Self::Throttled { .. } => "throttled".into(),
            Self::Active { sessions: 1 } => "● active · 1 session".into(),
            Self::Active { sessions } => format!("● active · {sessions} sessions"),
            Self::Ready => "ready".into(),
        }
    }

    pub fn tone(&self) -> Tone {
        match self {
            Self::SignInNeeded { .. } => Tone::Bad,
            Self::Disabled => Tone::Muted,
            Self::Limited { .. } | Self::Throttled { .. } => Tone::Warn,
            Self::Active { .. } | Self::Ready => Tone::Good,
        }
    }
}

/// A note beside an account's condition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum Note {
    /// Chosen with `slopmax use` for new sessions.
    Pinned,
    Priority {
        value: i32,
    },
    /// The tool whose copy of the tokens slopmax follows.
    Follows {
        tool: String,
    },
    /// Limit resets the account holds.
    Resets {
        count: u64,
    },
    /// Requests served since slopmax started, and their tokens.
    Served {
        requests: u64,
        tokens: u64,
    },
    LastError {
        text: String,
    },
}

impl Note {
    /// In words, as `slopmax status` says it.
    pub fn describe(&self) -> String {
        match self {
            Self::Pinned => "pinned".into(),
            Self::Priority { value } => format!("priority {value}"),
            Self::Follows { tool } => format!("follows {tool}"),
            Self::Resets { count: 1 } => "1 limit reset".into(),
            Self::Resets { count } => format!("{count} limit resets"),
            Self::Served { requests, tokens } => {
                format!(
                    "{requests} req · {} tok",
                    slopmax_common::human::compact(*tokens)
                )
            }
            Self::LastError { text } => format!("last error: {text}"),
        }
    }

    pub fn tone(&self) -> Tone {
        match self {
            Self::Pinned | Self::Resets { .. } => Tone::Accent,
            _ => Tone::Muted,
        }
    }
}

/// A window's use: a warning from 70%, bad from 90%.
pub fn tone_of_use(used: f64) -> Tone {
    match used {
        u if u >= 90.0 => Tone::Bad,
        u if u >= 70.0 => Tone::Warn,
        _ => Tone::Good,
    }
}

/// One usage window of an account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub span: Span,
    /// The model it caps, for a window on one model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Percent used, 0 to 100.
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<Instant>,
}

impl Window {
    /// Its use at `now`: none once it has reset.
    pub fn used_at(&self, now: Instant) -> f64 {
        used_at(self.used, self.resets_at, now)
    }

    /// When it resets, if that is still ahead.
    pub fn upcoming_reset(&self, now: Instant) -> Option<Instant> {
        self.resets_at.filter(|at| *at > now)
    }

    /// `5h`, `7d`, or `7d Fable`.
    pub fn label(&self) -> String {
        match &self.model {
            Some(model) => format!("{} {model}", self.span.as_str()),
            None => self.span.as_str().into(),
        }
    }
}

fn used_at(used: f64, resets_at: Option<Instant>, now: Instant) -> f64 {
    match resets_at {
        Some(at) if at <= now => 0.0,
        _ => used,
    }
}

impl AccountView {
    /// Its window of `span` over every request.
    pub fn window(&self, span: Span) -> Option<&Window> {
        self.windows
            .iter()
            .find(|w| w.model.is_none() && w.span == span)
    }

    /// The longer window: the week, or for plans without one, the month.
    pub fn long_window(&self) -> Option<&Window> {
        self.window(Span::Week).or_else(|| self.window(Span::Month))
    }

    /// Windows that cover one model only.
    pub fn scoped_windows(&self) -> impl Iterator<Item = &Window> {
        self.windows.iter().filter(|w| w.model.is_some())
    }

    /// Limit resets that have not expired at `now`, soonest first.
    pub fn unexpired_resets(&self, now: Instant) -> impl Iterator<Item = &LimitReset> {
        self.resets
            .iter()
            .filter(move |r| r.expires_at.is_none_or(|at| at > now))
    }
}

/// One of a pool's windows, over every account in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolWindow {
    pub span: Span,
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<Instant>,
    /// Weighted by each plan's size, when every plan's size is known.
    pub weighted: bool,
}

impl PoolWindow {
    pub fn used_at(&self, now: Instant) -> f64 {
        used_at(self.used, self.resets_at, now)
    }

    /// As one account's window, for what draws either alike.
    pub fn as_window(&self) -> Window {
        Window {
            span: self.span,
            model: None,
            used: self.used,
            resets_at: self.resets_at,
        }
    }
}

impl PoolView {
    pub fn window(&self, span: Span) -> Option<&PoolWindow> {
        self.windows.iter().find(|w| w.span == span)
    }

    /// The week, or for plans without one, the month.
    pub fn long_window(&self) -> Option<&PoolWindow> {
        self.window(Span::Week).or_else(|| self.window(Span::Month))
    }
}

/// A limit reset an account holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitReset {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<Instant>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Instant>,
}

/// Tokens: one request's, or everything an account served.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Usage {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    pub fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

/// Why a new session would get an account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NextReason {
    /// Chosen with `slopmax use`.
    Pinned,
    /// No other account of the provider can serve.
    OnlyOne,
    /// Its week resets within the day with quota to spare (reset-first).
    WeekEnding,
    /// Its used quota resets soonest (reset-first).
    ResetsFirst,
    /// First in priority order (fill-first).
    FillsFirst,
    /// The most room left.
    MostRoom,
    /// Handed a request longest ago (round-robin).
    Turn,
}

/// The account a new session would get now, and why, worded for people.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextView {
    pub account: String,
    pub reason: NextReason,
    pub why: String,
}

/// A subscription's working accounts (enabled and signed in) read as one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolView {
    pub provider: Provider,
    pub accounts: u64,
    /// The windows over every request.
    pub windows: Vec<PoolWindow>,
    /// Windows on one model, which stop only that model's requests.
    pub scoped: Vec<Window>,
    /// Each account's share of the pool's capacity, when every plan's size
    /// is known.
    pub shares: BTreeMap<String, f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<NextView>,
}

/// Something worth telling: an account limited or back, a reset about to
/// lapse.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub kind: NoticeKind,
    /// The same for the same occasion, so a notice is told once.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<Instant>,
    pub message: String,
    pub at: Instant,
    /// What acting on it is worth, in dollars.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worth: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RedeemOutcome {
    Reset,
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
    Declined,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResult {
    pub outcome: RedeemOutcome,
    pub report: Report,
}

/// One check of `slopmax doctor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Info,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub level: Level,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    pub title: String,
    pub findings: Vec<Finding>,
}

/// An agent's wiring to the proxy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWiring {
    pub id: crate::AgentId,
    pub title: String,
    pub installed: bool,
    pub config_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wired_to: Option<String>,
    pub wired: bool,
    pub backed_up: bool,
}
