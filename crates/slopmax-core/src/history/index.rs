//! The ledger summed by local hour, which a [`History`] is read from
//! without going back to the ledger: each hour holds, for each account,
//! model and agent, what was answered and what failed, the agents'
//! conversations, and how soon answers began and how fast they came.
//!
//! The daemon keeps one for the last month ([`Kept`]): built on a blocking
//! thread the first time a history is asked for, and added to as each
//! request settles, so `/history` reads no file after that.
//!
//! Waits and speeds are counted in [`Hist`] bins, exact below 1,024 and
//! within 0.1% above, so an hour holds a few hundred numbers however busy
//! it was; a median read from them is within 0.1% of the exact one.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use super::{
    Bucket, History, Part, Prices, Range, Speed, WARMUP, agent, cached, label, ranked, speed,
    tokens,
};
use crate::ledger::Entry;
use crate::pricing::{self, Price};
use crate::provider::ProviderId;
use crate::summary::{self, Totals};
use crate::time::Timestamp;

/// Local days an index the daemon keeps holds: the longest range, and the
/// day it began on.
const KEPT_DAYS: i64 = 31;

/// What one span's requests to one account, of one model, from one agent
/// came to.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Cell {
    provider: ProviderId,
    /// The account's id; empty for a failure that reached none.
    account: Arc<str>,
    model: Option<Arc<str>>,
    agent: Option<Arc<str>>,
}

#[derive(Debug, Clone, Default)]
struct Sums {
    /// Answers, and what they moved.
    answered: u64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    failed: u64,
    /// Answers that needed another account.
    rescued: u64,
}

impl Sums {
    fn merge(&mut self, other: &Sums) {
        self.answered += other.answered;
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.failed += other.failed;
        self.rescued += other.rescued;
    }

    /// As a ledger summary counts them, at `price` when the model has one.
    fn totals(&self, price: Option<Price>) -> Totals {
        let mut totals = Totals {
            requests: self.answered,
            input: self.input,
            output: self.output,
            cache_read: self.cache_read,
            cache_write: self.cache_write,
            failed: self.failed,
            ..Totals::default()
        };
        if self.answered > 0 {
            match price {
                Some(p) => {
                    totals.cost =
                        p.cost(self.input, self.output, self.cache_read, self.cache_write);
                }
                None => totals.unpriced = self.answered,
            }
        }
        totals
    }
}

/// A local hour, or a whole day rolled up from its hours.
#[derive(Debug, Clone, Default)]
struct Span {
    cells: Vec<(Cell, Sums)>,
    /// The agents' conversations answered in it, hashed, sorted, each once.
    sessions: Vec<u64>,
    /// The agents' answers by the hour of the day, warmups aside.
    work: [u64; 24],
    /// Milliseconds to the first byte of each answer.
    waits: Hist,
    /// Each model's output tokens a second, in thousandths, once each
    /// answer began.
    speeds: Vec<(Model, Hist)>,
}

/// A model as the history lists it, with the provider that served it.
type Model = (Option<Arc<str>>, ProviderId);

impl Span {
    fn sums(&mut self, cell: &Cell) -> &mut Sums {
        let i = match self.cells.iter().position(|(c, _)| c == cell) {
            Some(i) => i,
            None => {
                self.cells.push((cell.clone(), Sums::default()));
                self.cells.len() - 1
            }
        };
        &mut self.cells[i].1
    }

    fn merge(&mut self, other: &Span) {
        for (cell, sums) in &other.cells {
            self.sums(cell).merge(sums);
        }
        self.sessions = union(&self.sessions, &other.sessions);
        for (mine, theirs) in self.work.iter_mut().zip(other.work) {
            *mine += theirs;
        }
        self.waits.merge(&other.waits);
        for (model, hist) in &other.speeds {
            self.speeds(model).merge(hist);
        }
    }

    fn speeds(&mut self, model: &Model) -> &mut Hist {
        let i = match self.speeds.iter().position(|(m, _)| m == model) {
            Some(i) => i,
            None => {
                self.speeds.push((model.clone(), Hist::default()));
                self.speeds.len() - 1
            }
        };
        &mut self.speeds[i].1
    }
}

/// Two sorted lists of distinct values as one.
fn union(a: &[u64], b: &[u64]) -> Vec<u64> {
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => {
                out.push(a[i]);
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                out.push(b[j]);
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                out.push(a[i]);
                (i, j) = (i + 1, j + 1);
            }
        }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

