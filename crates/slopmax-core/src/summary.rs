//! Usage summaries from the ledger: token totals and what they would cost
//! on the API, by day, model, or account. `slopmax usage` prints them and
//! the dashboard charts them.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::ledger::{self, Entry};
use crate::pricing::{self, Custom};
use crate::time::{SignedDuration, Timestamp};

/// The periods a summary covers, counted in local days.
pub const RANGES: &[&str] = &["today", "7d", "30d", "all"];
/// How a summary groups requests.
pub const GROUPS: &[&str] = &["day", "model", "account"];

/// Totals for one row.
#[derive(Debug, Default, Clone, Serialize)]
pub struct Totals {
    /// Requests answered; failures and agents' housekeeping (listing
    /// models, counting tokens) are not among them.
    pub requests: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// API price of the requests to priced models, in dollars.
    #[serde(serialize_with = "micro_dollars")]
    pub cost: f64,
    /// Requests to models without a price, left out of `cost`.
    #[serde(skip_serializing_if = "is_zero")]
    pub unpriced: u64,
    /// Requests that ended in an error instead of an answer.
    #[serde(skip_serializing_if = "is_zero")]
    pub failed: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// Rounds away float noise such as `0.22701000000000002`.
fn micro_dollars<S: serde::Serializer>(cost: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((cost * 1e6).round() / 1e6)
}

impl Totals {
    /// Counts a ledger row: an answer in every total, a failure as failed,
    /// and an agent's housekeeping not at all.
    pub fn add(&mut self, entry: &Entry, prices: &BTreeMap<String, Custom>) {
        if entry.failed() {
            self.failed += 1;
            return;
        }
        if !entry.answered() {
            return;
        }
        let price = entry
            .model
            .as_deref()
            .and_then(|m| pricing::price(m, prices));
        match price {
            Some(p) => {
                self.cost += p.cost(
                    entry.input,
                    entry.output,
                    entry.cache_read,
                    entry.cache_write,
                );
            }
            None => self.unpriced += 1,
        }
        self.requests += 1;
        self.input += entry.input;
        self.output += entry.output;
        self.cache_read += entry.cache_read;
        self.cache_write += entry.cache_write;
    }

    /// The cost as shown: `—` when nothing is priced, a trailing `+` when
    /// some requests are left out.
    pub fn cost_label(&self) -> String {
        match self.unpriced {
            0 => format!("${:.2}", self.cost),
            n if n == self.requests => "—".to_owned(),
            _ => format!("${:.2}+", self.cost),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub since: Timestamp,
    pub by: String,
    pub rows: BTreeMap<String, Totals>,
    pub total: Totals,
}

/// The start of `range` (one of [`RANGES`]) at local midnight, or `None`
/// for an unknown range.
pub fn since(range: &str, now: Timestamp) -> Option<Timestamp> {
    let days = match range {
        "today" => 0,
        "7d" => 6,
        "30d" => 29,
        "all" => return Some(Timestamp::UNIX_EPOCH),
        _ => return None,
    };
    let offset = now.local_offset();
    let (y, m, d) = now.date(offset);
    let today = Timestamp::midnight(y, m, d, offset).unwrap_or(now);
    Some(today - SignedDuration::from_hours(24 * days))
}

/// Summarizes the ledger in `dir` from `since`, grouped `by` one of
/// [`GROUPS`]. `names` gives accounts their display names.
pub fn build(
    dir: &Path,
    since: Timestamp,
    by: &str,
    prices: &BTreeMap<String, Custom>,
    names: &HashMap<String, String>,
) -> Summary {
    let entries = ledger::read(dir, since);
    let key = |entry: &Entry| -> String {
        match by {
            "model" => entry.model.clone().unwrap_or_else(|| "-".into()),
            "account" => names
                .get(&entry.account)
                .cloned()
                .unwrap_or_else(|| entry.account.clone()),
            _ => {
                let (y, m, d) = entry.at.date(entry.at.local_offset());
                format!("{y:04}-{m:02}-{d:02}")
            }
        }
    };
    let mut rows: BTreeMap<String, Totals> = BTreeMap::new();
    let mut total = Totals::default();
    // An agent's housekeeping makes no row of its own.
    for entry in entries.iter().filter(|e| e.answered() || e.failed()) {
        rows.entry(key(entry)).or_default().add(entry, prices);
        total.add(entry, prices);
    }
    Summary {
        since,
        by: by.to_owned(),
        rows,
        total,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ProviderId;

    fn entry(model: &str, input: u64) -> Entry {
        Entry {
            at: Timestamp::now(),
            account: "a".into(),
            provider: ProviderId::Claude,
            model: Some(model.into()),
            status: 200,
            input,
            output: 0,
            cache_read: 0,
            cache_write: 0,
            ms: 1,
            first_byte_ms: None,
            attempts: 1,
            agent: None,
            session: None,
        }
    }

    #[test]
    fn unpriced_requests_are_counted_apart() {
        let prices = BTreeMap::new();
        let mut totals = Totals::default();
        totals.add(&entry("gpt-6-sol", 10), &prices);
        assert_eq!(totals.cost_label(), "—");
        totals.add(&entry("claude-opus-5-5", 1_000_000), &prices);
        assert_eq!(totals.cost_label(), "$4.00+");
        assert_eq!((totals.requests, totals.unpriced), (2, 1));

        let mut priced = Totals::default();
        priced.add(&entry("claude-opus-5-5", 500_000), &prices);
        assert_eq!(priced.cost_label(), "$2.00");
    }

    #[test]
    fn requests_are_the_answers_alone() {
        let prices = BTreeMap::new();
        let mut totals = Totals::default();
        totals.add(&entry("claude-opus-5-5", 100), &prices);
        // An agent listing models or counting tokens moves none.
        totals.add(&entry("claude-opus-5-5", 0), &prices);
        let failure = Entry {
            status: 429,
            ..entry("claude-opus-5-5", 0)
        };
        totals.add(&failure, &prices);
        assert_eq!((totals.requests, totals.failed, totals.input), (1, 1, 100));
        assert_eq!(totals.unpriced, 0);
    }

    #[test]
    fn ranges_start_at_local_midnight() {
        let now = Timestamp::now();
        assert_eq!(since("all", now), Some(Timestamp::UNIX_EPOCH));
        let today = since("today", now).unwrap();
        let week = since("7d", now).unwrap();
        assert!(today <= now && now.duration_since(today) < SignedDuration::from_hours(25));
        assert_eq!(
            today.duration_since(week),
            SignedDuration::from_hours(24 * 6)
        );
        assert_eq!(since("1y", now), None);
    }
}
