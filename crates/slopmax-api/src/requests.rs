//! What clients send, read strictly: a key the API does not know is
//! refused, so a typo is an error rather than a setting silently ignored.

use serde::{Deserialize, Serialize};

use crate::Dialect;
use crate::report::{AccountView, Report};

/// An account added through the API: an API key, or a compatible endpoint.
/// Subscriptions sign in instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum AddAccount {
    Key {
        provider: crate::Provider,
        key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    Endpoint {
        url: String,
        #[serde(default = "chat")]
        dialect: Dialect,
        #[serde(default)]
        models: Vec<String>,
        /// Some endpoints need no key.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
}

fn chat() -> Dialect {
    Dialect::Chat
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountAdded {
    pub account: AccountView,
    pub report: Report,
}

/// Changes to an account. A `null` or blank label clears it, so the email
/// shows again.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPatch {
    /// `Some(None)` clears the label.
    #[serde(default, with = "present", skip_serializing_if = "Option::is_none")]
    pub label: Option<Option<String>>,
    /// Higher goes first; 0 is the default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<bool>,
}

/// A key given as `null` reads as `Some(None)`, unlike one left out.
mod present {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<Option<String>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        value.as_ref().map(Option::as_deref).serialize(s)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<String>>, D::Error> {
        Ok(Some(Option::<String>::deserialize(d)?))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedeemRequest {
    /// The limit reset to spend; the soonest to expire when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset: Option<String>,
}

/// Where logins are imported from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ImportSource {
    ClaudeCode,
    Codex,
    #[serde(rename = "cliproxyapi")]
    CliProxyApi,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRequest {
    /// Every source when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<ImportSource>>,
    /// Take the logins over, so slopmax refreshes them itself, instead of
    /// following the tool's copy.
    #[serde(default)]
    pub own: bool,
}

/// One login found while importing: saved, or why it could not be.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum ImportOutcome {
    Saved {
        source: ImportSource,
        origin: String,
        account: Box<AccountView>,
        #[serde(rename = "isNew")]
        is_new: bool,
    },
    Failed {
        source: ImportSource,
        origin: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub outcomes: Vec<ImportOutcome>,
    pub report: Report,
}

/// A subscription sign-in. `device` asks for a code to enter on any device
/// instead of a browser redirect.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartLogin {
    pub provider: crate::Provider,
    #[serde(default)]
    pub device: bool,
    /// What to call the account; else its email.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Leave the browser closed: the client opens the address, or shows it
    /// for a browser on another machine.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_browser: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStarted {
    pub id: String,
}

/// The address the browser landed on after signing in, pasted from
/// another machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasteAddress {
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MakeKey {
    pub name: String,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnected {
    /// The settings file that was edited.
    pub path: String,
    /// What to know next, such as restarting the agent.
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDisconnected {
    pub path: String,
}

/// `POST /shutdown`'s answer. `restart` asks the service manager to start
/// it again, which the daemon signals with its exit code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopping {
    pub status: StoppingStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoppingStatus {
    Stopping,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shutdown {
    #[serde(default)]
    pub restart: bool,
}