/// Values counted by bin: exact below 1,024, and above it to ten
/// significant bits, which is within 0.1%. Sorted by bin.
#[derive(Debug, Clone, Default)]
pub(super) struct Hist(Vec<(u32, u32)>);

impl Hist {
    fn bin(value: u64) -> u32 {
        if value < 1024 {
            return value as u32;
        }
        let shift = 54 - value.leading_zeros();
        (shift << 10) | (value >> shift) as u32
    }

    fn value(bin: u32) -> u64 {
        u64::from(bin & 1023) << (bin >> 10)
    }

    fn add(&mut self, value: u64) {
        let bin = Self::bin(value);
        match self.0.binary_search_by_key(&bin, |(b, _)| *b) {
            Ok(i) => self.0[i].1 += 1,
            Err(i) => self.0.insert(i, (bin, 1)),
        }
    }

    fn merge(&mut self, other: &Hist) {
        if other.0.is_empty() {
            return;
        }
        let (a, b) = (&self.0, &other.0);
        let mut out = Vec::with_capacity(a.len() + b.len());
        let (mut i, mut j) = (0, 0);
        while i < a.len() && j < b.len() {
            match a[i].0.cmp(&b[j].0) {
                std::cmp::Ordering::Less => {
                    out.push(a[i]);
                    i += 1;
                }
                std::cmp::Ordering::Greater => {
                    out.push(b[j]);
                    j += 1;
                }
                std::cmp::Ordering::Equal => {
                    out.push((a[i].0, a[i].1 + b[j].1));
                    (i, j) = (i + 1, j + 1);
                }
            }
        }
        out.extend_from_slice(&a[i..]);
        out.extend_from_slice(&b[j..]);
        self.0 = out;
    }

    fn merge_into(&self, all: &mut Bins) {
        for &(bin, n) in &self.0 {
            *all.entry(bin).or_default() += u64::from(n);
        }
    }
}

/// A hasher for keys that are small numbers or hashes already: one
/// multiply, as a map of bins or of hashed sessions needs no more.
#[derive(Default, Clone, Copy)]
struct Mix(u64);

