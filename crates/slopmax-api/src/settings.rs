//! Settings: the ones that apply while the proxy runs, from one registry,
//! and the rest as the API shows them (no secrets).
//!
//! Each live setting is one row of [`live!`]: its name in the API, its key
//! in `config.toml` (unchanged across versions, so an older slopmax still
//! reads the file), what kind of value it takes, and what it does. The
//! patch type, the table front ends list, and the TOML keys all come from
//! those rows, so a setting cannot be added in one place and missed in
//! another, and a misspelled one does not compile:
//!
//! ```compile_fail
//! let patch = slopmax_api::settings::LivePatch {
//!     session_minuts: Some(30),
//!     ..Default::default()
//! };
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{NoticeKind, Strategy};

/// How long before a limit reset would expire unused that slopmax redeems
/// it, with `redeemExpiring` on.
pub const REDEEM_LEAD_HOURS: u64 = 3;

/// What a live setting takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveKind {
    /// On or off.
    Switch,
    /// A number of minutes.
    Minutes,
    /// One of a few names.
    Choice,
}

/// A live setting's value, as a front end or `slopmax config` gives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveValue {
    Switch(bool),
    Minutes(u64),
    Strategy(Strategy),
}

/// One live setting.
#[derive(Debug)]
pub struct Live {
    /// Its name in the API (`sessionMinutes`).
    pub name: &'static str,
    /// Its key in `config.toml` (`session_ttl_mins`).
    pub toml: &'static str,
    pub kind: LiveKind,
    pub summary: &'static str,
    /// The least a number of minutes may be.
    pub least: u64,
}

