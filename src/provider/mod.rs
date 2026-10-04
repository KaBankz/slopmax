//! Providers: the services slopmax holds accounts for.
//!
//! Each provider implements [`Provider`]: how to sign in and refresh, how
//! to read usage, how to send a request with an account's credentials, and
//! how to read the answer. The proxy, background tasks, and CLI only go
//! through this trait; [`ProviderId::get`] is the one place that lists the
//! implementations.
//!
//! Subscriptions (Claude, ChatGPT) sign in with OAuth and have usage
//! windows. Metered providers (API keys, compatible endpoints) take a key
//! and bill per token, so by default they never quietly absorb traffic a
//! subscription would serve.

pub mod claude;
pub mod codex;
pub mod compat;
pub mod credits;
pub mod keys;

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use anyhow::{Result, anyhow};
use http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::account::Account;
use crate::auth::{Grant, LoginOptions, RefreshError};
use crate::limits::{Limits, Refusal};
use crate::net::Client;
use crate::net::client::Response;
use crate::time::{SignedDuration, Timestamp};
use crate::wire::Dialect;

pub use credits::ResetCredits;

/// A boxed future, so [`Provider`] methods can be async behind `dyn`.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Which provider an account belongs to; stored in account files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    /// Claude Pro/Max, used by Claude Code.
    Claude,
    /// ChatGPT Plus/Pro/Team, used by Codex.
    Codex,
    /// Anthropic API keys.
    Anthropic,
    /// OpenAI API keys.
    OpenAI,
    /// xAI API keys.
    Xai,
    /// Any OpenAI- or Anthropic-compatible endpoint.
    Compat,
}

impl ProviderId {
    /// Every provider, subscriptions first: the order requests try them in.
    pub const ALL: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Anthropic,
        Self::OpenAI,
        Self::Xai,
        Self::Compat,
    ];

    pub fn get(self) -> &'static dyn Provider {
        match self {
            Self::Claude => &claude::Claude,
            Self::Codex => &codex::Codex,
            Self::Anthropic => &keys::ANTHROPIC,
            Self::OpenAI => &keys::OPENAI,
            Self::Xai => &keys::XAI,
            Self::Compat => &compat::Compat,
        }
    }

    pub fn spec(self) -> &'static Spec {
        self.get().spec()
    }

    pub fn as_str(self) -> &'static str {
        self.spec().id
    }
}

impl std::str::FromStr for ProviderId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|p| p.as_str() == s)
            .ok_or_else(|| {
                let ids: Vec<&str> = Self::ALL.iter().map(|p| p.as_str()).collect();
                format!("expected one of {}, got {s:?}", ids.join(", "))
            })
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What a provider declares about itself.
#[derive(Debug)]
pub struct Spec {
    /// Stable id, stored in account files: `claude`, `codex`.
    pub id: &'static str,
    /// For people: "your Claude account".
    pub title: &'static str,
    /// Base URL of the API agents talk to; their request path is appended.
    pub api: &'static str,
    /// The formats that API speaks, preferred first.
    pub dialects: &'static [Dialect],
    /// The models it serves, as patterns where `*` matches anything.
    pub models: &'static [&'static str],
    /// How its accounts are paid for.
    pub billing: Billing,
    /// The one agent that may use these accounts, by id.
    pub agent_only: Option<&'static str>,
    /// How long before expiry an access token is refreshed.
    pub refresh_lead: SignedDuration,
    /// Whether `slopmax login --device` is supported.
    pub device_login: bool,
}

impl Spec {
    /// Whether the provider has usage windows to poll.
    pub fn is_subscription(&self) -> bool {
        self.billing == Billing::Subscription
    }
}

/// How a provider's accounts are paid for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Billing {
    /// A plan with usage windows that reset.
    Subscription,
    /// Pay per token. `backs` is the subscription whose models these
    /// accounts also serve: they take that traffic only as paid overflow,
    /// or when there is no such subscription at all.
    Metered { backs: Option<ProviderId> },
}

/// Whether `model` matches `pattern`, where `*` matches any run of
/// characters.
pub fn matches(pattern: &str, model: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = model.strip_prefix(first) else {
        return false;
    };
    let mut parts = parts.peekable();
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            // The last part anchors at the end.
            return rest.len() >= part.len() && rest.ends_with(part);
        }
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    rest.is_empty()
}

/// A usage reading, plus the plan when the endpoint reports one.
#[derive(Debug, Clone)]
pub struct Reading {
    pub limits: Limits,
    pub plan: Option<String>,
}

/// Why a usage read failed.
#[derive(Debug)]
pub enum UsageError {
    /// The token was rejected; a refresh may help.
    Unauthorized,
    Other(anyhow::Error),
}

/// Reads a usage endpoint's JSON answer: a 401 means the token needs a
/// refresh; other failures carry the start of the body.
async fn usage_body(response: Response) -> Result<Value, UsageError> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(UsageError::Unauthorized);
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let snippet: String = body.chars().take(200).collect();
        return Err(UsageError::Other(anyhow!(
            "usage endpoint returned {status}: {snippet}"
        )));
    }
    response
        .json()
        .await
        .map_err(|e| UsageError::Other(e.into()))
}

