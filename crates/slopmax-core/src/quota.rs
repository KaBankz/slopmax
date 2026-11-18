//! The pools' quota over time, and where it is heading.
//!
//! Every few minutes the daemon reads each subscription pool's windows, and
//! each working account's, and writes them into the usage ledger beside the
//! month's requests as one `{"quota": …}` line, when they changed or an hour
//! passed ([`Sample`]). Every reader of requests skips those lines.
//!
//! [`Kept`] holds the last week of readings, and what each account served
//! in five-minute steps, from the first time a pool's detail is asked for;
//! [`Kept::detail`] reads a pool's [`PoolDetail`] from them: each window's
//! use as recorded, the pace it fills at, where that pace takes it as
//! accounts reset, the account that runs out first, what each account's
//! current windows have served, and how its requests fared by half hour.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use slopmax_api::pools::{
    AccountDetail, Burn, FirstOut, HealthCell, Point, PoolDetail, ResetMark, Trend, WindowSpend,
};

use crate::ledger::Entry;
use crate::limits::Window;
use crate::pricing::{self, Custom};
use crate::provider::ProviderId;
use crate::report::{AccountReport, Report};
use crate::time::{SignedDuration, Timestamp};

/// How often the daemon reads the pools.
pub const EVERY: std::time::Duration = std::time::Duration::from_secs(120);
/// How far back readings and spending are kept: the longest window drawn,
/// and a day before it.
const KEEP: SignedDuration = SignedDuration::from_hours(24 * 8);
/// Readings that have not changed are written again after this long, so a
/// quiet pool still draws as a line.
pub const REWRITE: SignedDuration = SignedDuration::from_hours(1);
/// What each account served is summed in steps of this many minutes.
const STEP_MINS: i64 = 5;
/// Health is shown in cells of this many minutes, over a day.
pub const CELL_MINS: u32 = 30;
const CELLS: usize = 48;
/// The most points a recorded line holds; more readings are thinned.
const POINTS: usize = 240;
/// The hours a pace is measured over, the preferred first.
const BURN_HOURS: [u32; 3] = [3, 1, 6];
/// A window must be this full before what it served says what a percent of
/// it is worth.
const PRICED_FROM: f64 = 2.0;

/// A pool's windows, and each working account's, at one moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sample {
    pub at: Timestamp,
    pub provider: ProviderId,
    pub pool: Vec<Reading>,
    pub accounts: Vec<AccountReading>,
}

/// One window's use, to a tenth of a percent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reading {
    pub span: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub used: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccountReading {
    pub id: String,
    /// Its share of the pool's capacity.
    pub share: f64,
    pub windows: Vec<Reading>,
}

/// A reading as the ledger holds it, among the requests.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Line {
    pub quota: Sample,
}

impl Reading {
    fn of(window: &Window, now: Timestamp) -> Self {
        Self {
            span: window.span.clone(),
            model: window.model.clone(),
            used: (window.used_at(now) * 10.0).round() / 10.0,
            resets_at: window.upcoming_reset(now),
        }
    }

    fn is(&self, span: &str) -> bool {
        self.model.is_none() && self.span == span
    }
}

impl Sample {
    /// Whether `other` reads the same, whenever it was taken.
    pub fn same_as(&self, other: &Sample) -> bool {
        self.provider == other.provider
            && self.pool == other.pool
            && self.accounts == other.accounts
    }

    fn pool_used(&self, span: &str) -> Option<f64> {
        self.pool.iter().find(|r| r.is(span)).map(|r| r.used)
    }

    fn account_used(&self, id: &str, span: &str) -> Option<f64> {
        let account = self.accounts.iter().find(|a| a.id == id)?;
        account.windows.iter().find(|r| r.is(span)).map(|r| r.used)
    }
}

/// The accounts of `provider` that serve: enabled and signed in.
fn working(report: &Report, provider: ProviderId) -> impl Iterator<Item = &AccountReport> {
    report
        .accounts
        .iter()
        .filter(move |a| a.provider == provider && !a.disabled && a.auth_error.is_none())
}

