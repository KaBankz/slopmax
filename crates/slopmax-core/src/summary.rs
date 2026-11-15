//! Usage summaries from the ledger: token totals and what they would cost
//! on the API, by day, model, account, or machine. `slopmax usage` prints
//! them and the dashboard charts them.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use serde::Serialize;

use crate::ledger::{self, Entry};
use crate::pricing::{self, Custom};
use crate::time::Timestamp;

/// The periods a summary covers, counted in local days.
pub const RANGES: &[&str] = &["today", "7d", "30d", "all"];
/// The row, by account, of failures no account could take.
pub const NO_ACCOUNT: &str = "(no account free)";

/// How a summary groups requests.
pub const GROUPS: &[&str] = &["day", "model", "account", "machine"];

/// The machine, by machine, of the requests sent with the owner key, read
/// on the machine that sent them.
pub const HERE_LOCAL: &str = "this machine";
/// The same, read by another machine through the hub's API.
pub const HERE_HUB: &str = "hub";

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

    /// Adds totals summed apart, as from another hour.
    pub fn merge(&mut self, other: &Totals) {
        self.requests += other.requests;
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.cost += other.cost;
        self.unpriced += other.unpriced;
        self.failed += other.failed;
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
    // The first day's own midnight: a week that spans a daylight saving
    // change is not 7 × 24 hours long.
    let (y, m, d) = Timestamp::add_days(now.date(now.local_offset()), -days);
    Some(Timestamp::local_midnight(y, m, d).unwrap_or(now))
}

/// Summarizes the ledger in `dir` from `since`, grouped `by` one of
/// [`GROUPS`]. `names` gives accounts their display names; `here` names
/// the machine of requests sent with the owner key, by machine: one of
/// [`HERE_LOCAL`] and [`HERE_HUB`].
pub fn build(
    dir: &Path,
    since: Timestamp,
    by: &str,
    prices: &BTreeMap<String, Custom>,
    names: &HashMap<String, String>,
    here: &str,
) -> Summary {
    let entries = ledger::read(dir, since);
    summarize(&entries, since, by, prices, names, here)
}

fn summarize(
    entries: &[Entry],
    since: Timestamp,
    by: &str,
    prices: &BTreeMap<String, Custom>,
    names: &HashMap<String, String>,
    here: &str,
) -> Summary {
    let key = |entry: &Entry| -> String {
        match by {
            "model" => entry.model.clone().unwrap_or_else(|| "-".into()),
            "machine" => entry.machine.clone().unwrap_or_else(|| here.to_owned()),
            // Failures that reached no account: every one was limited.
            "account" if entry.account.is_empty() => NO_ACCOUNT.to_owned(),
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
    use crate::time::SignedDuration;

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
            end: None,
            machine: None,
        }
    }

    #[test]
    fn unpriced_requests_are_counted_apart() {
        let prices = BTreeMap::new();
        let mut totals = Totals::default();
        totals.add(&entry("compat-model", 10), &prices);
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
    fn each_request_pays_the_prices_for_its_own_prompt() {
        let prices = BTreeMap::new();
        let mut totals = Totals::default();
        // Two prompts of 100,000 tokens, which together are over it.
        totals.add(&entry("claude-haiku-5-5", 100_000), &prices);
        totals.add(&entry("claude-haiku-5-5", 100_000), &prices);
        assert!((totals.cost - 0.02).abs() < 1e-12, "{}", totals.cost);
        // One token more, as a cache read, prices the whole request higher.
        let long = Entry {
            cache_read: 1,
            ..entry("claude-haiku-5-5", 100_000)
        };
        let mut one = Totals::default();
        one.add(&long, &prices);
        assert!((one.cost - (100_000. * 0.50 + 0.05) / 1e6).abs() < 1e-12);
    }

    #[test]
    fn by_machine_the_owner_keys_requests_are_here() {
        let prices = BTreeMap::new();
        let from = |machine: Option<&str>| Entry {
            machine: machine.map(str::to_owned),
            ..entry("claude-opus-5-5", 100)
        };
        let entries = [
            from(None),
            from(Some("laptop")),
            from(Some("laptop")),
            from(Some("ci")),
        ];
        let rows = |here| {
            summarize(
                &entries,
                Timestamp::UNIX_EPOCH,
                "machine",
                &prices,
                &HashMap::new(),
                here,
            )
            .rows
            .into_iter()
            .map(|(key, totals)| (key, totals.requests))
            .collect::<Vec<_>>()
        };
        assert_eq!(
            rows(HERE_LOCAL),
            [
                ("ci".to_owned(), 1),
                ("laptop".to_owned(), 2),
                ("this machine".to_owned(), 1)
            ]
        );
        assert_eq!(
            rows(HERE_HUB),
            [
                ("ci".to_owned(), 1),
                ("hub".to_owned(), 1),
                ("laptop".to_owned(), 2)
            ]
        );
        assert!(GROUPS.contains(&"machine"));
    }

    #[test]
    fn by_machine_reads_the_ledger() {
        let dir = crate::testkit::temp_dir("summary-machine");
        let ledger = ledger::Ledger::at(dir.clone());
        ledger.record(&Entry {
            machine: Some("laptop".into()),
            ..entry("claude-opus-5-5", 100)
        });
        ledger.record(&entry("claude-opus-5-5", 100));
        drop(ledger);
        let summary = build(
            &dir,
            Timestamp::UNIX_EPOCH,
            "machine",
            &BTreeMap::new(),
            &HashMap::new(),
            HERE_LOCAL,
        );
        let keys: Vec<&str> = summary.rows.keys().map(String::as_str).collect();
        assert_eq!(keys, ["laptop", "this machine"]);
        assert_eq!(summary.total.requests, 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ranges_start_at_local_midnight() {
        let now = Timestamp::now();
        assert_eq!(since("all", now), Some(Timestamp::UNIX_EPOCH));
        let today = since("today", now).unwrap();
        let week = since("7d", now).unwrap();
        assert!(today <= now && now.duration_since(today) < SignedDuration::from_hours(25));
        // Six days, give or take a daylight saving hour.
        let span = today.duration_since(week).as_secs();
        assert!((span - 6 * 86_400).abs() <= 3_600, "{span}");
        assert_eq!(since("1y", now), None);
    }
}