impl Hasher for Mix {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ u64::from(b)).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }

    fn write_u32(&mut self, n: u32) {
        self.write_u64(u64::from(n));
    }

    fn write_u64(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

type Fast = std::hash::BuildHasherDefault<Mix>;
/// Bins counted across spans.
type Bins = HashMap<u32, u64, Fast>;

/// Percentiles `ps` of what `bins` counted, each as the sorted values'
/// element at `len * p / 100` would be.
fn percentiles<const N: usize>(bins: &Bins, ps: [u64; N]) -> [Option<u64>; N] {
    let mut sorted: Vec<(u32, u64)> = bins.iter().map(|(&b, &n)| (b, n)).collect();
    sorted.sort_unstable_by_key(|(b, _)| *b);
    let count: u64 = sorted.iter().map(|(_, n)| n).sum();
    ps.map(|p| {
        if count == 0 {
            return None;
        }
        let rank = (count * p / 100).min(count - 1);
        let mut seen = 0;
        sorted.iter().find_map(|&(bin, n)| {
            seen += n;
            (seen > rank).then(|| Hist::value(bin))
        })
    })
}

/// The ledger by local hour, with the days before today rolled up as they
/// are first read.
#[derive(Debug, Default)]
pub struct Index {
    /// By local hour: hours since the epoch on this machine's clock.
    hours: BTreeMap<i64, Span>,
    /// Days before today, by local day, rolled up from their hours.
    days: HashMap<i64, Span>,
    /// Each name once, shared by the cells that use it.
    names: HashSet<Arc<str>>,
}

/// An instant's local hour, counted from the epoch.
fn hour_of(at: Timestamp) -> i64 {
    (at.as_second() + at.local_offset().as_secs()).div_euclid(3_600)
}

fn day_of(hour: i64) -> i64 {
    hour.div_euclid(24)
}

impl Index {
    /// An index of `entries`.
    pub fn of<'a>(entries: impl IntoIterator<Item = &'a Entry>) -> Self {
        let mut index = Self::default();
        for entry in entries {
            index.add(entry);
        }
        index
    }

    fn name(&mut self, name: &str) -> Arc<str> {
        if let Some(held) = self.names.get(name) {
            return held.clone();
        }
        let held: Arc<str> = name.into();
        self.names.insert(held.clone());
        held
    }

    /// Counts `entry`: an answer or a failure. An agent's housekeeping, which
    /// moved no tokens, counts in no total and is left out.
    pub fn add(&mut self, entry: &Entry) {
        let (answered, failed) = (entry.answered(), entry.failed());
        if !answered && !failed {
            return;
        }
        let cell = Cell {
            provider: entry.provider,
            account: self.name(&entry.account),
            model: entry.model.as_deref().map(|m| self.name(m)),
            agent: entry.agent.as_deref().map(|a| self.name(a)),
        };
        let hour = hour_of(entry.at);
        // A late answer changes a day already rolled up.
        self.days.remove(&day_of(hour));
        let span = self.hours.entry(hour).or_default();
        if answered && entry.agent.as_deref() != Some(WARMUP) {
            span.work[hour.rem_euclid(24) as usize] += 1;
        }
        if answered && let Some(session) = &entry.session {
            let mut hasher = DefaultHasher::new();
            session.hash(&mut hasher);
            let hashed = hasher.finish();
            if let Err(i) = span.sessions.binary_search(&hashed) {
                span.sessions.insert(i, hashed);
            }
        }
        if answered {
            if let Some(ms) = entry.first_byte_ms {
                span.waits.add(ms);
            }
            if let Some(speed) = speed(entry) {
                span.speeds(&(cell.model.clone(), cell.provider))
                    .add((speed * 1e3).round() as u64);
            }
        }
        let sums = span.sums(&cell);
        if failed {
            sums.failed += 1;
            return;
        }
        sums.answered += 1;
        sums.input += entry.input;
        sums.output += entry.output;
        sums.cache_read += entry.cache_read;
        sums.cache_write += entry.cache_write;
        if entry.attempts > 1 {
            sums.rescued += 1;
        }
    }

    /// Forgets the hours before `hour`, and the days they made.
    fn keep_from(&mut self, hour: i64) {
        self.hours = self.hours.split_off(&hour);
        self.days.retain(|&day, _| day >= day_of(hour));
    }

    /// What went through over `range` up to `now`. `names` gives accounts
    /// their display names.
    pub fn history(
        &mut self,
        range: Range,
        now: Timestamp,
        prices: &Prices,
        names: &HashMap<String, String>,
    ) -> History {
        let since = summary::since(range.key(), now).unwrap_or(now);
        let (first, last) = (hour_of(since), hour_of(now));
        let (first_day, today) = (day_of(first), day_of(last));
        let count = match range {
            Range::Today => (last - first + 1).max(0) as usize,
            Range::Week => 7,
            Range::Month => 30,
        };
        // Each bucket's spans: today's hours as they are, and each day
        // before today as one roll-up, made the first time it is read.
        for day in first_day..today {
            if self.days.contains_key(&day) {
                continue;
            }
            let mut rolled = Span::default();
            for (_, hour) in self.hours.range(day * 24..(day + 1) * 24) {
                rolled.merge(hour);
            }
            self.days.insert(day, rolled);
        }
        let mut spans: Vec<(usize, i64, &Span)> = Vec::new();
        match range {
            Range::Today => spans.extend(
                self.hours
                    .range(first..=last)
                    .map(|(&h, span)| ((h - first) as usize, day_of(h), span)),
            ),
            _ => {
                for day in first_day..today {
                    spans.push(((day - first_day) as usize, day, &self.days[&day]));
                }
                spans.extend(
                    self.hours
                        .range(today * 24..=last)
                        .map(|(_, span)| ((today - first_day) as usize, today, span)),
                );
            }
        }
        spans.retain(|(slot, _, _)| *slot < count);
        let providers: Vec<ProviderId> = ProviderId::ALL
            .into_iter()
            .filter(|p| {
                spans.iter().any(|(_, _, span)| {
                    span.cells
                        .iter()
                        .any(|(c, s)| c.provider == *p && s.answered > 0)
                })
            })
            .collect();

        let mut priced: HashMap<Arc<str>, Option<Price>> = HashMap::new();
        let mut price = |model: Option<&Arc<str>>| -> Option<Price> {
            let model = model?;
            *priced
                .entry(model.clone())
                .or_insert_with(|| pricing::price(model, prices.models))
        };

        struct Filling {
            totals: Totals,
            work: Totals,
            tokens: Vec<u64>,
            rescued: u64,
            sessions: HashSet<u64, Fast>,
            waits: Bins,
        }
        let mut buckets: Vec<Filling> = (0..count)
            .map(|_| Filling {
                totals: Totals::default(),
                work: Totals::default(),
                tokens: vec![0; providers.len()],
                rescued: 0,
                sessions: HashSet::default(),
                waits: Bins::default(),
            })
            .collect();
        let mut total = Totals::default();
        let mut work = Totals::default();
        let (mut rescued, mut unplaced) = (0, 0);
        let mut billed = Totals::default();
        let mut cache_saved = 0.;
        let mut sessions: HashSet<u64, Fast> = HashSet::default();
        let mut waits = Bins::default();
        let mut activity = [[0; 24]; 7];
        let mut models: HashMap<Model, Totals> = HashMap::new();
        let mut accounts: HashMap<(Arc<str>, ProviderId), Totals> = HashMap::new();
        let mut agents: BTreeMap<&'static str, Totals> = BTreeMap::new();
        let mut speeds: HashMap<Model, Bins> = HashMap::new();

        for (slot, day, span) in spans {
            let bucket = &mut buckets[slot];
            bucket.sessions.extend(&span.sessions);
            sessions.extend(&span.sessions);
            let weekday = (day + 3).rem_euclid(7) as usize;
            for (hour, n) in span.work.iter().enumerate() {
                activity[weekday][hour] += n;
            }
            span.waits.merge_into(&mut bucket.waits);
            span.waits.merge_into(&mut waits);
            for (model, hist) in &span.speeds {
                hist.merge_into(speeds.entry(model.clone()).or_default());
            }
            for (cell, sums) in &span.cells {
                let price = price(cell.model.as_ref());
                let totals = sums.totals(price);
                bucket.totals.merge(&totals);
                total.merge(&totals);
                if cell.account.is_empty() {
                    unplaced += sums.failed;
                } else {
                    accounts
                        .entry((cell.account.clone(), cell.provider))
                        .or_default()
                        .merge(&totals);
                }
                if sums.answered == 0 {
                    continue;
                }
                let answers = Totals {
                    failed: 0,
                    ..totals
                };
                if !cell.provider.spec().is_subscription() {
                    billed.merge(&answers);
                }
                if let Some(i) = providers.iter().position(|p| *p == cell.provider) {
                    bucket.tokens[i] += tokens(&answers);
                }
                bucket.rescued += sums.rescued;
                rescued += sums.rescued;
                if let Some(price) = price {
                    cache_saved += sums.cache_read as f64 * (price.input - price.cache_read) / 1e6;
                }
                let key = (cell.model.clone(), cell.provider);
                if cell.agent.as_deref() != Some(WARMUP) {
                    bucket.work.merge(&answers);
                    work.merge(&answers);
                }
                models.entry(key).or_default().merge(&answers);
                agents
                    .entry(agent(cell.agent.as_deref()))
                    .or_default()
                    .merge(&answers);
            }
        }

        let buckets = buckets
            .into_iter()
            .enumerate()
            .map(|(i, b)| {
                let [p50, p95] = percentiles(&b.waits, [50, 95]);
                Bucket {
                    label: label(range, since, i),
                    requests: b.totals.requests,
                    failed: b.totals.failed,
                    rescued: b.rescued,
                    sessions: b.sessions.len() as u64,
                    cost: b.totals.cost,
                    cached: cached(&b.work),
                    first_byte: p50.zip(p95),
                    tokens: b.tokens,
                }
            })
            .collect();
        let mut agents: Vec<Part> = agents
            .into_iter()
            .map(|(name, totals)| Part { name, totals })
            .collect();
        agents.sort_by_key(|a| std::cmp::Reverse(tokens(&a.totals)));
        // By the names people read: an account by its display name, a
        // model that named none as `unknown`.
        let model_name =
            |model: Option<Arc<str>>| model.map_or_else(|| "unknown".to_owned(), |m| m.to_string());
        let mut by_speed: BTreeMap<(String, ProviderId), Bins> = BTreeMap::new();
        for ((model, provider), bins) in speeds {
            let all = by_speed.entry((model_name(model), provider)).or_default();
            for (bin, n) in bins {
                *all.entry(bin).or_default() += n;
            }
        }
        let mut speeds: Vec<Speed> = by_speed
            .into_iter()
            .filter_map(|((model, provider), bins)| {
                let [median] = percentiles(&bins, [50]);
                Some(Speed {
                    model,
                    provider,
                    tokens_per_second: median? as f64 / 1e3,
                })
            })
            .collect();
        speeds.sort_by(|a, b| b.tokens_per_second.total_cmp(&a.tokens_per_second));
        let mut by_model: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
        for ((model, provider), totals) in models {
            by_model
                .entry((model_name(model), provider))
                .or_default()
                .merge(&totals);
        }
        let mut by_account: BTreeMap<(String, ProviderId), Totals> = BTreeMap::new();
        for ((account, provider), totals) in accounts {
            let name = names
                .get(&*account)
                .cloned()
                .unwrap_or_else(|| account.to_string());
            by_account
                .entry((name, provider))
                .or_default()
                .merge(&totals);
        }
        let [first_byte] = percentiles(&waits, [50]);
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
            first_byte,
            activity,
            models: ranked(by_model),
            accounts: ranked(by_account),
            agents,
            speeds,
        }
    }
}

