//! Usage: what was served, summed by day, model or account, and the
//! analytics the dashboard charts.

use serde::{Deserialize, Serialize};

use crate::report::Usage;
use crate::{Instant, Provider};

/// Who sent a request: an agent, or slopmax itself (starting a window).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sender {
    ClaudeCode,
    Codex,
    Slopmax,
}

/// How a request reached the provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    #[default]
    Http,
    Socket,
}

/// A record of the usage ledger.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum LedgerRecord {
    Request(RequestRecord),
}

/// One request slopmax answered, or failed to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub at: Instant,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub provider: Provider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub status: u16,
    pub usage: Usage,
    pub ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_byte_ms: Option<u64>,
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<Sender>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub via: Via,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryRange {
    Today,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    All,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryBy {
    Day,
    Model,
    Account,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryRange {
    Today,
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
}

/// Requests, tokens and dollars over some span.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Totals {
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Dollars at API prices.
    pub cost: f64,
    /// Requests of models with no known price.
    pub unpriced: u64,
    pub failed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryRow {
    pub key: String,
    pub totals: Totals,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub range: SummaryRange,
    pub by: SummaryBy,
    pub since: Instant,
    pub rows: Vec<SummaryRow>,
    pub total: Totals,
}

/// One account's unused quota at the resets it saw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftAccount {
    pub name: String,
    pub provider: Provider,
    pub windows: u64,
    pub unused: f64,
    pub dollars: f64,
}

/// Quota that reset unused, valued at the plans' prices.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftOnTheTable {
    pub windows: u64,
    pub unused: f64,
    pub dollars: f64,
    pub unpriced: u64,
    pub accounts: Vec<LeftAccount>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryBucket {
    pub label: String,
    /// Tokens by provider, in the order of [`History::providers`].
    pub tokens: Vec<f64>,
    pub requests: u64,
    pub failed: u64,
    pub rescued: u64,
    pub sessions: u64,
    pub cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached: Option<f64>,
    /// Median and 90th-percentile time to first byte, in ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_byte: Option<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedTotals {
    pub name: String,
    pub totals: Totals,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTotals {
    pub name: String,
    pub provider: Provider,
    pub totals: Totals,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Speed {
    pub model: String,
    pub provider: Provider,
    pub tokens_per_second: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub range: HistoryRange,
    pub buckets: Vec<HistoryBucket>,
    pub providers: Vec<Provider>,
    pub total: Totals,
    pub rescued: u64,
    pub unplaced: u64,
    pub billed: f64,
    pub left: LeftOnTheTable,
    pub cache_saved: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached: Option<f64>,
    pub sessions: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_byte: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monthly: Option<f64>,
    /// Requests by weekday (Monday first) and hour.
    pub activity: Vec<Vec<u64>>,
    pub models: Vec<NamedTotals>,
    pub accounts: Vec<AccountTotals>,
    pub agents: Vec<NamedTotals>,
    pub speeds: Vec<Speed>,
}