macro_rules! live {
    ($(
        $(#[$doc:meta])*
        $field:ident: $ty:ident = $name:literal, $toml:literal, $kind:ident, $least:literal, $summary:literal;
    )*) => {
        /// Every live setting, as it stands.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
        pub struct LiveSettings {
            $( $(#[$doc])* #[serde(rename = $name)] pub $field: live!(@type $ty), )*
        }

        /// Changes to live settings; each left out stays as it is.
        #[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
        #[serde(deny_unknown_fields)]
        pub struct LivePatch {
            $(
                $(#[$doc])*
                #[serde(rename = $name, default, skip_serializing_if = "Option::is_none")]
                pub $field: Option<live!(@type $ty)>,
            )*
        }

        /// Every live setting, in the order front ends list them.
        pub const LIVE: &[Live] = &[
            $( Live { name: $name, toml: $toml, kind: LiveKind::$kind, least: $least, summary: $summary }, )*
        ];

        impl LivePatch {
            /// The settings it changes, each with its new value.
            pub fn changes(&self) -> Vec<(&'static Live, LiveValue)> {
                let mut changes = Vec::new();
                let mut row = LIVE.iter();
                $(
                    let live = row.next().expect("a row per field");
                    if let Some(value) = self.$field {
                        changes.push((live, LiveValue::from(value)));
                    }
                )*
                changes
            }
        }

        impl LiveSettings {
            /// One setting's value, by its API or TOML name.
            pub fn get(&self, name: &str) -> Option<LiveValue> {
                $( if name == $name || name == $toml { return Some(LiveValue::from(self.$field)); } )*
                None
            }
        }
    };
    (@type Switch) => { bool };
    (@type Minutes) => { u64 };
    (@type Choice) => { Strategy };
}

live! {
    strategy: Choice = "strategy", "strategy", Choice, 0,
        "How a new session picks its account: reset-first, fill-first, least-used, or round-robin";
    session_affinity: Switch = "sessionAffinity", "session_affinity", Switch, 0,
        "Keep a session on its account, for the prompt cache";
    session_minutes: Minutes = "sessionMinutes", "session_ttl_mins", Minutes, 1,
        "Idle minutes before a session's account is forgotten";
    redeem_expiring: Switch = "redeemExpiring", "redeem_expiring_credits", Switch, 0,
        "Redeem a limit reset before it expires unused";
    redeem_when_exhausted: Switch = "redeemWhenExhausted", "redeem_when_exhausted", Switch, 0,
        "Redeem one when every account is spent";
    warm_windows: Switch = "warmWindows", "warm_windows", Switch, 0,
        "Start idle ChatGPT accounts' windows as they reset";
    paid_overflow: Switch = "paidOverflow", "paid_overflow", Switch, 0,
        "Let API keys take over once subscriptions are limited";
    poll_minutes: Minutes = "pollMinutes", "poll_mins", Minutes, 0,
        "Minutes between usage polls (0 turns them off)";
    refresh_tokens: Switch = "refreshTokens", "refresh_tokens", Switch, 0,
        "Refresh sign-ins before they expire";
    websockets: Switch = "websockets", "websockets", Switch, 0,
        "Relay Codex's WebSocket connections";
}

impl From<bool> for LiveValue {
    fn from(on: bool) -> Self {
        Self::Switch(on)
    }
}

impl From<u64> for LiveValue {
    fn from(minutes: u64) -> Self {
        Self::Minutes(minutes)
    }
}

impl From<Strategy> for LiveValue {
    fn from(strategy: Strategy) -> Self {
        Self::Strategy(strategy)
    }
}

/// A live setting by its API or TOML name.
pub fn live(name: &str) -> Option<&'static Live> {
    LIVE.iter().find(|l| l.name == name || l.toml == name)
}

/// Why `name` cannot be changed while the proxy runs.
fn not_live(name: &str) -> String {
    let names: Vec<&str> = LIVE.iter().map(|l| l.name).collect();
    format!(
        "{name} is not a setting slopmax changes while it runs; those are {}",
        names.join(", ")
    )
}

impl LivePatch {
    /// A patch from a request body, or what is wrong with it in words a
    /// person can act on.
    pub fn from_json(body: &[u8]) -> Result<Self, String> {
        let fields: serde_json::Map<String, Value> =
            serde_json::from_slice(body).map_err(|_| "the body is not a JSON object".to_owned())?;
        if fields.is_empty() {
            return Err("no settings to change".into());
        }
        if let Some(other) = fields
            .keys()
            .find(|name| live(name).is_none_or(|l| l.name != *name))
        {
            return Err(not_live(other));
        }
        for (name, value) in &fields {
            let live = live(name).expect("checked above");
            let fits = match live.kind {
                LiveKind::Switch => value.is_boolean(),
                LiveKind::Minutes => value.as_u64().is_some_and(|n| n >= live.least),
                LiveKind::Choice => serde_json::from_value::<Strategy>(value.clone()).is_ok(),
            };
            if !fits {
                return Err(expects(live));
            }
        }
        serde_json::from_value(Value::Object(fields)).map_err(|e| e.to_string())
    }

    /// One setting from text, as `slopmax config <name> <value>` gives it.
    pub fn parse(name: &str, text: &str) -> Result<Self, String> {
        let live = live(name).ok_or_else(|| not_live(name))?;
        let text = text.trim();
        let value = match live.kind {
            LiveKind::Switch => match text {
                "true" | "on" | "1" | "yes" => Value::Bool(true),
                "false" | "off" | "0" | "no" => Value::Bool(false),
                _ => return Err(expects(live)),
            },
            LiveKind::Minutes => match text.parse::<u64>() {
                Ok(n) => Value::from(n),
                Err(_) => return Err(expects(live)),
            },
            LiveKind::Choice => Value::from(text),
        };
        let body = serde_json::json!({ live.name: value });
        Self::from_json(body.to_string().as_bytes())
    }
}

fn expects(live: &Live) -> String {
    match live.kind {
        LiveKind::Switch => format!("{} is on or off", live.name),
        LiveKind::Minutes if live.least > 0 => {
            format!(
                "{} is a number of minutes, at least {}",
                live.name, live.least
            )
        }
        LiveKind::Minutes => format!("{} is a number of minutes", live.name),
        LiveKind::Choice => {
            "strategy is one of reset-first, fill-first, least-used, round-robin".into()
        }
    }
}

impl LiveValue {
    /// As `config.toml` and `slopmax config` write it.
    pub fn text(self) -> String {
        match self {
            Self::Switch(on) => on.to_string(),
            Self::Minutes(minutes) => minutes.to_string(),
            Self::Strategy(strategy) => strategy.as_str().into(),
        }
    }
}

impl Strategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ResetFirst => "reset-first",
            Self::FillFirst => "fill-first",
            Self::LeastUsed => "least-used",
            Self::RoundRobin => "round-robin",
        }
    }

    pub fn summary(self) -> &'static str {
        match self {
            Self::ResetFirst => "Spend the quota that resets soonest, so none is lost",
            Self::FillFirst => "Use accounts in priority order; fail over when one is limited",
            Self::LeastUsed => "Balance load toward the least used account",
            Self::RoundRobin => "Take turns across accounts",
        }
    }
}

