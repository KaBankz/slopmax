//! A subscription pool over time (`GET /pools/{provider}`): how full its
//! windows have been, where they are heading at the pace they fill, and
//! what each account's current windows have served. The daemon records the
//! pools' quota every few minutes; everything here is read from that and
//! the ledger, so every front end draws the same forecast.

use serde::{Deserialize, Serialize};

use crate::{Instant, Provider, Span};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolDetail {
    pub provider: Provider,
    pub generated_at: Instant,
    /// The pool's windows over every request, shortest first.
    pub trends: Vec<Trend>,
    /// Each working account of the pool, in the report's order.
    pub accounts: Vec<AccountDetail>,
    /// Where the first health cell begins; each lasts `cellMinutes`.
    pub health_since: Instant,
    pub cell_minutes: u32,
}

/// One of the pool's windows: its use as recorded, and as projected at the
/// pace it has been filling.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Trend {
    pub span: Span,
    /// Percent of the pool used now.
    pub used: f64,
    /// Oldest first, ending now.
    pub recorded: Vec<Point>,
    /// From now: the pool filling at `burn`, given back as accounts reset.
    pub projected: Vec<Point>,
    /// Accounts' resets ahead within the projection, soonest first.
    pub resets: Vec<ResetMark>,
    /// Percent of the pool used an hour, over the last hours `burns`
    /// measured: three when there are three to measure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub burn: Option<f64>,
    /// The pace over the last hour, three and six, as far as recorded.
    pub burns: Vec<Burn>,
    /// The pace an hour that would spend what is left, and what resets
    /// give back, over one window's length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sustainable: Option<f64>,
    /// When the pool would be spent at `burn`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runs_out_at: Option<Instant>,
    /// When it would have room again after that: the next reset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dry_until: Option<Instant>,
    /// The account that would be spent first, at its own pace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_out: Option<FirstOut>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub at: Instant,
    pub used: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetMark {
    pub at: Instant,
    pub account: String,
    /// Percent of the pool it gives back.
    pub gives_back: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Burn {
    pub hours: u32,
    /// Percent of the pool an hour.
    pub rate: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirstOut {
    pub account: String,
    pub at: Instant,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountDetail {
    pub id: String,
    /// What each of its current windows has served so far.
    pub windows: Vec<WindowSpend>,
    /// Answers and failures, oldest cell first.
    pub health: Vec<HealthCell>,
}

/// What one window has served since it began, and what that says about
/// the window as a whole.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSpend {
    pub span: Span,
    pub since: Instant,
    pub resets_at: Instant,
    pub used: f64,
    pub requests: u64,
    pub tokens: u64,
    /// Dollars at API prices.
    pub cost: f64,
    /// Dollars at API prices a percent of the window has bought, once
    /// enough is used to tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_percent: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthCell {
    pub answered: u64,
    pub failed: u64,
}