/// Each pool of `report` read now.
pub fn sample(report: &Report, now: Timestamp) -> Vec<Sample> {
    report
        .pools
        .iter()
        .map(|pool| {
            let accounts: Vec<&AccountReport> = working(report, pool.provider).collect();
            let even = 1.0 / accounts.len().max(1) as f64;
            Sample {
                at: now,
                provider: pool.provider,
                pool: pool.windows.iter().map(|w| Reading::of(w, now)).collect(),
                accounts: accounts
                    .iter()
                    .map(|a| AccountReading {
                        id: a.id.clone(),
                        share: pool.shares.get(&a.id).copied().unwrap_or(even),
                        windows: a
                            .state
                            .limits
                            .windows
                            .iter()
                            .map(|w| Reading::of(w, now))
                            .collect(),
                    })
                    .collect(),
            }
        })
        .collect()
}

/// What to write of `samples`, given the last written of each pool: those
/// that changed, or that were last written [`REWRITE`] ago.
pub fn due(samples: Vec<Sample>, last: &HashMap<ProviderId, Sample>) -> Vec<Sample> {
    samples
        .into_iter()
        .filter(|s| match last.get(&s.provider) {
            Some(before) => !s.same_as(before) || s.at.duration_since(before.at) >= REWRITE,
            None => true,
        })
        .collect()
}

/// What one account's requests in one five-minute step came to.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Spent {
    answered: u64,
    failed: u64,
    tokens: u64,
    cost: f64,
}

/// Readings and spending by step, oldest first.
#[derive(Debug, Default)]
struct Store {
    samples: Vec<Sample>,
    /// By the step's start (milliseconds) and account.
    spent: BTreeMap<(i64, Arc<str>), Spent>,
}

impl Store {
    fn add(&mut self, entry: &Entry, prices: &BTreeMap<String, Custom>) {
        if entry.account.is_empty() {
            return;
        }
        let step = step_of(entry.at);
        let spent = self
            .spent
            .entry((step, Arc::from(entry.account.as_str())))
            .or_default();
        if entry.failed() {
            spent.failed += 1;
        } else if entry.answered() {
            spent.answered += 1;
            spent.tokens += entry.tokens();
            if let Some(model) = &entry.model
                && let Some(price) = pricing::price(model, prices)
            {
                spent.cost += price.cost(
                    entry.input,
                    entry.output,
                    entry.cache_read,
                    entry.cache_write,
                );
            }
        }
    }

    fn sampled(&mut self, samples: &[Sample]) {
        self.samples.extend_from_slice(samples);
    }

    fn settle(&mut self, now: Timestamp) {
        let from = now - KEEP;
        self.samples.sort_by_key(|s| s.at);
        self.samples.retain(|s| s.at >= from);
        let first = step_of(from);
        self.spent = self.spent.split_off(&(first, Arc::from("")));
    }

    /// What `account` served from `since` up to now.
    fn spent_since(&self, account: &str, since: Timestamp) -> Spent {
        let mut total = Spent::default();
        for ((_, id), spent) in self.spent.range((step_of(since), Arc::from(""))..) {
            if &**id == account {
                total.answered += spent.answered;
                total.failed += spent.failed;
                total.tokens += spent.tokens;
                total.cost += spent.cost;
            }
        }
        total
    }
}

fn step_of(at: Timestamp) -> i64 {
    let step = STEP_MINS * 60_000;
    at.as_millisecond().div_euclid(step) * step
}

/// The readings and spending the daemon keeps: none until they are built
/// (the daemon builds them as it starts), then the last week's, kept
/// current as requests settle and readings are written.
#[derive(Debug, Default)]
pub struct Kept {
    stage: Mutex<Stage>,
    /// Held through a build, so a second caller waits for the first's
    /// rather than reading the ledger again.
    building: Mutex<()>,
}

#[derive(Debug, Default)]
enum Stage {
    #[default]
    Cold,
    /// Reading the ledger: what comes meanwhile waits here.
    Building(Vec<Entry>, Vec<Sample>),
    Ready(Box<Store>),
}