/// The index the daemon keeps of its own ledger, and of the windows that
/// reset: none until a history is first asked for, then the last month's,
/// kept current as requests settle.
#[derive(Debug, Default)]
pub struct Kept {
    stage: Mutex<Stage>,
}

#[derive(Debug, Default)]
enum Stage {
    /// Not asked for yet: nothing kept.
    #[default]
    Cold,
    /// Reading the ledger: what settles meanwhile waits here, and the
    /// windows that reset.
    Building(Vec<Entry>, Vec<crate::waste::Record>),
    Ready(Box<Ready>),
}

#[derive(Debug)]
struct Ready {
    index: Index,
    lapses: Vec<crate::waste::Record>,
}

impl Kept {
    fn stage(&self) -> std::sync::MutexGuard<'_, Stage> {
        self.stage.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Counts a request that settled, once the index is kept.
    pub fn add(&self, entry: &Entry) {
        match &mut *self.stage() {
            Stage::Cold => {}
            Stage::Building(waiting, _) => waiting.push(entry.clone()),
            Stage::Ready(ready) => ready.index.add(entry),
        }
    }

    /// Counts windows that reset, once the index is kept. One the build
    /// also reads counts once, as every window does.
    pub fn lapsed(&self, records: &[crate::waste::Record]) {
        match &mut *self.stage() {
            Stage::Cold => {}
            Stage::Building(_, lapses) => lapses.extend_from_slice(records),
            Stage::Ready(ready) => ready.lapses.extend_from_slice(records),
        }
    }

