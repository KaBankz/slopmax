//! The ledger as a window charts it: what went through slopmax over a
//! range, hour by hour or day by day; by provider, model, account, and
//! agent; what failover saved and what failed; what caching saved; how soon
//! answers began and how fast they came; and when the work happens. Worked
//! out once for every UI, as `view` is for the accounts.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Serialize;

use crate::ledger::{self, Entry};
use crate::pricing::{self, Custom};
use crate::provider::ProviderId;
use crate::summary::{self, Totals};
use crate::time::{SignedDuration, Timestamp};

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/// Answers shorter than this say little about a model's speed.
const SPEED_MIN_OUTPUT: u64 = 64;
/// The agent slopmax's own warmups name, which keep a window open at
/// slopmax's hours rather than do the user's work.
const WARMUP: &str = "slopmax";

/// The span a history covers, counted in local days.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
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

    /// The range `summary` knows as `key`: `today`, `7d`, or `30d`.
    pub fn parse(key: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|r| r.key() == key)
    }

    /// The name `summary` knows it by.
    pub fn key(self) -> &'static str {
        match self {
            Range::Today => "today",
            Range::Week => "7d",
            Range::Month => "30d",
        }
    }
}

/// What went through slopmax over a range.
#[derive(Debug, Clone, Serialize)]
pub struct History {
    pub range: Range,
    /// Hours for today, days otherwise, oldest first, empty ones included.
    pub buckets: Vec<Bucket>,
    /// The providers that answered, in the order each bucket lists its
    /// tokens.
    pub providers: Vec<ProviderId>,
    /// The answers' totals, failures counted apart.
    pub total: Totals,
    /// Answers that came from another account after the first could not
    /// give one: the requests failover saved.
    pub rescued: u64,
    /// Failures that reached no account, because every one was limited or
    /// out of rotation; the rest count against the account they reached.
    pub unplaced: u64,
    /// What answers from API keys were billed, in dollars: real spending,
    /// unlike the rest of `total.cost`, which subscriptions cover.
    pub billed: f64,
    /// Subscription quota the range's resets threw away, and what it cost.
    pub left: crate::waste::Left,
    /// What reading input from cache saved against sending it afresh, in
    /// dollars at API prices.
    pub cache_saved: f64,
    /// The share of the agents' input read from cache, from 0 to 1, when
    /// any came in; warmups, which never read it, left out.
    pub cached: Option<f32>,
    /// The agents' conversations that were answered.
    pub sessions: u64,
    /// The median time to the first byte of an answer, in milliseconds.
    pub first_byte: Option<u64>,
    /// What a month at this range's pace would be worth at API prices, when
    /// the range says enough about a month.
    pub monthly: Option<f64>,
    /// The agents' answers by local weekday (Monday first) and hour;
    /// warmups, at slopmax's hours, left out.
    pub activity: [[u64; 24]; 7],
    /// Most tokens first.
    pub models: Vec<Share>,
    /// Most tokens first; an account that only failed comes last.
    pub accounts: Vec<Share>,
    /// Claude Code, Codex, slopmax's own warmups, or other agents; most
    /// tokens first.
    pub agents: Vec<Part>,
    /// Each model's median output speed, fastest first.
    pub speeds: Vec<Speed>,
}

/// One hour or day.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Bucket {
    /// `09:00`, or `Oct 3`.
    pub label: String,
    /// Tokens answered by each of `History::providers`, in that order.
    pub tokens: Vec<u64>,
    pub requests: u64,
    pub failed: u64,
    /// Answers that needed another account.
    pub rescued: u64,
    /// The agents' conversations answered.
    pub sessions: u64,
    /// What the answers would have cost on the API, in dollars.
    pub cost: f64,
    /// The share of the agents' input read from cache, from 0 to 1, when
    /// any came in; warmups left out.
    pub cached: Option<f32>,
    /// The median and 95th percentile time to the first byte, in
    /// milliseconds, when any answer reported one.
    pub first_byte: Option<(u64, u64)>,
}

/// A model's or an account's part of the range.
#[derive(Debug, Clone, Serialize)]
pub struct Share {
    pub name: String,
    pub provider: ProviderId,
    pub totals: Totals,
}

/// An agent's part of the range.
#[derive(Debug, Clone, Serialize)]
pub struct Part {
    pub name: &'static str,
    pub totals: Totals,
}

/// How fast a model writes, once it has begun.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Speed {
    pub model: String,
    pub provider: ProviderId,
    /// Output tokens a second, the median over its answers.
    pub tokens_per_second: f64,
}

/// Every token a request moved: input, output, and both kinds of cache.
pub fn tokens(totals: &Totals) -> u64 {
    totals.input + totals.output + totals.cache_read + totals.cache_write
}

