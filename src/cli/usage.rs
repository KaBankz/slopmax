//! `slopmax usage`: token totals and API-equivalent cost from the ledger,
//! by day, model, or account.

use std::collections::{BTreeMap, HashMap};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::account::Store;
use crate::config::Config;
use crate::ledger::{self, Entry};
use crate::pricing::{self, Custom};
use crate::time::{SignedDuration, Timestamp};
use crate::{paths, ui};

/// Totals for one row of the report.
#[derive(Debug, Default, Clone, Serialize)]
struct Totals {
    requests: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    /// API price of the requests to priced models, in dollars.
    #[serde(serialize_with = "micro_dollars")]
    cost: f64,
    /// Requests to models without a price, left out of `cost`.
    #[serde(skip_serializing_if = "is_zero")]
    unpriced: u64,
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

/// Rounds away float noise such as `0.22701000000000002`.
fn micro_dollars<S: serde::Serializer>(cost: &f64, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_f64((cost * 1e6).round() / 1e6)
}

impl Totals {
    fn add(&mut self, entry: &Entry, prices: &BTreeMap<String, Custom>) {
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

    /// The cost column: `—` when nothing is priced, a trailing `+` when
    /// some requests are left out.
    fn cost_label(&self) -> String {
        match self.unpriced {
            0 => format!("${:.2}", self.cost),
            n if n == self.requests => "—".to_owned(),
            _ => format!("${:.2}+", self.cost),
        }
    }
}

/// Prints usage since the start of `range` (`today`, `7d`, `30d`, `all`),
/// grouped `by` day, model, or account.
pub fn run(config: &Config, store: &Store, range: &str, by: &str, json: bool) -> Result<()> {
    let now = Timestamp::now();
    let offset = now.local_offset();
    let days = match range {
        "today" => 0,
        "7d" => 6,
        "30d" => 29,
        "all" => i64::MAX,
        other => bail!("unknown range {other:?}; use today, 7d, 30d, or all"),
    };
    let since = if days == i64::MAX {
        Timestamp::UNIX_EPOCH
    } else {
        let (y, m, d) = now.date(offset);
        let today = Timestamp::midnight(y, m, d, offset).unwrap_or(now);
        today - SignedDuration::from_hours(24 * days)
    };
    let entries = ledger::read(&paths::usage_dir(), since);

    let names: HashMap<String, String> = store
        .list()
        .unwrap_or_default()
        .into_iter()
        .map(|a| (a.id.clone(), a.name()))
        .collect();
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
    for entry in &entries {
        rows.entry(key(entry))
            .or_default()
            .add(entry, &config.prices);
        total.add(entry, &config.prices);
    }

    if json {
        let report = serde_json::json!({ "since": since, "by": by, "rows": rows, "total": total });
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    let title = match range {
        "today" => "today".to_owned(),
        "all" => "all time".to_owned(),
        _ => format!("the last {} days", days + 1),
    };
    if entries.is_empty() {
        println!("No requests recorded for {title}.");
        return Ok(());
    }
    let width = rows
        .keys()
        .map(|k| ui::visible_width(k))
        .max()
        .unwrap_or(0)
        .max(5);
    let header = by.to_uppercase();
    println!(
        "\n{}  {:>6}  {:>8}  {:>8}  {:>10}  {:>11}  {:>9}",
        ui::bold(ui::pad(&header, width)),
        ui::dim("REQ"),
        ui::dim("INPUT"),
        ui::dim("OUTPUT"),
        ui::dim("CACHE READ"),
        ui::dim("CACHE WRITE"),
        ui::dim("API COST")
    );
    let line = |label: &str, t: &Totals| {
        format!(
            "{}  {:>6}  {:>8}  {:>8}  {:>10}  {:>11}  {:>9}",
            ui::pad(label, width),
            t.requests,
            ui::compact(t.input),
            ui::compact(t.output),
            ui::compact(t.cache_read),
            ui::compact(t.cache_write),
            t.cost_label()
        )
    };
    for (label, totals) in &rows {
        println!("{}", line(label, totals));
    }
    println!("{}", ui::bold(line("total", &total)));
    let mut note = format!(
        "Usage for {title}. API cost is what these requests would cost at API list \
         prices (Anthropic's as of 2026-09, and any set in config.toml)."
    );
    if total.unpriced > 0 {
        let n = total.unpriced;
        note.push_str(&format!(
            "\n+ leaves out {n} request{} to models without a price; set one under \
             [prices] in {}.",
            if n == 1 { "" } else { "s" },
            paths::config_file().display()
        ));
    }
    println!("\n{}", ui::dim(note));
    Ok(())
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
}
