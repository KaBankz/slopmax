//! Quota left on the table: what part of each subscription window went
//! unused when it reset, and what that part of the plan cost. A week of a
//! Max plan left half unused is half a week's fee paid for nothing.
//!
//! The daemon writes each window that resets to `~/.slopmax/windows.jsonl`
//! with how much of it was used; this reads them back and values the
//! unused part of the long windows (weekly, or monthly) at the plan's price.
//! The 5-hour windows are kept too, but valued at nothing: the weekly cap
//! is what the fee buys.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::fsx;
use crate::pricing;
use crate::provider::ProviderId;
use crate::time::Timestamp;

/// Weeks in an average month, to turn a monthly fee into a weekly one.
const WEEKS_A_MONTH: f64 = 52.0 / 12.0;

/// One window that reset, as the daemon saw it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub ended_at: Timestamp,
    pub account: String,
    pub provider: ProviderId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub span: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Percent used when it was last read before the reset.
    pub used: f64,
}

impl Record {
    fn key(&self) -> (&str, &str, Option<&str>, Timestamp) {
        (
            &self.account,
            &self.span,
            self.model.as_deref(),
            self.ended_at,
        )
    }
}

/// Appends `records` to the file at `path`.
pub fn append(path: &Path, records: &[Record]) -> Result<()> {
    if records.is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fsx::private_dir(dir)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    let mut text = String::new();
    for record in records {
        text.push_str(&serde_json::to_string(record)?);
        text.push('\n');
    }
    file.write_all(text.as_bytes())?;
    Ok(())
}

/// The windows that reset from `since` on, each once, oldest first.
pub fn read(path: &Path, since: Timestamp) -> Vec<Record> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut records: Vec<Record> = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Record>(&line).ok())
        .filter(|r| r.ended_at >= since)
        .collect();
    records.sort_by(|a, b| a.key().cmp(&b.key()));
    records.dedup_by(|a, b| a.key() == b.key());
    records.sort_by_key(|r| r.ended_at);
    records
}

/// What the unused part of a window cost: the share of the plan's fee for
/// that span of time it bought. `None` when the plan has no known price;
/// nothing for 5-hour windows and windows on one model, which the weekly
/// fee does not buy apart.
pub fn value(
    provider: ProviderId,
    plan: Option<&str>,
    span: &str,
    model: Option<&str>,
    used: f64,
    plan_prices: &BTreeMap<String, f64>,
) -> Option<f64> {
    let share = match (span, model) {
        ("7d", None) => 1.0 / WEEKS_A_MONTH,
        ("30d", None) => 1.0,
        _ => return Some(0.0),
    };
    let monthly = pricing::plan_monthly(provider, plan?, plan_prices)?;
    let unused = (100.0 - used).clamp(0.0, 100.0) / 100.0;
    Some(monthly * share * unused)
}

/// Quota left on the table over a range.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Left {
    /// Long windows (weekly or monthly) that reset.
    pub windows: u64,
    /// What they left unused, on average, in percent.
    pub unused: f64,
    /// What the unused part cost, at plan prices.
    pub dollars: f64,
    /// Windows of plans without a known price, left out of `dollars`.
    pub unpriced: u64,
    /// Most dollars first.
    pub accounts: Vec<AccountLeft>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountLeft {
    pub name: String,
    pub provider: ProviderId,
    pub windows: u64,
    pub unused: f64,
    pub dollars: f64,
}