/// An API price for a model, in dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub input: f64,
    pub output: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<f64>,
}

/// Where notices go.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifySettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub webhook: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub events: Vec<NoticeKind>,
}

/// A client key, without the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub name: String,
    pub models: Vec<String>,
}

/// A key just made: the only time its secret is shown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewKey {
    pub name: String,
    pub key: String,
    pub models: Vec<String>,
}

/// The settings as the API shows them: no owner key, client keys by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicSettings {
    pub listen: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_proxy: Option<String>,
    #[serde(flatten)]
    pub live: LiveSettings,
    pub aliases: BTreeMap<String, String>,
    pub fallbacks: BTreeMap<String, Vec<String>>,
    pub prices: BTreeMap<String, Price>,
    pub plan_prices: BTreeMap<String, f64>,
    pub notify: NotifySettings,
    pub keys: Vec<KeyInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pub name: String,
    pub summary: String,
    pub kind: LiveKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyInfo {
    pub id: Strategy,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: PublicSettings,
    pub live: Vec<LiveInfo>,
    pub strategies: Vec<StrategyInfo>,
    /// Settings changed in the file that apply only after a restart.
    pub restart_needed: Vec<String>,
}

impl SettingsView {
    pub fn new(settings: PublicSettings, restart_needed: Vec<String>) -> Self {
        Self {
            settings,
            live: LIVE
                .iter()
                .map(|l| LiveInfo {
                    name: l.name.into(),
                    summary: l.summary.into(),
                    kind: l.kind,
                })
                .collect(),
            strategies: Strategy::ALL
                .iter()
                .map(|s| StrategyInfo {
                    id: *s,
                    summary: s.summary().into(),
                })
                .collect(),
            restart_needed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_name_their_settings_exactly() {
        let patch =
            LivePatch::from_json(br#"{"sessionMinutes":30,"strategy":"fill-first"}"#).unwrap();
        let changes: Vec<(&str, &str, LiveValue)> = patch
            .changes()
            .iter()
            .map(|(l, v)| (l.name, l.toml, *v))
            .collect();
        assert_eq!(
            changes,
            [
                (
                    "strategy",
                    "strategy",
                    LiveValue::Strategy(Strategy::FillFirst)
                ),
                ("sessionMinutes", "session_ttl_mins", LiveValue::Minutes(30)),
            ]
        );
        assert_eq!(
            LivePatch::from_json(br#"{"bogus":1}"#).unwrap_err(),
            "bogus is not a setting slopmax changes while it runs; those are strategy, sessionAffinity, sessionMinutes, redeemExpiring, redeemWhenExhausted, warmWindows, paidOverflow, pollMinutes, refreshTokens, websockets"
        );
        // The API takes API names; TOML names are for `slopmax config`.
        assert!(LivePatch::from_json(br#"{"session_ttl_mins":30}"#).is_err());
        assert_eq!(
            LivePatch::from_json(b"{}").unwrap_err(),
            "no settings to change"
        );
        assert!(LivePatch::from_json(br#"{"sessionMinutes":0}"#).is_err());
        assert!(LivePatch::from_json(br#"{"pollMinutes":0}"#).is_ok());
        assert!(LivePatch::from_json(br#"{"websockets":"yes"}"#).is_err());
        assert!(LivePatch::from_json(br#"{"strategy":"fastest"}"#).is_err());
    }

    #[test]
    fn text_from_the_command_line_takes_either_name() {
        let patch = LivePatch::parse("session_ttl_mins", "45").unwrap();
        assert_eq!(patch.session_minutes, Some(45));
        assert_eq!(
            LivePatch::parse("websockets", "off").unwrap().websockets,
            Some(false)
        );
        assert!(LivePatch::parse("warmWindows", "maybe").is_err());
    }
}
