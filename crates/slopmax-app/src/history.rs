//! The ledger as a window charts it: what went through slopmax over a
//! range, hour by hour or day by day, by provider, model, and account, and
//! how soon answers began. Worked out once for every UI, as `view` is for
//! the accounts.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use slopmax_core::ledger::{self, Entry};
use slopmax_core::pricing::Custom;
use slopmax_core::provider::ProviderId;
use slopmax_core::summary::{self, Totals};
use slopmax_core::time::{SignedDuration, Timestamp};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The span a history covers, counted in local days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Range {
    Today,
    #[default]
    Week,
    Month,
}

impl Range {
    pub const ALL: [Range; 3] = [Range::Today, Range::Week, Range::Month];

    pub fn title(self) -> &'static str {
        match self {
            Range::Today => "Today",
            Range::Week => "7 Days",
            Range::Month => "30 Days",
        }
    }

    /// The name `summary` knows it by.
    fn key(self) -> &'static str {
        match self {
            Range::Today => "today",
            Range::Week => "7d",
            Range::Month => "30d",
        }
    }
}

/// What went through slopmax over a range.
#[derive(Debug, Clone)]
pub struct History {
    pub range: Range,
    /// Hours for today, days otherwise, oldest first, empty ones included.
    pub buckets: Vec<Bucket>,
    /// The providers that served requests, in the order each bucket lists
    /// its tokens.
    pub providers: Vec<ProviderId>,
    pub total: Totals,
    /// Requests that ended in an error status.
    pub failed: u64,
    /// The median time to the first byte of an answer, in milliseconds.
    pub first_byte: Option<u64>,
    /// Most tokens first.
    pub models: Vec<Share>,
    /// Most tokens first.
    pub accounts: Vec<Share>,
}

/// One hour or day.
#[derive(Debug, Clone, PartialEq)]
pub struct Bucket {
    /// `09:00`, or `Oct 3`.
    pub label: String,
    /// Tokens served by each of `History::providers`, in that order.
    pub tokens: Vec<u64>,
    pub requests: u64,
    /// What the requests would have cost on the API, in dollars.
    pub cost: f64,
    /// The median and 95th percentile time to the first byte, in
    /// milliseconds, when any request reported one.
    pub first_byte: Option<(u64, u64)>,
}

/// A model's or an account's part of the range.
#[derive(Debug, Clone)]
pub struct Share {
    pub name: String,
    pub provider: ProviderId,
    pub totals: Totals,
}

/// Every token a request moved: input, output, and both kinds of cache.
pub fn tokens(totals: &Totals) -> u64 {
    totals.input + totals.output + totals.cache_read + totals.cache_write
}

/// Reads the ledger in `dir` over `range`. `names` gives accounts their
/// display names.
pub fn load(
    dir: &Path,
    range: Range,
    now: Timestamp,
    prices: &BTreeMap<String, Custom>,
    names: &HashMap<String, String>,
) -> History {
    let since = summary::since(range.key(), now).unwrap_or(now);
    build(&ledger::read(dir, since), range, since, now, prices, names)
}

fn build(
    entries: &[Entry],
    range: Range,
    since: Timestamp,
    now: Timestamp,
    prices: &BTreeMap<String, Custom>,
    names: &HashMap<String, String>,
) -> History {
    // Days count on the local calendar, hours from the day's midnight.
    let day = |t: Timestamp| (t.as_second() + t.local_offset().as_secs()).div_euclid(86_400);
    let slot = |t: Timestamp| match range {
        Range::Today => (t.duration_since(since).as_secs() / 3_600).max(0) as usize,
        _ => (day(t) - day(since)).max(0) as usize,
    };
    let count = match range {
        Range::Today => slot(now) + 1,
        Range::Week => 7,
        Range::Month => 30,
    };
    let providers: Vec<ProviderId> = ProviderId::ALL
        .into_iter()
        .filter(|p| entries.iter().any(|e| e.provider == *p))
        .collect();

    let mut buckets: Vec<(Totals, Vec<u64>, Vec<u64>)> =
        vec![(Totals::default(), vec![0; providers.len()], Vec::new()); count];
    let mut total = Totals::default();
    let mut failed = 0;
    let mut waits = Vec::new();
    let mut models: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
    let mut accounts: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
    for entry in entries {
        let Some((totals, by_provider, bucket_waits)) = buckets.get_mut(slot(entry.at)) else {
            continue;
        };
        totals.add(entry, prices);
        let mut one = Totals::default();
        one.add(entry, prices);
        if let Some(i) = providers.iter().position(|p| *p == entry.provider) {
            by_provider[i] += tokens(&one);
        }
        if let Some(ms) = entry.first_byte_ms {
            bucket_waits.push(ms);
            waits.push(ms);
        }
        total.add(entry, prices);
        if entry.status >= 400 {
            failed += 1;
        }
        let model = entry.model.clone().unwrap_or_else(|| "unknown".into());
        models
            .entry((model, entry.provider))
            .or_default()
            .add(entry, prices);
        let account = names
            .get(&entry.account)
            .cloned()
            .unwrap_or_else(|| entry.account.clone());
        accounts
            .entry((account, entry.provider))
            .or_default()
            .add(entry, prices);
    }

    let buckets = buckets
        .into_iter()
        .enumerate()
        .map(|(i, (totals, tokens, mut waits))| Bucket {
            label: label(range, since, i),
            tokens,
            requests: totals.requests,
            cost: totals.cost,
            first_byte: percentile(&mut waits, 50).zip(percentile(&mut waits, 95)),
        })
        .collect();
    History {
        range,
        buckets,
        providers,
        total,
        failed,
        first_byte: percentile(&mut waits, 50),
        models: ranked(models),
        accounts: ranked(accounts),
    }
}