/// How the proxy treats a response that was not a success.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Hand the response to the agent unchanged.
    Final,
    /// The token was rejected: refresh it once, else set the account aside.
    Unauthorized,
    /// The account may not serve this request.
    Forbidden,
    /// The request carried conversation state another account minted; retry
    /// once without it.
    StaleState,
    /// The account's quota is spent until `until`, for `model` only if set.
    Exhausted {
        until: Option<Timestamp>,
        model: Option<String>,
    },
    /// Briefly throttled; the account itself is fine.
    Throttled { until: Option<Timestamp> },
}

impl Verdict {
    /// The answer for statuses every provider treats the same way.
    pub fn of_status(status: StatusCode) -> Self {
        match status {
            StatusCode::UNAUTHORIZED => Self::Unauthorized,
            StatusCode::FORBIDDEN => Self::Forbidden,
            _ => Self::Final,
        }
    }
}

impl From<Refusal> for Verdict {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::Exhausted { until, model } => Self::Exhausted { until, model },
            Refusal::Throttled { until } => Self::Throttled { until },
        }
    }
}

/// A service slopmax can hold accounts for and forward requests to.
pub trait Provider: Send + Sync {
    fn spec(&self) -> &'static Spec;

    /// The provider-side identity accounts are keyed by (an organization or
    /// workspace), so one email in two of them stays two accounts.
    fn identity(&self, account: &Account) -> Option<String>;

    /// Connects an account interactively.
    fn login<'a>(
        &'a self,
        http: &'a Client,
        options: LoginOptions,
    ) -> BoxFuture<'a, Result<Account>>;

    /// Redeems a refresh token for new tokens.
    fn refresh<'a>(
        &'a self,
        _http: &'a Client,
        _refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<Grant, RefreshError>> {
        let title = self.spec().title;
        Box::pin(std::future::ready(Err(RefreshError::Revoked(format!(
            "{title} keys cannot be refreshed"
        )))))
    }

    /// Updates email, plan, and organization once new tokens arrive.
    fn identify<'a>(&'a self, _http: &'a Client, _account: &'a mut Account) -> BoxFuture<'a, ()> {
        Box::pin(std::future::ready(()))
    }

    /// Reads the account's usage windows (subscriptions only).
    fn usage<'a>(
        &'a self,
        _http: &'a Client,
        _account: &'a Account,
    ) -> BoxFuture<'a, Result<Reading, UsageError>> {
        let title = self.spec().title;
        Box::pin(std::future::ready(Err(UsageError::Other(anyhow!(
            "{title} has no usage windows"
        )))))
    }

    /// Where the account's requests go; the request path is appended.
    fn api<'a>(&self, _account: &'a Account) -> &'a str {
        self.spec().api
    }

    /// The formats the account's API speaks, preferred first.
    fn dialects<'a>(&self, _account: &'a Account) -> &'a [Dialect] {
        self.spec().dialects
    }

    /// Whether the account serves `model`.
    fn serves(&self, _account: &Account, model: &str) -> bool {
        self.spec().models.iter().any(|p| matches(p, model))
    }

    /// The agent's request headers with the account's credentials in place
    /// of the slopmax key. `moved` says the session just left another
    /// account.
    fn headers(&self, client: &HeaderMap, account: &Account, moved: bool) -> HeaderMap;

    /// A body without conversation state bound to another account, or
    /// `None` when there is nothing to drop.
    fn rebind(&self, _body: &[u8]) -> Option<Vec<u8>> {
        None
    }

    /// Usage windows reported in response headers.
    fn limits(&self, _headers: &HeaderMap, _now: Timestamp) -> Option<Limits> {
        None
    }

    /// Classifies a response that was not a success.
    fn verdict(
        &self,
        status: StatusCode,
        headers: &HeaderMap,
        body: &[u8],
        model: Option<&str>,
        now: Timestamp,
    ) -> Verdict;

    /// Banked reset credits, for providers that grant them.
    fn credits(&self) -> Option<&dyn ResetCredits> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_with_wildcards() {
        assert!(matches("claude-*", "claude-opus-5-5"));
        assert!(!matches("claude-*", "gpt-6-sol"));
        assert!(matches("gpt-*", "gpt-6-sol"));
        assert!(matches("o3*", "o3"));
        assert!(matches("*-coder", "qwen3-coder"));
        assert!(matches("a*b*c", "a-x-b-y-c"));
        assert!(!matches("a*b*c", "a-x-c"));
        assert!(matches("exact", "exact"));
        assert!(!matches("exact", "exactly"));
        assert!(matches("*", "anything"));
    }

    #[test]
    fn registry_ids_are_unique_and_round_trip() {
        for provider in ProviderId::ALL {
            assert_eq!(provider.as_str().parse::<ProviderId>(), Ok(provider));
            let json = serde_json::to_string(&provider).unwrap();
            assert_eq!(json, format!("\"{provider}\""));
        }
        // Metered providers back up a subscription, never another key.
        for provider in ProviderId::ALL {
            if let Billing::Metered { backs: Some(sub) } = provider.spec().billing {
                assert!(sub.spec().is_subscription(), "{provider} backs {sub}");
            }
        }
    }
}