/// The share of input read from cache, from 0 to 1, when any came in.
pub fn cached(totals: &Totals) -> Option<f32> {
    let input = totals.input + totals.cache_read + totals.cache_write;
    (input > 0).then(|| totals.cache_read as f32 / input as f32)
}

/// Reads `home`'s ledger and reset windows over `range`. `names` gives
/// accounts their display names.
pub fn load(
    home: &crate::paths::Home,
    range: Range,
    now: Timestamp,
    prices: &Prices,
    names: &HashMap<String, String>,
) -> History {
    let since = summary::since(range.key(), now).unwrap_or(now);
    let mut history = build(
        &ledger::read(&home.usage(), since),
        range,
        since,
        now,
        prices.models,
        names,
    );
    let lapsed = crate::waste::read(&home.windows(), since);
    history.left = crate::waste::left(&lapsed, prices.plans, names);
    history
}

/// What usage is valued at: API prices per model, and plans' fees.
#[derive(Debug, Clone, Copy)]
pub struct Prices<'a> {
    pub models: &'a BTreeMap<String, Custom>,
    pub plans: &'a BTreeMap<String, f64>,
}

impl<'a> Prices<'a> {
    pub fn of(config: &'a crate::config::Config) -> Self {
        Self {
            models: &config.prices,
            plans: &config.plan_prices,
        }
    }
}

/// One bucket while it fills.
#[derive(Default)]
struct Filling {
    totals: Totals,
    /// The agents' answers, warmups aside.
    work: Totals,
    tokens: Vec<u64>,
    rescued: u64,
    sessions: HashSet<String>,
    waits: Vec<u64>,
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
        .filter(|p| entries.iter().any(|e| e.provider == *p && e.answered()))
        .collect();

    let mut buckets: Vec<Filling> = (0..count)
        .map(|_| Filling {
            tokens: vec![0; providers.len()],
            ..Filling::default()
        })
        .collect();
    let mut total = Totals::default();
    let mut work = Totals::default();
    let mut rescued = 0;
    let mut unplaced = 0;
    let mut billed = Totals::default();
    let mut cache_saved = 0.;
    let mut sessions = HashSet::new();
    let mut waits = Vec::new();
    let mut activity = [[0; 24]; 7];
    let mut models: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
    let mut accounts: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
    let mut agents: BTreeMap<&'static str, Totals> = BTreeMap::new();
    let mut speeds: BTreeMap<(String, ProviderId), Vec<f64>> = BTreeMap::new();
    for entry in entries {
        let Some(bucket) = buckets.get_mut(slot(entry.at)) else {
            continue;
        };
        bucket.totals.add(entry, prices);
        total.add(entry, prices);
        // A failure counts against the account it reached, if any.
        if !entry.account.is_empty() && (entry.answered() || entry.failed()) {
            let account = names
                .get(&entry.account)
                .cloned()
                .unwrap_or_else(|| entry.account.clone());
            accounts
                .entry((account, entry.provider))
                .or_default()
                .add(entry, prices);
        }
        if entry.failed() && entry.account.is_empty() {
            unplaced += 1;
        }
        if !entry.answered() {
            continue;
        }
        if !entry.provider.spec().is_subscription() {
            billed.add(entry, prices);
        }
        if let Some(i) = providers.iter().position(|p| *p == entry.provider) {
            bucket.tokens[i] += entry.tokens();
        }
        if entry.attempts > 1 {
            bucket.rescued += 1;
            rescued += 1;
        }
        if let Some(ms) = entry.first_byte_ms {
            bucket.waits.push(ms);
            waits.push(ms);
        }
        // An agent's conversation; slopmax's warmups have none.
        if let Some(session) = &entry.session {
            bucket.sessions.insert(session.clone());
            sessions.insert(session.clone());
        }
        let model = entry.model.clone().unwrap_or_else(|| "unknown".into());
        if let Some(price) = entry
            .model
            .as_deref()
            .and_then(|m| pricing::price(m, prices))
        {
            cache_saved += entry.cache_read as f64 * (price.input - price.cache_read) / 1e6;
        }
        if let Some(speed) = speed(entry) {
            speeds
                .entry((model.clone(), entry.provider))
                .or_default()
                .push(speed);
        }
        if entry.agent.as_deref() != Some(WARMUP) {
            bucket.work.add(entry, prices);
            work.add(entry, prices);
            let (weekday, hour) = when(entry.at, entry.at.local_offset());
            activity[weekday][hour] += 1;
        }
        models
            .entry((model, entry.provider))
            .or_default()
            .add(entry, prices);
        agents
            .entry(agent(entry.agent.as_deref()))
            .or_default()
            .add(entry, prices);
    }