impl Kept {
    fn stage(&self) -> std::sync::MutexGuard<'_, Stage> {
        self.stage.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Counts a request that settled, once anything is kept.
    pub fn add(&self, entry: &Entry, prices: &BTreeMap<String, Custom>) {
        match &mut *self.stage() {
            Stage::Cold => {}
            Stage::Building(waiting, _) => waiting.push(entry.clone()),
            Stage::Ready(store) => store.add(entry, prices),
        }
    }

    /// Keeps readings just written, once anything is kept.
    pub fn sampled(&self, samples: &[Sample]) {
        match &mut *self.stage() {
            Stage::Cold => {}
            Stage::Building(_, waiting) => waiting.extend_from_slice(samples),
            Stage::Ready(store) => store.sampled(samples),
        }
    }

    pub fn is_ready(&self) -> bool {
        matches!(*self.stage(), Stage::Ready(_))
    }

    /// Reads the last week of the ledger in `usage`, up to the lengths
    /// `ledger.mark` gives. Blocks: for a blocking thread, and while another
    /// caller builds it. `mark` runs under the ledger's lock and starts the
    /// build there, so each line lands either in what is read or in what
    /// waits, never both.
    pub fn build(
        &self,
        usage: &Path,
        now: Timestamp,
        prices: &BTreeMap<String, Custom>,
        mark: impl FnOnce(&mut dyn FnMut()) -> Vec<(PathBuf, u64)>,
    ) {
        let _one = self.building.lock().unwrap_or_else(|p| p.into_inner());
        // Another caller built it while this one waited.
        if self.is_ready() {
            return;
        }
        let lengths = {
            let mut start = || {
                let mut stage = self.stage();
                if matches!(*stage, Stage::Cold) {
                    *stage = Stage::Building(Vec::new(), Vec::new());
                }
            };
            mark(&mut start)
        };
        if !matches!(*self.stage(), Stage::Building(..)) {
            return;
        }
        let from = now - KEEP;
        let mut store = Store::default();
        crate::ledger::lines_upto(usage, from, &lengths, |line| {
            if line.starts_with("{\"quota\"") {
                if let Ok(Line { quota }) = serde_json::from_str::<Line>(line)
                    && quota.at >= from
                {
                    store.samples.push(quota);
                }
            } else if !line.starts_with("{\"window\"")
                && let Ok(entry) = serde_json::from_str::<Entry>(line)
                && entry.at >= from
            {
                store.add(&entry, prices);
            }
        });
        let mut stage = self.stage();
        if let Stage::Building(entries, samples) = std::mem::take(&mut *stage) {
            for entry in &entries {
                store.add(entry, prices);
            }
            store.sampled(&samples);
            *stage = Stage::Ready(Box::new(store));
        }
    }

    /// `provider`'s pool as `report` has it now, with what is kept; `None`
    /// until [`Kept::build`] has run, or when the pool has no working
    /// account.
    pub fn detail(
        &self,
        provider: ProviderId,
        report: &Report,
        now: Timestamp,
    ) -> Option<Option<PoolDetail>> {
        let mut stage = self.stage();
        let Stage::Ready(store) = &mut *stage else {
            return None;
        };
        store.settle(now);
        Some(detail(store, provider, report, now))
    }
}

fn span_length(span: &str) -> Option<SignedDuration> {
    match span {
        "5h" => Some(SignedDuration::from_hours(5)),
        "7d" => Some(SignedDuration::from_hours(24 * 7)),
        "30d" => Some(SignedDuration::from_hours(24 * 30)),
        _ => None,
    }
}

/// How far back a window's line is drawn, and how far ahead it is
/// projected: no further than one window, within which each account resets
/// once at most, as the projection counts them.
fn reach(span: &str) -> (SignedDuration, SignedDuration) {
    match span {
        "5h" => (
            SignedDuration::from_hours(24),
            SignedDuration::from_hours(5),
        ),
        _ => (
            SignedDuration::from_hours(24 * 7),
            SignedDuration::from_hours(24 * 3),
        ),
    }
}