    /// Whether the index is kept already, so a history needs no file.
    pub fn is_ready(&self) -> bool {
        matches!(*self.stage(), Stage::Ready(_))
    }

    /// Reads the last month of the ledger in `usage`, up to the lengths
    /// `ledger.mark` gives, and the windows in `windows` that reset, into
    /// the index. Blocks: for a blocking thread. `mark` runs under the
    /// ledger's lock and starts the build there, so each request lands
    /// either in what is read or in what waits, never both.
    pub fn build(
        &self,
        usage: &Path,
        windows: &Path,
        now: Timestamp,
        mark: impl FnOnce(&mut dyn FnMut()) -> Vec<(PathBuf, u64)>,
    ) {
        let lengths = {
            let mut start = || {
                let mut stage = self.stage();
                if matches!(*stage, Stage::Cold) {
                    *stage = Stage::Building(Vec::new(), Vec::new());
                }
            };
            mark(&mut start)
        };
        // Another caller built it, or is building it.
        if !matches!(*self.stage(), Stage::Building(..)) {
            return;
        }
        let from = now - crate::time::SignedDuration::from_hours(24 * KEPT_DAYS);
        let mut index = Index::default();
        for entry in crate::ledger::read_upto(usage, from, &lengths) {
            index.add(&entry);
        }
        let mut lapses = crate::waste::read(windows, from);
        let mut stage = self.stage();
        if let Stage::Building(waiting, lapsed) = std::mem::take(&mut *stage) {
            for entry in &waiting {
                index.add(entry);
            }
            lapses.extend(lapsed);
            *stage = Stage::Ready(Box::new(Ready { index, lapses }));
        }
    }