/// Totals `records`; `names` gives accounts their display names.
pub fn left(
    records: &[Record],
    plan_prices: &BTreeMap<String, f64>,
    names: &HashMap<String, String>,
) -> Left {
    let mut total = Left::default();
    let mut unused_sum = 0.0;
    let mut by_account: BTreeMap<(String, ProviderId), (u64, f64, f64)> = BTreeMap::new();
    for record in records {
        let long = record.model.is_none() && matches!(record.span.as_str(), "7d" | "30d");
        if !long {
            continue;
        }
        let unused = (100.0 - record.used).clamp(0.0, 100.0);
        let dollars = value(
            record.provider,
            record.plan.as_deref(),
            &record.span,
            None,
            record.used,
            plan_prices,
        );
        total.windows += 1;
        unused_sum += unused;
        match dollars {
            Some(d) => total.dollars += d,
            None => total.unpriced += 1,
        }
        let name = names
            .get(&record.account)
            .cloned()
            .unwrap_or_else(|| record.account.clone());
        let entry = by_account.entry((name, record.provider)).or_default();
        entry.0 += 1;
        entry.1 += unused;
        entry.2 += dollars.unwrap_or(0.0);
    }
    if total.windows > 0 {
        total.unused = unused_sum / total.windows as f64;
    }
    total.accounts = by_account
        .into_iter()
        .map(
            |((name, provider), (windows, unused, dollars))| AccountLeft {
                name,
                provider,
                windows,
                unused: unused / windows as f64,
                dollars,
            },
        )
        .collect();
    total.accounts.sort_by(|a, b| {
        b.dollars
            .total_cmp(&a.dollars)
            .then(b.unused.total_cmp(&a.unused))
    });
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn record(account: &str, plan: &str, span: &str, used: f64, ended: i64) -> Record {
        Record {
            ended_at: ts(ended),
            account: account.into(),
            provider: ProviderId::Claude,
            plan: Some(plan.into()),
            span: span.into(),
            model: None,
            used,
        }
    }

    #[test]
    fn the_unused_part_of_a_week_costs_its_share_of_the_fee() {
        let none = BTreeMap::new();
        // Max 20x at $200 a month: a week is $46.15; half unused, $23.08.
        let half = value(ProviderId::Claude, Some("max 20x"), "7d", None, 50.0, &none).unwrap();
        assert!((half - 200.0 * 12.0 / 52.0 / 2.0).abs() < 1e-9, "{half}");
        // A week used to the full wastes nothing; over the full, nothing.
        assert_eq!(
            value(ProviderId::Claude, Some("pro"), "7d", None, 100.0, &none),
            Some(0.0)
        );
        assert_eq!(
            value(ProviderId::Claude, Some("pro"), "7d", None, 130.0, &none),
            Some(0.0)
        );
        // Five hours and a model's own week are not what the fee buys.
        assert_eq!(
            value(ProviderId::Claude, Some("pro"), "5h", None, 0.0, &none),
            Some(0.0)
        );
        assert_eq!(
            value(
                ProviderId::Claude,
                Some("pro"),
                "7d",
                Some("Fable"),
                0.0,
                &none
            ),
            Some(0.0)
        );
        // A month's window is the whole fee.
        assert_eq!(
            value(ProviderId::Codex, Some("team"), "30d", None, 0.0, &none),
            Some(30.0)
        );
        assert_eq!(
            value(ProviderId::Claude, None, "7d", None, 0.0, &none),
            None
        );
        assert_eq!(
            value(
                ProviderId::Claude,
                Some("enterprise"),
                "7d",
                None,
                0.0,
                &none
            ),
            None
        );
    }

    #[test]
    fn records_are_kept_and_read_back_once_each() {
        let dir = std::env::temp_dir().join(format!("slopmax-waste-{}", crate::ids::token()));
        let path = dir.join("windows.jsonl");
        let a = record("a", "max 20x", "7d", 40.0, 1_000);
        let b = record("b", "pro", "7d", 90.0, 2_000);
        append(&path, &[a.clone(), b.clone()]).unwrap();
        // Told again after a restart.
        append(&path, std::slice::from_ref(&a)).unwrap();
        append(&path, &[]).unwrap();
        assert_eq!(read(&path, ts(0)), [a.clone(), b.clone()]);
        assert_eq!(read(&path, ts(1_500)), [b]);
        assert!(read(&dir.join("missing.jsonl"), ts(0)).is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn left_totals_long_windows_by_account() {
        let records = [
            record("a", "max 20x", "7d", 50.0, 1),
            record("a", "max 20x", "7d", 100.0, 2),
            record("a", "max 20x", "5h", 0.0, 3),
            record("b", "pro", "7d", 80.0, 4),
            record("c", "mystery", "7d", 0.0, 5),
        ];
        let names = HashMap::from([("a".to_owned(), "work@x.dev".to_owned())]);
        let left = left(&records, &BTreeMap::new(), &names);
        assert_eq!((left.windows, left.unpriced), (4, 1));
        // 50, 0, 20, and 100 unused.
        assert!((left.unused - 42.5).abs() < 1e-9);
        let week = |monthly: f64| monthly * 12.0 / 52.0;
        assert!((left.dollars - (week(200.0) * 0.5 + week(20.0) * 0.2)).abs() < 1e-9);
        assert_eq!(left.accounts[0].name, "work@x.dev");
        assert_eq!(
            (left.accounts[0].windows, left.accounts[0].unused),
            (2, 25.0)
        );
        assert_eq!(left.accounts.last().unwrap().dollars, 0.0);
    }
}