fn hours(d: SignedDuration) -> f64 {
    d.as_millis() as f64 / 3_600_000.0
}

fn detail(
    store: &Store,
    provider: ProviderId,
    report: &Report,
    now: Timestamp,
) -> Option<PoolDetail> {
    let pool = report.pools.iter().find(|p| p.provider == provider)?;
    let accounts: Vec<&AccountReport> = working(report, provider).collect();
    let even = 1.0 / accounts.len().max(1) as f64;
    let share = |id: &str| pool.shares.get(id).copied().unwrap_or(even);
    let samples: Vec<&Sample> = store
        .samples
        .iter()
        .filter(|s| s.provider == provider)
        .collect();

    let mut spans: Vec<&str> = pool
        .windows
        .iter()
        .filter(|w| w.model.is_none())
        .map(|w| w.span.as_str())
        .filter(|s| span_length(s).is_some())
        .collect();
    spans.sort_by_key(|s| span_length(s));
    spans.dedup();

    let trends = spans
        .iter()
        .filter_map(|span| {
            let window = pool
                .windows
                .iter()
                .find(|w| w.model.is_none() && w.span == *span)?;
            let used = round(window.used_at(now));
            let (back, ahead) = reach(span);
            let mut line: Vec<(Timestamp, f64)> = samples
                .iter()
                .filter(|s| s.at >= now - back && s.at < now)
                .filter_map(|s| Some((s.at, s.pool_used(span)?)))
                .collect();
            line.push((now, used));
            let burns: Vec<Burn> = BURN_HOURS
                .iter()
                .filter_map(|&h| {
                    Some(Burn {
                        hours: h,
                        rate: (pace(&line, now, h)? * 100.0).round() / 100.0,
                    })
                })
                .collect();
            let mut by_hours = burns.clone();
            by_hours.sort_by_key(|b| b.hours);
            let burn = BURN_HOURS
                .iter()
                .find_map(|h| burns.iter().find(|b| b.hours == *h))
                .map(|b| b.rate);
            let length = span_length(span)?;
            let marks: Vec<ResetMark> = {
                let mut marks: Vec<ResetMark> = accounts
                    .iter()
                    .filter_map(|a| {
                        let w = a
                            .state
                            .limits
                            .windows
                            .iter()
                            .find(|w| w.model.is_none() && w.span == *span)?;
                        let at = w.upcoming_reset(now)?;
                        let used = w.used_at(now);
                        (used > 0.0).then(|| ResetMark {
                            at,
                            account: a.id.clone(),
                            gives_back: round(share(&a.id) * used),
                        })
                    })
                    .collect();
                marks.sort_by_key(|m| m.at);
                marks
            };
            let back_within: f64 = marks
                .iter()
                .filter(|r| r.at <= now + length)
                .map(|r| r.gives_back)
                .sum();
            let sustainable = Some(((100.0 - used).max(0.0) + back_within) / hours(length))
                .map(|r| (r * 100.0).round() / 100.0);
            let resets: Vec<ResetMark> =
                marks.into_iter().filter(|m| m.at <= now + ahead).collect();
            let projection = project(now, used, burn.unwrap_or(0.0), &resets, now + ahead);
            let first_out = burn.and_then(|_| first_out(&samples, &accounts, span, now));
            Some(Trend {
                span: crate::api::span(span),
                used,
                recorded: thin(line, now - back, now),
                projected: projection.points,
                resets,
                burn,
                burns: by_hours,
                sustainable,
                runs_out_at: projection.runs_out_at,
                dry_until: projection.dry_until,
                first_out,
            })
        })
        .collect();

    let health_since = Timestamp::from_millisecond(
        step_of_cell(now) - (CELLS as i64 - 1) * CELL_MINS as i64 * 60_000,
    )
    .unwrap_or(now);
    let accounts = accounts
        .iter()
        .map(|a| AccountDetail {
            id: a.id.clone(),
            windows: a
                .state
                .limits
                .windows
                .iter()
                .filter(|w| w.model.is_none())
                .filter_map(|w| {
                    let resets_at = w.upcoming_reset(now)?;
                    let since = resets_at - span_length(&w.span)?;
                    let spent = store.spent_since(&a.id, since.max(now - KEEP));
                    let used = w.used_at(now);
                    Some(WindowSpend {
                        span: crate::api::span(&w.span),
                        since,
                        resets_at,
                        used,
                        requests: spent.answered,
                        tokens: spent.tokens,
                        cost: spent.cost,
                        per_percent: (used >= PRICED_FROM && spent.cost > 0.0)
                            .then(|| spent.cost / used),
                    })
                })
                .collect(),
            health: health(store, &a.id, health_since),
        })
        .collect();

    Some(PoolDetail {
        provider: crate::api::provider(provider),
        generated_at: now,
        trends,
        accounts,
        health_since,
        cell_minutes: CELL_MINS,
    })
}