    /// The history over `range`, when the index is kept; else `None`, and
    /// [`Kept::build`] is due.
    pub fn history(
        &self,
        range: Range,
        now: Timestamp,
        prices: &Prices,
        names: &HashMap<String, String>,
    ) -> Option<History> {
        let mut stage = self.stage();
        let Stage::Ready(ready) = &mut *stage else {
            return None;
        };
        ready.index.keep_from(hour_of(now) - 24 * KEPT_DAYS);
        let since = summary::since(range.key(), now).unwrap_or(now);
        ready.lapses.retain(|r| {
            r.ended_at >= now - crate::time::SignedDuration::from_hours(24 * KEPT_DAYS)
        });
        let mut history = ready.index.history(range, now, prices, names);
        let lapsed: Vec<crate::waste::Record> = crate::waste::once(
            ready
                .lapses
                .iter()
                .filter(|r| r.ended_at >= since)
                .cloned()
                .collect(),
        );
        history.left = crate::waste::left(&lapsed, prices.plans, names);
        Some(history)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bins_are_exact_below_1024_and_close_above() {
        for value in [0, 1, 512, 1023] {
            assert_eq!(Hist::value(Hist::bin(value)), value);
        }
        for value in [1024u64, 1500, 99_999, 100_000, 7_654_321, u64::MAX / 3] {
            let back = Hist::value(Hist::bin(value));
            assert!(back <= value, "{value} → {back}");
            assert!(
                (value - back) as f64 / value as f64 <= 1e-3,
                "{value} → {back}"
            );
        }
        // Bins sort as their values do.
        let mut last = 0;
        for value in (0..2_000_000u64).step_by(997) {
            let bin = Hist::bin(value);
            assert!(bin >= last);
            last = bin;
        }
    }

    #[test]
    fn percentiles_read_from_bins_as_from_sorted_values() {
        let mut hist = Hist::default();
        for value in 1..=100 {
            hist.add(value);
        }
        let mut bins = Bins::default();
        hist.merge_into(&mut bins);
        assert_eq!(percentiles(&bins, [50, 95]), [Some(51), Some(96)]);
        assert_eq!(percentiles(&Bins::default(), [50]), [None]);
        // Merged lists count as one.
        let mut other = Hist::default();
        other.add(51);
        other.add(5_000);
        hist.merge(&other);
        let mut bins = Bins::default();
        hist.merge_into(&mut bins);
        assert_eq!(bins[&51], 2);
        assert_eq!(bins.values().sum::<u64>(), 102);
    }
}

#[cfg(test)]
mod timing {
    use super::*;

    /// A heavy month: 10 agents' worth of answers, about 1.3 million, from
    /// 8 accounts and 4 models. `cargo test --release -- --ignored`.
    #[test]
    #[ignore = "measures; run by hand"]
    fn a_heavy_month_reads_in_well_under_a_millisecond_a_day() {
        let now = Timestamp::now();
        let mut index = Index::default();
        let started = std::time::Instant::now();
        let mut n = 0u64;
        for minute in 0..(30 * 24 * 60) {
            let at = now - crate::time::SignedDuration::from_mins(minute);
            for k in 0..30 {
                n += 1;
                let entry = Entry {
                    at,
                    account: format!("acct-{}", k % 8),
                    provider: ProviderId::Claude,
                    model: Some(format!("claude-opus-5-{}", k % 4)),
                    status: 200,
                    input: 100,
                    output: 300 + k,
                    cache_read: 10_000,
                    cache_write: 50,
                    ms: 9_000 + k * 13,
                    first_byte_ms: Some(400 + (minute % 977) as u64),
                    attempts: 1,
                    agent: Some("claude".into()),
                    session: Some(format!("s-{}", (minute / 30) * 30 + k as i64)),
                    end: None,
                };
                index.add(&entry);
            }
        }
        eprintln!("{n} entries indexed in {:?}", started.elapsed());
        let (models, plans) = (BTreeMap::new(), BTreeMap::new());
        let prices = Prices {
            models: &models,
            plans: &plans,
        };
        // The first read rolls the days up; the next are what a dashboard
        // waits for.
        for pass in ["first", "again"] {
            for range in Range::ALL {
                let started = std::time::Instant::now();
                let history = index.history(range, now, &prices, &HashMap::new());
                eprintln!(
                    "{pass} {range:?}: {:?} for {} requests",
                    started.elapsed(),
                    history.total.requests
                );
            }
        }
    }
}