/// `09:00` for an hour of today, `Oct 3` for a day.
fn label(range: Range, since: Timestamp, i: usize) -> String {
    match range {
        Range::Today => format!("{i:02}:00"),
        _ => {
            // Midday of the day, clear of any daylight saving shift.
            let noon = since + SignedDuration::from_hours(24 * i as i64 + 12);
            let (_, month, date) = noon.date(noon.local_offset());
            format!("{} {date}", MONTHS[month as usize - 1])
        }
    }
}

fn percentile(values: &mut [u64], p: usize) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[(values.len() * p / 100).min(values.len() - 1)])
}

fn ranked(groups: BTreeMap<(String, ProviderId), Totals>) -> Vec<Share> {
    let mut shares: Vec<Share> = groups
        .into_iter()
        .map(|((name, provider), totals)| Share {
            name,
            provider,
            totals,
        })
        .collect();
    shares.sort_by_key(|s| std::cmp::Reverse(tokens(&s.totals)));
    shares
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: i64) -> Timestamp {
        Timestamp::from_second(secs).unwrap()
    }

    fn entry(at: Timestamp, provider: ProviderId, model: &str, input: u64) -> Entry {
        Entry {
            at,
            account: format!("{}-1", provider.as_str()),
            provider,
            model: Some(model.into()),
            status: 200,
            input,
            output: 10,
            cache_read: 0,
            cache_write: 0,
            ms: 900,
            first_byte_ms: Some(input),
            attempts: 1,
        }
    }

    #[test]
    fn days_fill_their_buckets_by_provider() {
        let now = Timestamp::now();
        let since = summary::since("7d", now).unwrap();
        let today = since + SignedDuration::from_hours(24 * 6 + 1);
        let entries = vec![
            entry(
                since + SignedDuration::from_hours(1),
                ProviderId::Claude,
                "claude-opus-5-5",
                100,
            ),
            entry(today, ProviderId::Claude, "claude-opus-5-5", 300),
            entry(today, ProviderId::Codex, "gpt-6-sol", 50),
        ];
        let names = HashMap::from([("claude-1".to_owned(), "me@x.dev".to_owned())]);
        let history = build(&entries, Range::Week, since, now, &BTreeMap::new(), &names);
        assert_eq!(history.buckets.len(), 7);
        assert_eq!(history.providers, [ProviderId::Claude, ProviderId::Codex]);
        assert_eq!(history.buckets[0].tokens, [110, 0]);
        assert_eq!(history.buckets[6].tokens, [310, 60]);
        assert_eq!(history.buckets[6].requests, 2);
        assert!(history.buckets[1..6].iter().all(|b| b.requests == 0));
        assert_eq!(history.total.requests, 3);
        // The busiest first, under its display name.
        assert_eq!(history.models[0].name, "claude-opus-5-5");
        assert_eq!(history.accounts[0].name, "me@x.dev");
        assert_eq!(history.accounts[1].name, "codex-1");
    }

    #[test]
    fn today_counts_hours_up_to_now() {
        let since = ts(1_000_000);
        let now = since + SignedDuration::from_hours(5);
        let history = build(
            &[],
            Range::Today,
            since,
            now,
            &BTreeMap::new(),
            &HashMap::new(),
        );
        let labels: Vec<&str> = history.buckets.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(
            labels,
            ["00:00", "01:00", "02:00", "03:00", "04:00", "05:00"]
        );
        assert!(history.providers.is_empty());
    }

    #[test]
    fn first_bytes_read_as_median_and_slowest_twentieth() {
        let mut waits: Vec<u64> = (1..=100).collect();
        assert_eq!(percentile(&mut waits, 50), Some(51));
        assert_eq!(percentile(&mut waits, 95), Some(96));
        assert_eq!(percentile(&mut [], 50), None);
    }
}