fn step_of_cell(at: Timestamp) -> i64 {
    let cell = CELL_MINS as i64 * 60_000;
    at.as_millisecond().div_euclid(cell) * cell
}

fn health(store: &Store, account: &str, since: Timestamp) -> Vec<HealthCell> {
    let mut cells = vec![HealthCell::default(); CELLS];
    let cell = CELL_MINS as i64 * 60_000;
    for ((step, id), spent) in store.spent.range((step_of(since), Arc::from(""))..) {
        if &**id != account {
            continue;
        }
        let i = ((step - since.as_millisecond()) / cell) as usize;
        if let Some(c) = cells.get_mut(i) {
            c.answered += spent.answered;
            c.failed += spent.failed;
        }
    }
    cells
}

/// Percent an hour `line` rose over the last `hours`: every rise counted,
/// the drops resets make left out. `None` when the line reaches less than
/// half that far back.
fn pace(line: &[(Timestamp, f64)], now: Timestamp, hours_back: u32) -> Option<f64> {
    let from = now - SignedDuration::from_hours(hours_back as i64);
    let within: Vec<&(Timestamp, f64)> = line.iter().filter(|(at, _)| *at >= from).collect();
    let first = within.first()?;
    let measured = hours(now.duration_since(first.0));
    if within.len() < 2 || measured < hours_back as f64 / 2.0 {
        return None;
    }
    let rise: f64 = within
        .windows(2)
        .map(|pair| (pair[1].1 - pair[0].1).max(0.0))
        .sum();
    Some(rise / measured)
}

/// The account of `accounts` its own recent pace would spend first, before
/// its window resets.
fn first_out(
    samples: &[&Sample],
    accounts: &[&AccountReport],
    span: &str,
    now: Timestamp,
) -> Option<FirstOut> {
    accounts
        .iter()
        .filter_map(|a| {
            let w = a
                .state
                .limits
                .windows
                .iter()
                .find(|w| w.model.is_none() && w.span == span)?;
            let used = w.used_at(now);
            let mut line: Vec<(Timestamp, f64)> = samples
                .iter()
                .filter_map(|s| Some((s.at, s.account_used(&a.id, span)?)))
                .collect();
            line.push((now, used));
            let rate = BURN_HOURS.iter().find_map(|&h| pace(&line, now, h))?;
            if rate <= 0.0 {
                return None;
            }
            let at = if used >= 100.0 {
                now
            } else {
                now + SignedDuration::from_secs_f64((100.0 - used) / rate * 3600.0)
            };
            let before_reset = w.upcoming_reset(now).is_none_or(|reset| at < reset);
            (before_reset && used < 100.0).then(|| FirstOut {
                account: a.id.clone(),
                at,
            })
        })
        .min_by_key(|f| f.at)
}

struct Projection {
    points: Vec<Point>,
    runs_out_at: Option<Timestamp>,
    dry_until: Option<Timestamp>,
}

