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
#[derive(Debug, Clone)]
pub struct Credit {
    pub id: String,
    pub title: Option<String>,
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
}

/// A provider's reset credits.
pub trait ResetCredits: Send + Sync {
    /// Unspent credits, soonest-expiring first.
    fn list<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<Vec<Credit>>>;

    /// Redeems `credit`, or one the provider chooses.
    fn redeem<'a>(
        &'a self,
        http: &'a Client,
        account: &'a Account,
        credit: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Outcome>>;
}