    let buckets = buckets
        .into_iter()
        .enumerate()
        .map(|(i, mut b)| Bucket {
            label: label(range, since, i),
            requests: b.totals.requests,
            failed: b.totals.failed,
            rescued: b.rescued,
            sessions: b.sessions.len() as u64,
            cost: b.totals.cost,
            cached: cached(&b.work),
            first_byte: percentile(&mut b.waits, 50).zip(percentile(&mut b.waits, 95)),
            tokens: b.tokens,
        })
        .collect();
    let mut agents: Vec<Part> = agents
        .into_iter()
        .map(|(name, totals)| Part { name, totals })
        .collect();
    agents.sort_by_key(|a| std::cmp::Reverse(tokens(&a.totals)));
    let mut speeds: Vec<Speed> = speeds
        .into_iter()
        .filter_map(|((model, provider), mut each)| {
            each.sort_by(f64::total_cmp);
            let median = *each.get(each.len() / 2)?;
            Some(Speed {
                model,
                provider,
                tokens_per_second: median,
            })
        })
        .collect();
    speeds.sort_by(|a, b| b.tokens_per_second.total_cmp(&a.tokens_per_second));
    History {
        range,
        buckets,
        providers,
        monthly: match range {
            Range::Week => Some(total.cost * 30. / 7.),
            _ => None,
        },
        total,
        rescued,
        unplaced,
        billed: billed.cost,
        left: crate::waste::Left::default(),
        cache_saved,
        cached: cached(&work),
        sessions: sessions.len() as u64,
        first_byte: percentile(&mut waits, 50),
        activity,
        models: ranked(models),
        accounts: ranked(accounts),
        agents,
        speeds,
    }
}

/// How fast an answer came once it began, in output tokens a second, when
/// it was long enough to say.
fn speed(entry: &Entry) -> Option<f64> {
    let writing = entry.ms.checked_sub(entry.first_byte_ms?)?;
    (entry.output >= SPEED_MIN_OUTPUT && writing > 0)
        .then(|| entry.output as f64 * 1e3 / writing as f64)
}

/// An agent as people know it.
fn agent(id: Option<&str>) -> &'static str {
    match id {
        Some("claude") => "Claude Code",
        Some("codex") => "Codex",
        Some(WARMUP) => "Warmups",
        _ => "Other",
    }
}