/// The pool from `used` now, filling at `burn` percent an hour until
/// `until`, and given back as each of `resets` comes: straight lines
/// between those moments, flat at 100 while it is spent.
fn project(
    now: Timestamp,
    used: f64,
    burn: f64,
    resets: &[ResetMark],
    until: Timestamp,
) -> Projection {
    let mut points = vec![Point { at: now, used }];
    let (mut at, mut level) = (now, used.clamp(0.0, 100.0));
    let mut runs_out_at = (level >= 100.0).then_some(now);
    let mut dry_until = None;
    // Fills from `at` to `to`, noting when it is spent on the way.
    let advance = |to: Timestamp, at: &mut Timestamp, level: &mut f64, points: &mut Vec<Point>| {
        let mut spent = None;
        if *level < 100.0 && burn > 0.0 {
            let full = *at + SignedDuration::from_secs_f64((100.0 - *level) / burn * 3600.0);
            if full < to {
                points.push(Point {
                    at: full,
                    used: 100.0,
                });
                spent = Some(full);
                *level = 100.0;
            } else {
                *level += burn * hours(to.duration_since(*at));
            }
        }
        *at = to;
        points.push(Point {
            at: to,
            used: round(*level),
        });
        spent
    };
    for reset in resets.iter().filter(|r| r.at <= until) {
        if let Some(full) = advance(reset.at, &mut at, &mut level, &mut points) {
            runs_out_at.get_or_insert(full);
        }
        if level >= 100.0 && runs_out_at.is_some() && dry_until.is_none() && reset.gives_back > 0.0
        {
            dry_until = Some(reset.at);
        }
        level = (level - reset.gives_back).max(0.0);
        points.push(Point {
            at: reset.at,
            used: round(level),
        });
    }
    if let Some(full) = advance(until, &mut at, &mut level, &mut points) {
        runs_out_at.get_or_insert(full);
    }
    points.dedup_by(|b, a| a.at == b.at && a.used == b.used);
    Projection {
        points,
        runs_out_at,
        dry_until,
    }
}

fn round(used: f64) -> f64 {
    (used * 10.0).round() / 10.0
}

