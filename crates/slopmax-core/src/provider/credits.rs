//! Banked rate-limit resets.
//!
//! Some providers grant accounts credits that reset their usage windows on
//! the spot. slopmax redeems them on request (`slopmax redeem`), just before
//! one would expire unused (`redeem_expiring_credits`), and, with
//! `redeem_when_exhausted`, once every account of the provider is spent, so
//! the pool keeps serving instead of waiting.

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::BoxFuture;
use crate::account::Account;
use crate::net::Client;
use crate::time::Timestamp;

/// One unspent credit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// When the provider granted it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub granted_at: Option<Timestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<Timestamp>,
}

/// What a redemption did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The account's windows were reset.
    Reset,
    /// Nothing was used, so the credit was kept.
    NothingToReset,
    NoCredit,
    AlreadyRedeemed,
    /// The provider would not spend one now, as while it is paused or
    /// cooling down, so the credit was kept.
    Declined,
}

/// A provider's reset credits.
///
/// `agent` is the user agent of the provider's own client, as slopmax last
/// saw it in a request, for a provider that answers that client alone.
pub trait ResetCredits: Send + Sync {
    /// Whether the provider's usage reports how many credits an account
    /// holds, so they are listed as that count changes. Those of a provider
    /// whose usage does not are listed every hour instead.
    fn counted(&self) -> bool {
        true
    }

    /// Whether it answers its own client alone, so nothing can be listed or
    /// redeemed until slopmax has seen that client's user agent.
    fn needs_agent(&self) -> bool {
        false
    }

    /// Unspent credits, in the order to spend them: soonest-expiring
    /// first, or the one the provider names next.
    fn list<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        agent: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Vec<Credit>>>;

    /// Redeems `credit`, or the one the provider would spend next.
    fn redeem<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        agent: Option<&'a str>,
        credit: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Outcome>>;
}