/// The weekday (Monday first) and hour of `at`, on a clock `offset` east of
/// UTC.
fn when(at: Timestamp, offset: SignedDuration) -> (usize, usize) {
    let local = at.as_second() + offset.as_secs();
    // The first day, January 1st 1970, was a Thursday.
    let weekday = (local.div_euclid(86_400) + 3).rem_euclid(7) as usize;
    let hour = (local.rem_euclid(86_400) / 3_600) as usize;
    (weekday, hour)
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

/// Most tokens first; what moved none (an account that only failed) last.
fn ranked(groups: BTreeMap<(String, ProviderId), Totals>) -> Vec<Share> {
    let mut shares: Vec<Share> = groups
        .into_iter()
        .map(|((name, provider), totals)| Share {
            name,
            provider,
            totals,
        })
        .collect();
    shares.sort_by_key(|s| std::cmp::Reverse((tokens(&s.totals), s.totals.failed)));
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
            agent: None,
            session: None,
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
        let week: u64 = history.activity.iter().flatten().sum();
        assert_eq!(week, 3);
    }

    #[test]
    fn failover_failures_and_housekeeping_count_apart() {
        let now = Timestamp::now();
        let since = summary::since("today", now).unwrap();
        // Now, not a minute ago: in an hour's first minute, that would be
        // the hour before, and not the last bucket.
        let at = now;
        let rescued = Entry {
            attempts: 2,
            ..entry(at, ProviderId::Claude, "claude-opus-5-5", 100)
        };
        let failed = Entry {
            status: 429,
            input: 0,
            output: 0,
            first_byte_ms: None,
            ..entry(at, ProviderId::Claude, "claude-opus-5-5", 0)
        };
        // Spent before any account could be tried.
        let refused = Entry {
            account: String::new(),
            ..failed.clone()
        };
        // An agent listing models.
        let listing = Entry {
            model: None,
            input: 0,
            output: 0,
            ..entry(at, ProviderId::Claude, "-", 0)
        };
        let entries = [rescued, failed, refused, listing];
        let history = build(
            &entries,
            Range::Today,
            since,
            now,
            &BTreeMap::new(),
            &HashMap::new(),
        );
        assert_eq!((history.total.requests, history.total.failed), (1, 2));
        assert_eq!(history.rescued, 1);
        let bucket = history.buckets.last().unwrap();
        assert_eq!((bucket.requests, bucket.failed, bucket.rescued), (1, 2, 1));
        // The account the failure reached counts it; no account, no row.
        assert_eq!(history.accounts.len(), 1);
        assert_eq!(history.accounts[0].totals.failed, 1);
        assert_eq!(history.unplaced, 1, "the failure no account took");
        assert_eq!(history.models.len(), 1);
    }

    #[test]
    fn api_keys_bill_what_subscriptions_only_value() {
        let now = Timestamp::now();
        let since = summary::since("today", now).unwrap();
        let at = since.max(now - SignedDuration::from_mins(1));
        let subscription = entry(at, ProviderId::Claude, "claude-opus-5-5", 1_000_000);
        let key = entry(at, ProviderId::Anthropic, "claude-opus-5-5", 1_000_000);
        let history = build(
            &[subscription, key],
            Range::Today,
            since,
            now,
            &BTreeMap::new(),
            &HashMap::new(),
        );
        // 1M input at $4 and 10 output: both valued, one of them billed.
        let each = 4.0 + 10.0 * 20.0 / 1e6;
        assert!((history.total.cost - 2.0 * each).abs() < 1e-9);
        assert!((history.billed - each).abs() < 1e-9);
    }

    #[test]
    fn caching_speed_sessions_and_agents() {
        let now = Timestamp::now();
        let since = summary::since("7d", now).unwrap();
        let at = now - SignedDuration::from_mins(1);
        let prices = BTreeMap::from([(
            "m".to_owned(),
            Custom {
                input: 10.,
                output: 0.,
                cache_read: Some(1.),
                cache_write: None,
            },
        )]);
        let answer = |session: &str| Entry {
            cache_read: 1_000_000,
            output: 1_000,
            ms: 11_000,
            first_byte_ms: Some(1_000),
            agent: Some("claude".into()),
            session: Some(session.into()),
            ..entry(at, ProviderId::Claude, "m", 0)
        };
        let warmup = Entry {
            agent: Some("slopmax".into()),
            ..entry(at, ProviderId::Codex, "gpt-6-sol", 5)
        };
        let entries = [answer("a"), answer("a"), answer("b"), warmup];
        let history = build(&entries, Range::Week, since, now, &prices, &HashMap::new());
        // Three million tokens read from cache at $1 instead of $10.
        assert!((history.cache_saved - 27.).abs() < 1e-9);
        assert_eq!(history.sessions, 2);
        assert_eq!(history.speeds[0].model, "m");
        assert!((history.speeds[0].tokens_per_second - 100.).abs() < 1e-9);
        let agents: Vec<&str> = history.agents.iter().map(|a| a.name).collect();
        assert_eq!(agents, ["Claude Code", "Warmups"]);
        assert!(history.monthly.is_some());
        // The warmup is neither work nor input that missed the cache.
        let work: u64 = history.activity.iter().flatten().sum();
        assert_eq!(work, 3);
        assert_eq!(history.cached, Some(1.));
        assert_eq!(history.buckets.last().unwrap().cached, Some(1.));
    }

    #[test]
    fn an_hour_of_warmups_alone_has_no_cache_rate() {
        let now = Timestamp::now();
        let since = summary::since("today", now).unwrap();
        let warmup = Entry {
            agent: Some(WARMUP.into()),
            ..entry(
                since.max(now - SignedDuration::from_mins(1)),
                ProviderId::Codex,
                "gpt-6-sol",
                9,
            )
        };
        let history = build(
            &[warmup],
            Range::Today,
            since,
            now,
            &BTreeMap::new(),
            &HashMap::new(),
        );
        assert_eq!(history.total.requests, 1);
        assert_eq!(history.buckets.last().unwrap().cached, None);
        assert_eq!(history.cached, None);
        assert!(history.activity.iter().flatten().all(|&n| n == 0));
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
    fn work_falls_on_the_local_weekday_and_hour() {
        // 1970-01-01 00:16:40 UTC, a Thursday.
        assert_eq!(when(ts(1_000), SignedDuration::ZERO), (3, 0));
        // Five hours west it is still Wednesday evening.
        assert_eq!(
            when(ts(1_000), SignedDuration::from_secs(-5 * 3_600)),
            (2, 19)
        );
    }

    #[test]
    fn first_bytes_read_as_median_and_slowest_twentieth() {
        let mut waits: Vec<u64> = (1..=100).collect();
        assert_eq!(percentile(&mut waits, 50), Some(51));
        assert_eq!(percentile(&mut waits, 95), Some(96));
        assert_eq!(percentile(&mut [], 50), None);
    }
}