/// At most [`POINTS`] of `line`, from `from` to `to`: the last reading of
/// each slice, and the first and last kept as they are.
fn thin(line: Vec<(Timestamp, f64)>, from: Timestamp, to: Timestamp) -> Vec<Point> {
    let slice = (to.duration_since(from).as_millis() / POINTS as i64).max(1);
    let mut points: Vec<Point> = Vec::with_capacity(POINTS + 2);
    let mut last_slice = None;
    for (at, used) in line {
        let s = at.duration_since(from).as_millis() / slice;
        let point = Point { at, used };
        if last_slice == Some(s) && points.len() > 1 {
            *points.last_mut().expect("one at least") = point;
        } else {
            points.push(point);
        }
        last_slice = Some(s);
    }
    points
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    fn mark(at: &str, gives_back: f64) -> ResetMark {
        ResetMark {
            at: ts(at),
            account: "a".into(),
            gives_back,
        }
    }

    #[test]
    fn pace_counts_rises_and_leaves_out_resets() {
        let now = ts("2026-11-16T12:00:00Z");
        let line = vec![
            (ts("2026-11-16T09:00:00Z"), 10.0),
            (ts("2026-11-16T10:00:00Z"), 20.0),
            // A reset gave 15 back.
            (ts("2026-11-16T10:30:00Z"), 5.0),
            (ts("2026-11-16T12:00:00Z"), 15.0),
        ];
        assert_eq!(pace(&line, now, 3), Some(20.0 / 3.0));
        // An hour back reaches only the last reading before now.
        assert_eq!(pace(&line[3..], now, 1), None);
    }

    #[test]
    fn projection_fills_runs_dry_and_is_given_back() {
        let now = ts("2026-11-16T12:00:00Z");
        let resets = [mark("2026-11-16T20:00:00Z", 30.0)];
        let p = project(now, 80.0, 5.0, &resets, ts("2026-11-17T00:00:00Z"));
        // 20 points left at 5 an hour: dry at 16:00, until the reset at 20:00.
        assert_eq!(p.runs_out_at, Some(ts("2026-11-16T16:00:00Z")));
        assert_eq!(p.dry_until, Some(ts("2026-11-16T20:00:00Z")));
        let at = |text: &str| {
            p.points
                .iter()
                .filter(|pt| pt.at == ts(text))
                .map(|pt| pt.used)
                .collect::<Vec<_>>()
        };
        assert_eq!(at("2026-11-16T16:00:00Z"), [100.0]);
        assert_eq!(at("2026-11-16T20:00:00Z"), [100.0, 70.0]);
        assert_eq!(at("2026-11-17T00:00:00Z"), [90.0]);
    }

    #[test]
    fn a_pool_at_rest_projects_flat_but_for_resets() {
        let now = ts("2026-11-16T12:00:00Z");
        let resets = [mark("2026-11-16T14:00:00Z", 10.0)];
        let p = project(now, 40.0, 0.0, &resets, ts("2026-11-16T22:00:00Z"));
        assert_eq!(p.runs_out_at, None);
        let used: Vec<f64> = p.points.iter().map(|pt| pt.used).collect();
        assert_eq!(used, [40.0, 40.0, 30.0, 30.0]);
    }

    #[test]
    fn thinning_keeps_the_ends_and_the_last_of_each_slice() {
        let from = ts("2026-11-16T00:00:00Z");
        let to = from + SignedDuration::from_hours(24);
        let line: Vec<(Timestamp, f64)> = (0..24 * 60)
            .map(|m| (from + SignedDuration::from_mins(m), m as f64))
            .chain([(to, 9999.0)])
            .collect();
        let points = thin(line, from, to);
        assert!(points.len() <= POINTS + 2, "{}", points.len());
        assert_eq!(points[0].used, 0.0);
        assert_eq!(points.last().unwrap().used, 9999.0);
    }

    #[test]
    fn readings_are_written_when_they_change_or_an_hour_on() {
        let at = ts("2026-11-16T12:00:00Z");
        let sample = |at: Timestamp, used: f64| Sample {
            at,
            provider: ProviderId::Claude,
            pool: vec![Reading {
                span: "5h".into(),
                model: None,
                used,
                resets_at: None,
            }],
            accounts: Vec::new(),
        };
        let last = HashMap::from([(ProviderId::Claude, sample(at, 10.0))]);
        let later = at + SignedDuration::from_mins(5);
        assert!(due(vec![sample(later, 10.0)], &last).is_empty());
        assert_eq!(due(vec![sample(later, 11.0)], &last).len(), 1);
        assert_eq!(due(vec![sample(at + REWRITE, 10.0)], &last).len(), 1);
        assert_eq!(due(vec![sample(later, 10.0)], &HashMap::new()).len(), 1);
    }

    #[test]
    fn health_and_spending_land_in_their_cells() {
        let mut store = Store::default();
        let entry = |at: &str, status: u16| Entry {
            at: ts(at),
            account: "a".into(),
            provider: ProviderId::Claude,
            model: Some("claude-opus-5-5".into()),
            status,
            input: 1000,
            output: 1000,
            cache_read: 0,
            cache_write: 0,
            ms: 1,
            first_byte_ms: None,
            attempts: 1,
            agent: None,
            session: None,
            machine: None,
            end: None,
        };
        let prices = BTreeMap::new();
        store.add(&entry("2026-11-16T11:10:00Z", 200), &prices);
        store.add(&entry("2026-11-16T11:40:00Z", 200), &prices);
        store.add(&entry("2026-11-16T11:41:00Z", 529), &prices);
        let since = ts("2026-11-16T11:00:00Z");
        let cells = health(&store, "a", since);
        assert_eq!(
            cells[0],
            HealthCell {
                answered: 1,
                failed: 0
            }
        );
        assert_eq!(
            cells[1],
            HealthCell {
                answered: 1,
                failed: 1
            }
        );
        let spent = store.spent_since("a", ts("2026-11-16T11:30:00Z"));
        assert_eq!(spent.answered, 1);
        assert_eq!(spent.tokens, 2000);
        assert!(spent.cost > 0.0);
        assert_eq!(store.spent_since("b", since).answered, 0);
    }
}
